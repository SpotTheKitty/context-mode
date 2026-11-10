// One-shot native hook forwarder. It never opens a store or starts a stdio server.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAdapter } from "../adapters/table.ts";
import { logHookError } from "../core/hooks/fallback.ts";
import type { AgentId, HookOutput } from "../core/contracts/types.ts";

export interface HookHttpConfig {
  dataDir: string; host: string; port: number; path: string; tenantHeader: string; hookTimeoutMs: number;
  tenants: Record<string,{agent:AgentId;toolPrefix?:string;hookAdapters?:Record<string,{toolPrefix?:string}>}>;
}
// Claude's native PreToolUse contract supports updatedInput. Preserve routing decisions
// and all other hook output; only add missing workspace metadata to our own tools.
export function injectWorkspace(out: HookOutput, raw: unknown, agent: AgentId, prefix = "mcp__contextMode__"): HookOutput {
  if (agent !== "claude-code" || !raw || typeof raw !== "object") return out;
  const input = raw as Record<string, unknown>;
  if (input.hook_event_name !== "PreToolUse" || typeof input.cwd !== "string" || !input.cwd ||
      typeof input.tool_name !== "string" || !input.tool_name.startsWith(prefix + "ctx_")) return out;
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  if (!toolInput || typeof toolInput !== "object" || toolInput._workspace !== undefined) return out;
  try {
    const body = out.stdout ? JSON.parse(out.stdout) : {};
    const specific = body.hookSpecificOutput ?? {};
    if (out.exitCode !== 0 || specific.permissionDecision === "deny") return out;
    body.hookSpecificOutput = {...specific, hookEventName:"PreToolUse", updatedInput:{...toolInput,...specific.updatedInput,_workspace:specific.updatedInput?._workspace ?? input.cwd}};
    return {...out,stdout:JSON.stringify(body)};
  } catch {return out;}
}

export async function forwardHook(config: HookHttpConfig, tenant: string, raw: unknown, adapter?: AgentId): Promise<HookOutput> {
  const identity = config.tenants[tenant];
  if (!identity || !config.tenantHeader || !(config.hookTimeoutMs > 0)) throw new Error("invalid HTTP hook configuration");
  const agent = adapter ?? identity.agent;
  if (agent !== identity.agent && !Object.hasOwn(identity.hookAdapters ?? {},agent)) throw new Error("unknown HTTP hook adapter");
  try {
    const response = await fetch(`http://${config.host}:${config.port}${config.path}/hooks`,{
      method:"POST",headers:{"Content-Type":"application/json",[config.tenantHeader]:tenant},
      body:JSON.stringify({adapter:agent,raw}),signal:AbortSignal.timeout(config.hookTimeoutMs),
    });
    if (!response.ok) throw new Error("HTTP hook status " + response.status);
    const out = await response.json() as HookOutput;
    if (typeof out.stdout !== "string" || (out.exitCode !== 0 && out.exitCode !== 2) || (out.stderr !== undefined && typeof out.stderr !== "string")) throw new Error("invalid native hook response");
    return injectWorkspace(out,raw,agent,identity.toolPrefix);
  } catch (err) {
    logHookError({CONTEXT_MODE_DATA_DIR:config.dataDir},agent,"http",err);
    const row = getAdapter(agent);
    let event: ReturnType<typeof row.decode>["event"] = "PreToolUse";
    try {event=row.decode(raw).event;} catch { /* Empty allow also permits malformed native inputs. */ }
    return injectWorkspace({...row.encode({event,agent,sessionId:"",cwd:"",turn:0},{kind:"allow"}),
      stderr:"context-mode HTTP hook unavailable; allowed"},raw,agent,identity.toolPrefix);
  }
}

export async function hookMain(argv: string[]): Promise<void> {
  const config = JSON.parse(readFileSync(argv[0]!,"utf8")).contextMode as HookHttpConfig;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const out = await forwardHook(config,argv[1]!,JSON.parse(text),argv[2] as AgentId | undefined);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr + "\n");
  process.exitCode = out.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {await hookMain(process.argv.slice(2));}
  catch {process.stderr.write("context-mode HTTP hook configuration/input is invalid\n");process.exitCode=0;}
}
