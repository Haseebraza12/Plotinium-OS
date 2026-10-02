/**
 * Realm sandbox for executors (syscall-abi.md §3.2.3, ABI-16; processes-and-scheduling.md
 * §3.7.1). Run by the executor bootstrap BEFORE any program chunk is imported: every storage,
 * thread, network, message-escape and timer global becomes a non-configurable accessor that
 * throws, on the global object AND on every prototype in its lookup chain that exposes the name.
 *
 * Pure with respect to its argument: tests pass a fake global object.
 */
export const SANDBOX_MESSAGE = 'Plotinium: use the system-call interface';

/** Names shadowed on the global object and its prototype chain. */
export const SHADOWED_GLOBALS = [
  // storage
  'indexedDB',
  'caches',
  // threads
  'Worker',
  'SharedWorker',
  'importScripts',
  // network
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'BroadcastChannel',
  // escape hatches (the runtime captured its own port first)
  'postMessage',
  'onmessage',
  // timers: programs use `sleep`, which the scheduler sees and accounts
  'setTimeout',
  'setInterval',
] as const;

/** Names shadowed on `navigator` and its prototypes (WorkerNavigator.prototype). */
export const SHADOWED_NAVIGATOR = ['storage', 'locks'] as const;

export interface SandboxReport {
  readonly shadowed: string[];
  /** Names that could not be redefined (already non-configurable); tests assert this is empty. */
  readonly failed: string[];
}

function thrower(): never {
  throw new TypeError(SANDBOX_MESSAGE);
}

function lock(target: object, name: string, report: SandboxReport, label: string): void {
  try {
    Object.defineProperty(target, name, {
      get: thrower,
      set: thrower,
      configurable: false,
      enumerable: false,
    });
    report.shadowed.push(label);
  } catch {
    report.failed.push(label);
  }
}

/** Every object in `obj`'s prototype chain that has an own property `name`, `obj` included. */
function holders(obj: object, name: string): object[] {
  const out: object[] = [];
  for (let o: object | null = obj; o !== null; o = Object.getPrototypeOf(o) as object | null) {
    if (Object.prototype.hasOwnProperty.call(o, name)) out.push(o);
  }
  return out;
}

function shadowEverywhere(root: object, name: string, report: SandboxReport, label: string): void {
  const found = holders(root, name);
  for (const holder of found) lock(holder, name, report, label);
  // A name nobody defines yet still gets a throwing accessor on the root, so later code cannot
  // install its own.
  if (found.length === 0 || !found.includes(root)) lock(root, name, report, label);
}

/**
 * Shadow the globals of `global` (the executor's `self`). `addEventListener('message', …)` is
 * refused while every other event type still works.
 */
export function sandboxRealm(global: object): SandboxReport {
  const report: SandboxReport = { shadowed: [], failed: [] };
  const g = global as Record<string, unknown>;

  for (const name of SHADOWED_GLOBALS) shadowEverywhere(global, name, report, name);

  const nav = g['navigator'];
  if (nav !== null && typeof nav === 'object') {
    for (const name of SHADOWED_NAVIGATOR) shadowEverywhere(nav, name, report, `navigator.${name}`);
  }
  const storageManager = g['StorageManager'];
  if (typeof storageManager === 'function') {
    const proto: unknown = (storageManager as { prototype?: unknown }).prototype;
    if (proto !== null && typeof proto === 'object')
      lock(proto, 'getDirectory', report, 'StorageManager.prototype.getDirectory');
  }

  const add = g['addEventListener'];
  if (typeof add === 'function') {
    const original = add as (this: unknown, type: string, ...rest: unknown[]) => void;
    const guarded = function (this: unknown, type: string, ...rest: unknown[]): void {
      if (type === 'message' || type === 'messageerror') thrower();
      original.call(this, type, ...rest);
    };
    for (const holder of holders(global, 'addEventListener')) {
      try {
        Object.defineProperty(holder, 'addEventListener', {
          value: guarded,
          writable: false,
          configurable: false,
        });
        report.shadowed.push('addEventListener(message)');
      } catch {
        report.failed.push('addEventListener(message)');
      }
    }
  }
  return report;
}
