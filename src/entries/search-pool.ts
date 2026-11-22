// Pooled worker_threads runner for the shared HTTP server.
// Runs MCP tools and hooks off the HTTP listener event loop so /healthz and fast hook checks
// never stall behind synchronous SQLite, file indexing, or sandbox work. Also coordinates a
// single-database FIFO write mutex, forwards cancellation to per-job AbortControllers with a
// parent-owned child-tree kill fallback, cleans up abandoned pending sources on worker exit,
// and bounds worker restarts with readiness acks, backoff, and once-per-outage logging.
import { Worker } from "node:worker_threads";
import type { AgentId, HookOutput, ToolReply } from "../core/contracts/types.ts";
import type { ProjectSourceInput } from "../core/project/resolve.ts";
import type { ExcerptBand } from "../core/store/http-scope.ts";
import { killTree } from "../core/sandbox/kill.ts";

/** Hard ceiling for any single RequestPool size. */
export const MAX_POOL_WORKERS = 32;

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 250;
const RESTART_BACKOFF_MAX_MS = 30_000;
const CANCEL_CHILD_GRACE_MS = 1500;
const CANCEL_SYNC_GRACE_MS = 100;
const CLEANUP_TIMEOUT_MS = 10_000;

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

export interface CleanupJob {
  __cmCleanupSources: true;
  database: string;
  sourceIds: number[];
}

export type WorkerOutcome<Reply> = { kind: "reply"; reply: Reply } | { kind: "timeout"; started: boolean } | { kind: "failed"; message: string };
export type WorkerMessage =
  | { id: number; reply: ToolReply | HookOutput }
  | { id: number; error: string }
  | { id: number; cancelled: true };
export type WriteLockMessage =
  | { __cmWriteLock: "acquire"; database?: string; seq?: number }
  | { __cmWriteLock: "release"; database?: string };
type PendingSourceMessage =
  | { __cmPendingSource: "add"; database: string; sourceId: number }
  | { __cmPendingSource: "done"; database: string; sourceId: number };
type ChildPidMessage =
  | { __cmChildPid: "add"; pid: number }
  | { __cmChildPid: "remove"; pid: number };
type ReadyMessage = { __cmReady: true };
type InboundWorkerMessage = WorkerMessage | WriteLockMessage | PendingSourceMessage | ChildPidMessage | ReadyMessage;

export const SEARCH_WORKER_ROLE = "context-mode-search";

export interface PoolOptions {
  coordinator?: WriteCoordinator;
  onWorker?: (worker: Worker, pool: string) => void;
}

interface Waiter {
  worker: Worker;
  signal: Int32Array;
}

/** Simple single-database FIFO write mutex across all worker pools sharing the HTTP store.
 *  One owner, one FIFO queue, one wake word. If the holding worker exits, `releaseWorker` frees the lease. */
export class WriteCoordinator {
  private holder: Worker | null = null;
  private queue: Waiter[] = [];
  private closed = false;

  handle(worker: Worker, signal: Int32Array, msg: WriteLockMessage): void {
    if (msg.__cmWriteLock === "acquire") {
      if (this.closed) {
        Atomics.store(signal, 0, 2);
        Atomics.notify(signal, 0, 1);
        return;
      }
      if (this.holder === null) {
        this.holder = worker;
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0, 1);
      } else {
        this.queue.push({ worker, signal });
      }
      return;
    }
    if (this.holder === worker) {
      this.grantNext();
    }
  }

  releaseWorker(worker: Worker): void {
    if (this.queue.length > 0) {
      this.queue = this.queue.filter((w) => w.worker !== worker);
    }
    if (this.holder === worker) {
      this.grantNext();
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      Atomics.store(waiter.signal, 0, 2);
      Atomics.notify(waiter.signal, 0, 1);
    }
    this.holder = null;
  }

  private grantNext(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.holder = null;
      return;
    }
    this.holder = next.worker;
    Atomics.store(next.signal, 0, 1);
    Atomics.notify(next.signal, 0, 1);
  }
}

