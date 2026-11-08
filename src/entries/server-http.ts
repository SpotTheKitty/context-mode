import { createServer as createHttpServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer, WebStandardStreamableHTTPServerTransport, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { TOOLS } from "../core/tools/registry.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { handleHook } from "../core/hooks/dispatch.ts";
import { appendEvent, ownCallRow } from "../core/journal/append.ts";
import { closeDb, openDb } from "../core/store/db.ts";
import { httpScope, settleHttpScope } from "../core/store/http-scope.ts";
import type { AgentId, ToolContext } from "../core/contracts/types.ts";
import { DB_FILE_NAME } from "../core/contracts/constants.ts";

export interface HttpConfig {
  host: string; port: number; path: string; tenantHeader: string; dataDir: string;
  maxRequestBytes: number; tenants: Record<string, {agent: AgentId; toolPrefix?: string; hookAdapters?: Record<string,{toolPrefix?:string}>}>;
}

// Only environment names needed by project resolution and sandbox execution. Never copy the
// service's complete environment (which may contain unrelated credentials) into hook handling.
function environment(config: HttpConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {CONTEXT_MODE_DATA_DIR:config.dataDir};
  for (const key of ["HOME","USERPROFILE","PATH","SystemRoot","COMSPEC","TEMP","TMP","SHELL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function listenHttp(config: HttpConfig): Promise<Server> {
  if (!config.tenantHeader || !config.dataDir || !config.path || !config.maxRequestBytes) throw new Error("incomplete contextMode table");
  const database = join(config.dataDir,DB_FILE_NAME);
  const env = environment(config);
  const host = createHttpServer(async (incoming,outgoing) => {
    try {
      const url = new URL(incoming.url ?? "/", `http://${config.host}`);
      if (url.pathname === "/healthz") {outgoing.end("ok"); return;}
      if (url.pathname !== config.path && url.pathname !== config.path + "/hooks") {outgoing.writeHead(404).end(); return;}
      const tenant = incoming.headers[config.tenantHeader.toLowerCase()];
      if (typeof tenant !== "string" || !Object.hasOwn(config.tenants,tenant)) {outgoing.writeHead(403).end("unknown tenant"); return;}
      const agent = config.tenants[tenant]!.agent;
      await httpScope.run({tenant,database,toolPrefix:config.tenants[tenant]!.toolPrefix},async () => {
        const chunks: Buffer[] = []; let bytes=0;
        for await (const chunk of incoming) {
          bytes += chunk.length;
          if (bytes > config.maxRequestBytes) {outgoing.writeHead(413).end(); return;}
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        if (url.pathname.endsWith("/hooks")) {
          if (incoming.method !== "POST") {outgoing.writeHead(405).end(); return;}
          const input = JSON.parse(body) as Record<string,unknown>;
          const wrapped = typeof input.adapter === "string" && Object.hasOwn(input,"raw");
          const adapter = wrapped ? input.adapter as AgentId : agent;
          const adapters = config.tenants[tenant]!.hookAdapters;
          if (adapter !== agent && !Object.hasOwn(adapters ?? {},adapter)) {outgoing.writeHead(403).end("unknown hook adapter");return;}
          const scope = httpScope.getStore()!;
          scope.toolPrefix = adapters?.[adapter]?.toolPrefix ?? config.tenants[tenant]!.toolPrefix;
          const raw: unknown = wrapped ? input.raw : input;
          let answer;
          try {answer = await handleHook(adapter,raw,env);} finally {await settleHttpScope();}
          outgoing.setHeader("Content-Type","application/json"); outgoing.end(JSON.stringify(answer)); return;
        }
        const server = new McpServer({name:"context-mode",version:"tenant-http"});
        // Machine-wide install/repair tools are deliberately unavailable on a shared tenant
        // connection. They remain available unchanged through the stdio entry.
        for (const tool of TOOLS.filter(t=> t.name !== "ctx_upgrade" && t.name !== "ctx_doctor")) {
          const schema = z.toJSONSchema(tool.schema,{target:"draft-2020-12",io:"input"}) as Record<string,unknown>;
          schema.properties = {...schema.properties as object,_workspace:{type:"string",description:"Absolute project/worktree directory on the server workstation"},_sessionId:{type:"string"}};
          const inputSchema = {"~standard":{version:1,vendor:"context-mode",validate:(value:unknown)=>({value}),jsonSchema:{input:()=>schema,output:()=>schema}}} as StandardSchemaWithJSON;
          server.registerTool(tool.name,{description:tool.description,inputSchema}, async (input,req) => {
            const args = {...input as Record<string,unknown>};
            const meta = req.mcpReq._meta as Record<string,unknown> | undefined;
            const sandbox = meta?.["codex/sandbox-state-meta"] as {sandboxCwd?:string} | undefined;
            let workspace = args._workspace ?? meta?.cwd ?? sandbox?.sandboxCwd ?? args.cwd;
            if (typeof workspace === "string" && workspace.startsWith("file:")) workspace = (await import("node:url")).fileURLToPath(workspace);
            const sessionId = typeof args._sessionId === "string" ? args._sessionId : typeof meta?.sessionId === "string" ? meta.sessionId : "http";
            delete args._workspace; delete args._sessionId;
            try {
              if (typeof workspace !== "string") throw new Error("HTTP context-mode requires _workspace or workspace metadata");
              const project = resolveProject(agent,{env,argv:["--agent",agent,"--workspace-folder",workspace],cwd:workspace,piCwd:workspace});
              const ctx: ToolContext = {project,sessionId,turn:0,signal:req.mcpReq.signal,protocolVersion:server.server.getNegotiatedProtocolVersion() ?? ""};
              const reply = await tool.handler(tool.schema.parse(args),ctx);
              const db = await openDb(project);
              try {appendEvent(db,ownCallRow(project,ctx,tool.name,reply));} finally {closeDb(db);}
              return {content:[{type:"text" as const,text:reply.text}],isError:reply.isError};
            } catch (e) {return {content:[{type:"text" as const,text:e instanceof Error ? e.message : "HTTP tool failed"}],isError:true};}
          });
        }
        const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        await server.connect(transport);
        try {
          const headers = new Headers();
          for (const [key,value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key,Array.isArray(value)?value.join(","):value);
          const request = new Request(`http://${config.host}${incoming.url}`,{method:incoming.method ?? "POST",headers,...(body ? {body}: {})});
          const response = await transport.handleRequest(request);
          outgoing.writeHead(response.status,Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } finally {await settleHttpScope(); await server.close();}
      });
    } catch (e) {console.error("context-mode HTTP request failed", e); if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end("request failed");}
  });
  await new Promise<void>((resolve,reject)=>{host.once("error",reject);host.listen(config.port,config.host,()=>{host.off("error",reject);resolve();});});
  return host;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.argv[2]!,"utf8")).contextMode as HttpConfig;
  const host = await listenHttp(config);
  console.error(JSON.stringify({event:"listening",pid:process.pid,parentPid:process.ppid,address:host.address(),instance:randomUUID()}));
}
