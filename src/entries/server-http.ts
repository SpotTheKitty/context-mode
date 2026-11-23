import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { isMainThread, workerData, type Worker } from "node:worker_threads";
import { McpServer, WebStandardStreamableHTTPServerTransport, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { TOOLS } from "../core/tools/registry.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { appendEvent, ownCallRow } from "../core/journal/append.ts";
import { closeDb, openDb } from "../core/store/db.ts";
import { httpScope, settleHttpScope, type ExcerptBand } from "../core/store/http-scope.ts";
import { buildStatsIndex } from "../core/store/tenant-store.ts";
import type { AgentId, HookOutput, ToolContext, ToolReply } from "../core/contracts/types.ts";
import { DB_FILE_NAME, EXEC_TIMEOUT_MS, HOOK_TIMEOUT_MS } from "../core/contracts/constants.ts";
import { MAX_POOL_WORKERS, SEARCH_WORKER_ROLE, RequestPool, WriteCoordinator, type HookJob, type ToolJob } from "./search-pool.ts";
import { serveSearchWorker, stallSync } from "./search-worker.ts";

export { buildStatsIndex, MAX_POOL_WORKERS };

export interface HttpConfig {
  host: string; port: number; path: string; tenantHeader: string; dataDir: string;
  defaultWorkspace?: string; sessionRoot?: string;
  maxRequestBytes: number; tenants: Record<string, {agent: AgentId; defaultWorkspace?: string; toolPrefix?: string; hookAdapters?: Record<string,{toolPrefix?:string}>}>;
  /** Data setting: general worker count for tool execution (defaults dynamically from CPU count). */
  workers?: number;
  /** Data setting: worker threads for heavy/general MCP tools (ctx_index, ctx_execute, ctx_batch, ctx_purge, ctx_resume, ctx_stats). */
  toolWorkers?: number;
  /** Data setting: budget in ms for general MCP tools. Default EXEC_TIMEOUT_MS. */
  toolTimeoutMs?: number;
  /** T230: budget for one ctx_search, queue wait included. Default SEARCH_TIMEOUT_MS. */
  searchTimeoutMs?: number;
  /** T230: worker threads that run searches. 0 runs a search on the request path (library control test only; rejected in endpoint tables). */
  searchWorkers?: number;
  /** Data setting: worker threads that run /mcp/hooks. Defaults dynamically from CPU count (>= 2). */
  hookWorkers?: number;
  hookTimeoutMs?: number;
  /** T1011: tool name (as the host sends it, or its canonical form) -> bytes of its result a hook returns whole. Above it the result is diverted. */
  inlineLimits?: Record<string, number>;
  /** T1021: tool name -> the middle band: above the tool's whole limit and up to upToBytes, a hook returns about returnBytes of excerpts
   *  that best match the call's own arguments, plus the pointer for the rest. Above upToBytes the diversion is unchanged. */
  excerptBands?: Record<string, ExcerptBand>;
}
/** Test seams: `searchStall` blocks the thread running ctx_search; `onWorker` observes spawned worker threads. */
export interface HttpOptions {
  searchStall?: (args: unknown) => number;
  onWorker?: (worker: Worker, pool: string) => void;
}

export const SEARCH_TIMEOUT_MS = 20000;
const SEARCH_TOOLS = new Set(["ctx_search"]);

export function defaultWorkerCounts(cpus: number = availableParallelism()): { toolWorkers: number; searchWorkers: number; hookWorkers: number } {
  const cores = Math.max(1, Math.floor(cpus));
  return {
    toolWorkers: Math.max(2, Math.min(8, Math.ceil(cores / 2))),
    searchWorkers: Math.max(2, Math.min(4, Math.ceil(cores / 4))),
    hookWorkers: Math.max(2, Math.min(4, Math.ceil(cores / 4))),
  };
}

/** Parses a workstation endpoint table JSON object for CLI startup and forbids the zero-worker control mode in production tables. */
export function configFromEndpointTable(table: { contextMode?: HttpConfig; sessionLog?: { sessionRoot?: string } }): HttpConfig {
  if (!table || typeof table !== "object" || !table.contextMode || typeof table.contextMode !== "object") {
    throw new Error("incomplete contextMode table");
  }
  const config = {
    ...table.contextMode,
    sessionRoot: table.contextMode.sessionRoot ?? table.sessionLog?.sessionRoot,
  } as HttpConfig;
  if (config.searchWorkers === 0) {
    throw new Error("invalid contextMode searchWorkers: 0 is not allowed in endpoint table config");
  }
  return config;
}

function validWorkerCount(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= MAX_POOL_WORKERS;
}

function validTimeout(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function timeoutReply(tool: string, ms: number, started: boolean, setting: string): ToolReply {
  const why = started ? "did not finish within" : "waited for a free worker for";
  const hint = tool === "ctx_search"
    ? " Narrow the search with source or scope, use fewer or more specific words, or retry."
    : " Retry or split the operation into smaller inputs.";
  return {
    text: `${tool} timed out: it ${why} ${ms} ms (${setting}). The server is still answering other requests.${hint}`,
    isError: true,
    sandboxBytes: 0,
  };
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

export async function listenHttp(config: HttpConfig, options: HttpOptions = {}): Promise<Server> {
  if (!config.tenantHeader || !config.dataDir || !config.path || !config.maxRequestBytes) throw new Error("incomplete contextMode table");
  const database = join(config.dataDir,DB_FILE_NAME);
  const env = environment(config);
  const defaults = defaultWorkerCounts();
  const toolWorkers = config.toolWorkers ?? config.workers ?? defaults.toolWorkers;
  const toolTimeoutMs = config.toolTimeoutMs ?? EXEC_TIMEOUT_MS;
  const searchTimeoutMs = config.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  const searchWorkers = config.searchWorkers ?? defaults.searchWorkers;
  const hookWorkers = config.hookWorkers ?? defaults.hookWorkers;
  const hookTimeoutMs = config.hookTimeoutMs ?? HOOK_TIMEOUT_MS;
  if (!validWorkerCount(toolWorkers, 1) || !validTimeout(toolTimeoutMs)) {
    throw new Error(`invalid contextMode toolWorkers (expected integer 1..${MAX_POOL_WORKERS}) or toolTimeoutMs`);
  }
  if (!validTimeout(searchTimeoutMs) || !validWorkerCount(searchWorkers, 0)) {
    throw new Error(`invalid contextMode searchTimeoutMs or searchWorkers (expected integer 0..${MAX_POOL_WORKERS})`);
  }
  if (!validWorkerCount(hookWorkers, 1) || !validTimeout(hookTimeoutMs)) {
    throw new Error(`invalid contextMode hookWorkers (expected integer 1..${MAX_POOL_WORKERS}) or hookTimeoutMs`);
  }
  const inlineLimits = config.inlineLimits;
  if (inlineLimits !== undefined && (typeof inlineLimits !== "object" || inlineLimits === null || Array.isArray(inlineLimits) ||
      !Object.values(inlineLimits).every((n) => Number.isSafeInteger(n) && n > 0))) throw new Error("invalid contextMode inlineLimits");
  const excerptBands = config.excerptBands;
  const bandOk = (b: unknown): boolean => typeof b === "object" && b !== null && !Array.isArray(b) &&
    [(b as ExcerptBand).upToBytes, (b as ExcerptBand).returnBytes].every((n) => Number.isSafeInteger(n) && n > 0);
  if (excerptBands !== undefined && (typeof excerptBands !== "object" || excerptBands === null || Array.isArray(excerptBands) ||
      !Object.values(excerptBands).every(bandOk))) throw new Error("invalid contextMode excerptBands");

  // Workers load this same file (the flat bundle has no other), so the entry is our own URL.
  const entry = fileURLToPath(import.meta.url);
  const coordinator = new WriteCoordinator();
  const poolOpts = { coordinator, onWorker: options.onWorker };
  // Separate pools keep fast /mcp/hooks and bounded ctx_search isolated from heavy indexing/execution.
  const toolPool = new RequestPool<ToolJob, ToolReply>(entry, toolWorkers, "tools", poolOpts);
  const searchPool = searchWorkers > 0 ? new RequestPool<ToolJob, ToolReply>(entry, searchWorkers, "search", poolOpts) : null;
  const hooks = new RequestPool<HookJob, HookOutput>(entry, hookWorkers, "hook", poolOpts);

  // Machine-wide install/repair tools are deliberately unavailable on a shared tenant
  // connection. Pre-compile JSON schemas once rather than per request.
  const httpTools = TOOLS.filter((t) => t.name !== "ctx_upgrade" && t.name !== "ctx_doctor").map((tool) => {
    const schema = z.toJSONSchema(tool.schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
    schema.properties = {
      ...(schema.properties as object),
      _workspace: { type: "string", description: "Absolute project/worktree directory on the server workstation" },
      _sessionId: { type: "string" },
    };
    const inputSchema = {
      "~standard": {
        version: 1,
        vendor: "context-mode",
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => schema, output: () => schema },
      },
    } as StandardSchemaWithJSON;
    return { tool, inputSchema };
  });

  const host = createHttpServer(async (incoming,outgoing) => {
    try {
      const url = new URL(incoming.url ?? "/", `http://${config.host}`);
      if (url.pathname === "/healthz") {outgoing.end("ok"); return;}
      const isReady = url.pathname === config.path + "/ready";
      if (url.pathname !== config.path && url.pathname !== config.path + "/hooks" && !isReady) {outgoing.writeHead(404).end(); return;}
      const tenant = incoming.headers[config.tenantHeader.toLowerCase()];
      if (typeof tenant !== "string" || !Object.hasOwn(config.tenants,tenant)) {outgoing.writeHead(403).end("unknown tenant"); return;}
      const agent = config.tenants[tenant]!.agent;
      if (isReady) {
        if (incoming.method !== "GET") {outgoing.writeHead(405).end(); return;}
        outgoing.setHeader("Content-Type","application/json");
        outgoing.end(JSON.stringify({ok:true,tenant,agent}));
        return;
      }
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
        const toolPrefix = adapters?.[adapter]?.toolPrefix ?? config.tenants[tenant]!.toolPrefix;
        const raw: unknown = wrapped ? input.raw : input;
        const result = await hooks.run({adapter,raw,env,tenant,database,toolPrefix,inlineLimits,excerptBands},hookTimeoutMs);
        if (result.kind !== "reply") {
          const reason = result.kind === "failed" ? result.message : `context-mode hook exceeded ${hookTimeoutMs} ms (hookTimeoutMs)`;
          console.error(reason);
          outgoing.writeHead(503).end(reason);
          return;
        }
        outgoing.setHeader("Content-Type","application/json"); outgoing.end(JSON.stringify(result.reply)); return;
      }
      const toolPrefix = config.tenants[tenant]!.toolPrefix;
      const server = new McpServer({name:"context-mode",version:"tenant-http"});
      for (const { tool, inputSchema } of httpTools) {
        server.registerTool(tool.name,{description:tool.description,inputSchema}, async (input,req) => {
          const args = {...input as Record<string,unknown>};
          const meta = req.mcpReq._meta as Record<string,unknown> | undefined;
          const sandbox = meta?.["codex/sandbox-state-meta"] as {sandboxCwd?:string} | undefined;
          const explicitWorkspace = args._workspace ?? meta?.cwd ?? sandbox?.sandboxCwd ?? args.cwd;
          const fallback = explicitWorkspace === undefined;
          let workspace = explicitWorkspace ?? config.tenants[tenant]!.defaultWorkspace ?? config.defaultWorkspace ?? config.sessionRoot ?? process.cwd();
          if (typeof workspace === "string" && workspace.startsWith("file:")) workspace = fileURLToPath(workspace);
          const sessionId = typeof args._sessionId === "string" ? args._sessionId : typeof meta?.sessionId === "string" ? meta.sessionId : "http";
          delete args._workspace; delete args._sessionId;
          try {
            if (typeof workspace !== "string") throw new Error("HTTP context-mode requires _workspace or workspace metadata");
            const source = {env,argv:["--agent",agent,"--workspace-folder",workspace],cwd:workspace,piCwd:workspace};
            const parsed = tool.schema.parse(args);
            const protocolVersion = server.server.getNegotiatedProtocolVersion() ?? "";
            const isSearch = SEARCH_TOOLS.has(tool.name);
            const stallMs = isSearch ? options.searchStall?.(parsed) ?? 0 : 0;
            let reply: ToolReply;
            if (isSearch && searchPool === null) {
              // T230 control path (searchWorkers === 0): run in-thread on the request path.
              reply = await httpScope.run({tenant,database,toolPrefix,inlineLimits,excerptBands}, async () => {
                try {
                  const project = resolveProject(agent,source);
                  const ctx: ToolContext = {project,sessionId,turn:0,signal:req.mcpReq.signal,protocolVersion};
                  stallSync(stallMs);
                  const r = await tool.handler(parsed,ctx);
                  const db = await openDb(project);
                  try {appendEvent(db,ownCallRow(project,ctx,tool.name,r));} finally {closeDb(db);}
                  return r;
                } finally {await settleHttpScope();}
              });
            } else {
              const targetPool = isSearch ? searchPool! : toolPool;
              const budgetMs = isSearch ? searchTimeoutMs : toolTimeoutMs;
              const setting = isSearch ? "searchTimeoutMs" : "toolTimeoutMs";
              const out = await targetPool.run({
                tool: tool.name, args: parsed, tenant, database, toolPrefix, agent, source, sessionId, protocolVersion,
                // ctx_stats is read-only and excluded from all stats counts; journaling its report on HTTP probes bloats events and forces a WAL write + checkpoint per poll.
                journal: tool.name !== "ctx_stats",
                stallMs,
              }, budgetMs, req.mcpReq.signal);
              if (out.kind === "failed") throw new Error(out.message);
              reply = out.kind === "timeout" ? timeoutReply(tool.name, budgetMs, out.started, setting) : out.reply;
            }
            return {content:[{type:"text" as const,text:(fallback ? `Workspace fallback: ${workspace}. Pass _workspace for project-specific results.\n` : "") + reply.text}],isError:reply.isError};
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
      } finally {await server.close();}
    } catch (e) {console.error("context-mode HTTP request failed", e); if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end("request failed");}
  });
  try {
    await new Promise<void>((resolve,reject)=>{host.once("error",reject);host.listen(config.port,config.host,()=>{host.off("error",reject);resolve();});});
  } catch (err) {
    coordinator.close();
    await Promise.allSettled([toolPool.close(), searchPool?.close(), hooks.close()]);
    throw err;
  }
  host.once("close",() => {coordinator.close(); void toolPool.close(); void searchPool?.close(); void hooks.close();});
  // Pre-warm hook workers only after the bind succeeds so a failed bind never leaks workers.
  hooks.warm(Math.min(2, hookWorkers));
  return host;
}

// A worker is this same file started as a thread: it must not read argv (copied from the parent) and listen.
if (!isMainThread && (workerData as {role?: string} | null)?.role === SEARCH_WORKER_ROLE) {
  serveSearchWorker();
} else if (isMainThread && process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const table = JSON.parse(readFileSync(process.argv[2]!,"utf8"));
  const config = configFromEndpointTable(table);
  if (process.argv.includes("--build-stats-index")) {
    const database = join(config.dataDir, DB_FILE_NAME);
    const result = buildStatsIndex(database);
    console.log(JSON.stringify({ event: "stats_index_upgrade", database, ...result }));
    process.exit(0);
  }
  const host = await listenHttp(config);
  console.error(JSON.stringify({event:"listening",pid:process.pid,parentPid:process.ppid,address:host.address(),instance:randomUUID()}));
}
