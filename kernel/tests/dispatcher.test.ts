import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Cap, SysRes } from '@plotinium/protocol';
import { ABI_VERSION, abiDigest } from '@plotinium/protocol';

import { KernelError } from '../src/core/errors.ts';
import { DEV_IDENTITY } from '../src/core/host.ts';
import { MemoryAuditSink } from '../src/core/ipc/audit.ts';
import { NO_REPLY } from '../src/core/ipc/handlers.ts';
import type { ExecPortRec } from '../src/core/ipc/ports.ts';
import { execPort, viewPort } from '../src/core/ipc/ports.ts';
import type { Kernel } from '../src/core/kernel.ts';
import { createKernel } from '../src/core/kernel.ts';
import type { PCB } from '../src/core/proc/pcb.ts';
import { ManualClock } from '../src/host/clock.ts';
import { LOOPBACK_PLATFORM } from '../src/host/loopback.ts';

interface Rig {
  kernel: Kernel;
  sink: MemoryAuditSink;
  port: ExecPortRec;
  replies: { pid: number; res: SysRes }[];
  proc(opts?: {
    uid?: number;
    caps?: Cap[];
    cls?: 'user' | 'agent' | 'system';
    fsScope?: string[];
  }): PCB;
  call(pcb: PCB, req: unknown, stamp?: { pid?: number; sliceSeq?: number }): SysRes | undefined;
  suspects: number[];
  violations: (number | null)[];
}

function rig(ai = true): Rig {
  const sink = new MemoryAuditSink();
  const suspects: number[] = [];
  const violations: (number | null)[] = [];
  const kernel = createKernel({
    host: { clock: new ManualClock(), identity: DEV_IDENTITY, platform: LOOPBACK_PLATFORM },
    ai,
    auditSink: sink,
    onSuspectExecutor: (p) => suspects.push(p.index),
    onAbiViolation: (pid) => violations.push(pid),
  });
  const replies: { pid: number; res: SysRes }[] = [];
  const port = execPort(0, (pid, res) => replies.push({ pid, res }));
  let seq = 0;
  return {
    kernel,
    sink,
    port,
    replies,
    suspects,
    violations,
    proc: (o = {}) => {
      const uid = o.uid ?? 1001;
      const p = kernel.procs.create({
        ppid: 1,
        kind: 'user',
        cls: o.cls ?? 'user',
        name: 'p',
        cred: { uid, gid: uid, groups: [], ruid: uid },
        caps: o.caps ?? ['proc', 'fs.read'],
      });
      if (o.fsScope) p.fsScope = o.fsScope;
      p.worker = 0;
      kernel.lifecycle.transition(p, 'READY', 'admit');
      kernel.lifecycle.transition(p, 'RUNNING', 'dispatch');
      return p;
    },
    call: (pcb, req, stamp = {}) => {
      seq++;
      port.slice = { pid: pcb.pid, sliceSeq: seq };
      const before = replies.length;
      kernel.execFrame(port, { pid: stamp.pid ?? pcb.pid, sliceSeq: stamp.sliceSeq ?? seq, req });
      return replies[before]?.res;
    },
  };
}

const errnoOf = (res: SysRes | undefined): string | undefined =>
  res && !res.ok ? res.errno : undefined;

