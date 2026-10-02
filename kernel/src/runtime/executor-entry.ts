/**
 * Executor bootstrap: the first code of every executor, a nested module worker spawned by the
 * kernel (syscall-abi.md §3.2.3; processes-and-scheduling.md §3.7.1). `startExecutor` runs, in
 * order:
 *   1. capture the control port (this worker's own message channel) in a closure;
 *   2. sandbox the realm (storage, threads, network, message escape hatches, timers);
 *   3. freeze the runtime's ctx and sys (done by ExecutorRuntime);
 *   4. send `hello {abi, digest}` and wait for `init` and the first `load`.
 * Program modules are imported only after step 2, so no program ever sees a live platform object.
 *
 * PROGRAM REGISTRY (injected, never imported by the kernel): the host that bundles the executor
 * (web) passes `loaders`, a map from `manifest.entry` to `() => import(...)`. A `load` frame whose
 * entry has no loader falls back to `import(entry)` when `allowUrlImport` is set (tests and a
 * bare kernel build), else it fails to load (the child exits 126, `spawn-failed`).
 */
import type { KernelToExecutor, LoadFrame } from '../core/proc/exec-frames.ts';
import type { ControlBlock } from '../core/sched/control-block.ts';
import { ExecutorRuntime, helloFrame } from './executor.ts';
import { sandboxRealm } from './sandbox.ts';
import type { ProgramLoaders } from './sys.ts';
import { programOf } from './sys.ts';

export interface ExecutorEntryOptions {
  /** `manifest.entry` → lazy module loader (the program registry). */
  readonly loaders?: ProgramLoaders;
  /** Resolve unknown entries with a dynamic `import(entry)` (default false). */
  readonly allowUrlImport?: boolean;
}

type Incoming =
  | { t: 'init'; index: number; ctl: SharedArrayBuffer | null; abi: number }
  | (KernelToExecutor & { sizes?: readonly number[] });

interface WorkerScope {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent<Incoming>) => void): void;
}

/** Start the executor in the current worker realm. Call exactly once, at module top level. */
export function startExecutor(opts: ExecutorEntryOptions = {}): void {
  const scope = self as unknown as WorkerScope;
  // 1. Capture the control port NOW: the sandbox (step 2) replaces `postMessage` on the global
  // and its prototypes with a throwing accessor, so a later `scope.postMessage` lookup would throw.
  const rawPost = scope.postMessage.bind(scope);
  const post = (msg: unknown, transfer: Transferable[] = []): void => {
    rawPost(msg, transfer);
  };
  const now = performance.now.bind(performance);
  const loaders = opts.loaders ?? {};
  const pendingFrames: Incoming[] = [];
  let runtime: ExecutorRuntime | null = null;
  // Loads resolve asynchronously; frames for a pid that is still loading wait behind it.
  const loading = new Map<number, Incoming[]>();

  const resolveProgram = async (entry: string): Promise<unknown> => {
    const loader = Object.hasOwn(loaders, entry) ? loaders[entry] : undefined;
    if (loader !== undefined) return loader();
    if (opts.allowUrlImport === true) return import(/* @vite-ignore */ entry);
    throw new Error(`no program module for ${entry}`);
  };

  const load = async (msg: LoadFrame, rt: ExecutorRuntime): Promise<void> => {
    try {
      // The start-up closure's libs first, dependencies before dependents (KPS-07).
      for (const lib of msg.libs ?? []) {
        try {
          await resolveProgram(lib);
        } catch (e) {
          throw new Error(`missing lib ${lib}: ${e instanceof Error ? e.message : String(e)}`, {
            cause: e,
          });
        }
      }
      const program = programOf(await resolveProgram(msg.entry));
      if (program === null) {
        post({ t: 'loaded', pid: msg.pid, ok: false, error: `${msg.entry} has no Program export` });
        return;
      }
      post(rt.load(msg, program));
    } catch (e) {
      post({
        t: 'loaded',
        pid: msg.pid,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      const queued = loading.get(msg.pid) ?? [];
      loading.delete(msg.pid);
      for (const f of queued) handle(f);
    }
  };

  function pidOf(msg: Incoming): number | null {
    return 'pid' in msg && typeof msg.pid === 'number' ? msg.pid : null;
  }

  function handle(msg: Incoming): void {
    if (msg.t === 'init') {
      const ctl: ControlBlock | null = msg.ctl === null ? null : new Int32Array(msg.ctl);
      runtime = new ExecutorRuntime({ now, ctl });
      for (const queued of pendingFrames.splice(0)) handle(queued);
      return;
    }
    if (runtime === null) {
      pendingFrames.push(msg);
      return;
    }
    const pid = pidOf(msg);
    if (msg.t !== 'load' && pid !== null && loading.has(pid)) {
      loading.get(pid)?.push(msg);
      return;
    }
    const rt = runtime;
    switch (msg.t) {
      case 'load':
        loading.set(msg.pid, []);
        void load(msg, rt);
        return;
      case 'dispatch':
      case 'resume':
        post(rt.runSlice(msg));
        return;
      case 'drop':
        rt.drop(msg.pid);
        return;
      case 'preempt':
        // Message fallback: a pre-emption request arrives only between slices, where there is
        // nothing to interrupt; the next slice ends at its quantum (§3.7.4).
        return;
      case 'checkpoint': {
        const r = rt.checkpoint(msg.reqId, msg.pid);
        post(r, r.t === 'checkpointed' && r.ok ? [r.body] : []);
        return;
      }
      case 'pageOut': {
        const r = rt.pageOut(msg.reqId, msg.pid, msg.pageIds, msg.sizes ?? []);
        post(r, r.t === 'pagedOut' ? r.pages.map((pg) => pg.body) : []);
        return;
      }
      case 'pageIn':
        post(rt.pageIn(msg.reqId, msg.pid, msg.pageId, msg.body));
        return;
      case 'release':
        post(rt.release(msg.reqId, msg.pid, msg.pageIds, msg.dropProcess));
        return;
    }
  }

  // 1. The listener is installed before the sandbox refuses new 'message' listeners.
  scope.addEventListener('message', (ev) => {
    handle(ev.data);
  });
  // 2. Sandbox.
  const report = sandboxRealm(self);
  // 4. Hello (the kernel compares abi and digest and refuses a mixed-cache executor, ABI-10). A
  // sandbox gap is reported separately so the kernel can refuse the executor and log it.
  post(helloFrame());
  if (report.failed.length > 0) post({ t: 'sandbox', failed: report.failed });
}