interface Slot<Job, Reply> {
  worker: Worker;
  threadId: number;
  signal: Int32Array | null;
  job: Pending<Job, Reply> | null;
  ready: boolean;
  retiring: boolean;
  errored: boolean;
  lastError: string | null;
  childPids: Set<number>;
  pendingSources: Map<number, string>;
}

interface Pending<Job, Reply> {
  id: number;
  job: Job | CleanupJob;
  resolve(outcome: WorkerOutcome<Reply>): void;
  timer: NodeJS.Timeout;
  cancelTimer: NodeJS.Timeout | null;
  slot: Slot<Job, Reply> | null;
  timedOut: boolean;
  cancelled: boolean;
  abortCleanup: (() => void) | null;
}

function isWriteLockMessage(value: unknown): value is WriteLockMessage {
  return typeof value === "object" && value !== null && "__cmWriteLock" in value;
}

function isPendingSourceMessage(value: unknown): value is PendingSourceMessage {
  return typeof value === "object" && value !== null && "__cmPendingSource" in value;
}

function isChildPidMessage(value: unknown): value is ChildPidMessage {
  return typeof value === "object" && value !== null && "__cmChildPid" in value;
}

function isReadyMessage(value: unknown): value is ReadyMessage {
  return typeof value === "object" && value !== null && "__cmReady" in value;
}

export class RequestPool<Job extends ToolJob | HookJob, Reply extends ToolReply | HookOutput> {
  private readonly idle: Slot<Job, Reply>[] = [];
  private readonly busy = new Set<Slot<Job, Reply>>();
  /** Retiring or errored workers whose thread has not exited yet; they still count against `size`. */
  private readonly leaving = new Set<Worker>();
  private queue: Pending<Job, Reply>[] = [];
  private readonly restartTimers = new Set<NodeJS.Timeout>();
  private next = 1;
  private closed = false;
  private consecutiveFailures = 0;
  private outageLogged = false;
  private lastFailureReason: string | null = null;

  private readonly entry: string;
  private readonly size: number;
  private readonly name: string;
  private readonly coordinator: WriteCoordinator | undefined;
  private readonly onWorker: ((worker: Worker, pool: string) => void) | undefined;

