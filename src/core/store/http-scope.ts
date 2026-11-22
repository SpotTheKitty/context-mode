import { AsyncLocalStorage } from "node:async_hooks";

/** T1021: a result above the tool's whole limit and up to `upToBytes` comes back as about `returnBytes` of excerpts plus the pointer. */
export interface ExcerptBand { upToBytes: number; returnBytes: number; }
export interface HttpScope { tenant: string; database: string; toolPrefix?: string; inlineLimits?: Readonly<Record<string, number>>; excerptBands?: Readonly<Record<string, ExcerptBand>>; pending?: Set<Promise<unknown>>; closers?: Set<() => void>; }
export const httpScope = new AsyncLocalStorage<HttpScope>();

interface WriteLockAdapter {
  acquire(database: string): void;
  release(database: string): void;
}

let writeLock: WriteLockAdapter | null = null;
const lockDepth = new Map<string, number>();

/** Registers the per-database single-writer lock used by HTTP worker threads. */
export function registerHttpWriteLock(adapter: WriteLockAdapter | null): void {
  writeLock = adapter;
  lockDepth.clear();
}

/** Runs `fn` while holding the HTTP process-wide write lease for `database`. No-op outside an HTTP worker. */
export function withHttpWriteLock<T>(database: string, fn: () => T): T {
  if (writeLock === null || httpScope.getStore() === undefined) return fn();
  const depth = lockDepth.get(database) ?? 0;
  if (depth === 0) writeLock.acquire(database);
  lockDepth.set(database, depth + 1);
  try {
    return fn();
  } finally {
    const next = (lockDepth.get(database) ?? 1) - 1;
    if (next <= 0) {
      lockDepth.delete(database);
      writeLock.release(database);
    } else {
      lockDepth.set(database, next);
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
