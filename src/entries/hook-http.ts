// One-shot native hook forwarder. It never opens a store or starts a stdio server.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAdapter } from "../adapters/table.ts";
import { failureOutput } from "../core/hooks/fallback.ts";
import type { AgentId, HookOutput } from "../core/contracts/types.ts";

export interface HookHttpConfig {
  host: string; port: number; path: string; tenantHeader: string; hookTimeoutMs: number;
  tenants: Record<string,{agent:AgentId;toolPrefix?:string;hookAdapters?:Record<string,{toolPrefix?:string}>}>;
}

export async function forwardHook(config: HookHttpConfig, tenant: string, raw: unknown, adapter?: AgentId): Promise<HookOutput> {
  const identity = config.tenants[tenant];
  if (!identity || !config.tenantHeader || !(config.hookTimeoutMs > 0)) throw new Error("invalid HTTP hook configuration");
  const agent = adapter ?? identity.agent;
  if (agent !== identity.agent && !Object.hasOwn(identity.hookAdapters ?? {},agent)) throw new Error("unknown HTTP hook adapter");
  const toolPrefix = identity.hookAdapters?.[agent]?.toolPrefix ?? identity.toolPrefix;
  try {
    const response = await fetch(`http://${config.host}:${config.port}${config.path}/hooks`,{
      method:"POST",headers:{"Content-Type":"application/json",[config.tenantHeader]:tenant},
      body:JSON.stringify({adapter:agent,raw}),signal:AbortSignal.timeout(config.hookTimeoutMs),
    });
    if (!response.ok) throw new Error("HTTP hook status " + response.status);
    const out = await response.json() as HookOutput;
    if (typeof out.stdout !== "string" || (out.exitCode !== 0 && out.exitCode !== 2) || (out.stderr !== undefined && typeof out.stderr !== "string")) throw new Error("invalid native hook response");
    return out;
  } catch (err) {
    // Reuse upstream's existing failure policy rather than inventing a local allow path.
    const out = failureOutput(agent,raw,err);
    const oldPrefix = getAdapter(agent).toolNamePrefix;
    return {...out,stdout:toolPrefix && oldPrefix ? out.stdout.replaceAll(oldPrefix,toolPrefix) : out.stdout,
      stderr:"context-mode HTTP hook unavailable; upstream failure policy applied"};
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
