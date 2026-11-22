// Pooled worker_threads runner for the shared HTTP server.
// Runs MCP tools and hooks off the HTTP listener event loop so /healthz and fast hook checks
// never stall behind synchronous SQLite, file indexing, or sandbox work. Also coordinates a
// per-database FIFO write lease so at most one worker writes to a given SQLite file at a time,
// and loudly logs + replaces any worker that crashes or exits unexpectedly.
import { Worker } from "node:worker_threads";
import type { AgentId, HookOutput, ToolReply } from "../core/contracts/types.ts";
import type { ProjectSourceInput } from "../core/project/resolve.ts";
import type { ExcerptBand } from "../core/store/http-scope.ts";

/** The worker resolves the project itself from `source`: a resolved ProjectContext has lazy getters, and
 * structured-cloning it would run its `git worktree list` (about 180 ms of event loop) for a field most calls never read. */
export interface ToolJob {
  tool: string; args: unknown; tenant: string; database: string; toolPrefix?: string;
  agent: AgentId; source: ProjectSourceInput; sessionId: string; protocolVersion: string;
  /** Write the ownCallRow journal event inside the worker after the tool finishes. Default true. */
  journal?: boolean;
  /** Test seam: the worker blocks this long before it starts. */
  stallMs?: number;
}
export type SearchJob = ToolJob;

export interface HookJob {
  adapter: AgentId; raw: unknown; env: NodeJS.ProcessEnv;
  tenant: string; database: string; toolPrefix?: string;
  /** T1011: per-tool inline limit in bytes, from the contextMode table. */
  inlineLimits?: Readonly<Record<string, number>>;
  /** T1021: per-tool middle band (excerpts plus the pointer), from the contextMode table. */
  excerptBands?: Readonly<Record<string, ExcerptBand>>;
}

export type WorkerOutcome<Reply> = { kind: "reply"; reply: Reply } | { kind: "timeout"; started: boolean } | { kind: "failed"; message: string };
export type WorkerMessage = { id: number; reply: ToolReply | HookOutput } | { id: number; error: string };
export type WriteLockMessage =
  | { __cmWriteLock: "acquire"; database: string; seq: number }
  | { __cmWriteLock: "release"; database: string };
export const SEARCH_WORKER_ROLE = "context-mode-search";

export interface PoolOptions {
  coordinator?: WriteCoordinator;
  onWorker?: (worker: Worker, pool: string) => void;
}

interface Waiter {
  worker: Worker;
  signal: Int32Array;
  seq: number;
}

interface DbLockState {
  holder: Worker | null;
  queue: Waiter[];
}

/** Coordinates strict single-writer FIFO access per SQLite database path across all worker pools.
 *  If a holding worker crashes or is terminated, `releaseWorker` immediately frees the lease. */
export class WriteCoordinator {
  private readonly locks = new Map<string, DbLockState>();
  private closed = false;

  handle(worker: Worker, signal: Int32Array, msg: WriteLockMessage): void {
    if (msg.__cmWriteLock === "acquire") {
      if (this.closed) {
        Atomics.store(signal, 0, 2);
        Atomics.notify(signal, 0, 1);
        return;
      }
      let state = this.locks.get(msg.database);
      if (state === undefined) {
        state = { holder: null, queue: [] };
        this.locks.set(msg.database, state);
      }
      if (state.holder === null) {
        state.holder = worker;
        Atomics.store(signal, 1, msg.seq);
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0, 1);
      } else {
        state.queue.push({ worker, signal, seq: msg.seq });
      }
      return;
    }
    const state = this.locks.get(msg.database);
    if (state !== undefined && state.holder === worker) {
      this.grantNext(msg.database, state);
    }
  }

  releaseWorker(worker: Worker): void {
    for (const [database, state] of this.locks) {
      if (state.queue.length > 0) {
        state.queue = state.queue.filter((w) => w.worker !== worker);
      }
      if (state.holder === worker) {
        this.grantNext(database, state);
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const state of this.locks.values()) {
      for (const waiter of state.queue.splice(0)) {
        Atomics.store(waiter.signal, 0, 2);
        Atomics.notify(waiter.signal, 0, 1);
      }
      state.holder = null;
    }
    this.locks.clear();
  }

  private grantNext(database: string, state: DbLockState): void {
    const next = state.queue.shift();
    if (next === undefined) {
      state.holder = null;
      this.locks.delete(database);
      return;
    }
    state.holder = next.worker;
    Atomics.store(next.signal, 1, next.seq);
    Atomics.store(next.signal, 0, 1);
    Atomics.notify(next.signal, 0, 1);
  }
}

interface Slot<Job, Reply> {
  worker: Worker;
  threadId: number;
  signal: Int32Array;
  job: Pending<Job, Reply> | null;
  online: boolean;
  retiring: boolean;
  lastError: string | null;
}

interface Pending<Job, Reply> {
  id: number;
  job: Job;
  resolve(outcome: WorkerOutcome<Reply>): void;
  timer: NodeJS.Timeout;
  slot: Slot<Job, Reply> | null;
}

function isWriteLockMessage(value: unknown): value is WriteLockMessage {
  return typeof value === "object" && value !== null && "__cmWriteLock" in value;
}

export class RequestPool<Job extends ToolJob | HookJob, Reply extends ToolReply | HookOutput> {
  private readonly idle: Slot<Job, Reply>[] = [];
  private readonly busy = new Set<Slot<Job, Reply>>();
  /** Terminated workers whose thread has not exited yet; they still count against `size`. */
  private readonly leaving = new Set<Worker>();
  private queue: Pending<Job, Reply>[] = [];
  private next = 1;
  private closed = false;

