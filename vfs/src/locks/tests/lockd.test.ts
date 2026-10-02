import { describe, expect, it } from 'vitest';

import { FakeClock, settle } from '../../sync/tests/doubles/clock.ts';
import { ALICE, BOB, tid } from '../../sync/tests/doubles/device.ts';
import { FakeServer } from '../../sync/tests/doubles/fake-server.ts';
import { Harness } from '../../sync/tests/doubles/harness.ts';
import { advisoryName, platformLocks, requestAdvisory } from '../advisory.ts';
import type { Lockd } from '../lockd.ts';
import { LocalLockTable } from '../table.ts';
import type { AcquireRequest, Grant, LockManagerLike, LockResult } from '../types.ts';

const F = tid(0xf11e);
const G = tid(0x6666);
const BOB_SESSION = tid(0xb5e55);

/** TEST-ONLY Web Locks double: shared/exclusive by name, `ifAvailable`, `signal`. */
class FakeLocks implements LockManagerLike {
  readonly held = new Map<string, { mode: 'shared' | 'exclusive'; count: number }>();
  readonly requests: { name: string; mode: string; ifAvailable: boolean; signal: boolean }[] = [];
  block = new Set<string>();

  request(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    cb: (lock: { name: string } | null) => unknown,
  ): Promise<unknown> {
    this.requests.push({
      name,
      mode: options.mode,
      ifAvailable: options.ifAvailable === true,
      signal: options.signal !== undefined,
    });
    if (options.ifAvailable === true && options.signal !== undefined)
      return Promise.reject(new DOMException('both', 'NotSupportedError'));
    const cur = this.held.get(name);
    const free =
      !this.block.has(name) &&
      (cur === undefined || (cur.mode === 'shared' && options.mode === 'shared'));
    if (!free) return Promise.resolve(cb(null));
    this.held.set(name, { mode: options.mode, count: (cur?.count ?? 0) + 1 });
    const held = Promise.resolve(cb({ name }));
    return held.then(() => {
      const c = this.held.get(name);
      if (c !== undefined && --c.count <= 0) this.held.delete(name);
    });
  }
}

async function pair(
  opts: { aliceClock?: FakeClock; locks?: LockManagerLike; aliceOnline?: boolean } = {},
): Promise<{ clock: FakeClock; server: FakeServer; alice: Harness; bob: Harness }> {
  const clock = new FakeClock();
  const server = new FakeServer(clock, 15_000);
  const alice = await Harness.create({
    clock: opts.aliceClock ?? clock,
    server,
    withLocks: true,
    online: opts.aliceOnline ?? true,
    ...(opts.locks === undefined ? {} : { locks: opts.locks }),
  });
  const bob = await Harness.create({
    clock,
    server,
    withLocks: true,
    osSessionId: BOB_SESSION,
    loginUid: BOB,
    auth: { uid: BOB, username: 'bob' },
  });
  await bob.live();
  if (opts.aliceOnline !== false) await alice.live();
  return { clock, server, alice, bob };
}

function lockd(h: Harness): Lockd {
  if (h.lockd === null) throw new Error('no lockd');
  return h.lockd;
}

async function acquire(
  h: Harness,
  req: Partial<AcquireRequest> & { pid: number },
): Promise<LockResult<Grant>> {
  const p = lockd(h).acquire({ ino: F, mode: 'X', wait: false, principal: ALICE, ...req });
  await settle();
  return p;
}

function granted(r: LockResult<Grant>): Grant {
  if (!r.ok) throw new Error(`not granted: ${r.errno}`);
  return r.value;
}

