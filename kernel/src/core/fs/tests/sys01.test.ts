/**
 * SYS-01 (a permission check on every call), the VFS-04 permission matrix through the dispatcher,
 * and the VFS events on the kernel bus (ABI-07, SYS-03, PVFS-07).
 */
import type { KEvent, Stat } from '@plotinium/protocol';
import { INO } from '@plotinium/protocol';
import type { VfsEvent } from '@plotinium/vfs';
import { describe, expect, it } from 'vitest';

import { MemStore } from '../mem-store.ts';
import { FS_SYSCALLS } from '../syscalls.ts';
import type { Proc, World } from './harness.ts';
import { UID, boot, bytes, snapshot } from './harness.ts';

describe('SYS-01 permission checks on every call', () => {
  it('SYS-01 every fs call registered with the dispatcher has a stage-5 permission check', async () => {
    const w = await boot();
    for (const name of FS_SYSCALLS) {
      const impl = w.kernel.handlers.get(name);
      expect(impl, name).toBeDefined();
      expect(typeof impl?.authorize, name).toBe('function');
    }
  });

  it('SYS-01 a denied call is rejected at stage 5 before the handler and changes nothing', async () => {
    const w = await boot();
    const before = snapshot(w.store);
    const res = await w.bob.call('mkdir', { path: '/home/alice/x' });
    expect(res).toMatchObject({ ok: false, errno: 'EACCES' });
    expect(snapshot(w.store)).toBe(before);
    const trace = w.kernel.klog.read({ filter: (r) => r.kind === 'trace' }).at(-1);
    expect(trace).toMatchObject({
      kind: 'trace',
      call: 'mkdir',
      errno: 'EACCES',
      pid: w.bob.pcb.pid,
    });
  });

  it('SYS-01 the handler repeats every check when stage 5 met a directory not yet in memory', async () => {
    const store = new MemStore();
    await boot({ store });
    const w = await boot({ store }); // a fresh kernel on the same store: only / is in memory
    expect(w.fs.tree.isLoaded(INO.HOME)).toBe(false);
    const before = snapshot(w.store);
    expect(await w.bob.errno('mkdir', { path: '/home/alice/x' })).toBe('EACCES');
    expect(await w.bob.errno('writeFile', { path: '/home/alice/f', data: bytes('x') })).toBe(
      'EACCES',
    );
    expect(snapshot(w.store)).toBe(before);
    expect(w.fs.tree.isLoaded(INO.HOME)).toBe(true);
  });

  it('SYS-01 a uid smuggled into args is rejected at stage 3 with EINVAL', async () => {
    const w = await boot();
    expect(await w.bob.errno('mkdir', { path: '/home/alice/x', uid: 0 })).toBe('EINVAL');
    expect(await w.bob.errno('unlink', { path: '/home/alice', recursive: true, pid: 1 })).toBe(
      'EINVAL',
    );
  });

  it('SYS-01 a process without fs.write cannot mutate and an agent batch needs a plan token', async () => {
    const w = await boot();
    const reader = w.spawn(UID.alice, { caps: ['fs.read'] });
    expect(await reader.call('mkdir', { path: '/home/alice/x' })).toMatchObject({
      ok: false,
      errno: 'EPERM',
      detail: { reason: 'capability' },
    });
    expect(await reader.errno('stat', { path: '/home/alice' })).toBe('ok');
    const agent = w.spawn(UID.alice, { cls: 'agent', caps: ['fs.read', 'batch.grant'] });
    const batch = {
      txnId: '01920000-0000-7000-8000-00000000c001',
      ops: [{ op: 'mkdir', path: '/home/alice/by-agent' }],
      expectedVersions: [],
    };
    expect(await agent.call('batch', batch)).toMatchObject({
      ok: false,
      errno: 'EPERM',
      detail: { reason: 'no-token' },
    });
    expect(await agent.errno('mkdir', { path: '/home/alice/x' })).toBe('EPERM');
    expect(await w.alice.errno('stat', { path: '/home/alice/by-agent' })).toBe('ENOENT');
  });

  it('SYS-01 fs.scope is checked on the resolved path, so a symlink cannot escape the scope', async () => {
    const w = await boot();
    await w.alice.ok('symlink', { target: '/tmp', path: '/home/alice/esc' });
    const scoped = w.spawn(UID.alice, { caps: ['fs.read', 'fs.scope'], fsScope: ['/home/alice'] });
    expect(await scoped.errno('stat', { path: '/home/alice' })).toBe('ok');
    expect(await scoped.call('stat', { path: '/home/alice/esc' })).toMatchObject({
      ok: false,
      errno: 'EPERM',
      detail: { reason: 'scope', path: '/tmp' },
    });
    expect(await scoped.errno('lstat', { path: '/home/alice/esc' })).toBe('ok');
    expect(await scoped.errno('stat', { path: '/tmp' })).toBe('EPERM');
  });

  it("SYS-01 fd calls work only on the caller's own descriptors", async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('mine') });
    const { fd } = await w.alice.ok<{ fd: number }>('open', { path: '/home/alice/f', flags: 'r' });
    expect(await w.bob.errno('read', { fd, len: 10 })).toBe('EBADF');
    expect(await w.bob.errno('close', { fd })).toBe('EBADF');
    expect(await w.alice.errno('read', { fd, len: 10 })).toBe('ok');
  });
});