  private readonly entry: string;
  private readonly size: number;
  private readonly name: string;
  private readonly coordinator: WriteCoordinator | undefined;
  private readonly onWorker: ((worker: Worker, pool: string) => void) | undefined;

  constructor(entry: string, size: number, name = "search", options: PoolOptions = {}) {
    this.entry = entry;
    this.size = size;
    this.name = name;
    this.coordinator = options.coordinator;
    this.onWorker = options.onWorker;
  }

  /** Pre-spawns up to `count` idle workers (capped at `size`) so the first latency-sensitive call avoids cold load. */
  warm(count: number): void {
    if (this.closed) return;
    const target = Math.min(this.size, Math.max(0, Math.floor(count)));
    while (this.liveCount() < target) {
      this.idle.push(this.spawn());
    }
  }

  /** The budget starts now, so time spent waiting for a free worker is part of it. */
  run(job: Job, budgetMs: number): Promise<WorkerOutcome<Reply>> {
    if (this.closed) return Promise.resolve({ kind: "failed", message: this.name + " pool closed" });
    return new Promise((resolve) => {
      const pending: Pending<Job, Reply> = { id: this.next++, job, resolve, slot: null, timer: setTimeout(() => this.expire(pending), budgetMs) };
      this.queue.push(pending);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "failed", message: this.name + " pool closed" });
    }
    const slots = [...this.idle, ...this.busy];
    for (const slot of slots) {
      slot.retiring = true;
      if (slot.job) { clearTimeout(slot.job.timer); slot.job.resolve({ kind: "failed", message: this.name + " pool closed" }); slot.job = null; }
    }
    this.idle.length = 0;
    this.busy.clear();
    await Promise.allSettled([...slots.map((s) => s.worker), ...this.leaving].map((w) => w.terminate()));
  }

  private liveCount(): number {
    return this.idle.length + this.busy.size + this.leaving.size;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.idle.pop();
      if (slot === undefined) {
        if (this.liveCount() >= this.size) return;
        slot = this.spawn();
      }
      const pending = this.queue.shift()!;
      pending.slot = slot;
      slot.job = pending;
      this.busy.add(slot);
      slot.worker.postMessage({ id: pending.id, job: pending.job });
    }
  }

  private spawn(): Slot<Job, Reply> {
    const sab = new SharedArrayBuffer(8);
    const signal = new Int32Array(sab);
    const worker = new Worker(this.entry, { workerData: { role: SEARCH_WORKER_ROLE, pool: this.name, writeSignal: sab } });
    const slot: Slot<Job, Reply> = { worker, threadId: worker.threadId, signal, job: null, online: false, retiring: false, lastError: null };
    this.onWorker?.(worker, this.name);
    worker.on("online", () => { slot.online = true; });
    worker.on("message", (message: WorkerMessage | WriteLockMessage) => {
      if (isWriteLockMessage(message)) {
        this.coordinator?.handle(worker, signal, message);
        return;
      }
      const pending = slot.job;
      if (pending === null || pending.id !== message.id) return;
      clearTimeout(pending.timer);
      slot.job = null;
      this.busy.delete(slot);
      this.idle.push(slot);
      pending.resolve("error" in message ? { kind: "failed", message: message.error } : { kind: "reply", reply: message.reply as Reply });
      this.pump();
    });
    worker.on("error", (error) => {
      slot.lastError = error.message;
      if (!this.closed && !slot.retiring) {
        console.error(JSON.stringify({
          event: "worker_error",
          pool: this.name,
          threadId: slot.threadId,
          inFlightJobId: slot.job?.id ?? null,
          error: error.message,
        }));
      }
      this.lose(slot, error.message);
    });
    worker.on("exit", (code) => {
      this.coordinator?.releaseWorker(worker);
      const wasLeaving = this.leaving.delete(worker);
      const intentional = this.closed || slot.retiring || wasLeaving;
      const inFlightJobId = slot.job?.id ?? null;
      const reason = slot.lastError ?? `${this.name} worker exited (code ${code})`;
      this.lose(slot, reason);
      if (!intentional) {
        console.error(JSON.stringify({
          event: "worker_crash",
          pool: this.name,
          threadId: slot.threadId,
          exitCode: code,
          inFlightJobId,
          reason,
        }));
        if (slot.online && !this.closed && this.liveCount() < this.size) {
          const replacement = this.spawn();
          this.idle.push(replacement);
          console.error(JSON.stringify({
            event: "worker_replaced",
            pool: this.name,
            oldThreadId: slot.threadId,
            newThreadId: replacement.threadId,
          }));
        }
      }
      if (!this.closed) this.pump();
    });
    return slot;
  }

  private lose(slot: Slot<Job, Reply>, message: string): void {
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

  private expire(pending: Pending<Job, Reply>): void {
    const slot = pending.slot;
    if (slot === null) {
      this.queue = this.queue.filter((p) => p !== pending);
      pending.resolve({ kind: "timeout", started: false });
      return;
    }
    // Answer first, then retire the worker: terminate() cannot take effect inside a running SQLite statement.
    slot.retiring = true;
    slot.job = null;
    this.busy.delete(slot);
    this.leaving.add(slot.worker);
    pending.resolve({ kind: "timeout", started: true });
    void slot.worker.terminate();
  }
}

export const SearchPool = RequestPool;
