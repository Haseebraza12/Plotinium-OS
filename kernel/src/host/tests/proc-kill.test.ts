/**
 * PROC-07 the kill path through the system calls on the process loopback host
 * (processes-and-scheduling.md §3.16, §3.17): `kill` terminates the process in every state, frees
 * its executor residency, run token, heap entry and timers, closes its descriptors, releases its
 * locks and re-parents its children to init; the parent's `wait` reports the signal. Signals with
 * the default action, caught signals (the hook runs and a blocked call ends ECANCELED), permission
 * rules, and a leak check after a random mix of spawns and kills.
 */
import type { SignalName } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { INIT_PID } from '../../core/proc/pid.ts';
import type { ProcLoopback } from '../proc-loopback.ts';
import {
  attempt,
  defineScript,
  exited,
  loopback,
  recordOf,
  runScript,
  trace,
} from './proc-harness.ts';

const VICTIM_FILE = '/home/alice/victim.txt';

defineScript('sleeper', function* (ctx) {
  yield* ctx.sleep(400);
  return 7;
});

defineScript('victim', function* (ctx, rec) {
  const f = yield* ctx.sys.open({ path: VICTIM_FILE, flags: 'w', create: true });
  rec['fd'] = f.fd;
  rec['ino'] = f.ino;
  const lease = yield* ctx.sys['lock.acquire']({ path: VICTIM_FILE, mode: 'X' });
  rec['lease'] = lease.leaseId;
  const a = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'sleeper'] });
  const b = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'sleeper'] });
  rec['kids'] = [a.pid, b.pid];
  rec['ready'] = true;
  yield* ctx.sleep(1_000_000);
  rec['woke'] = true;
  return 0;
});

defineScript('kill-victim', function* (ctx, rec) {
  const v = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'victim'] });
  rec['victim'] = v.pid;
  yield* ctx.sleep(100);
  rec['killAt'] = ctx.now();
  rec['kill'] = yield* ctx.sys.kill({ pid: v.pid, sig: 'SIGKILL' });
  rec['wait'] = yield* ctx.sys.wait({ pid: v.pid });
  // A second lock on the same file now succeeds at once: the victim's lease is gone.
  const again = yield* attempt(ctx.sys['lock.acquire']({ path: VICTIM_FILE, mode: 'X' }));
  rec['relock'] = 'leaseId' in again ? 'ok' : again;
  return 0;
});

defineScript('term-default', function* (ctx) {
  yield* ctx.sleep(1_000_000);
  return 0;
});

defineScript(
  'term-catch',
  function* (ctx, rec) {
    yield* ctx.sys['sig.action']({ sig: 'SIGTERM', action: 'catch' });
    const r = yield* attempt(ctx.sys.sleep({ ms: 1_000_000 }));
    rec['sleep'] = r;
    return rec['term'] === true ? 42 : 1;
  },
  (_ctx, rec, sig) => {
    if (sig === 'SIGTERM') rec['term'] = true;
  },
);

defineScript('signal-children', function* (ctx, rec) {
  const d = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'term-default'] });
  const c = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'term-catch'] });
  yield* ctx.sleep(50);
  rec['killD'] = yield* ctx.sys.kill({ pid: d.pid, sig: 'SIGTERM' });
  rec['killC'] = yield* ctx.sys.kill({ pid: c.pid, sig: 'SIGTERM' });
  rec['waitD'] = yield* ctx.sys.wait({ pid: d.pid });
  rec['waitC'] = yield* ctx.sys.wait({ pid: c.pid });
  rec['sigInt'] = yield* ctx.sys.spawn({
    path: '/bin/script.json',
    argv: ['script', 'term-default'],
  });
  const i = rec['sigInt'] as { pid: number };
  yield* ctx.sleep(10);
  yield* ctx.sys.kill({ pid: i.pid, sig: 'SIGINT' });
  rec['waitI'] = yield* ctx.sys.wait({ pid: i.pid });
  return 0;
});

