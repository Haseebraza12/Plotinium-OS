/**
 * lockdemo: takes a lease on a file and holds it, for the two-user contention demonstration
 * (VFS-09, Demo Day item 7; lease protocol in offline-and-sync.md §3.14, calls in syscall-abi.md
 * §4.4.7). The kernel renews the lease with its heartbeat while the process lives and releases it
 * when the process exits (PROC-07), so killing lockdemo, or the renderer it runs in, lets the
 * other user acquire the lease within the TTL.
 */
import type { SignalName } from '@plotinium/protocol';
import type { ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';

import type { DemoState, Out } from '../lib/cli.ts';
import {
  defineDemo,
  epochNow,
  errText,
  intOption,
  nap,
  parseFor,
  seconds,
  statusFor,
  takeSignal,
  UsageError,
} from '../lib/cli.ts';

export type LeaseMode = 'S' | 'X';

export interface LockOpts {
  readonly path: string;
  readonly mode: LeaseMode;
  readonly wait: boolean;
  /** Seconds to wait with `--wait`, or null for the kernel's default. */
  readonly timeout: number | null;
  /** Seconds to hold, or null until interrupted. */
  readonly hold: number | null;
  /** Seconds between status lines; 0 = quiet. */
  readonly interval: number;
}

export interface LockWork {
  phase: 'acquire' | 'hold' | 'release' | 'done';
  leaseId: string | null;
  fence: number | null;
  scope: string | null;
  acquiredAt: number | null;
  holdUntil: number | null;
  failed: boolean;
  stoppedBy: SignalName | null;
}

export function parseLock(args: readonly string[]): LockOpts {
  const p = parseFor('lockdemo', args);
  if (p.operands.length === 0) throw new UsageError('lockdemo: missing PATH');
  if (p.operands.length > 1)
    throw new UsageError(`lockdemo: extra operand '${p.operands[1] ?? ''}'`);
  if (p.has('x') && p.has('s')) throw new UsageError('lockdemo: -x and -s cannot be used together');
  const num = (key: string, flag: string, min: number, max: number): number | null => {
    const raw = p.value(key);
    return raw === undefined ? null : intOption('lockdemo', flag, raw, min, max);
  };
  const timeout = num('t', '--timeout', 1, 600);
  if (timeout !== null && !p.has('w')) throw new UsageError('lockdemo: --timeout needs --wait');
  return {
    path: p.operands[0] ?? '',
    mode: p.has('s') ? 'S' : 'X',
    wait: p.has('w'),
    timeout,
    hold: num('hold', '--hold', 1, 86_400),
    interval: num('i', '--interval', 0, 3_600) ?? 5,
  };
}

function expiresIn(expiresAt: number, now: number): string {
  return `${String(Math.max(0, Math.ceil((expiresAt - now) / 1000)))} s`;
}

/** `PATH is locked by alice@lab-pc-3 (X, expires in 12 s)`, from `lock.status`. */
function* holderText(ctx: ProgramContext, path: string): SysGen<string | null> {
  try {
    const s = yield* ctx.sys.call('lock.status', { path });
    const now = (yield* epochNow(ctx)).epochMs;
    if (s.holders.length === 0) return null;
    const holders = s.holders
      .map((h) => `${h.holder} (${h.mode}, expires in ${expiresIn(h.expiresAt, now)})`)
      .join(', ');
    const queued = s.queued > 0 ? `; ${String(s.queued)} waiting` : '';
    return `${holders}${queued}`;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return null;
  }
}

function* statusLine(ctx: ProgramContext, o: LockOpts, w: LockWork): SysGen<string> {
  const now = (yield* epochNow(ctx)).epochMs;
  const held = seconds(now - (w.acquiredAt ?? now));
  let tail = '';
  try {
    const s = yield* ctx.sys.call('lock.status', { path: o.path });
    const mine = s.holders.filter((h) => h.mode === o.mode);
    const expiry = mine.length === 0 ? null : Math.max(...mine.map((h) => h.expiresAt));
    tail = `${expiry === null ? '' : `, expires in ${expiresIn(expiry, now)}`}, ${String(s.queued)} waiting`;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
  return `lockdemo: holding ${o.mode} lease on ${o.path} for ${held} (fence ${String(w.fence ?? '-')}${tail})`;
}

function* acquire(
  ctx: ProgramContext,
  out: Out,
  o: LockOpts,
  w: LockWork,
  st: DemoState<LockOpts, LockWork>,
): SysGen<void> {
  if (o.wait) {
    const holder = yield* holderText(ctx, o.path);
    if (holder !== null)
      yield* out.line(`lockdemo: waiting for an ${o.mode} lease on ${o.path}; held by ${holder}`);
  }
  const started = (yield* epochNow(ctx)).epochMs;
  for (;;) {
    const sig = takeSignal(st);
    if (sig !== null) {
      w.stoppedBy = sig;
      w.phase = 'done';
      return;
    }
    try {
      const r = yield* ctx.sys.call('lock.acquire', {
        path: o.path,
        mode: o.mode,
        wait: o.wait,
        ...(o.timeout === null ? {} : { timeoutMs: o.timeout * 1000 }),
      });
      const now = (yield* epochNow(ctx)).epochMs;
      w.leaseId = r.leaseId;
      w.fence = r.fence;
      w.scope = r.scope;
      w.acquiredAt = now;
      w.holdUntil = o.hold === null ? null : now + o.hold * 1000;
      w.phase = 'hold';
      const waited = o.wait ? ` after ${seconds(now - started)}` : '';
      yield* out.line(
        `lockdemo: acquired ${o.mode} lease on ${o.path}${waited} (fence ${String(r.fence)}, scope ${r.scope}, expires in ${expiresIn(r.expiresAt, now)})`,
      );
      return;
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === 'ECANCELED') continue;
      if (errno === 'EBUSY' && !o.wait) {
        const holder = yield* holderText(ctx, o.path);
        yield* out.error(
          holder === null
            ? `${o.path} is locked (${errText(e)})`
            : `${o.path} is locked by ${holder}`,
        );
      } else if (errno === 'ETIMEDOUT') {
        yield* out.error(
          `timed out after ${String(o.timeout ?? 0)} s waiting for an ${o.mode} lease on ${o.path}`,
        );
      } else {
        yield* out.error(`cannot lock '${o.path}': ${errText(e)}`);
      }
      w.failed = true;
      w.phase = 'done';
      return;
    }
  }
}

function* hold(
  ctx: ProgramContext,
  out: Out,
  o: LockOpts,
  w: LockWork,
  st: DemoState<LockOpts, LockWork>,
): SysGen<void> {
  // Executor time is not state: after a restore the status timer starts again.
  let lastStatus = ctx.now();
  while (w.phase === 'hold') {
    const sig = takeSignal(st);
    if (sig !== null) {
      w.stoppedBy = sig;
      w.phase = 'release';
      break;
    }
    if (w.holdUntil !== null && (yield* epochNow(ctx)).epochMs >= w.holdUntil) {
      w.phase = 'release';
      break;
    }
    if (o.interval > 0 && ctx.now() - lastStatus >= o.interval * 1000) {
      lastStatus = ctx.now();
      yield* out.line(yield* statusLine(ctx, o, w));
    }
    yield* nap(ctx, 1000);
  }
}

function* release(ctx: ProgramContext, out: Out, o: LockOpts, w: LockWork): SysGen<void> {
  const now = (yield* epochNow(ctx)).epochMs;
  const held = seconds(now - (w.acquiredAt ?? now));
  if (w.leaseId !== null) {
    try {
      yield* ctx.sys.call('lock.release', { leaseId: w.leaseId });
      yield* out.line(`lockdemo: released ${o.mode} lease on ${o.path} after ${held}`);
    } catch (e) {
      yield* out.error(`lease on ${o.path} was already gone after ${held}: ${errText(e)}`);
      w.failed = true;
    }
  }
  w.leaseId = null;
  w.phase = 'done';
}

function* run(
  ctx: ProgramContext,
  out: Out,
  o: LockOpts,
  w: LockWork,
  st: DemoState<LockOpts, LockWork>,
): SysGen<number> {
  if (w.phase === 'acquire') yield* acquire(ctx, out, o, w, st);
  if (w.phase === 'hold') yield* hold(ctx, out, o, w, st);
  if (w.phase === 'release') yield* release(ctx, out, o, w);
  if (w.failed) return 1;
  return w.stoppedBy === null ? 0 : statusFor(w.stoppedBy);
}

const lockdemo = defineDemo<LockOpts, LockWork>({
  name: 'lockdemo',
  checkpointable: true,
  catches: ['SIGINT', 'SIGTERM', 'SIGHUP'],
  parse: parseLock,
  start: () => ({
    phase: 'acquire',
    leaseId: null,
    fence: null,
    scope: null,
    acquiredAt: null,
    holdUntil: null,
    failed: false,
    stoppedBy: null,
  }),
  run,
});

export default lockdemo;