/**
 * The matrix: 3 users (owner alice, group member bob, other carol) × 9 modes × 8 operations, with an
 * independent oracle computed from the mode bits. Root is checked separately (it bypasses r and w).
 */
describe('VFS-04 permission matrix through the syscall layer', () => {
  const MODES = [0o000, 0o400, 0o200, 0o100, 0o644, 0o640, 0o604, 0o600, 0o755] as const;
  const bitsFor = (mode: number, who: 'owner' | 'group' | 'other'): number =>
    (mode >> (who === 'owner' ? 6 : who === 'group' ? 3 : 0)) & 7;

  async function setup(w: World): Promise<void> {
    await w.root.ok('mkdir', { path: '/shared' });
    await w.root.ok('chmod', { path: '/shared', mode: { op: 'set', bits: 0o777 } });
    for (const m of MODES) {
      const f = `/shared/f${m.toString(8)}`;
      const d = `/shared/d${m.toString(8)}`;
      await w.root.ok('writeFile', { path: f, data: bytes('x') });
      await w.root.ok('mkdir', { path: d });
      for (const u of ['alice', 'bob', 'carol'])
        await w.root.ok('writeFile', { path: `${d}/g-${u}`, data: bytes('g') });
      await w.root.ok('chown', { path: f, uid: UID.alice, gid: 100 });
      await w.root.ok('chown', { path: d, uid: UID.alice, gid: 100 });
      await w.root.ok('chmod', { path: f, mode: { op: 'set', bits: m } });
      await w.root.ok('chmod', { path: d, mode: { op: 'set', bits: m } });
    }
  }

  async function row(p: Proc, name: string, m: number): Promise<string[]> {
    const f = `/shared/f${m.toString(8)}`;
    const d = `/shared/d${m.toString(8)}`;
    const out: string[] = [];
    const r = await p.call('open', { path: f, flags: 'r' });
    out.push(r.ok ? 'ok' : r.errno);
    if (r.ok) await p.ok('close', { fd: (r.value as { fd: number }).fd });
    const wr = await p.call('open', { path: f, flags: 'w' });
    out.push(wr.ok ? 'ok' : wr.errno);
    if (wr.ok) await p.ok('close', { fd: (wr.value as { fd: number }).fd });
    out.push(await p.errno('stat', { path: f }));
    out.push(await p.errno('readdir', { path: d }));
    out.push(await p.errno('stat', { path: `${d}/g-${name}` }));
    out.push(await p.errno('open', { path: `${d}/new-${name}`, flags: 'w', create: true }));
    out.push(await p.errno('unlink', { path: `${d}/g-${name}` }));
    out.push(await p.errno('chmod', { path: f, mode: { op: 'set', bits: m } }));
    return out;
  }

  function oracle(m: number, who: 'owner' | 'group' | 'other'): string[] {
    const b = bitsFor(m, who);
    const yes = (ok: boolean, no = 'EACCES'): string => (ok ? 'ok' : no);
    return [
      yes((b & 4) !== 0),
      yes((b & 2) !== 0),
      'ok',
      yes((b & 4) !== 0),
      yes((b & 1) !== 0),
      yes((b & 3) === 3),
      yes((b & 3) === 3),
      yes(who === 'owner', 'EPERM'),
    ];
  }

  it('VFS-04 permission matrix of 3 users, 9 modes and 8 operations gives the rwx oracle results', async () => {
    const w = await boot();
    await setup(w);
    const users = [
      [w.alice, 'alice', 'owner'],
      [w.bob, 'bob', 'group'],
      [w.carol, 'carol', 'other'],
    ] as const;
    for (const m of MODES) {
      for (const [p, name, who] of users) {
        expect(await row(p, name, m), `${name} mode ${m.toString(8)}`).toEqual(oracle(m, who));
      }
    }
  });

  it('VFS-04 root bypasses r and w on every mode but still honours sticky-free ownership rules', async () => {
    const w = await boot();
    await setup(w);
    for (const m of MODES) {
      expect(await row(w.root, 'root', m), `root mode ${m.toString(8)}`).toEqual([
        'ok',
        'ok',
        'ok',
        'ok',
        'ENOENT', // root has no g-root file; resolution itself is allowed
        'ok',
        'ENOENT',
        'ok',
      ]);
    }
  });
});

