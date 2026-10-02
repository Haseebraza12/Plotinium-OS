/**
 * The executor runtime: runs ONE quantum of a resident program generator and reports back
 * (processes-and-scheduling.md §3.5 and §3.7.3, KPS-03/KPS-04; syscall-abi.md §3.2.1), and holds
 * the process's data pages for the pager (memory-and-paging.md §4.2, §4.3).
 *
 * Thread-agnostic: `executor-entry.ts` binds it to a nested module worker, and the Node loopback
 * host runs it in-process. A slice ends in exactly one report:
 *   - `syscall` the program yielded a request (the frame is the call AND the slice end, §3.2.1);
 *   - `fault`   `ctx.mem.get` of a page that is not resident (runtime-internal `mem.fault`);
 *   - `yield`   the quantum expired or PREEMPT = 1 at a yield point;
 *   - `exit`    `run` returned (exit code, default 0);
 *   - `killed`  PREEMPT = 2 at a yield point (the generator is dropped);
 *   - `error`   an uncaught exception (exit 1, reason `crash`, message + 2 KB of stack).
 * The quantum is wall time from dispatch; a `resume` carries the remaining quantum.
 *
 * Page frames (`checkpoint`, `pageOut`, `pageIn`, `release`) are handled between slices: a worker
 * processes one message at a time, so a page frame never interleaves with a running slice.
 */
import type { SysRes } from '@plotinium/protocol';
import { ABI_VERSION, abiDigest, SIGNAL_NAMES, signalBit } from '@plotinium/protocol';

import { decodeState, encodeRaw, encodeState } from '../core/mm/codec.ts';
import { DEFAULT_PARAMS } from '../core/mm/params.ts';
import type {
  DispatchFrame,
  LoadedReport,
  MemReport,
  PageFile,
  SliceAcct,
  SliceReport,
} from '../core/proc/exec-frames.ts';
import type { ControlBlock } from '../core/sched/control-block.ts';
import {
  CTL,
  execEndSlice,
  execYieldPoint,
  PREEMPT_KILL,
  PREEMPT_YIELD,
} from '../core/sched/control-block.ts';
import type { CtxMem, PageMode, Program, ProgramContext, Sys, SysGen, SysRequest } from './sys.ts';
import { createSys, SysError, TICK } from './sys.ts';

export type {
  DispatchFrame,
  LoadedReport,
  MemReport,
  SliceReport,
} from '../core/proc/exec-frames.ts';

/** A state restored by value (tests, migration) or from a verified state page. */
export type RestoreSource =
  | { readonly state: unknown; readonly from: 'page-in' | 'migration' | 'session' }
  | (PageFile & { readonly from: 'page-in' | 'migration' | 'session' });

export interface LoadRequest {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly uid: number;
  readonly gid: number;
  readonly argv: readonly string[];
  readonly env: readonly (readonly [string, string])[];
  readonly cwd: string;
  readonly tty: number | null;
  /** Restore a checkpointed state instead of calling `init(argv)`. */
  readonly restore?: RestoreSource;
}

export interface HelloFrame {
  readonly t: 'hello';
  readonly abi: number;
  readonly digest: string;
}

/** The fault marker `ctx.mem.get` yields; the runtime turns it into a `fault` frame. */
interface FaultRequest {
  readonly fault: number;
}

/** Per-process executor memory: cwd, data pages and the pages touched in the current slice. */
interface ResidentMem {
  cwd: string;
  /** Data pages held by this executor (memory-and-paging.md §3.4). */
  readonly pages: Map<number, ArrayBuffer>;
  /** pageId → the id of its allocation (the allocation's first page). */
  readonly segOf: Map<number, number>;
  /** allocation id → its page ids. */
  readonly segs: Map<number, number[]>;
  touched: Set<number>;
  dirtied: Set<number>;
}

