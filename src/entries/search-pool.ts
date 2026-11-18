// T230: bounded ctx_search for the shared HTTP server. A search is synchronous SQLite work; run on the
// request path it holds the one event loop, so /healthz and every other tenant wait with it. Here each
// search runs in a pooled worker thread under a deadline: past the budget the caller gets a timeout
// outcome at once, the worker is terminated, and the pool keeps counting the thread until it has exited
// (node:sqlite has no interrupt, so a statement already inside SQLite finishes before the thread can end).
import { Worker } from "node:worker_threads";
import type { AgentId, ToolReply } from "../core/contracts/types.ts";
import type { ProjectSourceInput } from "../core/project/resolve.ts";

/** The worker resolves the project itself from `source`: a resolved ProjectContext has lazy getters, and
 * structured-cloning it would run its `git worktree list` (about 180 ms of event loop) for a field a search never reads. */
export interface SearchJob {
  tool: string; args: unknown; tenant: string; database: string; toolPrefix?: string;
  agent: AgentId; source: ProjectSourceInput; sessionId: string; protocolVersion: string;
  /** Test seam: the worker blocks this long before it starts the search. */
  stallMs?: number;
}
/** started=false: the budget ran out while every worker was busy, so the search never began. */
export type SearchOutcome = { kind: "reply"; reply: ToolReply } | { kind: "timeout"; started: boolean } | { kind: "failed"; message: string };
export type SearchWorkerMessage = { id: number; reply: ToolReply } | { id: number; error: string };
export const SEARCH_WORKER_ROLE = "context-mode-search";

interface Slot { worker: Worker; job: Pending | null; }
interface Pending { id: number; job: SearchJob; resolve(outcome: SearchOutcome): void; timer: NodeJS.Timeout; slot: Slot | null; }

export class SearchPool {
  private readonly idle: Slot[] = [];
  private readonly busy = new Set<Slot>();
  /** Terminated workers whose thread has not exited yet; they still count against `size`. */
  private readonly leaving = new Set<Worker>();
  private queue: Pending[] = [];
  private next = 1;
  private closed = false;

  private readonly entry: string;
  private readonly size: number;

  constructor(entry: string, size: number) {
    this.entry = entry;
    this.size = size;
  }

  /** The budget starts now, so time spent waiting for a free worker is part of it. */
  run(job: SearchJob, budgetMs: number): Promise<SearchOutcome> {
    if (this.closed) return Promise.resolve({ kind: "failed", message: "search pool closed" });
    return new Promise((resolve) => {
      const pending: Pending = { id: this.next++, job, resolve, slot: null, timer: setTimeout(() => this.expire(pending), budgetMs) };
      this.queue.push(pending);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "failed", message: "search pool closed" });
    }
    const slots = [...this.idle, ...this.busy];
    for (const slot of slots) {
      if (slot.job) { clearTimeout(slot.job.timer); slot.job.resolve({ kind: "failed", message: "search pool closed" }); slot.job = null; }
    }
    this.idle.length = 0;
    this.busy.clear();
    await Promise.allSettled([...slots.map((s) => s.worker), ...this.leaving].map((w) => w.terminate()));
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.idle.pop();
      if (slot === undefined) {
        if (this.idle.length + this.busy.size + this.leaving.size >= this.size) return;
        slot = this.spawn();
      }
      const pending = this.queue.shift() as Pending;
      pending.slot = slot;
      slot.job = pending;
      this.busy.add(slot);
      slot.worker.postMessage({ id: pending.id, job: pending.job });
    }
  }

  private spawn(): Slot {
    const worker = new Worker(this.entry, { workerData: { role: SEARCH_WORKER_ROLE } });
    const slot: Slot = { worker, job: null };
    worker.on("message", (message: SearchWorkerMessage) => {
      const pending = slot.job;
      if (pending === null || pending.id !== message.id) return;
      clearTimeout(pending.timer);
      slot.job = null;
      this.busy.delete(slot);
      this.idle.push(slot);
      pending.resolve("error" in message ? { kind: "failed", message: message.error } : { kind: "reply", reply: message.reply });
      this.pump();
    });
    worker.on("error", (error) => this.lose(slot, error.message));
    worker.on("exit", () => {
      this.leaving.delete(worker);
      this.lose(slot, "search worker exited");
      if (!this.closed) this.pump();
    });
    return slot;
  }

  private lose(slot: Slot, message: string): void {
    const pending = slot.job;
    slot.job = null;
    this.busy.delete(slot);
    const at = this.idle.indexOf(slot);
    if (at >= 0) this.idle.splice(at, 1);
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "failed", message });
    }
  }

  private expire(pending: Pending): void {
    const slot = pending.slot;
    if (slot === null) {
      this.queue = this.queue.filter((p) => p !== pending);
      pending.resolve({ kind: "timeout", started: false });
      return;
    }
    // Answer first, then retire the worker: terminate() cannot take effect inside a running SQLite statement.
    slot.job = null;
    this.busy.delete(slot);
    this.leaving.add(slot.worker);
    pending.resolve({ kind: "timeout", started: true });
    void slot.worker.terminate();
  }
}