defineScript('kill-rules', function* (ctx, rec) {
  rec['init'] = yield* attempt(ctx.sys.kill({ pid: INIT_PID, sig: 'SIGKILL' }));
  rec['missing'] = yield* attempt(ctx.sys.kill({ pid: 30_000, sig: 'SIGTERM' }));
  const t = Number(ctx.argv[2]);
  rec['foreign'] = yield* attempt(ctx.sys.kill({ pid: t, sig: 'SIGKILL' }));
  rec['probe'] = yield* attempt(ctx.sys.kill({ pid: ctx.pid, sig: 0 }));
  return 0;
});

async function mounted(opts: Parameters<typeof loopback>[0] = {}): Promise<ProcLoopback> {
  const lb = loopback(opts);
  await lb.mountFs();
  return lb;
}

describe('PROC-07 kill path (syscalls)', () => {
  it('PROC-07 kill of a blocked process closes its fds, releases its locks, cancels its timers and re-parents its children to init', async () => {
    const lb = await mounted();
    const { fs, locks } = await lb.mountFs();
    const exits: number[] = [];
    const sub = lb.kernel.bus.subscribe(['proc.exit'], {
      cred: { uid: 0, gid: 0, groups: [] },
      limit: 10_000,
    });

    const { rec, code } = await runScript(lb, 'kill-victim');
    expect(code).toBe(0);
    const v = rec['victim'] as number;
    const vrec = recordOf(v);
    expect(vrec['ready']).toBe(true);
    expect(vrec['woke']).toBeUndefined();
    expect(rec['kill']).toEqual({ delivered: 1 });
    expect(rec['wait']).toEqual({
      pid: v,
      status: { kind: 'signaled', signal: 'SIGKILL', code: 137 },
    });
    // Descriptors closed, lease released (the parent could take the lock at once), no timers.
    expect(fs.fds.list().filter((x) => x.pid === v)).toEqual([]);
    expect(rec['relock']).toBe('ok');
    expect(locks.holders(vrec['ino'] as string).every((l) => l.pid !== v)).toBe(true);
    expect(lb.kernel.timers.timersOf(v)).toEqual([]);
    // The victim was BLOCKED in sleep: the kill is synchronous with the call.
    const t = trace(lb, v);
    expect(t).toContain('BLOCKED>TERMINATED:signal:9');
    // Its children were re-parented to init and init reaped them when they exited.
    const [a, b] = vrec['kids'] as [number, number];
    for (const k of [a, b]) {
      const recs = lb.kernel.klog.read({ filter: (r) => r.kind === 'proc' && r.pid === k });
      expect(recs.length).toBeGreaterThan(0);
    }
    await lb.until(
      () => lb.kernel.procs.get(a) === undefined && lb.kernel.procs.get(b) === undefined,
      5_000,
    );
    expect(lb.kernel.procs.get(a)).toBeUndefined();
    expect(lb.kernel.procs.get(b)).toBeUndefined();
    // The executor no longer holds the victim; nothing refers to a dead pid (INV-P7).
    for (const e of [0, 1, 2, 3, 4, 5, 6, 7])
      expect(lb.executors.runtime(e)?.has(v) ?? false).toBe(false);
    for (const ev of sub.take().events) if (ev.topic === 'proc.exit') exits.push(ev.data.pid);
    expect(exits).toContain(v);
    lb.checkInvariants();
    expect(lb.kernel.proc.stats()).toEqual({
      inflight: 0,
      cancels: 0,
      loads: 0,
      memReqs: 0,
      waiters: 0,
    });
  });

  it('PROC-07 children of a killed process are re-parented to init while they still run', async () => {
    const lb = await mounted();
    const killer = await lb.spawn('script', { argv: ['script', 'kill-victim'] });
    await lb.until(() => typeof recordOf(killer.pid)['kill'] === 'object', 10_000);
    const v = recordOf(killer.pid)['victim'] as number;
    const kids = recordOf(v)['kids'] as number[];
    for (const k of kids) {
      const p = lb.kernel.procs.get(k);
      expect(p?.ppid).toBe(INIT_PID);
      expect(p?.state).not.toBe('TERMINATED');
      expect(lb.kernel.init.children.has(k)).toBe(true);
    }
    await lb.until(() => exited(killer), 10_000);
    lb.checkInvariants();
  });

  it('PROC-07 kill of a RUNNING CPU-bound process pre-empts it through the SAB control block (PREEMPT = 2)', async () => {
    const lb = loopback({ sab: true });
    const burn = await lb.spawn('burn');
    expect(await lb.until(() => burn.state === 'RUNNING', 1_000)).toBe(true);
    const e = burn.worker;
    expect(e).not.toBeNull();
    expect(lb.kernel.proc.signalPid(burn.pid, 'SIGKILL', lb.session.pid)).toBe(true);
    // Marked TERMINATED at once; the kill completes at the first yield point of the slice. Until
    // then it is not a zombie: `wait` does not report it and nobody may reap it.
    expect(burn.state).toBe('TERMINATED');
    expect(lb.kernel.proc.waits.poll(lb.session, { pid: burn.pid })).toBe('none');
    await lb.until(() => exited(burn), 1_000);
    expect(burn.exitCode).toBe(137);
    expect(lb.kernel.proc.waits.poll(lb.session, { pid: burn.pid })).toEqual({
      pid: burn.pid,
      status: { kind: 'signaled', signal: 'SIGKILL', code: 137 },
    });
    expect(trace(lb, burn.pid)).toContain('RUNNING>TERMINATED:signal:9');
    expect(lb.executors.runtime(e ?? 0)?.has(burn.pid)).toBe(false);
    lb.checkInvariants();
  });

  it('PROC-07 without SAB (message fallback) a running process is still killed at its slice end', async () => {
    const lb = loopback({ sab: false });
    const burn = await lb.spawn('burn');
    expect(await lb.until(() => burn.state === 'RUNNING', 1_000)).toBe(true);
    const t0 = lb.clock.now();
    lb.kernel.proc.signalPid(burn.pid, 'SIGKILL');
    await lb.until(() => exited(burn), 2_000);
    expect(burn.exitCode).toBe(137);
    // Bounded by one quantum plus H_kill (the watchdog's forced termination).
    expect(lb.clock.now() - t0).toBeLessThanOrEqual(400);
    lb.checkInvariants();
  });

  it('PROC-07 kill works in READY and SUSPENDED-free states alike: a READY process parked behind a busy executor is terminated at once', async () => {
    const lb = loopback({ cores: 3, sched: { maxExecutors: 1 } });
    const a = await lb.spawn('burn');
    const b = await lb.spawn('burn');
    expect(
      await lb.until(
        () =>
          (a.state === 'READY' && b.state === 'RUNNING') ||
          (b.state === 'READY' && a.state === 'RUNNING'),
        1_000,
      ),
    ).toBe(true);
    const ready = a.state === 'READY' ? a : b;
    lb.kernel.proc.signalPid(ready.pid, 'SIGKILL');
    expect(ready.state).toBe('TERMINATED');
    expect(trace(lb, ready.pid)).toContain('READY>TERMINATED:signal:9');
    lb.checkInvariants();
  });
});

