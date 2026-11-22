import { AsyncLocalStorage } from "node:async_hooks";

/** T1021: a result above the tool's whole limit and up to `upToBytes` comes back as about `returnBytes` of excerpts plus the pointer. */
export interface ExcerptBand { upToBytes: number; returnBytes: number; }
export interface HttpScope { tenant: string; database: string; toolPrefix?: string; inlineLimits?: Readonly<Record<string, number>>; excerptBands?: Readonly<Record<string, ExcerptBand>>; pending?: Set<Promise<unknown>>; closers?: Set<() => void>; }
export const httpScope = new AsyncLocalStorage<HttpScope>();

interface WriteLockAdapter {
  acquire(): void;
  release(): void;
}

export interface PendingSourceTracker {
  add(database: string, sourceId: number): void;
  done(database: string, sourceId: number): void;
}

let writeLock: WriteLockAdapter | null = null;
let lockDepth = 0;
let pendingTracker: PendingSourceTracker | null = null;

/** Registers the single-database write mutex used by HTTP worker threads. */
export function registerHttpWriteLock(adapter: WriteLockAdapter | null): void {
  writeLock = adapter;
  lockDepth = 0;
}

/** Registers the pending-source reservation tracker used by HTTP worker threads. */
export function registerPendingSourceTracker(tracker: PendingSourceTracker | null): void {
  pendingTracker = tracker;
}

/** Records a newly reserved pending source on the parent coordinator so worker exit can clean it up. */
export function notifyPendingSourceAdd(database: string, sourceId: number): void {
  if (pendingTracker !== null && httpScope.getStore() !== undefined) pendingTracker.add(database, sourceId);
}

/** Clears a pending source reservation after it has been published or rolled back. */
export function notifyPendingSourceDone(database: string, sourceId: number): void {
  if (pendingTracker !== null && httpScope.getStore() !== undefined) pendingTracker.done(database, sourceId);
}

/** Runs `fn` while holding the HTTP process-wide write mutex. No-op outside an HTTP worker. */
export function withHttpWriteLock<T>(fn: () => T): T {
  if (writeLock === null || httpScope.getStore() === undefined) return fn();
  if (lockDepth === 0) writeLock.acquire();
  lockDepth += 1;
  try {
    return fn();
  } finally {
    lockDepth -= 1;
    if (lockDepth <= 0) {
      lockDepth = 0;
      writeLock.release();
    }
  }
}

export async function settleHttpScope(): Promise<void> {
  const scope = httpScope.getStore();
  if (!scope) return;
  do {
    await Promise.allSettled([...(scope.pending ?? [])]);
    // Hook writers attach .then handlers to openDb. Let those handlers (and any
    // subsequent opens) finish before closing their request-owned connections.
    await new Promise<void>(resolve => setImmediate(resolve));
  } while (scope.pending?.size);
  for (const close of scope.closers ?? []) { try {close();} catch { /* already closed */ } }
  scope.closers?.clear();
}
