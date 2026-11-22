// The HTTP entry loads this in each request worker, away from the listener and /healthz.
import { parentPort } from "node:worker_threads";
import { TOOLS } from "../core/tools/registry.ts";
import { httpScope, settleHttpScope } from "../core/store/http-scope.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { handleHook } from "../core/hooks/dispatch.ts";
import type { ToolContext, ToolReply } from "../core/contracts/types.ts";
import type { HookJob, SearchJob, WorkerMessage } from "./search-pool.ts";

/** Blocks the calling thread the way a long native SQLite statement does. Test seam for `SearchJob.stallMs`. */
export function stallSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function runSearchJob(job: SearchJob, signal: AbortSignal): Promise<ToolReply> {
  const tool = TOOLS.find((t) => t.name === job.tool);
  if (tool === undefined) throw new Error("unknown tool " + job.tool);
  return await httpScope.run({ tenant: job.tenant, database: job.database, toolPrefix: job.toolPrefix }, async () => {
    try {
      const ctx: ToolContext = { project: resolveProject(job.agent, job.source), sessionId: job.sessionId, turn: 0, signal, protocolVersion: job.protocolVersion };
      return await tool.handler(job.args as never, ctx);
    } finally {
      await settleHttpScope();
    }
  });
}

function runHookJob(job: HookJob) {
  return httpScope.run({ tenant: job.tenant, database: job.database, toolPrefix: job.toolPrefix, inlineLimits: job.inlineLimits, excerptBands: job.excerptBands }, async () => {
    try {
      return await handleHook(job.adapter, job.raw, job.env);
    } finally {
      await settleHttpScope();
    }
  });
}

export function serveSearchWorker(): void {
  const port = parentPort;
  if (port === null) throw new Error("search worker started without a parent port");
  const signal = new AbortController().signal;
  port.on("message", ({ id, job }: { id: number; job: SearchJob | HookJob }) => {
    void (async () => {
      let answer: WorkerMessage;
      try {
        if ("adapter" in job) {
          answer = { id, reply: await runHookJob(job) };
        } else {
          stallSync(job.stallMs ?? 0);
          answer = { id, reply: await runSearchJob(job, signal) };
        }
      } catch (e) {
        answer = { id, error: e instanceof Error ? e.message : "context-mode request failed" };
      }
      port.postMessage(answer);
    })();
  });
}
