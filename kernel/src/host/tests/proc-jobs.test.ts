/**
 * KPS-09 signals, process groups, sessions and TTY job control through the system calls on the
 * process loopback host (processes-and-scheduling.md §3.17; syscall-abi.md §3.9): stop and
 * continue with `wait {untraced, continued}`, group signalling with `kill(-pgid)`, `setpgid`,
 * `tcsetpgrp` / `tcgetpgrp` and the foreground group per TTY, the line discipline's kernel-authority
 * signals (Ctrl-C, Ctrl-Z) to the foreground group only, SIGTTIN / SIGTTOU for background jobs and
 * SIGHUP when the session leader exits.
 */
import { describe, expect, it } from 'vitest';

import {
  attempt,
  defineScript,
  exited,
  loopback,
  recordOf,
  runScript,
  trace,
} from './proc-harness.ts';

const TTY = 7;

defineScript('stop-cont', function* (ctx, rec) {
  const c = yield* ctx.sys.spawn({ path: '/bin/burn.json', argv: ['burn'], pgid: 0 });
  rec['child'] = c.pid;
  yield* ctx.sleep(20);
  rec['tstp'] = yield* ctx.sys.kill({ pid: c.pid, sig: 'SIGTSTP' });
  rec['stopped'] = yield* ctx.sys.wait({ pid: c.pid, untraced: true });
  rec['infoStopped'] = yield* ctx.sys['proc.info']({ pid: c.pid });
  yield* ctx.sleep(50);
  rec['cont'] = yield* ctx.sys.kill({ pid: c.pid, sig: 'SIGCONT' });
  rec['continued'] = yield* ctx.sys.wait({ pid: c.pid, continued: true });
  yield* ctx.sleep(20);
  rec['infoRunning'] = yield* ctx.sys['proc.info']({ pid: c.pid });
  yield* ctx.sys.kill({ pid: c.pid, sig: 'SIGKILL' });
  rec['end'] = yield* ctx.sys.wait({ pid: c.pid });
  return 0;
});

defineScript('group', function* (ctx, rec) {
  const a = yield* ctx.sys.spawn({
    path: '/bin/script.json',
    argv: ['script', 'forever'],
    pgid: 0,
  });
  const b = yield* ctx.sys.spawn({
    path: '/bin/script.json',
    argv: ['script', 'forever'],
    pgid: a.pid,
  });
  const c = yield* ctx.sys.spawn({
    path: '/bin/script.json',
    argv: ['script', 'forever'],
    pgid: a.pid,
  });
  const other = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'forever'] });
  rec['members'] = [a.pid, b.pid, c.pid];
  rec['badGroup'] = yield* attempt(
    ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'forever'], pgid: 29_999 }),
  );
  yield* ctx.sleep(10);
  rec['kill'] = yield* ctx.sys.kill({ pid: -a.pid, sig: 'SIGTERM' });
  rec['w1'] = yield* ctx.sys.wait({ pid: -a.pid });
  rec['w2'] = yield* ctx.sys.wait({ pid: -a.pid });
  rec['w3'] = yield* ctx.sys.wait({ pid: -a.pid });
  rec['none'] = yield* attempt(ctx.sys.wait({ pid: -a.pid, nohang: true }));
  rec['otherAlive'] = yield* ctx.sys.kill({ pid: other.pid, sig: 0 });
  // setpgid: a child into a new group of its own, a non-child is ESRCH.
  rec['setpgid'] = yield* ctx.sys.setpgid({ pid: other.pid, pgid: 0 });
  rec['notChild'] = yield* attempt(ctx.sys.setpgid({ pid: 1, pgid: 0 }));
  yield* ctx.sys.kill({ pid: other.pid, sig: 'SIGKILL' });
  yield* ctx.sys.wait({ pid: other.pid });
  return 0;
});