interface Resident {
  readonly program: Program<unknown>;
  readonly ctx: ProgramContext;
  readonly m: ResidentMem;
  st: unknown;
  gen: SysGen<number | undefined> | null;
  /** Request id the generator is suspended on, or null. */
  awaiting: number | null;
  nextId: number;
}

export interface ExecutorDeps {
  /** `performance.now()` in the executor. */
  readonly now: () => number;
  /** The 32-byte control block; null without cross-origin isolation (message fallback). */
  readonly ctl: ControlBlock | null;
  /** PAGE_CHUNK (default 256 KiB, memory-and-paging.md §3.1). */
  readonly pageChunk?: number;
}

function isSysRequest(x: unknown): x is SysRequest {
  return (
    x !== null &&
    typeof x === 'object' &&
    typeof (x as { call?: unknown }).call === 'string' &&
    'args' in x
  );
}

function isFaultRequest(x: unknown): x is FaultRequest {
  return (
    x !== null && typeof x === 'object' && typeof (x as { fault?: unknown }).fault === 'number'
  );
}

function clampCode(x: unknown): number {
  return typeof x === 'number' && Number.isInteger(x) ? Math.min(255, Math.max(0, x)) : 0;
}

/**
 * Start of a slice on the control block. Unlike `execBeginSlice` it does NOT clear PREEMPT: the
 * kernel clears PREEMPT when it posts a fresh `dispatch` (ProcessSystem's SchedHost), so a
 * pre-emption or kill requested while the dispatch frame was still queued is honoured at the first
 * yield point instead of being lost (a PREEMPT = 2 lost there would otherwise wait for the
 * watchdog's KILL_GRACE termination).
 */
function beginSlice(ctl: ControlBlock, pid: number): void {
  Atomics.store(ctl, CTL.RUNNING_PID, pid | 0);
  Atomics.store(ctl, CTL.STEPS, 0);
  Atomics.store(ctl, CTL.MAX_STEP_US, 0);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 1_024) : String(e).slice(0, 1_024);
}

/**
 * Create the executor-side pages of a granted allocation. Its page ids are consecutive from
 * `segId − 1` (core/proc/mem-syscalls.ts `firstPageOf`: the protocol's segment ids start at 1,
 * page ids at 0). Chunk allocations are split into PAGE_CHUNK pages.
 */
function mapAllocation(
  p: ResidentMem,
  segId: number,
  kind: 'chunk' | 'logical',
  size: number,
  chunk: number,
): number[] {
  const count = kind === 'chunk' ? Math.ceil(size / chunk) : 1;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = segId - 1 + i;
    const len = kind === 'chunk' ? Math.min(chunk, size - i * chunk) : size;
    if (!p.pages.has(id)) p.pages.set(id, new ArrayBuffer(len));
    p.segOf.set(id, segId);
    p.dirtied.add(id);
    ids.push(id);
  }
  p.segs.set(segId, ids);
  return ids;
}

/** The allocations (first page ids) that `pageIds` belong to; EINVAL for an unknown page. */
function allocationsOf(p: ResidentMem, pageIds: readonly number[]): Set<number> {
  const segIds = new Set<number>();
  for (const id of pageIds) {
    const seg = p.segOf.get(id);
    if (seg === undefined) throw new SysError('EINVAL', `no page ${String(id)}`);
    segIds.add(seg);
  }
  return segIds;
}

/** Forget every page of one freed allocation. */
function unmapAllocation(p: ResidentMem, seg: number): void {
  for (const id of p.segs.get(seg) ?? []) {
    p.pages.delete(id);
    p.segOf.delete(id);
    p.touched.delete(id);
    p.dirtied.delete(id);
  }
  p.segs.delete(seg);
}

export function helloFrame(): HelloFrame {
  return { t: 'hello', abi: ABI_VERSION, digest: abiDigest() };
}