describe('second writer (VFS-09, §3.14.7)', () => {
  it('VFS-09 a second writer gets EBUSY with the holder named, sees the file read-only, then Available once it is released', async () => {
    const { alice, bob } = await pair();
    const g = granted(await acquire(alice, { pid: 10 }));
    expect(g).toMatchObject({ scope: 'server', fence: 41 });
    expect(lockd(alice).fenceFor(10, F)).toBe(41);
    expect(alice.lockEvents.map((e) => e.topic)).toEqual(['lock.granted']);
    const denied = await acquire(bob, { pid: 20, principal: BOB });
    expect(denied).toEqual({ ok: false, errno: 'EBUSY', reason: 'lease', holder: 'alice' });
    expect(lockd(bob).checkWritable(F, 21)).toEqual({
      ok: false,
      errno: 'EBUSY',
      reason: 'lease',
      holder: 'alice',
    });
    expect(lockd(bob).foreignHolder(F)).toMatchObject({ username: 'alice', mode: 'X' });
    expect(lockd(bob).lsof()).toEqual([
      expect.objectContaining({ ino: F, holder: 'alice', foreign: true, scope: 'server' }),
    ]);
    expect(lockd(alice).release(10, g.leaseId)).toEqual({ ok: true, value: {} });
    await settle();
    expect(bob.lockEvents).toContainEqual(
      expect.objectContaining({ topic: 'lock.released', ino: F }),
    );
    expect(lockd(bob).checkWritable(F, 21)).toEqual({ ok: true, value: null });
    const again = granted(await acquire(bob, { pid: 20, principal: BOB }));
    expect(again.fence).toBe(42);
  });

  it('VFS-09 many S or one X: local holders share one server lease; an S holder alone may upgrade to X', async () => {
    const { alice, server } = await pair();
    const s1 = granted(await acquire(alice, { pid: 10, mode: 'S' }));
    const s2 = granted(await acquire(alice, { pid: 11, mode: 'S' }));
    expect(s2.leaseId).toBe(s1.leaseId);
    expect(server.framesOf('lock.acquire')).toHaveLength(1);
    expect(await acquire(alice, { pid: 10, mode: 'X' })).toMatchObject({
      ok: false,
      errno: 'EBUSY',
      holder: 'pid 11',
    });
    expect(lockd(alice).checkWritable(F, 10)).toMatchObject({ ok: false, errno: 'EBUSY' });
    lockd(alice).release(11, s2.leaseId);
    const x = granted(await acquire(alice, { pid: 10, mode: 'X' }));
    expect(x.fence).toBeGreaterThan(s1.fence ?? 0);
    expect(lockd(alice).fenceFor(10, F)).toBe(x.fence);
    expect(server.leases.filter((l) => l.ino === F)).toHaveLength(1);
    expect(lockd(alice).release(10, 'nope')).toEqual({
      ok: false,
      errno: 'EINVAL',
      reason: 'unknown-lease',
    });
    expect(
      await lockd(alice).acquire({
        pid: 1,
        ino: F,
        mode: 'S',
        wait: false,
        timeoutMs: 5,
        principal: ALICE,
      }),
    ).toEqual({ ok: false, errno: 'EINVAL' });
  });
});