/** A login shell on TTY 7: runs a foreground job, then takes the terminal back. */
defineScript('shell', function* (ctx, rec) {
  // Shells ignore SIGTTOU so they can take the terminal back from the background.
  yield* ctx.sys['sig.action']({ sig: 'SIGTTOU', action: 'ignore' });
  yield* ctx.sys['sig.action']({ sig: 'SIGINT', action: 'ignore' });
  rec['fg0'] = yield* ctx.sys.tcgetpgrp({ fd: 0 });
  const job = yield* ctx.sys.spawn({ path: '/bin/burn.json', argv: ['burn'], pgid: 0 });
  rec['job'] = job.pid;
  yield* ctx.sys.tcsetpgrp({ fd: 0, pgid: job.pid });
  rec['fg1'] = yield* ctx.sys.tcgetpgrp({ fd: 0 });
  rec['ready'] = true;
  // Ctrl-Z (from the test, as the line discipline) stops the job: the shell sees it.
  rec['stop'] = yield* ctx.sys.wait({ pid: job.pid, untraced: true });
  yield* ctx.sys.tcsetpgrp({ fd: 0, pgid: ctx.pgid });
  rec['fg2'] = yield* ctx.sys.tcgetpgrp({ fd: 0 });
  // `fg`: give the terminal back, continue it; Ctrl-C then kills it.
  yield* ctx.sys.tcsetpgrp({ fd: 0, pgid: job.pid });
  yield* ctx.sys.kill({ pid: -job.pid, sig: 'SIGCONT' });
  rec['fgReady'] = true;
  rec['end'] = yield* ctx.sys.wait({ pid: job.pid });
  yield* ctx.sys.tcsetpgrp({ fd: 0, pgid: ctx.pgid });
  // A background job that does not ignore SIGTTOU cannot take the terminal.
  const bg = yield* ctx.sys.spawn({
    path: '/bin/script.json',
    argv: ['script', 'bg-grab'],
    pgid: 0,
  });
  rec['bg'] = yield* ctx.sys.wait({ pid: bg.pid, untraced: true });
  rec['fgAfterBg'] = yield* ctx.sys.tcgetpgrp({ fd: 0 });
  // Continued, it sees its tcsetpgrp refused (the reply waited while it was stopped).
  yield* ctx.sys.kill({ pid: bg.pid, sig: 'SIGCONT' });
  yield* ctx.sleep(20);
  yield* ctx.sys.kill({ pid: bg.pid, sig: 'SIGKILL' });
  rec['bgEnd'] = yield* ctx.sys.wait({ pid: bg.pid });
  // A foreground job that outlives the shell is hung up when the session leader exits.
  const orphan = yield* ctx.sys.spawn({
    path: '/bin/script.json',
    argv: ['script', 'forever'],
    pgid: 0,
  });
  yield* ctx.sys.tcsetpgrp({ fd: 0, pgid: orphan.pid });
  rec['orphan'] = orphan.pid;
  return 0;
});

defineScript('bg-grab', function* (ctx, rec) {
  rec['r'] = yield* attempt(ctx.sys.tcsetpgrp({ fd: 0, pgid: ctx.pgid }));
  yield* ctx.sleep(1_000_000);
  return 0;
});

describe('KPS-09 stop, continue and wait (syscalls)', () => {
  it('KPS-09 SIGTSTP stops a job (BLOCKED sigcont, wait untraced reports it), SIGCONT resumes it (wait continued)', async () => {
    const lb = loopback();
    const { rec, code } = await runScript(lb, 'stop-cont');
    expect(code).toBe(0);
    const child = rec['child'] as number;
    expect(rec['tstp']).toEqual({ delivered: 1 });
    expect(rec['stopped']).toEqual({ pid: child, status: { kind: 'stopped', signal: 'SIGTSTP' } });
    expect(rec['infoStopped']).toMatchObject({
      pid: child,
      state: 'BLOCKED',
      waitingOn: 'sigcont',
    });
    expect(rec['continued']).toEqual({ pid: child, status: { kind: 'continued' } });
    expect((rec['infoRunning'] as { state: string }).state).toMatch(/READY|RUNNING/);
    expect(rec['end']).toMatchObject({ status: { kind: 'signaled', signal: 'SIGKILL' } });
    const t = trace(lb, child);
    expect(t.some((x) => x.endsWith('>BLOCKED:signal:20'))).toBe(true);
    expect(t).toContain('BLOCKED>READY:cont');
    lb.checkInvariants();
  });
});

describe('KPS-09 process groups (syscalls)', () => {
  it('KPS-09 kill(-pgid) signals every member of the group and nothing else; setpgid and spawn pgid follow the session rules', async () => {
    const lb = loopback();
    const { rec, code } = await runScript(lb, 'group');
    expect(code).toBe(0);
    const members = rec['members'] as number[];
    expect(rec['kill']).toEqual({ delivered: 3 });
    const reaped = [rec['w1'], rec['w2'], rec['w3']]
      .map((w) => (w as { pid: number }).pid)
      .sort((x, y) => x - y);
    expect(reaped).toEqual([...members].sort((x, y) => x - y));
    for (const w of [rec['w1'], rec['w2'], rec['w3']])
      expect(w).toMatchObject({ status: { kind: 'signaled', signal: 'SIGTERM', code: 143 } });
    expect(rec['none']).toEqual({ errno: 'ESRCH' });
    expect(rec['otherAlive']).toEqual({ delivered: 0 });
    expect(rec['badGroup']).toEqual({ errno: 'EPERM' });
    expect(rec['notChild']).toEqual({ errno: 'ESRCH' });
    expect((rec['setpgid'] as { pgid: number }).pgid).toBeGreaterThan(0);
    lb.checkInvariants();
  });
});

