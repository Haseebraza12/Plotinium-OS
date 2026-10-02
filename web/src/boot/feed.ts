/**
 * A tiny observable value: plain data plus change notifications. The boot path carries no Solid
 * (BOOT-10); the lazily loaded desktop turns a feed into a signal with `subscribe`.
 */
export interface Feed<T> {
  current(): T;
  /** Calls `fn` on every change (not immediately); returns the unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void;
}

export interface WritableFeed<T> extends Feed<T> {
  set(value: T): void;
}

export function createFeed<T>(initial: T): WritableFeed<T> {
  let value = initial;
  const listeners = new Set<(v: T) => void>();
  return {
    current: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    set(next) {
      value = next;
      for (const fn of [...listeners]) fn(next);
    },
  };
}
