/**
 * An in-process `ExecutorTransport` (processes-and-scheduling.md §4.3): every executor is an
 * `ExecutorRuntime` in the same realm, and frames travel through ONE FIFO queue that the host
 * pumps explicitly. Used by the Node loopback host (`proc-loopback.ts`) so tests run real
 * programs through the real process system: scheduler, pool, kill path, memory glue and
 * dispatcher, with no worker threads.
 *
 * Faithful to the browser transport where it matters:
 *   - frames are asynchronous (nothing runs inside `post`), so the kernel finishes its transition
 *     before the executor sees the dispatch, as with `postMessage`;
 *   - `load` answers `loaded` from the program registry (`ProgramLoaders` or a lookup function);
 *   - the control block is a real SharedArrayBuffer when `sab` is set (pre-emption at yield
 *     points, PREEMPT = 2 kills), else the message fallback;
 *   - CPU time is virtual: each generator step costs `stepCostMs` on the host clock (`advance`),
 *     so a CPU-bound program ends its quantum and the aging tick, watchdog and sleeps all run on
 *     the same manual clock.
 */
import { CTL_BYTES } from '../core/sched/control-block.ts';
import type { ControlBlock } from '../core/sched/control-block.ts';
import type {
  ExecutorToKernel,
  ExecutorTransport,
  KernelToExecutor,
} from '../core/proc/exec-frames.ts';
import { ExecutorRuntime } from '../runtime/executor.ts';
import type { Program } from '../runtime/sys.ts';
import { programOf } from '../runtime/sys.ts';

/** `manifest.entry` → the program, or undefined (the load fails like a missing module). */
export type ProgramLookup = (entry: string) => Program<unknown> | undefined;

export interface InProcessExecutorsOptions {
  /** Executor clock (the kernel's manual clock). */
  readonly now: () => number;
  /** Move the host clock forward (virtual CPU time); default: no virtual time. */
  readonly advance?: (ms: number) => void;
  /** Virtual cost of one generator step in ms (default 0.25). */
  readonly stepCostMs?: number;
  readonly programs: ProgramLookup;
  /** Real SharedArrayBuffer control blocks (default true when SharedArrayBuffer exists). */
  readonly sab?: boolean;
  /** Make `start(index)` fail for these indices (placement / crash tests). */
  readonly failStart?: (index: number) => boolean;
}

interface Realm {
  readonly rt: ExecutorRuntime;
  readonly ctl: ControlBlock | null;
}

interface Queued {
  readonly index: number;
  readonly frame: KernelToExecutor;
}

export class InProcessExecutors implements ExecutorTransport {
  private readonly opts: InProcessExecutorsOptions;
  private readonly realms = new Map<number, Realm>();
  private readonly queue: Queued[] = [];
  private onFrame: (index: number, frame: ExecutorToKernel) => void = () => undefined;
  private onCrash: (index: number, why: string) => void = () => undefined;
  /** Every frame the kernel posted, in order (tests inspect dispatch order). */
  readonly posted: { index: number; t: KernelToExecutor['t']; pid: number | null }[] = [];
  /** The `libs` of every `load` frame, in order (start-up closure tests, KPS-07). */
  readonly libLoads: { pid: number; libs: readonly string[] }[] = [];
  /** Executor starts and terminations (tests). */
  readonly starts: number[] = [];
  readonly terminations: number[] = [];
  /** The largest number of realms alive at once. */
  peakAlive = 0;

  constructor(opts: InProcessExecutorsOptions) {
    this.opts = opts;
  }

  connect(
    onFrame: (index: number, frame: ExecutorToKernel) => void,
    onCrash: (index: number, why: string) => void,
  ): void {
    this.onFrame = onFrame;
    this.onCrash = onCrash;
  }

  start(index: number): Promise<void> {
    if (this.opts.failStart?.(index) === true)
      return Promise.reject(new Error(`executor ${String(index)} failed to start`));
    const sab = this.opts.sab ?? typeof SharedArrayBuffer === 'function';
    const ctl = sab ? new Int32Array(new SharedArrayBuffer(CTL_BYTES)) : null;
    const step = this.opts.stepCostMs ?? 0.25;
    const advance = this.opts.advance;
    const now = this.opts.now;
    const rt = new ExecutorRuntime({
      ctl,
      now:
        advance === undefined || step <= 0
          ? now
          : () => {
              advance(step);
              return now();
            },
    });
    this.realms.set(index, { rt, ctl });
    this.starts.push(index);
    this.peakAlive = Math.max(this.peakAlive, this.realms.size);
    return Promise.resolve();
  }

  terminate(index: number): void {
    if (this.realms.delete(index)) this.terminations.push(index);
    // Frames still queued for a terminated realm are never delivered (worker.terminate()).
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i]?.index === index) this.queue.splice(i, 1);
  }

  post(index: number, frame: KernelToExecutor): void {
    this.posted.push({ index, t: frame.t, pid: 'pid' in frame ? frame.pid : null });
    this.queue.push({ index, frame });
  }

  ctl(index: number): ControlBlock | null {
    return this.realms.get(index)?.ctl ?? null;
  }

  alive(index: number): boolean {
    return this.realms.has(index);
  }

  /** The runtime of executor `index` (tests inspect residents and pages). */
  runtime(index: number): ExecutorRuntime | undefined {
    return this.realms.get(index)?.rt;
  }

  get aliveCount(): number {
    return this.realms.size;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Deliver `frame` as if executor `index` had sent it (forged-frame and identity tests). */
  inject(index: number, frame: ExecutorToKernel): void {
    this.onFrame(index, frame);
  }

  /** Simulate a realm crash (`worker.onerror`): the kernel's crash path runs. */
  crash(index: number, why = 'simulated crash'): void {
    this.onCrash(index, why);
  }

  /** Deliver the oldest queued frame; false when the queue is empty. */
  deliverOne(): boolean {
    const q = this.queue.shift();
    if (q === undefined) return false;
    const realm = this.realms.get(q.index);
    if (realm === undefined) return true;
    const reply = this.handle(realm.rt, q.frame);
    if (reply !== null) this.onFrame(q.index, reply);
    return true;
  }

  private handle(rt: ExecutorRuntime, f: KernelToExecutor): ExecutorToKernel | null {
    switch (f.t) {
      case 'load': {
        // Libs are modules, not programs: this host records their order and loads nothing.
        if (f.libs !== undefined) this.libLoads.push({ pid: f.pid, libs: f.libs });
        const program = this.opts.programs(f.entry);
        const resolved = program === undefined ? null : programOf(program);
        if (resolved === null)
          return { t: 'loaded', pid: f.pid, ok: false, error: `no program module for ${f.entry}` };
        return rt.load(f, resolved);
      }
      case 'dispatch':
      case 'resume':
        return rt.runSlice(f);
      case 'drop':
        rt.drop(f.pid);
        return null;
      case 'preempt':
        return null;
      case 'checkpoint':
        return rt.checkpoint(f.reqId, f.pid);
      case 'pageOut':
        return rt.pageOut(f.reqId, f.pid, f.pageIds, f.sizes ?? []);
      case 'pageIn':
        return rt.pageIn(f.reqId, f.pid, f.pageId, f.body);
      case 'release':
        return rt.release(f.reqId, f.pid, f.pageIds, f.dropProcess);
    }
  }
}