describe('KPS-09 TTY job control (syscalls)', () => {
  it('KPS-09 the foreground group per TTY: tcsetpgrp/tcgetpgrp, Ctrl-Z and Ctrl-C reach only the foreground job, SIGTTOU stops a background grab, SIGHUP on leader exit', async () => {
    const lb = loopback();
    const sh = await lb.spawn('script', { argv: ['script', 'shell'], setsid: true, tty: TTY });
    expect(sh.sessionLeader).toBe(true);
    const rec = (): Record<string, unknown> => recordOf(sh.pid);
    expect(await lb.until(() => rec()['ready'] === true, 5_000)).toBe(true);
    expect(rec()['fg0']).toEqual({ pgid: sh.pgid });
    const job = rec()['job'] as number;
    expect(rec()['fg1']).toEqual({ pgid: job });
    expect(lb.kernel.proc.jobs.foreground(TTY)).toBe(job);
    expect(lb.kernel.proc.jobs.isForeground(sh)).toBe(false);

    // Ctrl-Z: the line discipline signals the foreground group with kernel authority.
    await lb.runFor(20);
    expect(lb.kernel.proc.jobs.ttySignal(TTY, 'SIGTSTP')).toBe(1);
    expect(await lb.until(() => rec()['fgReady'] === true, 5_000)).toBe(true);
    expect(rec()['stop']).toEqual({ pid: job, status: { kind: 'stopped', signal: 'SIGTSTP' } });
    expect(rec()['fg2']).toEqual({ pgid: sh.pgid });

    // Ctrl-C: SIGINT to the foreground job only; the shell (background now) is untouched.
    await lb.runFor(20);
    expect(lb.kernel.proc.jobs.ttySignal(TTY, 'SIGINT')).toBe(1);
    await lb.until(() => exited(sh), 10_000);
    expect(rec()['end']).toMatchObject({
      pid: job,
      status: { kind: 'signaled', signal: 'SIGINT', code: 130 },
    });
    expect(sh.exitCode).toBe(0);

    // The background grab got SIGTTOU (stopped) and its tcsetpgrp failed with EPERM.
    expect(rec()['bg']).toMatchObject({ status: { kind: 'stopped', signal: 'SIGTTOU' } });
    expect(rec()['fgAfterBg']).toEqual({ pgid: sh.pgid });
    const bgPid = (rec()['bg'] as { pid: number }).pid;
    expect(recordOf(bgPid)['r']).toEqual({ errno: 'EPERM' });

    // The session leader exited while `forever` was the foreground group: SIGHUP (then SIGCONT).
    const orphan = rec()['orphan'] as number;
    await lb.until(() => lb.kernel.procs.get(orphan)?.exitCode != null, 5_000);
    const o = lb.kernel.procs.get(orphan);
    if (o !== undefined) expect(o.exitCode).toBe(129);
    else expect(trace(lb, orphan)).toContain('BLOCKED>TERMINATED:signal:1');
    expect(lb.kernel.proc.jobs.binding(TTY)).toBeUndefined();
    lb.checkInvariants();
  });

  it('KPS-09 a background reader gets SIGTTIN and stops; the foreground reader may read', async () => {
    const lb = loopback();
    const leader = await lb.spawn('script', {
      argv: ['script', 'forever'],
      setsid: true,
      tty: TTY,
    });
    lb.kernel.proc.jobs.attach(TTY, leader.sid, leader.pgid);
    const bg = await lb.spawn('burn', { parent: leader, pgid: 'new' });
    expect(bg.tty).toBe(TTY);
    expect(lb.kernel.proc.jobs.checkRead(leader, TTY)).toBe(true);
    expect(lb.kernel.proc.jobs.checkRead(bg, TTY)).toBe(false);
    await lb.until(() => bg.stopped && bg.state === 'BLOCKED', 1_000);
    expect(bg.waitingOn).toBe('sigcont');
    lb.kernel.proc.signalPid(bg.pid, 'SIGKILL');
    lb.kernel.proc.signalPid(leader.pid, 'SIGKILL');
    await lb.until(() => exited(bg) && exited(leader), 1_000);
    lb.checkInvariants();
  });
});

describe('KPS-12 focus boost', () => {
  it('KPS-12 focusing a Terminal boosts its process and the foreground job of its TTY; moving focus away removes the boost', async () => {
    const lb = loopback();
    const term = await lb.spawn('script', { argv: ['script', 'forever'], setsid: true, tty: TTY });
    lb.kernel.proc.jobs.attach(TTY, term.sid, term.pgid);
    const job = await lb.spawn('burn', { parent: term, pgid: 'new', nice: 5 });
    const other = await lb.spawn('script', { argv: ['script', 'forever'] });
    lb.kernel.proc.jobs.binding(TTY)!.fgPgid = job.pgid;
    lb.kernel.proc.focus(term.pid);
    expect(term.boosted).toBe(true);
    expect(job.boosted).toBe(true);
    expect(other.boosted).toBe(false);
    lb.kernel.proc.focus(other.pid);
    expect(term.boosted).toBe(false);
    expect(job.boosted).toBe(false);
    expect(other.boosted).toBe(true);
    lb.kernel.proc.focus(null);
    expect(other.boosted).toBe(false);
    for (const p of [job, term, other]) lb.kernel.proc.signalPid(p.pid, 'SIGKILL');
    await lb.runFor(20);
    lb.checkInvariants();
  });
});