describe('heartbeat, expiry and fences (VFS-09, §3.14.2–§3.14.5)', () => {
  it('VFS-09 heartbeats at TTL/3 from the kernel worker renew the lease; a crashed holder expires within TTL and the waiter gets a higher fence', async () => {
    const aliceClock = new FakeClock();
    const { clock, server, alice, bob } = await pair({ aliceClock });
    const both = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 500) {
        await aliceClock.advance(500, 10);
        await clock.advance(500, 10);
      }
    };
    const g = granted(await acquire(alice, { pid: 10 }));
    const hbBefore = server
      .framesOf('hb')
      .filter((h) => h.leases.some((l) => l.leaseId === g.leaseId)).length;
    await both(30_000);
    const renewals =
      server.framesOf('hb').filter((h) => h.leases.some((l) => l.leaseId === g.leaseId)).length -
      hbBefore;
    expect(renewals).toBe(6); // every 5 s = TTL / 3
    expect(await acquire(bob, { pid: 20, principal: BOB })).toMatchObject({
      ok: false,
      errno: 'EBUSY',
    });
    // The renderer dies: its socket closes abnormally and its timers never run again.
    const lastRenewal = clock.now();
    server.conns.find((c) => c.session !== BOB_SESSION && !c.closed)?.kill(1006);
    await clock.advance(14_000);
    expect(await acquire(bob, { pid: 20, principal: BOB })).toMatchObject({
      ok: false,
      errno: 'EBUSY',
    });
    await clock.advance(1_500);
    server.sweep();
    await settle();
    expect(clock.now() - lastRenewal).toBeLessThanOrEqual(15_000 + 500 + 1_000);
    expect(bob.lockEvents).toContainEqual(
      expect.objectContaining({ topic: 'lock.released', ino: F, reason: 'expired' }),
    );
    const b = granted(await acquire(bob, { pid: 20, principal: BOB }));
    expect(b.fence).toBeGreaterThan(g.fence ?? 0);
    // alice's frozen tab wakes: its writes still carry fence 41 (the stale-fence path), and the
    // reconnect reports the lease lost, so the Editor turns read-only.
    expect(lockd(alice).fenceFor(10, F)).toBe(g.fence);
    alice.syncd.onVisible();
    await alice.until(() => alice.lockEvents.some((e) => e.topic === 'lock.lost'), 1_000, 60);
    expect(alice.lockEvents).toContainEqual(
      expect.objectContaining({ topic: 'lock.lost', ino: F, pids: [10], reason: 'expired' }),
    );
    expect(lockd(alice).lsof()).toEqual([
      expect.objectContaining({ ino: F, lost: true, fence: g.fence, remainingMs: null }),
    ]);
    expect(lockd(alice).fenceFor(10, F)).toBe(g.fence);
  });

  it('VFS-09 a tab that becomes visible sends an immediate hb and a lease lost meanwhile turns the holder read-only', async () => {
    const { alice, server } = await pair();
    granted(await acquire(alice, { pid: 10 }));
    server.leases.splice(0, server.leases.length); // expired while the tab was frozen
    const before = server.framesOf('hb').length;
    lockd(alice).onVisible();
    await settle();
    expect(server.framesOf('hb').length).toBe(before + 1);
    expect(alice.lockEvents).toContainEqual(
      expect.objectContaining({ topic: 'lock.lost', ino: F, pids: [10] }),
    );
    expect(lockd(alice).heldLeases()).toEqual([]);
    lockd(alice).onVisible();
    await settle();
    expect(server.framesOf('hb').length).toBe(before + 1);
  });

  it('VFS-09 hello.heldLeases keeps leases after a quick reconnect and reports them lost after the TTL', async () => {
    const { clock, server, alice, bob } = await pair();
    const g = granted(await acquire(alice, { pid: 10 }));
    server.conns.find((c) => c.session !== BOB_SESSION && !c.closed)?.kill(1006);
    await settle();
    await alice.live();
    const hello = server.framesOf('hello').at(-1);
    expect(hello?.heldLeases).toEqual([{ leaseId: g.leaseId, ino: F, fence: g.fence }]);
    expect(alice.lockEvents.some((e) => e.topic === 'lock.lost')).toBe(false);
    expect(lockd(alice).heldLeases()).toHaveLength(1);
    alice.syncd.setOnline(false);
    await clock.advance(16_000);
    server.sweep();
    await settle();
    expect(bob.lockEvents).toContainEqual(
      expect.objectContaining({ topic: 'lock.released', ino: F }),
    );
    alice.syncd.setOnline(true);
    await alice.live();
    expect(alice.lockEvents).toContainEqual(
      expect.objectContaining({ topic: 'lock.lost', ino: F, reason: 'expired' }),
    );
  });

  it('VFS-09 lsof shows the lease countdown from the server time offset', async () => {
    const { clock, alice } = await pair();
    granted(await acquire(alice, { pid: 10 }));
    await clock.advance(4_000);
    const [row] = lockd(alice).lsof();
    expect(row).toMatchObject({
      ino: F,
      mode: 'X',
      scope: 'server',
      holder: 'pid 10',
      pids: [10],
      foreign: false,
      lost: false,
      remainingMs: 11_000,
    });
    await clock.advance(1_500); // the hb at 5 s renewed it
    expect(lockd(alice).lsof()[0]?.remainingMs).toBe(14_500);
    expect(lockd(alice).status(F)).toMatchObject({
      queued: 0,
      holders: [expect.objectContaining({ ino: F })],
    });
    expect(lockd(alice).serverLayer).toBe(true);
  });
});

