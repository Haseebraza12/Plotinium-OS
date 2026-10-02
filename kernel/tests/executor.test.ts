import { describe, expect, it } from 'vitest';

import { abiDigest, ABI_VERSION } from '@plotinium/protocol';

import { CTL, CTL_BYTES, PREEMPT_KILL, PREEMPT_YIELD } from '../src/core/sched/control-block.ts';
import type { LoadRequest } from '../src/runtime/executor.ts';
import { ExecutorRuntime, helloFrame } from '../src/runtime/executor.ts';
import type { Program } from '../src/runtime/sys.ts';
import { counter, crasher } from './fixtures/programs.ts';
import type { CountState } from './fixtures/programs.ts';

const load = (pid: number, argv: string[] = ['p']): LoadRequest => ({
  pid,
  ppid: 1,
  pgid: pid,
  sid: pid,
  uid: 1001,
  gid: 1001,
  argv,
  env: [['HOME', '/home/alice']],
  cwd: '/home/alice',
  tty: null,
});

function runtime(opts: { ctl?: Int32Array | null; step?: number } = {}) {
  let t = 0;
  const rt = new ExecutorRuntime({ now: () => (t += opts.step ?? 0.1), ctl: opts.ctl ?? null });
  return { rt, time: () => t };
}

describe('executor runtime', () => {
  it('ABI-10 hello carries this build ABI version and digest', () => {
    expect(helloFrame()).toEqual({ t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
  });

  it('PROC-03 a slice runs until the quantum expires, then yields, and the program resumes where it was', () => {
    const { rt } = runtime({ step: 1 });
    const out: CountState = { n: 0, target: 1_000 };
    expect(rt.load(load(10, ['count', '1000']), { ...counter, init: () => out })).toEqual({
      t: 'loaded',
      pid: 10,
      ok: true,
    });
    const r1 = rt.runSlice({ t: 'dispatch', pid: 10, sliceSeq: 1, quantumMs: 5, pendingSigs: 0 });
    expect(r1).toMatchObject({ t: 'yield', pid: 10, sliceSeq: 1 });
    const afterFirst = out.n;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(10);
    rt.runSlice({ t: 'dispatch', pid: 10, sliceSeq: 2, quantumMs: 5, pendingSigs: 0 });
    expect(out.n).toBeGreaterThan(afterFirst);
    expect(rt.stateOf(10)).toBe(out);
  });

  it('PROC-03 a finished run exits with its code and the process leaves the executor', () => {
    const { rt } = runtime();
    rt.load(load(11, ['count', '3']), counter);
    const r = rt.runSlice({
      t: 'dispatch',
      pid: 11,
      sliceSeq: 1,
      quantumMs: 1_000,
      pendingSigs: 0,
    });
    expect(r).toMatchObject({ t: 'exit', code: 3 });
    expect(rt.has(11)).toBe(false);
    expect(
      rt.runSlice({ t: 'dispatch', pid: 11, sliceSeq: 2, quantumMs: 1, pendingSigs: 0 }),
    ).toMatchObject({ t: 'error' });
  });

  it('KPS-04 PREEMPT = 1 ends the slice at the next yield point and PREEMPT = 2 kills the process there', () => {
    const ctl = new Int32Array(new SharedArrayBuffer(CTL_BYTES));
    const { rt } = runtime({ ctl });
    rt.load(load(12, ['count', '1000000']), counter);
    const program: Program<CountState> = {
      init: () => ({ n: 0, target: 10 }),
      *run(ctx, st) {
        for (;;) {
          st.n++;
          if (st.n === 3) Atomics.store(ctl, CTL.PREEMPT, PREEMPT_YIELD);
          yield ctx.tick;
        }
      },
    };
    rt.load(load(13), program);
    expect(
      rt.runSlice({ t: 'dispatch', pid: 13, sliceSeq: 1, quantumMs: 10_000, pendingSigs: 0 }),
    ).toMatchObject({ t: 'yield', steps: 3 });
    expect(Atomics.load(ctl, CTL.RUNNING_PID)).toBe(0);
    expect(Atomics.load(ctl, CTL.HEARTBEAT)).toBe(3);
    const killer: Program<null> = {
      init: () => null,
      *run(ctx) {
        for (;;) {
          Atomics.store(ctl, CTL.PREEMPT, PREEMPT_KILL);
          yield ctx.tick;
        }
      },
    };
    rt.load(load(14), killer);
    expect(
      rt.runSlice({ t: 'dispatch', pid: 14, sliceSeq: 1, quantumMs: 10_000, pendingSigs: 0 }),
    ).toEqual({ t: 'killed', pid: 14, sliceSeq: 1 });
    expect(rt.has(14)).toBe(false);
  });

  it('SYS-01 a syscall ends the slice with a stamped request, and the reply resumes the generator', () => {
    const { rt } = runtime();
    const seen: unknown[] = [];
    const p: Program<null> = {
      init: () => null,
      *run(ctx) {
        seen.push(yield* ctx.sys.getpid({}));
        seen.push(yield* ctx.sys['time.now']({}));
        return 0;
      },
    };
    rt.load(load(20), p);
    const r1 = rt.runSlice({ t: 'dispatch', pid: 20, sliceSeq: 1, quantumMs: 10, pendingSigs: 0 });
    expect(r1).toMatchObject({ t: 'syscall', req: { id: 1, call: 'getpid', args: {} } });
    const r2 = rt.runSlice({
      t: 'resume',
      pid: 20,
      sliceSeq: 1,
      quantumMs: 10,
      pendingSigs: 0,
      res: { id: 1, ok: true, value: { pid: 20 } },
    });
    expect(r2).toMatchObject({ t: 'syscall', req: { id: 2, call: 'time.now' } });
    // A reply for the wrong id is a runtime error, never a silent mix-up.
    expect(
      rt.runSlice({
        t: 'resume',
        pid: 20,
        sliceSeq: 1,
        quantumMs: 10,
        pendingSigs: 0,
        res: { id: 9, ok: true, value: null },
      }),
    ).toMatchObject({ t: 'error' });
    expect(seen).toEqual([{ pid: 20 }]);
  });

  it('ABI-09 a failed call throws SysError into the program, and a caught signal runs the hook before resuming', () => {
    const { rt } = runtime();
    const out = { errno: '', sig: '' };
    const p: Program<typeof out> = {
      init: () => out,
      *run(ctx, st) {
        try {
          yield* ctx.sleep(1_000);
        } catch (e) {
          st.errno = (e as { errno: string }).errno;
        }
        yield* ctx.sleepUntil(ctx.now() + 5);
        return 0;
      },
      signal(_ctx, st, sig) {
        st.sig = sig;
      },
    };
    rt.load(load(21), p);
    expect(
      rt.runSlice({ t: 'dispatch', pid: 21, sliceSeq: 1, quantumMs: 10, pendingSigs: 0 }),
    ).toMatchObject({ req: { call: 'sleep', args: { ms: 1_000 } } });
    const r = rt.runSlice({
      t: 'dispatch',
      pid: 21,
      sliceSeq: 2,
      quantumMs: 10,
      pendingSigs: 1 << 2,
      res: { id: 1, ok: false, errno: 'ECANCELED', detail: { reason: 'signal' } },
    });
    expect(out).toEqual({ errno: 'ECANCELED', sig: 'SIGINT' });
    expect(r).toMatchObject({ t: 'syscall', req: { call: 'sleep' } });
  });

  it('PROC-06 an uncaught exception is reported with its message and stack, and a bad init fails the load', () => {
    const { rt } = runtime();
    rt.load(load(30), crasher);
    const r = rt.runSlice({ t: 'dispatch', pid: 30, sliceSeq: 1, quantumMs: 10, pendingSigs: 0 });
    expect(r).toMatchObject({ t: 'error', message: 'boom' });
    expect(r.t === 'error' && r.stack !== undefined).toBe(true);
    const bad: Program<null> = {
      init: () => {
        throw new Error('bad argv');
      },
      // eslint-disable-next-line require-yield -- never runs
      *run() {
        return 0;
      },
    };
    expect(rt.load(load(31), bad)).toEqual({ t: 'loaded', pid: 31, ok: false, error: 'bad argv' });
    const thrower: Program<null> = {
      init: () => null,
      // eslint-disable-next-line require-yield -- throws a non-Error on purpose
      *run() {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw on purpose
        throw 'plain string';
      },
    };
    rt.load(load(32), thrower);
    expect(
      rt.runSlice({ t: 'dispatch', pid: 32, sliceSeq: 1, quantumMs: 10, pendingSigs: 0 }),
    ).toMatchObject({ t: 'error' });
  });

  it('KPS-03 restored state is used instead of init, the context is frozen, and drop discards a resident', () => {
    const { rt } = runtime();
    const st: CountState = { n: 7, target: 8 };
    rt.load({ ...load(40), restore: { state: st, from: 'page-in' } }, counter);
    expect(rt.stateOf(40)).toBe(st);
    expect(
      rt.runSlice({ t: 'dispatch', pid: 40, sliceSeq: 1, quantumMs: 100, pendingSigs: 0 }),
    ).toMatchObject({ t: 'exit', code: 8 });
    let frozen = false;
    const probe: Program<null> = {
      init: () => null,
      // eslint-disable-next-line require-yield -- inspects ctx only
      *run(ctx) {
        frozen =
          Object.isFrozen(ctx) &&
          Object.isFrozen(ctx.sys) &&
          ctx.restored === 'no' &&
          ctx.env.get('HOME') === '/home/alice';
        return 0;
      },
    };
    rt.load(load(41), probe);
    rt.runSlice({ t: 'dispatch', pid: 41, sliceSeq: 1, quantumMs: 10, pendingSigs: 0 });
    expect(frozen).toBe(true);
    rt.load(load(42), counter);
    expect(rt.residents).toBe(1);
    rt.drop(42);
    expect(rt.residents).toBe(0);
  });
});
