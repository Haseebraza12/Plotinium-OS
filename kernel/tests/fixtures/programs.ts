/**
 * Test programs for the executor runtime and the loopback kernel (processes-and-scheduling.md
 * §3.5.1 program model). State lives in `st` only.
 */
import type { CallName } from '@plotinium/protocol';

import type { Program, Tick } from '../../src/runtime/sys.ts';
import { errnoOf } from '../../src/runtime/sys.ts';

export interface ProbeState {
  results: Record<string, unknown>;
  errors: Record<string, string>;
}

/**
 * Calls each core syscall once and records the values (or errnos) into `out`, which becomes the
 * program's state so the test can read it after the process exits.
 */
export const probe = (out: ProbeState): Program<ProbeState> => ({
  init: () => out,
  *run(ctx, st) {
    st.results['getpid'] = yield* ctx.sys.getpid({});
    st.results['uname'] = yield* ctx.sys.uname({});
    st.results['time.now'] = yield* ctx.sys['time.now']({});
    st.results['proc.list'] = yield* ctx.sys['proc.list']({});
    st.results['dmesg'] = yield* ctx.sys.dmesg({ limit: 5 });
    try {
      yield* ctx.sys.stat({ path: '/' });
    } catch (e) {
      st.errors['stat'] = errnoOf(e) ?? 'unknown';
    }
    return 0;
  },
});

export interface CountState {
  n: number;
  target: number;
}

/** Counts to argv[1] (default 100) with a yield point per step; exits with n mod 256. */
export const counter: Program<CountState> = {
  checkpointable: true,
  init: (argv) => ({ n: 0, target: Number(argv[1] ?? 100) }),
  *run(ctx, st) {
    while (st.n < st.target) {
      st.n++;
      yield ctx.tick;
    }
    return st.n % 256;
  },
  signal(_ctx, st, sig) {
    if (sig === 'SIGTERM') st.target = st.n;
  },
};

/** Throws from `run` (exit 1, reason crash). */
export const crasher: Program<null> = {
  init: () => null,
  // eslint-disable-next-line require-yield -- the crash happens before the first yield on purpose
  *run() {
    throw new Error('boom');
  },
};

/** Yields something that is neither a tick nor a syscall. */
export const rogue: Program<null> = {
  init: () => null,
  *run() {
    yield { not: 'a syscall' } as unknown as Tick;
    return 0;
  },
};

/** Makes one raw call by name (used to probe ENOSYS and schema failures). */
export interface OneCallState {
  err: string | null;
  value: unknown;
}

export function oneCall(
  call: string,
  args: unknown,
  out: OneCallState = { err: null, value: undefined },
): Program<OneCallState> {
  return {
    init: () => out,
    *run(ctx, st) {
      try {
        st.value = yield* ctx.sys.call(call as CallName, args as never);
      } catch (e) {
        st.err = errnoOf(e) ?? 'unknown';
      }
      return 0;
    },
  };
}