describe('degraded mode and kills (PVFS-13, PROC-07)', () => {
  it('VFS-09 offline, acquire grants a local advisory lock; reconnecting turns it into a server lease with a fence', async () => {
    const locks = new FakeLocks();
    const { alice } = await pair({ locks, aliceOnline: false });
    alice.syncd.connect();
    const g = granted(await acquire(alice, { pid: 10 }));
    expect(g).toMatchObject({ scope: 'local', fence: null, expiresAt: null });
    expect(locks.requests).toEqual([
      { name: advisoryName(F), mode: 'exclusive', ifAvailable: true, signal: false },
    ]);
    expect(lockd(alice).fenceFor(10, F)).toBeUndefined();
    expect(lockd(alice).serverLayer).toBe(false);
    alice.syncd.setOnline(true);
    await alice.live();
    await settle();
    expect(alice.lockEvents.filter((e) => e.topic === 'lock.granted').at(-1)).toMatchObject({
      ino: F,
      fence: 41,
      pids: [10],
    });
    expect(lockd(alice).fenceFor(10, F)).toBe(41);
    expect(locks.held.size).toBe(0);
    expect(lockd(alice).release(10, g.leaseId).ok).toBe(true);
  });

  it('VFS-09 a local lock denied by the server after reconnect is reported lost', async () => {
    const locks = new FakeLocks();
    const { alice, bob } = await pair({ locks, aliceOnline: false });
    granted(await acquire(bob, { pid: 20, principal: BOB, ino: G }));
    alice.syncd.connect();
    granted(await acquire(alice, { pid: 10, ino: G, mode: 'S' }));
    alice.syncd.setOnline(true);
    await alice.live();
    await settle();
    expect(alice.lockEvents).toContainEqual(
      expect.objectContaining({
        topic: 'lock.lost',
        ino: G,
        pids: [10],
        reason: 'denied',
        holder: 'bob',
      }),
    );
    expect(locks.held.size).toBe(0);
  });

  it('VFS-09 an advisory lock held elsewhere is EBUSY; a waiting advisory request passes its signal', async () => {
    const locks = new FakeLocks();
    locks.block.add(advisoryName(F));
    const { alice } = await pair({ locks, aliceOnline: false });
    alice.syncd.connect();
    expect(await acquire(alice, { pid: 10 })).toEqual({
      ok: false,
      errno: 'EBUSY',
      reason: 'lease',
      holder: 'another tab',
    });
    const ctrl = new AbortController();
    locks.block.clear();
    const h = await requestAdvisory(locks, G, 'S', true, ctrl.signal);
    expect(h?.mode).toBe('S');
    expect(locks.requests.at(-1)).toEqual({
      name: advisoryName(G),
      mode: 'shared',
      ifAvailable: false,
      signal: true,
    });
    h?.release();
    const rejecting: LockManagerLike = { request: () => Promise.reject(new Error('x')) };
    await expect(requestAdvisory(rejecting, G, 'X', false)).resolves.toBeNull();
    // Node 24 ships the Web Locks API too; in the kernel worker it is `navigator.locks`.
    const platform = platformLocks();
    expect(platform === undefined || typeof platform.request === 'function').toBe(true);
  });

  it('PROC-07 kill of a lease holder releases its leases and the server grants the waiter', async () => {
    const { alice, bob, server } = await pair();
    granted(await acquire(alice, { pid: 10 }));
    const waiting = lockd(bob).acquire({
      pid: 20,
      ino: F,
      mode: 'X',
      wait: true,
      timeoutMs: 60_000,
      principal: BOB,
    });
    await settle();
    expect(bob.lockEvents).toContainEqual(
      expect.objectContaining({ topic: 'lock.queued', ino: F, pids: [20] }),
    );
    lockd(alice).releaseAll(10);
    await settle();
    expect(server.framesOf('lock.release').length).toBeGreaterThan(0);
    expect(granted(await waiting).fence).toBe(42);
  });

  it('PROC-07 a killed process cancels its queued server request; a late grant for it is given back', async () => {
    const { alice, bob, server } = await pair();
    granted(await acquire(alice, { pid: 10 }));
    const waiting = lockd(bob).acquire({ pid: 20, ino: F, mode: 'X', wait: true, principal: BOB });
    await settle();
    lockd(bob).releaseAll(20);
    expect(await waiting).toEqual({ ok: false, errno: 'ECANCELED', reason: 'signal' });
    await settle();
    expect(server.framesOf('lock.release').some((r) => r.reqId !== undefined)).toBe(true);
    const before = server.framesOf('lock.release').length;
    server.last.push('lock.granted', {
      reqId: tid(0x999),
      leaseId: tid(0x998),
      ino: G,
      mode: 'S',
      fence: 99,
      expiresAt: new Date().toISOString(),
      ttlMs: 15_000,
    });
    await settle();
    expect(server.framesOf('lock.release').length).toBe(before + 1);
  });

  it('VFS-09 local waiters are served FIFO, time out with ETIMEDOUT and are cancelled by a kill', async () => {
    const { clock, alice } = await pair({ aliceOnline: false });
    alice.syncd.connect();
    const x = granted(await acquire(alice, { pid: 10 }));
    const timed = lockd(alice).acquire({
      pid: 11,
      ino: F,
      mode: 'S',
      wait: true,
      timeoutMs: 1_000,
      principal: ALICE,
    });
    await settle();
    await clock.advance(1_001);
    expect(await timed).toEqual({ ok: false, errno: 'ETIMEDOUT' });
    const killed = lockd(alice).acquire({
      pid: 12,
      ino: F,
      mode: 'S',
      wait: true,
      principal: ALICE,
    });
    await settle();
    expect(lockd(alice).status(F).queued).toBe(1);
    lockd(alice).releaseAll(12);
    expect(await killed).toEqual({ ok: false, errno: 'ECANCELED', reason: 'signal' });
    const next = lockd(alice).acquire({ pid: 13, ino: F, mode: 'S', wait: true, principal: ALICE });
    await settle();
    lockd(alice).release(10, x.leaseId);
    expect(granted(await next).scope).toBe('local');
  });

  it('VFS-09 a request in flight when the connection drops falls back to a local lock', async () => {
    const { alice, server } = await pair();
    server.mute = true;
    const p = lockd(alice).acquire({ pid: 10, ino: F, mode: 'X', wait: false, principal: ALICE });
    await settle();
    alice.syncd.setOnline(false);
    expect(granted(await p).scope).toBe('local');
  });
});