  constructor(entry: string, size: number, name = "search", options: PoolOptions = {}) {
    if (!Number.isInteger(size) || size < 1 || size > MAX_POOL_WORKERS) {
      throw new Error(`invalid ${name} pool size: ${size} (expected integer 1..${MAX_POOL_WORKERS})`);
    }
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
      const slot = this.trySpawn();
      if (slot === null) break;
      this.idle.push(slot);
    }
  }

  /** The budget starts now, so time spent waiting for a free worker is part of it. */
  run(job: Job, budgetMs: number, signal?: AbortSignal): Promise<WorkerOutcome<Reply>> {
    if (this.closed) return Promise.resolve({ kind: "failed", message: this.name + " pool closed" });
    if (signal?.aborted) return Promise.resolve({ kind: "failed", message: "Cancelled." });
    return this.enqueue(job, budgetMs, signal, false);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    for (const pending of this.queue.splice(0)) {
      this.clearTimers(pending);
      pending.resolve({ kind: "failed", message: this.name + " pool closed" });
    }
    const slots = [...this.idle, ...this.busy];
    for (const slot of slots) {
      slot.retiring = true;
      this.killTrackedChildren(slot);
      if (slot.job) {
        this.clearTimers(slot.job);
        slot.job.resolve({ kind: "failed", message: this.name + " pool closed" });
        slot.job = null;
      }
    }
    this.idle.length = 0;
    this.busy.clear();
    await Promise.allSettled([...slots.map((s) => s.worker), ...this.leaving].map((w) => w.terminate()));
  }

  private enqueue(job: Job | CleanupJob, budgetMs: number, signal: AbortSignal | undefined, front: boolean): Promise<WorkerOutcome<Reply>> {
    return new Promise((resolve) => {
      const pending: Pending<Job, Reply> = {
        id: this.next++,
        job,
        resolve,
        timer: setTimeout(() => this.expire(pending), budgetMs),
        cancelTimer: null,
        slot: null,
        timedOut: false,
        cancelled: false,
        abortCleanup: null,
      };
      if (signal !== undefined) {
        const onAbort = (): void => this.abortPending(pending);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      if (front) this.queue.unshift(pending);
      else this.queue.push(pending);
      this.pump();
    });
  }

  private liveCount(): number {
    return this.idle.length + this.busy.size + this.leaving.size;
  }

  private clearTimers(pending: Pending<Job, Reply>): void {
    clearTimeout(pending.timer);
    if (pending.cancelTimer !== null) {
      clearTimeout(pending.cancelTimer);
      pending.cancelTimer = null;
    }
    pending.abortCleanup?.();
    pending.abortCleanup = null;
  }

  private killTrackedChildren(slot: Slot<Job, Reply>): void {
    for (const pid of slot.childPids) killTree(pid);
    slot.childPids.clear();
  }

  private failQueued(message: string): void {
    for (const pending of this.queue.splice(0)) {
      this.clearTimers(pending);
      pending.resolve({ kind: "failed", message });
    }
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.idle.pop();
      if (slot === undefined) {
        if (this.liveCount() >= this.size) return;
        const spawned = this.trySpawn();
        if (spawned === null) {
          if (this.liveCount() === 0) {
            this.failQueued(this.lastFailureReason ?? `${this.name} worker failed to start`);
          }
          return;
        }
        slot = spawned;
      }
      const pending = this.queue.shift()!;
      pending.slot = slot;
      slot.job = pending;
      this.busy.add(slot);
      try {
        slot.worker.postMessage({ id: pending.id, job: pending.job });
      } catch (err) {
        const message = err instanceof Error ? err.message : `${this.name} worker postMessage failed`;
        this.clearTimers(pending);
        slot.job = null;
        this.busy.delete(slot);
        pending.resolve({ kind: "failed", message });
      }
    }
  }

  private trySpawn(): Slot<Job, Reply> | null {
    let sab: SharedArrayBuffer | undefined;
    let signal: Int32Array | null = null;
    let worker: Worker;
    try {
      if (this.coordinator !== undefined) {
        sab = new SharedArrayBuffer(4);
        signal = new Int32Array(sab);
      }
      worker = new Worker(this.entry, {
        workerData: {
          role: SEARCH_WORKER_ROLE,
          pool: this.name,
          ...(sab !== undefined ? { writeSignal: sab } : {}),
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.consecutiveFailures += 1;
      this.lastFailureReason = reason;
      if (!this.closed && !this.outageLogged) {
        this.outageLogged = true;
        console.error(JSON.stringify({
          event: "worker_spawn_failed",
          pool: this.name,
          error: reason,
        }));
      }
      return null;
    }

    const slot: Slot<Job, Reply> = {
      worker,
      threadId: worker.threadId,
      signal,
      job: null,
      ready: false,
      retiring: false,
      errored: false,
      lastError: null,
      childPids: new Set(),
      pendingSources: new Map(),
    };
    this.onWorker?.(worker, this.name);

    worker.on("message", (message: InboundWorkerMessage) => {
      if (isReadyMessage(message)) {
        slot.ready = true;
        return;
      }
      // Custom test workers that do not send __cmReady still prove initialization once they emit any protocol message.
      slot.ready = true;
      if (isWriteLockMessage(message)) {
        if (signal !== null) this.coordinator?.handle(worker, signal, message);
        return;
      }
      if (isPendingSourceMessage(message)) {
        if (message.__cmPendingSource === "add") slot.pendingSources.set(message.sourceId, message.database);
        else slot.pendingSources.delete(message.sourceId);
        return;
      }
      if (isChildPidMessage(message)) {
        if (message.__cmChildPid === "add") slot.childPids.add(message.pid);
        else slot.childPids.delete(message.pid);
        return;
      }
      const pending = slot.job;
      if (pending === null || pending.id !== message.id) return;
      this.clearTimers(pending);
      slot.job = null;
      this.busy.delete(slot);
      if (!this.closed && !slot.retiring && !slot.errored) {
        this.idle.push(slot);
        this.consecutiveFailures = 0;
        this.outageLogged = false;
        this.lastFailureReason = null;
      }
      if (pending.timedOut) {
        pending.resolve({ kind: "timeout", started: true });
      } else if (pending.cancelled || "cancelled" in message) {
        pending.resolve({ kind: "failed", message: "Cancelled." });
      } else if ("error" in message) {
        pending.resolve({ kind: "failed", message: message.error });
      } else {
        pending.resolve({ kind: "reply", reply: message.reply as Reply });
      }
      if (!this.closed) this.pump();
    });

    worker.on("error", (error) => {
      slot.lastError = error.message;
      slot.errored = true;
      // Keep errored slots counted in `leaving` through `exit`, when their write lease is released.
      this.leaving.add(worker);
      this.busy.delete(slot);
      const at = this.idle.indexOf(slot);
      if (at >= 0) this.idle.splice(at, 1);
    });

    worker.on("exit", (code) => {
      this.coordinator?.releaseWorker(worker);
      this.leaving.delete(worker);
      this.busy.delete(slot);
      const at = this.idle.indexOf(slot);
      if (at >= 0) this.idle.splice(at, 1);

      // Parent-owned fallback: if the worker died while sandbox children were alive, terminate their trees.
      this.killTrackedChildren(slot);

      const intentional = this.closed || slot.retiring;
      const pending = slot.job;
      slot.job = null;
      const inFlightJobId = pending?.id ?? null;
      const reason = slot.lastError ?? `${this.name} worker exited (code ${code})`;
      const abandoned = [...slot.pendingSources.entries()];
      slot.pendingSources.clear();

      const resolvePending = (): void => {
        if (pending === null) return;
        this.clearTimers(pending);
        pending.resolve(pending.timedOut ? { kind: "timeout", started: true } : { kind: "failed", message: reason });
      };

      if (!intentional) {
        this.consecutiveFailures += 1;
        this.lastFailureReason = reason;
        if (!slot.ready) {
          // Startup failure: log once per outage and never spin an idle restart loop.
          if (!this.outageLogged) {
            this.outageLogged = true;
            console.error(JSON.stringify({
              event: "worker_outage",
              pool: this.name,
              threadId: slot.threadId,
              exitCode: code,
              inFlightJobId,
              reason,
              startupFailure: true,
            }));
          }
          if (this.queue.length > 0) {
            if (this.consecutiveFailures >= MAX_RESTART_ATTEMPTS) {
              this.failQueued(reason);
            } else {
              this.scheduleBackoffPump(this.consecutiveFailures);
            }
          }
        } else if (this.consecutiveFailures === 1) {
          // Single runtime crash of a ready worker: log loudly and proactively replace it immediately.
          console.error(JSON.stringify({
            event: "worker_crash",
            pool: this.name,
            threadId: slot.threadId,
            exitCode: code,
            inFlightJobId,
            reason,
          }));
          if (!this.closed && this.liveCount() < this.size) {
            const replacement = this.trySpawn();
            if (replacement !== null) {
              this.idle.push(replacement);
              console.error(JSON.stringify({
                event: "worker_replaced",
                pool: this.name,
                oldThreadId: slot.threadId,
                newThreadId: replacement.threadId,
              }));
            }
          }
        } else {
          // Repeated crashes: log once per outage and cap/back off replacements.
          if (!this.outageLogged) {
            this.outageLogged = true;
            console.error(JSON.stringify({
              event: "worker_outage",
              pool: this.name,
              threadId: slot.threadId,
              exitCode: code,
              inFlightJobId,
              reason,
              consecutiveFailures: this.consecutiveFailures,
            }));
          }
          if (this.consecutiveFailures <= MAX_RESTART_ATTEMPTS && !this.closed && this.liveCount() < this.size) {
            this.scheduleBackoffReplace(this.consecutiveFailures - 1);
          } else if (this.queue.length > 0 && this.liveCount() === 0) {
            this.failQueued(reason);
          }
        }
      }

      if (abandoned.length > 0 && !this.closed) {
        void this.cleanupAbandoned(abandoned).finally(resolvePending);
      } else {
        resolvePending();
      }

      if (!this.closed && (intentional || (slot.ready && this.consecutiveFailures <= 1))) {
        this.pump();
      }
    });

    return slot;
  }

  private scheduleBackoffPump(attempt: number): void {
    const delayMs = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)));
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      if (!this.closed) this.pump();
    }, delayMs);
    timer.unref();
    this.restartTimers.add(timer);
  }

  private scheduleBackoffReplace(attempt: number): void {
    const delayMs = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)));
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      if (this.closed || this.liveCount() >= this.size) return;
      const replacement = this.trySpawn();
      if (replacement !== null) {
        this.idle.push(replacement);
        this.pump();
      }
    }, delayMs);
    timer.unref();
    this.restartTimers.add(timer);
  }

  private async cleanupAbandoned(entries: ReadonlyArray<[number, string]>): Promise<void> {
    const byDb = new Map<string, number[]>();
    for (const [sourceId, database] of entries) {
      let ids = byDb.get(database);
      if (ids === undefined) {
        ids = [];
        byDb.set(database, ids);
      }
      ids.push(sourceId);
    }
    const tasks: Promise<unknown>[] = [];
    for (const [database, sourceIds] of byDb) {
      tasks.push(this.enqueue({ __cmCleanupSources: true, database, sourceIds }, CLEANUP_TIMEOUT_MS, undefined, true));
    }
    await Promise.allSettled(tasks);
  }

  private abortPending(pending: Pending<Job, Reply>): void {
    if (pending.timedOut || pending.cancelled) return;
    pending.cancelled = true;
    const slot = pending.slot;
    if (slot === null) {
      this.queue = this.queue.filter((p) => p !== pending);
      this.clearTimers(pending);
      pending.resolve({ kind: "failed", message: "Cancelled." });
      return;
    }
    clearTimeout(pending.timer);
    this.beginCancel(slot, pending);
  }

  private expire(pending: Pending<Job, Reply>): void {
    if (pending.timedOut || pending.cancelled) return;
    pending.timedOut = true;
    const slot = pending.slot;
    if (slot === null) {
      this.queue = this.queue.filter((p) => p !== pending);
      this.clearTimers(pending);
      pending.resolve({ kind: "timeout", started: false });
      return;
    }
    this.beginCancel(slot, pending);
  }

  private beginCancel(slot: Slot<Job, Reply>, pending: Pending<Job, Reply>): void {
    if (pending.cancelTimer !== null) return;
    try {
      slot.worker.postMessage({ __cmCancel: pending.id });
    } catch {
      this.forceRetire(slot, pending);
      return;
    }
    const graceMs = slot.childPids.size > 0 ? CANCEL_CHILD_GRACE_MS : CANCEL_SYNC_GRACE_MS;
    pending.cancelTimer = setTimeout(() => this.forceRetire(slot, pending), graceMs);
  }

  private forceRetire(slot: Slot<Job, Reply>, pending: Pending<Job, Reply>): void {
    pending.cancelTimer = null;
    if (slot.job !== pending) return;
    // Worker did not finish graceful cancel in time (e.g. blocked inside native SQLite):
    // kill any tracked sandbox children from the parent, reply now, and terminate the thread.
    this.clearTimers(pending);
    slot.retiring = true;
    slot.job = null;
    this.busy.delete(slot);
    this.leaving.add(slot.worker);
    this.killTrackedChildren(slot);
    pending.resolve(pending.timedOut ? { kind: "timeout", started: true } : { kind: "failed", message: "Cancelled." });
    void slot.worker.terminate();
  }
}

export const SearchPool = RequestPool;
