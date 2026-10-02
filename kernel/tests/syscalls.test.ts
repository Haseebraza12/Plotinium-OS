import { describe, expect, it } from 'vitest';

import { DEV_IDENTITY } from '../src/core/host.ts';
import type { Caller } from '../src/core/ipc/ports.ts';
import { createKernel } from '../src/core/kernel.ts';
import type { PCB } from '../src/core/proc/pcb.ts';
import { StaticUserDirectory } from '../src/core/proc/users.ts';
import { ManualClock } from '../src/host/clock.ts';
import { LOOPBACK_PLATFORM } from '../src/host/loopback.ts';

const identity = {
  ...DEV_IDENTITY,
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-11-02',
  codename: 'Orthorhombic',
};

function setup() {
  const clock = new ManualClock({
    epoch0: Date.UTC(2026, 10, 2, 8, 0, 0),
    tz: 'Asia/Karachi',
    offsetMin: 300,
  });
  const kernel = createKernel({
    host: { clock, identity, platform: LOOPBACK_PLATFORM },
    users: new StaticUserDirectory([
      [1001, 'alice'],
      [1002, 'bob'],
    ]),
  });
  const mk = (uid: number): PCB => {
    const p = kernel.procs.create({
      ppid: 1,
      kind: 'user',
      cls: 'user',
      name: 'sh',
      argv: ['sh', '-c', 'secret'],
      cred: { uid, gid: uid, groups: [], ruid: uid },
    });
    kernel.lifecycle.transition(p, 'READY', 'admit');
    return p;
  };
  const call = (
    name: 'uname' | 'dmesg' | 'time.now' | 'proc.list' | 'getpid',
    pcb: PCB,
    args: unknown,
  ): unknown => {
    const impl = kernel.handlers.get(name);
    const caller: Caller = { pcb, origin: 'E', wid: null };
    return impl?.handle(caller, args);
  };
  return { kernel, clock, mk, call };
}

describe('core syscalls', () => {
  it('PLT-ID-07 uname returns the build identity, the browser, the cores and the caller identity from its PCB', () => {
    const { mk, call } = setup();
    const alice = mk(1001);
    expect(call('uname', alice, {})).toEqual({
      sysname: 'Plotinium',
      version: '0.3.0',
      build: 'a1f93c2',
      buildDate: '2026-11-02',
      codename: 'Orthorhombic',
      browser: { brand: 'Chrome', major: 154 },
      cores: 8,
      uid: 1001,
      user: 'alice',
    });
    const root = mk(0);
    expect(call('uname', root, {})).toMatchObject({ uid: 0, user: 'root' });
  });

  it('AGT-07 time.now reads the frozen test clock (epoch, monotonic, zone, offset) so relative dates are reproducible', () => {
    const { mk, call, clock } = setup();
    clock.advance(1_500);
    expect(call('time.now', mk(1001), {})).toEqual({
      epochMs: Date.UTC(2026, 10, 2, 8, 0, 1, 500),
      monotonicMs: 1_500,
      tz: 'Asia/Karachi',
      tzOffsetMin: 300,
    });
  });

  it('PROC-08 proc.list shows every process and hides other users arguments', () => {
    const { mk, call } = setup();
    const alice = mk(1001);
    const bob = mk(1002);
    const page = call('proc.list', alice, { limit: 10 }) as {
      procs: { pid: number; argv: string[]; user: string }[];
    };
    expect(page.procs.map((p) => p.pid)).toEqual([1, alice.pid, bob.pid]);
    expect(page.procs.find((p) => p.pid === bob.pid)).toMatchObject({ argv: ['sh'], user: 'bob' });
    expect(page.procs.find((p) => p.pid === alice.pid)?.argv).toEqual(['sh', '-c', 'secret']);
    const next = call('proc.list', alice, { limit: 1 }) as { next?: string };
    expect(next.next).toBe('1');
    const filtered = call('proc.list', alice, { uid: 1002, pgid: 1, cursor: '0' }) as {
      procs: unknown[];
    };
    expect(filtered.procs).toHaveLength(1);
  });

  it('SYS-02 dmesg entries about other users processes are root-only', () => {
    const { mk, call, kernel } = setup();
    const alice = mk(1001);
    const bob = mk(1002);
    kernel.log('test', 'warn', 'about bob', bob.pid);
    kernel.log('test', 'warn', 'about a reaped pid', 30_000);
    const mine = call('dmesg', alice, {}) as { entries: { pid?: number; msg: string }[] };
    expect(mine.entries.some((e) => e.pid === bob.pid)).toBe(false);
    expect(mine.entries.some((e) => e.pid === alice.pid)).toBe(true);
    expect(mine.entries.some((e) => e.msg === 'about a reaped pid')).toBe(false);
    const all = call('dmesg', mk(0), { level: 'warn' }) as { entries: { msg: string }[] };
    expect(all.entries.map((e) => e.msg)).toEqual(['about bob', 'about a reaped pid']);
    const since = call('dmesg', mk(0), { since: kernel.klog.lastSeq - 1, limit: 1 }) as {
      entries: { seq: number }[];
    };
    expect(since.entries).toHaveLength(1);
  });

  it('SYS-01 getpid answers from the port-bound PCB', () => {
    const { mk, call } = setup();
    const p = mk(1001);
    expect(call('getpid', p, {})).toEqual({ pid: p.pid, ppid: 1, pgid: 1, sid: 1 });
  });

  it('ARC-06 the kernel starts with the no-op AI hooks and ai/ can register real ones', () => {
    const { kernel } = setup();
    expect(kernel.hooks.hooks.search.available()).toBe('none');
    expect(kernel.hooks.hooks.shell.available()).toBe(false);
    expect(kernel.hooks.hooks.scheduler.residencyHint()).toBeNull();
    kernel.hooks.hooks.scheduler.onIdle(2_000);
    kernel.hooks.register({ search: { available: () => 'keyword' } });
    expect(kernel.hooks.hooks.search.available()).toBe('keyword');
    expect(kernel.hooks.hooks.shell.available()).toBe(false);
    kernel.hooks.reset();
    expect(kernel.hooks.hooks.search.available()).toBe('none');
  });

  it('ABI-08 the OS session id on audit records can be replaced by the session service', () => {
    const { kernel } = setup();
    const first = kernel.osSessionId;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    kernel.osSessionId = '0192f0c1-0000-7000-8000-000000000001';
    expect(kernel.osSessionId).toBe('0192f0c1-0000-7000-8000-000000000001');
  });
});
