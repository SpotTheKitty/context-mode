// The HTTP entry loads this in each request worker, away from the listener and /healthz.
import { parentPort, workerData } from "node:worker_threads";
import { TOOLS } from "../core/tools/registry.ts";
import { httpScope, registerHttpWriteLock, settleHttpScope } from "../core/store/http-scope.ts";
import { closeDb, openDb } from "../core/store/db.ts";
import { appendEvent, ownCallRow } from "../core/journal/append.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { handleHook } from "../core/hooks/dispatch.ts";
import type { ToolContext, ToolReply } from "../core/contracts/types.ts";
import type { HookJob, ToolJob, WorkerMessage } from "./search-pool.ts";

/** Blocks the calling thread the way a long native SQLite statement does. Test seam for `ToolJob.stallMs`. */
export function stallSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function runToolJob(job: ToolJob, signal: AbortSignal): Promise<ToolReply> {
  const tool = TOOLS.find((t) => t.name === job.tool);
  if (tool === undefined) throw new Error("unknown tool " + job.tool);
  return await httpScope.run({ tenant: job.tenant, database: job.database, toolPrefix: job.toolPrefix }, async () => {
    try {
      const project = resolveProject(job.agent, job.source);
      const ctx: ToolContext = { project, sessionId: job.sessionId, turn: 0, signal, protocolVersion: job.protocolVersion };
      const reply = await tool.handler(job.args as never, ctx);
      if (job.journal !== false) {
        const db = await openDb(project);
        try { appendEvent(db, ownCallRow(project, ctx, tool.name, reply)); } finally { closeDb(db); }
      }
      return reply;
    } finally {
      await settleHttpScope();
    }
  });
}

export const runSearchJob = runToolJob;

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
  if (port === null) throw new Error("request worker started without a parent port");
  const data = workerData as { writeSignal?: SharedArrayBuffer } | null;
  if (data?.writeSignal instanceof SharedArrayBuffer) {
    const view = new Int32Array(data.writeSignal);
    let seq = 0;
    registerHttpWriteLock({
      acquire(database: string): void {
        seq = (seq + 1) | 0;
        Atomics.store(view, 0, 0);
        port.postMessage({ __cmWriteLock: "acquire", database, seq });
        while (Atomics.load(view, 0) === 0) {
          Atomics.wait(view, 0, 0, 1000);
        }
        if (Atomics.load(view, 0) === 2) {
          throw new Error("HTTP write coordinator closed");
        }
      },
      release(database: string): void {
        Atomics.store(view, 0, 0);
        port.postMessage({ __cmWriteLock: "release", database });
      },
    });
  }
  const signal = new AbortController().signal;
  port.on("message", ({ id, job }: { id: number; job: ToolJob | HookJob }) => {
    void (async () => {
      let answer: WorkerMessage;
      try {
        if ("adapter" in job) {
          answer = { id, reply: await runHookJob(job) };
        } else {
          stallSync(job.stallMs ?? 0);
          answer = { id, reply: await runToolJob(job, signal) };
        }
      } catch (e) {
        answer = { id, error: e instanceof Error ? e.message : "context-mode request failed" };
      }
      port.postMessage(answer);
    })();
  });
}