describe('KPS-09 signals (syscalls)', () => {
  it('KPS-09 SIGTERM and SIGINT terminate by default (143, 130); a caught SIGTERM runs the hook and interrupts the blocked call with ECANCELED', async () => {
    const lb = loopback();
    const { rec } = await runScript(lb, 'signal-children');
    expect(rec['killD']).toEqual({ delivered: 1 });
    expect(rec['waitD']).toMatchObject({
      status: { kind: 'signaled', signal: 'SIGTERM', code: 143 },
    });
    expect(rec['waitC']).toMatchObject({ status: { kind: 'exited', code: 42 } });
    expect(rec['waitI']).toMatchObject({
      status: { kind: 'signaled', signal: 'SIGINT', code: 130 },
    });
    const c = (rec['waitC'] as { pid: number }).pid;
    expect(recordOf(c)['signals']).toEqual(['SIGTERM']);
    expect(recordOf(c)['sleep']).toEqual({ errno: 'ECANCELED' });
    lb.checkInvariants();
  });

  it('PROC-07 kill rules: init is never signalled (EPERM), a missing pid is ESRCH, another user needs kill.other (EPERM, audited), signal 0 probes', async () => {
    const lb = loopback();
    const bobs = await lb.spawn('script', {
      argv: ['script', 'term-default'],
      cred: { uid: 1002, gid: 1002, groups: [], ruid: 1002 },
    });
    const p = await lb.spawn('script', { argv: ['script', 'kill-rules', String(bobs.pid)] });
    await lb.until(() => exited(p), 5_000);
    const rec = recordOf(p.pid);
    expect(rec['init']).toEqual({ errno: 'EPERM' });
    expect(rec['missing']).toEqual({ errno: 'ESRCH' });
    expect(rec['foreign']).toEqual({ errno: 'EPERM' });
    expect(rec['probe']).toEqual({ delivered: 0 });
    expect(bobs.state).not.toBe('TERMINATED');
    // The refused cross-user kill is a security audit record.
    expect(
      lb.kernel.klog
        .read({ filter: (r) => r.kind === 'line' && r.msg.includes('security: kill SIGKILL') })
        .map((r) => r.pid),
    ).toContain(p.pid);
    lb.kernel.proc.signalPid(bobs.pid, 'SIGKILL');
    lb.checkInvariants();
  });
});

