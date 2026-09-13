/** A tiny external store for useSyncExternalStore: one snapshot, replaced wholesale, listeners told after each set. */

export type Store<T> = {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l();
  };
  return {
    get: () => state,
    set,
    update: (fn) => set(fn(state)),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