describe('local lock table (VFS §3.16.1)', () => {
  it('VFS-09 compatibility: many S or one X, upgrade by the sole holder, lost holders do not block', () => {
    const t = new LocalLockTable();
    expect(t.compatible(F, 1, 'X')).toBe(true);
    t.add({
      id: 'a',
      pid: 1,
      ino: F,
      principal: ALICE,
      mode: 'S',
      scope: 'local',
      fence: null,
      lost: false,
    });
    expect(t.compatible(F, 2, 'S')).toBe(true);
    expect(t.compatible(F, 2, 'X')).toBe(false);
    expect(t.compatible(F, 1, 'X')).toBe(true);
    t.add({
      id: 'b',
      pid: 2,
      ino: F,
      principal: ALICE,
      mode: 'X',
      scope: 'local',
      fence: null,
      lost: true,
    });
    expect(t.strongest(F)).toBe('S');
    expect(t.otherHolder(F, 1)).toBeUndefined();
    expect(t.byPid(2)).toHaveLength(1);
    expect(t.remove(9, 'a')).toBeNull();
    expect(t.remove(1, 'a')?.id).toBe('a');
    expect(t.remove(2, 'b')?.id).toBe('b');
    expect(t.inos()).toEqual([]);
    expect(t.strongest(F)).toBeNull();
    t.addWaiter(F, 1);
    t.addWaiter(F, -1);
    expect(t.waiters(F)).toBe(0);
  });
});