describe('PROC-07 leak check (INV-P7)', () => {
  it('PROC-07 after a random mix of spawns, blocks and kills, no table, heap, token, timer, fd or lock refers to a dead process', async () => {
    const lb = await mounted({ cores: 4 });
    const { fs, locks } = await lb.mountFs();
    let seed = 12_345;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % n;
    };
    const kinds = ['burn', 'sleeper', 'victim', 'term-catch', 'term-default'] as const;
    const signals: readonly SignalName[] = ['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP'];
    const live: number[] = [];
    for (let round = 0; round < 30; round++) {
      const kind = kinds[rand(kinds.length)] ?? 'burn';
      const p =
        kind === 'burn'
          ? await lb.spawn('burn', { argv: ['burn', String(200 + rand(400))] })
          : await lb.spawn('script', { argv: ['script', kind] });
      live.push(p.pid);
      await lb.runFor(rand(30));
      if (rand(3) === 0 && live.length > 0) {
        const victim = live.splice(rand(live.length), 1)[0] ?? 0;
        lb.kernel.proc.signalPid(victim, signals[rand(signals.length)] ?? 'SIGKILL');
      }
      lb.checkInvariants();
    }
    for (const pid of live) lb.kernel.proc.signalPid(pid, 'SIGKILL');
    await lb.runFor(2_000);
    lb.checkInvariants();
    const alive = [...lb.kernel.procs.table.values()].filter(
      (p) => p.kind === 'user' && p.state !== 'TERMINATED',
    );
    expect(alive).toEqual([]);
    expect(fs.fds.list().filter((x) => x.pid !== 0)).toEqual([]);
    for (const p of lb.kernel.procs.table.values())
      expect(lb.kernel.timers.timersOf(p.pid)).toEqual([]);
    expect(lb.kernel.proc.sched.runningCount).toBe(0);
    expect(lb.kernel.proc.sched.readyCount).toBe(0);
    expect(lb.kernel.proc.stats()).toEqual({
      inflight: 0,
      cancels: 0,
      loads: 0,
      memReqs: 0,
      waiters: 0,
    });
    const ino = recordOf(live[0] ?? 0)['ino'];
    if (typeof ino === 'string') expect(locks.holders(ino)).toEqual([]);
    for (let e = 0; e < 8; e++) expect(lb.executors.runtime(e)?.residents ?? 0).toBe(0);
  });
});