describe('dispatcher', () => {
  it('ABI-01 every reply carries the request id and exactly one of value or errno', () => {
    const r = rig();
    const p = r.proc();
    const ok = r.call(p, { id: 41, call: 'getpid', args: {} });
    expect(ok).toEqual({ id: 41, ok: true, value: { pid: p.pid, ppid: 1, pgid: 1, sid: 1 } });
    const bad = r.call(p, { id: 42, call: 'nosuch.call', args: {} });
    expect(bad).toMatchObject({ id: 42, ok: false, errno: 'ENOSYS' });
    expect(bad && 'value' in bad).toBe(false);
  });

  it('ABI-03 a request failing every stage gets ESRCH, then with a live caller ENOSYS, then EINVAL, then EPERM, then EACCES', () => {
    const r = rig();
    const p = r.proc({ caps: [] });
    // Stage 1 fails first: nothing dispatched on the port.
    r.port.slice = null;
    const before = r.replies.length;
    r.kernel.execFrame(r.port, {
      pid: p.pid,
      sliceSeq: 1,
      req: { id: 1, call: 'nosuch', args: { junk: 1 } },
    });
    expect(errnoOf(r.replies[before]?.res)).toBe('ESRCH');
    expect(errnoOf(r.call(p, { id: 2, call: 'nosuch', args: { junk: 1 } }))).toBe('ENOSYS');
    // proc.list exists; a bad arg fails at stage 3 before the (absent) capability matters.
    r.kernel.handlers.register('kill', { handle: () => ({ delivered: 1 }) });
    expect(errnoOf(r.call(p, { id: 3, call: 'kill', args: { pid: 'x', sig: 'SIGTERM' } }))).toBe(
      'EINVAL',
    );
    // Well-formed kill without the `proc` capability: stage 4.
    expect(errnoOf(r.call(p, { id: 4, call: 'kill', args: { pid: 5, sig: 'SIGTERM' } }))).toBe(
      'EPERM',
    );
    // With the capability, stage 5 authorize decides.
    r.kernel.handlers.register('kill', {
      authorize: () => new KernelError('EACCES'),
      handle: () => ({ delivered: 1 }),
    });
    const q = r.proc({ caps: ['proc'] });
    expect(errnoOf(r.call(q, { id: 5, call: 'kill', args: { pid: 5, sig: 'SIGTERM' } }))).toBe(
      'EACCES',
    );
  });

  it('ABI-04 an args object with an unknown key uid is rejected with EINVAL naming the field, never the value', () => {
    const r = rig();
    const res = r.call(r.proc(), { id: 7, call: 'uname', args: { uid: 0 } });
    expect(res).toMatchObject({ ok: false, errno: 'EINVAL', detail: { field: 'uid' } });
    expect(res && !res.ok ? res.msg : '').not.toContain('0)');
  });

  it('VFS-08 a path argument over 4096 bytes fails at stage 3 with ENAMETOOLONG', () => {
    const r = rig();
    r.kernel.handlers.register('stat', { handle: () => ({}) as never });
    const res = r.call(r.proc(), { id: 8, call: 'stat', args: { path: `/${'a'.repeat(4_096)}` } });
    expect(errnoOf(res)).toBe('ENAMETOOLONG');
  });

  it('SYS-01 B5 a syscall frame whose stamped pid differs from the dispatched pid gets ESRCH and a security audit record', () => {
    const r = rig();
    const a = r.proc();
    const b = r.proc();
    expect(errnoOf(r.call(a, { id: 1, call: 'getpid', args: {} }, { pid: b.pid }))).toBe('ESRCH');
    const audit = r.kernel.klog.read({
      filter: (rec) => rec.kind === 'line' && rec.sub === 'audit',
    });
    expect(audit.at(-1)).toMatchObject({ level: 'warn' });
    expect(r.suspects).toEqual([]);
    expect(errnoOf(r.call(a, { id: 2, call: 'getpid', args: {} }, { sliceSeq: 999 }))).toBe(
      'ESRCH',
    );
    expect(r.suspects).toEqual([0]);
  });

  it('SYS-01 a frame for a process that is not resident on this executor or is terminated gets ESRCH', () => {
    const r = rig();
    const p = r.proc();
    p.worker = 3;
    expect(errnoOf(r.call(p, { id: 1, call: 'getpid', args: {} }))).toBe('ESRCH');
  });

  it('SYS-01 B8 malformed frames fail closed: a readable id gets EINVAL, an unreadable one is dropped and the caller ended', () => {
    const r = rig();
    const p = r.proc();
    expect(errnoOf(r.call(p, { id: 9, call: 42, args: {} }))).toBe('EINVAL');
    expect(r.call(p, { call: 'getpid', args: {} })).toBeUndefined();
    expect(r.call(p, 'garbage')).toBeUndefined();
    expect(r.violations).toEqual([p.pid, p.pid]);
  });

  it('ABI-06 an agent-class process gets EPERM for a call whose capability is outside its set', () => {
    const r = rig();
    r.kernel.handlers.register('mkdir', { handle: () => ({}) as never });
    const agent = r.proc({ cls: 'agent', caps: ['fs.read', 'fs.scope', 'ai.plan', 'mem'] });
    const res = r.call(agent, { id: 1, call: 'mkdir', args: { path: '/home/alice/x' } });
    expect(res).toMatchObject({ errno: 'EPERM', detail: { reason: 'capability' } });
    expect(r.sink.records.some((rec) => rec.level === 'agent' && rec.outcome === 'rejected')).toBe(
      true,
    );
  });

  it('AGT-04 a scoped process gets EPERM scope for a path outside its prefixes', () => {
    const r = rig();
    r.kernel.handlers.register('stat', { handle: () => ({}) as never });
    const scoped = r.proc({ caps: ['fs.read', 'fs.scope'], fsScope: ['/home/alice'] });
    expect(
      r.call(scoped, { id: 1, call: 'stat', args: { path: '/system/services' } }),
    ).toMatchObject({ detail: { reason: 'scope', path: '/system/services' } });
    expect(
      r.call(scoped, { id: 2, call: 'stat', args: { path: '/home/alice/notes.md' } }),
    ).toMatchObject({ ok: true });
    scoped.cwdPath = '/home/alice';
    expect(errnoOf(r.call(scoped, { id: 3, call: 'stat', args: { path: '../bob' } }))).toBe(
      'EPERM',
    );
  });

  it('ABI-12 handler failures become replies: KernelError keeps its errno, anything else is EIO and logged', async () => {
    const r = rig();
    const p = r.proc();
    r.kernel.handlers.register('uptime', {
      handle: () => {
        throw new KernelError('EAGAIN', { reason: 'rate' });
      },
    });
    expect(r.call(p, { id: 1, call: 'uptime', args: {} })).toMatchObject({
      errno: 'EAGAIN',
      detail: { reason: 'rate' },
    });
    r.kernel.handlers.register('uptime', {
      handle: () => {
        throw new TypeError('oops');
      },
    });
    expect(errnoOf(r.call(p, { id: 2, call: 'uptime', args: {} }))).toBe('EIO');
    expect(r.kernel.klog.read({ level: 'fail' }).at(-1)).toMatchObject({ sub: 'ipc' });
    r.kernel.handlers.register('uptime', {
      handle: () => Promise.reject(new KernelError('ETIMEDOUT')),
    });
    r.call(p, { id: 3, call: 'uptime', args: {} });
    r.kernel.handlers.register('uptime', {
      handle: () =>
        Promise.resolve({
          bootAt: 0,
          uptimeMs: 1,
          users: 1,
          load: [0, 0, 0] as [number, number, number],
        }),
    });
    r.call(p, { id: 4, call: 'uptime', args: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.replies.map((x) => x.res.id).slice(-2)).toEqual([3, 4]);
    expect(errnoOf(r.replies.at(-2)?.res)).toBe('ETIMEDOUT');
  });

  it('ABI-02 a reply to a process that terminated meanwhile is dropped, and exit sends none', async () => {
    const r = rig();
    const p = r.proc();
    let release: (v: {
      bootAt: number;
      uptimeMs: number;
      users: number;
      load: [number, number, number];
    }) => void = () => undefined;
    r.kernel.handlers.register('uptime', {
      handle: () =>
        new Promise((res) => {
          release = res;
        }),
    });
    const before = r.replies.length;
    r.call(p, { id: 1, call: 'uptime', args: {} });
    r.kernel.procs.terminate(p, 'signal:9', { code: 137, reason: 'signal' });
    release({ bootAt: 0, uptimeMs: 0, users: 0, load: [0, 0, 0] });
    await Promise.resolve();
    expect(r.replies.length).toBe(before);
    r.kernel.handlers.register('exit', { handle: () => NO_REPLY });
    const q = r.proc();
    expect(r.call(q, { id: 2, call: 'exit', args: { code: 0 } })).toBeUndefined();
  });

  it('ABI-11 the AI-off build answers ENOSYS for every ai.* call (litmus)', () => {
    const r = rig(false);
    r.kernel.handlers.register('ai.predict', {
      handle: () => ({ predictions: [], model: 'mfu', launches: 0, updatedAt: 0 }),
    });
    expect(errnoOf(r.call(r.proc(), { id: 1, call: 'ai.predict', args: {} }))).toBe('ENOSYS');
    const on = rig(true);
    on.kernel.handlers.register('ai.predict', {
      handle: () => ({ predictions: [], model: 'mfu', launches: 0, updatedAt: 0 }),
    });
    expect(on.call(on.proc(), { id: 1, call: 'ai.predict', args: {} })).toMatchObject({ ok: true });
  });

  it('ABI-08 security-level calls write a durable record with a digest and a redacted summary', () => {
    const r = rig();
    r.kernel.handlers.register('svc.restart', { handle: () => ({}) });
    const root = r.proc({ uid: 0, caps: ['sys.admin'] });
    r.call(root, { id: 1, call: 'svc.restart', args: { name: 'sync' } });
    const rec = r.sink.records.at(-1);
    expect(rec).toMatchObject({
      level: 'security',
      call: 'svc.restart',
      outcome: 'ok',
      pid: root.pid,
      uid: 0,
    });
    expect(rec?.argsDigest).toMatch(/^[0-9a-f]{64}$/);
    const user = r.proc();
    r.call(user, { id: 2, call: 'svc.restart', args: { name: 'sync' } });
    expect(r.sink.records.at(-1)).toMatchObject({
      outcome: 'rejected',
      errno: 'EPERM',
      errnoCode: 1,
    });
  });

  it('ABI-12 fast-check arbitrary frames never make the dispatcher throw and never leave a readable id unanswered', () => {
    const r = rig();
    const p = r.proc();
    fc.assert(
      fc.property(
        fc.anything(),
        fc.oneof(fc.constant('getpid'), fc.constant('uname'), fc.string()),
        fc.anything(),
        (idLike, call, args) => {
          const id =
            typeof idLike === 'number' &&
            Number.isInteger(idLike) &&
            idLike >= 0 &&
            idLike <= 0xffff_ffff
              ? idLike
              : 5;
          const res = r.call(p, { id, call, args });
          expect(res?.id).toBe(id);
          expect(() => r.call(p, idLike)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('view ports', () => {
  it('ABI-10 a view without a matching hello is refused and closed with abi-mismatch', () => {
    const r = rig();
    const p = r.proc();
    p.windows.add(7);
    const replies: SysRes[] = [];
    let closed = '';
    const vp = viewPort(
      p.pid,
      7,
      (res) => replies.push(res),
      (why) => (closed = why),
    );
    r.kernel.viewMessage(vp, { t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
    expect(vp.greeted).toBe(true);
    r.kernel.viewMessage(vp, { t: 'req', req: { id: 1, call: 'getpid', args: {} } });
    expect(replies[0]).toMatchObject({ ok: true, value: { pid: p.pid } });
    r.kernel.viewMessage(vp, { t: 'hello', abi: ABI_VERSION + 1, digest: abiDigest() });
    expect(closed).toBe('abi-mismatch');
    expect(vp.open).toBe(false);
    r.kernel.viewMessage(vp, { t: 'req', req: { id: 2, call: 'getpid', args: {} } });
    expect(replies).toHaveLength(1);
  });

  it('ABI-15 a view port answers ENOSYS for write, unlink and spawn', () => {
    const r = rig();
    for (const name of ['write', 'unlink', 'spawn'] as const)
      r.kernel.handlers.register(name, { handle: () => ({}) as never });
    const p = r.proc({ caps: ['fs.read', 'fs.write', 'proc'] });
    p.windows.add(3);
    const replies: SysRes[] = [];
    const vp = viewPort(
      p.pid,
      3,
      (res) => replies.push(res),
      () => undefined,
    );
    r.kernel.viewMessage(vp, {
      t: 'req',
      req: { id: 1, call: 'write', args: { fd: 1, data: new ArrayBuffer(1) } },
    });
    r.kernel.viewMessage(vp, {
      t: 'req',
      req: { id: 2, call: 'unlink', args: { path: '/tmp/x' } },
    });
    r.kernel.viewMessage(vp, {
      t: 'req',
      req: { id: 3, call: 'spawn', args: { path: '/bin/sh', argv: [] } },
    });
    expect(replies.map(errnoOf)).toEqual(['ENOSYS', 'ENOSYS', 'ENOSYS']);
  });

  it('SYS-01 B8 the 65th outstanding view call gets EAGAIN view-backlog and a gone window gets ESRCH', () => {
    const r = rig();
    const p = r.proc();
    p.windows.add(1);
    r.kernel.handlers.register('uptime', { handle: () => new Promise(() => undefined) });
    const replies: SysRes[] = [];
    const vp = viewPort(
      p.pid,
      1,
      (res) => replies.push(res),
      () => undefined,
    );
    for (let i = 1; i <= 65; i++)
      r.kernel.viewMessage(vp, { t: 'req', req: { id: i, call: 'uptime', args: {} } });
    expect(replies).toEqual([
      {
        id: 65,
        ok: false,
        errno: 'EAGAIN',
        msg: 'too many outstanding calls',
        detail: { reason: 'view-backlog' },
      },
    ]);
    const vp2 = viewPort(
      p.pid,
      99,
      (res) => replies.push(res),
      () => undefined,
    );
    r.kernel.viewMessage(vp2, { t: 'req', req: { id: 1, call: 'getpid', args: {} } });
    expect(errnoOf(replies.at(-1))).toBe('ESRCH');
    r.kernel.viewMessage(vp2, { t: 'req', req: { id: 'x' } });
    expect(errnoOf(replies.at(-1))).toBe('ESRCH');
    r.kernel.viewMessage(vp2, { t: 'bogus' });
    expect(vp2.open).toBe(false);
  });
});
