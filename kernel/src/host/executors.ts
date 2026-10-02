/**
 * Spawning executors from the kernel worker (processes-and-scheduling.md §3.7, §3.13): a nested
 * module worker per executor, a 32-byte SharedArrayBuffer control block when cross-origin
 * isolated, and the ABI `hello` check (ABI-10: a mixed-cache executor is refused).
 * `WorkerExecutorTransport` binds them to the kernel's process system (`ExecutorTransport`).
 */
import { ABI_VERSION, abiDigest } from '@plotinium/protocol';

import type {
  ExecutorToKernel,
  ExecutorTransport,
  KernelToExecutor,
} from '../core/proc/exec-frames.ts';
import { CTL_BYTES } from '../core/sched/control-block.ts';
import type { ControlBlock } from '../core/sched/control-block.ts';

export interface ExecutorHandle {
  readonly index: number;
  readonly worker: Worker;
  readonly ctl: Int32Array | null;
}

export type WorkerFactory = (index: number) => Worker;

/** The default factory: Vite bundles `executor.worker.ts` as a separate ES-module chunk. */
export const defaultExecutorFactory: WorkerFactory = (index) =>
  new Worker(new URL('../runtime/executor.worker.ts', import.meta.url), {
    type: 'module',
    name: `executor-${String(index)}`,
  });

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object';
}

/**
 * Start executor `index` and resolve once its `hello` carries this build's ABI version and digest.
 * Rejects on a mismatch, a sandbox gap, or a worker error; the caller's service timeout bounds it.
 * `onCode` runs once, at the worker's first message (its entry's `booting`, or the `hello`): the
 * script and its imports have downloaded by then, so the rest is CPU work (UI-032).
 */
export function spawnExecutor(
  index: number,
  isolated: boolean,
  factory: WorkerFactory = defaultExecutorFactory,
  onCode?: () => void,
): Promise<ExecutorHandle> {
  return new Promise<ExecutorHandle>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = factory(index);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const ctl =
      isolated && typeof SharedArrayBuffer === 'function'
        ? new Int32Array(new SharedArrayBuffer(CTL_BYTES))
        : null;
    const fail = (why: string): void => {
      worker.terminate();
      reject(new Error(`executor ${String(index)}: ${why}`));
    };
    worker.addEventListener('error', (ev) => {
      fail(ev.message || 'failed to start');
    });
    let code = onCode;
    worker.addEventListener('message', function onHello(ev: MessageEvent) {
      const msg: unknown = ev.data;
      code?.();
      code = undefined;
      if (!isRecord(msg)) return;
      if (msg['t'] === 'sandbox') {
        fail(
          `sandbox incomplete: ${Array.isArray(msg['failed']) ? msg['failed'].join(', ') : '?'}`,
        );
        return;
      }
      if (msg['t'] !== 'hello') return;
      worker.removeEventListener('message', onHello);
      if (msg['abi'] !== ABI_VERSION || msg['digest'] !== abiDigest()) {
        fail('ABI mismatch (mixed cache); restart to update');
        return;
      }
      worker.postMessage({
        t: 'init',
        index,
        ctl: ctl === null ? null : ctl.buffer,
        abi: ABI_VERSION,
      });
      resolve({ index, worker, ctl });
    });
  });
}

/** Frames an executor sends after its `hello` (the kernel-internal half of the port, §4.3). */
const EXECUTOR_FRAMES = new Set([
  'yield',
  'syscall',
  'fault',
  'exit',
  'killed',
  'error',
  'loaded',
  'checkpointed',
  'pagedOut',
  'pagedIn',
  'released',
]);

function isExecutorFrame(x: unknown): x is ExecutorToKernel {
  return isRecord(x) && typeof x['t'] === 'string' && EXECUTOR_FRAMES.has(x['t']);
}

/**
 * The browser `ExecutorTransport` (processes-and-scheduling.md §3.7): executor `index` of the pool
 * is a nested module worker `executor-<index>` built by `factory` (the host's executor bundle,
 * which carries the program loaders, runtime/executor-entry.ts). A realm that errors is reported
 * to the kernel's crash path; frames of a terminated realm are never delivered.
 */
export class WorkerExecutorTransport implements ExecutorTransport {
  private readonly isolated: boolean;
  private readonly factory: WorkerFactory;
  private readonly handles = new Map<number, ExecutorHandle>();
  private onFrame: (index: number, frame: ExecutorToKernel) => void = () => undefined;
  private onCrash: (index: number, why: string) => void = () => undefined;
  private readonly code = new Map<
    number,
    { readonly done: Promise<void>; resolve(): void; reject(e: Error): void }
  >();

  constructor(isolated: boolean, factory: WorkerFactory = defaultExecutorFactory) {
    this.isolated = isolated;
    this.factory = factory;
  }

  private codeOf(index: number): {
    readonly done: Promise<void>;
    resolve(): void;
    reject(e: Error): void;
  } {
    let c = this.code.get(index);
    if (c === undefined) {
      let resolve: () => void = () => undefined;
      let reject: (e: Error) => void = () => undefined;
      const done = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A start that fails before any caller waits must not be an unhandled rejection.
      done.catch(() => undefined);
      c = { done, resolve, reject };
      this.code.set(index, c);
    }
    return c;
  }

  /**
   * Resolves once executor `index`'s code has downloaded (its first message), rejects if it fails
   * to start first. The `sched` service waits on it with `ctx.codeWait` (UI-032).
   */
  codeLoaded(index: number): Promise<void> {
    return this.codeOf(index).done;
  }

  connect(
    onFrame: (index: number, frame: ExecutorToKernel) => void,
    onCrash: (index: number, why: string) => void,
  ): void {
    this.onFrame = onFrame;
    this.onCrash = onCrash;
  }

  async start(index: number): Promise<void> {
    const code = this.codeOf(index);
    let h: ExecutorHandle;
    try {
      h = await spawnExecutor(index, this.isolated, this.factory, () => {
        code.resolve();
      });
    } catch (e) {
      code.reject(e instanceof Error ? e : new Error(String(e)));
      this.code.delete(index);
      throw e;
    }
    this.handles.set(index, h);
    h.worker.addEventListener('message', (ev: MessageEvent) => {
      if (this.handles.get(index) !== h) return;
      const msg: unknown = ev.data;
      if (isExecutorFrame(msg)) this.onFrame(index, msg);
    });
    h.worker.addEventListener('error', (ev: ErrorEvent) => {
      if (this.handles.get(index) !== h) return;
      ev.preventDefault();
      this.onCrash(index, ev.message || 'executor realm error');
    });
    h.worker.addEventListener('messageerror', () => {
      if (this.handles.get(index) === h) this.onCrash(index, 'undeserialisable frame');
    });
  }

  terminate(index: number): void {
    this.code.delete(index);
    const h = this.handles.get(index);
    if (h === undefined) return;
    this.handles.delete(index);
    h.worker.terminate();
  }

  post(index: number, frame: KernelToExecutor, transfer: Transferable[] = []): void {
    this.handles.get(index)?.worker.postMessage(frame, transfer);
  }

  ctl(index: number): ControlBlock | null {
    return this.handles.get(index)?.ctl ?? null;
  }

  alive(index: number): boolean {
    return this.handles.has(index);
  }

  /** Terminate every realm (kernel halt, takeover lost). */
  terminateAll(): void {
    for (const i of [...this.handles.keys()]) this.terminate(i);
  }
}
