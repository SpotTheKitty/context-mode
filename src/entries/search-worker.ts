// T230: the worker-thread side of SearchPool. It runs a tool handler for one tenant request, exactly as
// the request path does, and posts the reply back. The entry file loads this when it is started as a worker.
import { parentPort } from "node:worker_threads";
import { TOOLS } from "../core/tools/registry.ts";
import { httpScope, settleHttpScope } from "../core/store/http-scope.ts";
import { resolveProject } from "../core/project/resolve.ts";
import type { ToolContext, ToolReply } from "../core/contracts/types.ts";
import type { SearchJob, SearchWorkerMessage } from "./search-pool.ts";

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

export function serveSearchWorker(): void {
  const port = parentPort;
  if (port === null) throw new Error("search worker started without a parent port");
  const signal = new AbortController().signal;
  port.on("message", (message: { id: number; job: SearchJob }) => {
    void (async () => {
      let answer: SearchWorkerMessage;
      try {
        stallSync(message.job.stallMs ?? 0);
        answer = { id: message.id, reply: await runSearchJob(message.job, signal) };
      } catch (e) {
        answer = { id: message.id, error: e instanceof Error ? e.message : "search failed" };
      }
      port.postMessage(answer);
    })();
  });
}