describe('VFS events on the kernel bus', () => {
  const ROOT_CRED = { uid: 0, gid: 0, groups: [0] };

  it('VFS-07 committed mutations publish vfs events on the bus with their op id', async () => {
    const w = await boot();
    const sub = w.kernel.bus.subscribe(['vfs.*'], { cred: ROOT_CRED });
    const mk = await w.alice.ok<{ opId: string }>('mkdir', { path: '/home/alice/d' });
    await w.alice.ok('writeFile', { path: '/home/alice/d/f', data: bytes('1') });
    await w.alice.ok('writeFile', { path: '/home/alice/d/f', data: bytes('22') });
    await w.alice.ok('rename', { from: '/home/alice/d/f', to: '/home/alice/d/g' });
    await w.alice.ok('chmod', { path: '/home/alice/d/g', mode: { op: 'set', bits: 0o600 } });
    await w.alice.ok('unlink', { path: '/home/alice/d', recursive: true });
    const events = sub.take().events;
    expect(events.map((e) => e.topic)).toEqual([
      'vfs.create',
      'vfs.create',
      'vfs.write',
      'vfs.rename',
      'vfs.chmod',
      'vfs.unlink',
    ]);
    const first = events[0] as KEvent<'vfs.create'>;
    expect(first.data).toMatchObject({
      name: 'd',
      type: 'd',
      uid: UID.alice,
      origin: 'local',
      opId: mk.opId,
    });
    const write = events[2] as KEvent<'vfs.write'>;
    expect(write.data).toMatchObject({ size: 2, version: 2 });
    const unlink = events[5] as KEvent<'vfs.unlink'>;
    expect(unlink.data.inos).toHaveLength(2);
  });

  it('ABI-07 a vfs.write event under a 0700 home is not delivered to another uid', async () => {
    const w = await boot();
    const bob = w.kernel.bus.subscribe(['vfs.*'], {
      cred: { uid: UID.bob, gid: 100, groups: [100] },
    });
    const root = w.kernel.bus.subscribe(['vfs.*'], { cred: ROOT_CRED });
    await w.alice.ok('writeFile', { path: '/home/alice/secret', data: bytes('s') });
    await w.carol.ok('writeFile', { path: '/home/carol/public', data: bytes('p') });
    const seenByBob = bob.take().events;
    expect(seenByBob).toHaveLength(1);
    expect((seenByBob[0] as KEvent<'vfs.create'>).data.name).toBe('public');
    expect(root.take().events).toHaveLength(2);
  });

  it('VFS-07 an aborted transaction publishes no event and leaves the tree unchanged', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/t' });
    for (let i = 0; i < 3; i++)
      await w.alice.ok('writeFile', { path: `/home/alice/t/f${String(i)}`, data: bytes('x') });
    const seen: VfsEvent[] = [];
    w.fs.events.listen((ev) => seen.push(ev));
    const sub = w.kernel.bus.subscribe(['vfs.*'], { cred: ROOT_CRED });
    w.fs.faults.armFor('unlink', 2, w.fs.now());
    expect(await w.alice.errno('unlink', { path: '/home/alice/t', recursive: true })).toBe('EIO');
    expect(seen).toHaveLength(0);
    expect(sub.pending).toBe(0);
    expect(w.fs.tree.child(w.fs.tree.user(UID.alice)?.homeIno ?? '', 't')).not.toBeNull();
  });

  it('SYS-03 kernel-internal listeners receive vfs.load and the create and unlink items the trie needs', async () => {
    const store = new MemStore();
    const seed = await boot({ store });
    await seed.alice.ok('mkdir', { path: '/home/alice/docs' });
    const w = await boot({ store });
    const seen: VfsEvent[] = [];
    w.fs.events.listen((ev) => seen.push(ev));
    await w.alice.ok('readdir', { path: '/home/alice' });
    const loads = seen.filter((e) => e.topic === 'vfs.load');
    expect(
      loads.some((e) => e.topic === 'vfs.load' && e.data.entries.some((x) => x.name === 'docs')),
    ).toBe(true);
    await w.alice.ok('writeFile', { path: '/home/alice/docs/report.md', data: bytes('r') });
    await w.alice.ok('unlink', { path: '/home/alice/docs/report.md' });
    const create = seen.find((e) => e.topic === 'vfs.create');
    const unlink = seen.find((e) => e.topic === 'vfs.unlink');
    expect(create?.data).toMatchObject({ items: [{ name: 'report.md', type: 'f' }] });
    expect(unlink?.data).toMatchObject({ items: [{ name: 'report.md', count: 1 }] });
    expect(create?.vseq).toBeLessThan(unlink?.vseq ?? 0);
  });

  it('VFS-07 a directory watch sees only what its watcher may read and permEpoch counts permission changes', async () => {
    const w = await boot();
    const carolHome = w.fs.tree.user(UID.carol)?.homeIno ?? '';
    const aliceHome = w.fs.tree.user(UID.alice)?.homeIno ?? '';
    const bobCred = { uid: UID.bob, gid: 100, groups: [100] };
    const inCarol: VfsEvent[] = [];
    const inAlice: VfsEvent[] = [];
    w.fs.events.watch(bobCred, carolHome, (ev) => inCarol.push(ev));
    w.fs.events.watch(bobCred, aliceHome, (ev) => inAlice.push(ev));
    await w.carol.ok('writeFile', { path: '/home/carol/a', data: bytes('a') });
    await w.alice.ok('writeFile', { path: '/home/alice/b', data: bytes('b') });
    expect(inCarol.map((e) => e.topic)).toEqual(['vfs.create']);
    expect(inAlice).toHaveLength(0);
    const epoch = w.fs.events.permEpoch;
    await w.carol.ok('chmod', { path: '/home/carol/a', mode: { op: 'set', bits: 0o600 } });
    expect(w.fs.events.permEpoch).toBe(epoch + 1);
  });

  it('VFS-05 stat of a synthesised file reports its fresh snapshot and every mutation of it is EPERM', async () => {
    const w = await boot();
    const s = await w.alice.ok<Stat>('stat', { path: '/system/release' });
    expect(s).toMatchObject({ ino: INO.SYSTEM_RELEASE, uid: 0, mode: 0o444, synth: true });
    expect(s.size).toBeGreaterThan(0);
    expect(await w.root.errno('unlink', { path: '/system/release' })).toBe('EPERM');
    expect(await w.root.errno('open', { path: '/system/release', flags: 'w' })).toBe('EPERM');
    expect(await w.alice.errno('open', { path: '/system/log/audit.log', flags: 'r' })).toBe(
      'EACCES',
    );
  });
});
