import { AsyncLocalStorage } from "node:async_hooks";

export interface HttpScope { tenant: string; database: string; toolPrefix?: string; pending?: Set<Promise<unknown>>; closers?: Set<() => void>; }
export const httpScope = new AsyncLocalStorage<HttpScope>();

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