export class ExecutorRuntime {
  private readonly deps: ExecutorDeps;
  private readonly resident = new Map<number, Resident>();
  private readonly sys: Sys = createSys();
  private readonly chunk: number;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
    this.chunk = deps.pageChunk ?? DEFAULT_PARAMS.pageChunk;
  }

  get residents(): number {
    return this.resident.size;
  }

  has(pid: number): boolean {
    return this.resident.has(pid);
  }

  /** The serialisable state of a resident (for a checkpoint). */
  stateOf(pid: number): unknown {
    return this.resident.get(pid)?.st;
  }

  /** Page ids held for `pid` (tests and diagnostics). */
  pagesOf(pid: number): number[] {
    return [...(this.resident.get(pid)?.m.pages.keys() ?? [])].sort((a, b) => a - b);
  }

  /** Make `program` resident as `req.pid`: `init(argv)` (or the restored state) runs here. */
  load(req: LoadRequest, program: Program<unknown>): LoadedReport {
    try {
      const st = req.restore ? this.restoredState(req.restore) : program.init(req.argv);
      const m: ResidentMem = {
        cwd: req.cwd,
        pages: new Map(),
        segOf: new Map(),
        segs: new Map(),
        touched: new Set(),
        dirtied: new Set(),
      };
      const ctx = this.context(req, m);
      this.resident.set(req.pid, { program, ctx, m, st, gen: null, awaiting: null, nextId: 1 });
      return { t: 'loaded', pid: req.pid, ok: true };
    } catch (e) {
      return { t: 'loaded', pid: req.pid, ok: false, error: errMessage(e) };
    }
  }

  private restoredState(r: RestoreSource): unknown {
    if ('state' in r) return r.state;
    return decodeState(r.header, r.body, { expectedSha: r.sha256 });
  }

  /** Kill of a resident that is not running: discard its generator, state and pages. */
  drop(pid: number): void {
    this.resident.delete(pid);
  }

  private context(req: LoadRequest, p: ResidentMem): ProgramContext {
    const sys = this.sys;
    const now = this.deps.now;
    const restored: ProgramContext['restored'] = req.restore?.from ?? 'no';
    const ctx: ProgramContext = {
      pid: req.pid,
      ppid: req.ppid,
      pgid: req.pgid,
      sid: req.sid,
      uid: req.uid,
      gid: req.gid,
      argv: Object.freeze([...req.argv]),
      env: new Map(req.env),
      get cwd(): string {
        return p.cwd;
      },
      tty: req.tty,
      restored,
      sys,
      tick: TICK,
      now,
      *sleep(ms: number): SysGen<void> {
        yield* sys.sleep({ ms: Math.max(0, Math.min(2_147_483_647, Math.round(ms))) });
      },
      *sleepUntil(tMs: number): SysGen<void> {
        yield* sys.sleep({ ms: Math.max(0, Math.min(2_147_483_647, Math.round(tMs - now()))) });
      },
      mem: Object.freeze(this.memApi(p)),
    };
    return Object.freeze(ctx);
  }

  /** `ctx.mem` over this executor's page map (memory-and-paging.md §4.2). */
  private memApi(p: ResidentMem): CtxMem {
    const sys = this.sys;
    const chunk = this.chunk;
    return {
      *alloc(req): SysGen<{ readonly pageIds: readonly number[] }> {
        const size = Math.max(1, Math.trunc(req.size));
        const r = yield* sys['mem.alloc']({
          bytes: size,
          kind: req.kind === 'chunk' ? 'buffer' : 'state',
          ...(req.label === undefined ? {} : { key: req.label.slice(0, 128) }),
        });
        return { pageIds: mapAllocation(p, r.segId, req.kind, size, chunk) };
      },
      *get(pageId: number, mode: PageMode): SysGen<ArrayBuffer> {
        let buf = p.pages.get(pageId);
        if (buf === undefined) {
          const faulted = (yield { fault: pageId } as unknown as SysRequest) as {
            size?: unknown;
          } | null;
          buf = p.pages.get(pageId);
          if (buf === undefined) {
            const size = typeof faulted?.size === 'number' ? faulted.size : 0;
            buf = new ArrayBuffer(size);
            p.pages.set(pageId, buf);
          }
        }
        p.touched.add(pageId);
        if (mode === 'rw') p.dirtied.add(pageId);
        return buf;
      },
      *free(pageIds: readonly number[]): SysGen<{ readonly bytes: number }> {
        let bytes = 0;
        for (const seg of allocationsOf(p, pageIds)) {
          const r = yield* sys['mem.free']({ segId: seg });
          bytes += r.bytes;
          unmapAllocation(p, seg);
        }
        return { bytes };
      },
    };
  }

  /** Signals whose bit is set are caught ones: run the program's synchronous hook for each. */
  private deliverSignals(p: Resident, bits: number): void {
    if (bits === 0 || !p.program.signal) return;
    for (const sig of SIGNAL_NAMES) {
      if ((bits & signalBit(sig)) !== 0) p.program.signal(p.ctx, p.st, sig);
    }
  }

  /** Run one quantum of `frame.pid` and return the slice report. Never throws. */
  runSlice(frame: DispatchFrame): SliceReport {
    const { pid, sliceSeq } = frame;
    const p = this.resident.get(pid);
    if (!p)
      return { t: 'error', pid, sliceSeq, message: 'process is not resident on this executor' };
    if (frame.cwd !== undefined) p.m.cwd = frame.cwd;
    const { ctl } = this.deps;
    const start = this.deps.now();
    const end = start + Math.max(0, frame.quantumMs);
    if (ctl) beginSlice(ctl, pid);
    let last = start;
    let maxStep = 0;
    let steps = 0;
    const acct = (): SliceAcct => {
      const a: SliceAcct = {
        cpuMs: last - start,
        steps,
        maxStepUs: Math.round(maxStep * 1_000),
        ...(p.m.touched.size > 0 ? { touched: [...p.m.touched] } : {}),
        ...(p.m.dirtied.size > 0 ? { dirtied: [...p.m.dirtied] } : {}),
      };
      p.m.touched = new Set();
      p.m.dirtied = new Set();
      return a;
    };
    const finish = (report: SliceReport): SliceReport => {
      if (ctl) execEndSlice(ctl);
      return report;
    };

    let input: unknown;
    let thrown: SysError | null = null;
    const res: SysRes | undefined = frame.res;
    if (res !== undefined) {
      if (p.awaiting === null || res.id !== p.awaiting) {
        return finish({
          t: 'error',
          pid,
          sliceSeq,
          message: `reply ${String(res.id)} does not match the pending call`,
        });
      }
      p.awaiting = null;
      if (res.ok) input = res.value;
      else thrown = new SysError(res.errno, res.msg, res.detail);
    }

    try {
      this.deliverSignals(p, frame.pendingSigs);
      p.gen ??= p.program.run(p.ctx, p.st);
      for (;;) {
        const r = thrown ? p.gen.throw(thrown) : p.gen.next(input);
        thrown = null;
        input = undefined;
        const t = this.deps.now();
        maxStep = Math.max(maxStep, t - last);
        last = t;
        steps++;
        if (r.done) {
          this.resident.delete(pid);
          return finish({
            t: 'exit',
            pid,
            sliceSeq,
            cpuMs: last - start,
            code: clampCode(r.value),
          });
        }
        if (r.value !== TICK) {
          const id = p.nextId;
          if (isFaultRequest(r.value)) {
            p.nextId = p.nextId >= 0xffff_ffff ? 1 : p.nextId + 1;
            p.awaiting = id;
            return finish({ t: 'fault', pid, sliceSeq, id, pageId: r.value.fault, ...acct() });
          }
          if (!isSysRequest(r.value))
            throw new TypeError('a program may only yield ctx.tick or a system call');
          p.nextId = p.nextId >= 0xffff_ffff ? 1 : p.nextId + 1;
          p.awaiting = id;
          return finish({
            t: 'syscall',
            pid,
            sliceSeq,
            req: { id, call: r.value.call, args: r.value.args },
            ...acct(),
          });
        }
        const pre = ctl ? execYieldPoint(ctl, steps, maxStep * 1_000) : 0;
        if (pre === PREEMPT_KILL) {
          this.resident.delete(pid);
          return finish({ t: 'killed', pid, sliceSeq });
        }
        if (pre === PREEMPT_YIELD || t >= end)
          return finish({ t: 'yield', pid, sliceSeq, ...acct() });
      }
    } catch (e) {
      this.resident.delete(pid);
      const err = e instanceof Error ? e : new Error(String(e));
      const report: SliceReport = err.stack
        ? {
            t: 'error',
            pid,
            sliceSeq,
            message: err.message.slice(0, 1_024),
            stack: err.stack.slice(0, 2_048),
          }
        : { t: 'error', pid, sliceSeq, message: err.message.slice(0, 1_024) };
      return finish(report);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Page frames (memory-and-paging.md §4.3), always between slices
  // -------------------------------------------------------------------------------------------

  /** Encode `st` with the codec (a rejected state answers EINVAL; the process keeps running). */
  checkpoint(reqId: number, pid: number): MemReport {
    const p = this.resident.get(pid);
    if (!p)
      return { t: 'checkpointed', reqId, pid, ok: false, errno: 'EINVAL', msg: 'not resident' };
    try {
      const enc = encodeState(p.st);
      return {
        t: 'checkpointed',
        reqId,
        pid,
        ok: true,
        header: enc.header,
        body: enc.body,
        sha256: enc.sha256,
        bytes: enc.bytes,
      };
    } catch (e) {
      return { t: 'checkpointed', reqId, pid, ok: false, errno: 'EINVAL', msg: errMessage(e) };
    }
  }

  /**
   * Hash and hand over these data pages; the executor no longer holds them. A page the program
   * never touched is transferred as zeros of its size (`sizes[i]`).
   */
  pageOut(
    reqId: number,
    pid: number,
    pageIds: readonly number[],
    sizes: readonly number[] = [],
  ): MemReport {
    const p = this.resident.get(pid);
    const pages = pageIds.map((pageId, i) => {
      const body = p?.m.pages.get(pageId) ?? new ArrayBuffer(sizes[i] ?? 0);
      p?.m.pages.delete(pageId);
      const enc = encodeRaw(body, { chunk: body.byteLength === this.chunk });
      return { pageId, header: enc.header, body: enc.body, sha256: enc.sha256 };
    });
    return { t: 'pagedOut', reqId, pid, pages };
  }

  /** A verified page body is back (transferred in); a later `get` finds it resident. */
  pageIn(reqId: number, pid: number, pageId: number, body: ArrayBuffer): MemReport {
    const p = this.resident.get(pid);
    if (!p) return { t: 'pagedIn', reqId, pid, ok: false };
    p.m.pages.set(pageId, body);
    return { t: 'pagedIn', reqId, pid, ok: true };
  }

  /** Drop clean pages, or the whole process (generator, `st`, pages) after a releasing checkpoint. */
  release(reqId: number, pid: number, pageIds: readonly number[], dropProcess: boolean): MemReport {
    const p = this.resident.get(pid);
    let bytes = 0;
    if (p) {
      for (const id of pageIds) {
        bytes += p.m.pages.get(id)?.byteLength ?? 0;
        p.m.pages.delete(id);
      }
      if (dropProcess) {
        for (const buf of p.m.pages.values()) bytes += buf.byteLength;
        this.resident.delete(pid);
      }
    }
    return { t: 'released', reqId, pid, bytes };
  }
}
