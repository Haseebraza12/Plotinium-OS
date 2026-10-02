/**
 * The lease manager against an in-memory `locks` double and a manual clock (offline-and-sync.md
 * §3.14, §5.6; database.md §3.17). Every frame the manager emits is parsed with the protocol's
 * S2CFrame schema, so these tests also check wire conformance (SYN-03).
 */
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { LEASE_TTL_DEMO_MS, S2CFrame, type LeaseRef } from '@plotinium/protocol';

import { ManualClock } from '../sync/tests/manual-clock.ts';
import { LockManager, type LockAcquireBody } from './manager.ts';
import { MemoryLockStore } from './tests/memory-store.ts';
import { testHeapFactory } from './tests/test-heap.ts';
import type { LockConnRef, LockFrame, LockNotifier } from './types.ts';

const FILE = '01920000-0000-7000-8000-00000000f001';
const FILE2 = '01920000-0000-7000-8000-00000000f002';
const DIR = '01920000-0000-7000-8000-00000000d001';
const ALICE = 1001;
const BOB = 1002;
const TTL = LEASE_TTL_DEMO_MS;

let reqCounter = 0;
const reqId = (): string =>
  `01930000-0000-7000-8000-${(++reqCounter).toString(16).padStart(12, '0')}`;

interface Sent {
  readonly to: string;
  readonly kind: 'conn' | 'session';
  readonly frame: LockFrame;
}

class CaptureNotifier implements LockNotifier {
  readonly sent: Sent[] = [];
  watchers = new Map<string, string[]>();

  #check(frame: LockFrame): void {
    v.parse(S2CFrame, { v: 1, t: frame.t, id: 1, body: frame.body });
  }

  toConn(connId: string, frame: LockFrame): void {
    this.#check(frame);
    this.sent.push({ to: connId, kind: 'conn', frame });
  }

  toSession(osSessionId: string, frame: LockFrame): void {
    this.#check(frame);
    this.sent.push({ to: osSessionId, kind: 'session', frame });
  }

  watchersOf(ino: string): Iterable<string> {
    return this.watchers.get(ino) ?? [];
  }

  to(connId: string): LockFrame[] {
    return this.sent.filter((s) => s.to === connId).map((s) => s.frame);
  }

  last(connId: string): LockFrame | undefined {
    return this.to(connId).at(-1);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

function conn(
  connId: string,
  osSessionId: string,
  uid: number,
  grants: number[] = [],
): LockConnRef {
  return { connId, osSessionId, uid, mayActAs: (p) => p === uid || grants.includes(p) };
}

function setup(opts: { maxLeases?: number; dbSkewMs?: number } = {}) {
  const clock = new ManualClock();
  const dbClock = {
    now: () => clock.now() - (opts.dbSkewMs ?? 0),
    setTimer: clock.setTimer.bind(clock),
  };
  const store = new MemoryLockStore(dbClock);
  store.users.set(ALICE, 'alice');
  store.users.set(BOB, 'bob');
  store.inodes.set(FILE, { type: 'f', mode: 0o666, uid: ALICE, gid: ALICE, lockFence: 0 });
  store.inodes.set(FILE2, { type: 'f', mode: 0o666, uid: ALICE, gid: ALICE, lockFence: 0 });
  store.inodes.set(DIR, { type: 'd', mode: 0o777, uid: ALICE, gid: ALICE, lockFence: 0 });
  const notifier = new CaptureNotifier();
  const errors: string[] = [];
  const manager = new LockManager({
    store,
    notifier,
    clock,
    ttlMs: TTL,
    createHeap: testHeapFactory,
    onError: (_e, ctx) => errors.push(ctx),
    ...(opts.maxLeases === undefined ? {} : { maxLeases: opts.maxLeases }),
  });
  const a = conn('c-alice', 'os-alice', ALICE);
  const b = conn('c-bob', 'os-bob', BOB);
  store.sessions.set('os-alice', {
    authSessionId: 'auth-alice',
    deviceId: 'dev-a',
    ownerUid: ALICE,
    kernelEpoch: 3,
  });
  store.sessions.set('os-bob', {
    authSessionId: 'auth-bob',
    deviceId: 'dev-b',
    ownerUid: BOB,
    kernelEpoch: 1,
  });
  return { clock, store, notifier, manager, a, b, errors };
}

function acq(
  mode: 'S' | 'X',
  principal: number,
  extra: Partial<LockAcquireBody> = {},
): LockAcquireBody {
  return { reqId: reqId(), ino: FILE, mode, wait: false, principal, ...extra };
}

function granted(frame: LockFrame | undefined) {
  if (frame?.t !== 'lock.granted')
    throw new Error(`expected lock.granted, got ${frame?.t ?? 'nothing'}`);
  return frame.body;
}

describe('VFS-09 S/X leases (offline-and-sync.md §3.14.1, §3.14.3)', () => {
  it('VFS-09 a second writer gets lock.denied EBUSY lease naming the holder (read-only mode)', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    expect(g.mode).toBe('X');
    expect(g.ttlMs).toBe(TTL);

    await manager.acquire(b, acq('X', BOB));
    const d = notifier.last('c-bob');
    expect(d?.t).toBe('lock.denied');
    if (d?.t !== 'lock.denied') return;
    expect(d.body.errno).toBe('EBUSY');
    expect(d.body.reason).toBe('lease');
    expect(d.body.holder).toMatchObject({ username: 'alice', mode: 'X' });
  });

  it('VFS-09 many S leases coexist, an X request is refused while any S is held, and S is refused under X', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('S', ALICE));
    await manager.acquire(b, acq('S', BOB));
    expect(notifier.last('c-alice')?.t).toBe('lock.granted');
    expect(notifier.last('c-bob')?.t).toBe('lock.granted');
    const carol = conn('c-carol', 'os-carol', BOB);
    await manager.acquire(carol, acq('X', BOB));
    expect(notifier.last('c-carol')).toMatchObject({ t: 'lock.denied', body: { errno: 'EBUSY' } });
    expect(manager.holdersOf(FILE)).toHaveLength(2);

    await manager.acquire(a, { ...acq('S', ALICE), ino: FILE2 });
    await manager.acquire(a, { ...acq('X', ALICE), ino: FILE2 }); // sole holder upgrades
    await manager.acquire(b, { ...acq('S', BOB), ino: FILE2 });
    expect(notifier.last('c-bob')).toMatchObject({
      t: 'lock.denied',
      body: { errno: 'EBUSY', holder: { mode: 'X' } },
    });
  });

  it('VFS-09 fences strictly increase and an upgrade is a new grant that replaces the old lease', async () => {
    const { manager, notifier, store, a } = setup();
    await manager.acquire(a, acq('S', ALICE));
    const s = granted(notifier.last('c-alice'));
    await manager.acquire(a, acq('X', ALICE));
    const x = granted(notifier.last('c-alice'));
    expect(x.fence).toBeGreaterThan(s.fence);
    expect(x.leaseId).not.toBe(s.leaseId);
    expect(manager.leasesOf('os-alice').map((l) => l.leaseId)).toEqual([x.leaseId]);
    expect(store.inodes.get(FILE)?.lockFence).toBe(x.fence);
  });

  it('VFS-09 directories, missing inodes and files without permission are refused with EISDIR, ENOENT and EACCES', async () => {
    const { manager, notifier, store, a, b } = setup();
    await manager.acquire(a, { ...acq('S', ALICE), ino: DIR });
    expect(notifier.last('c-alice')).toMatchObject({ t: 'lock.denied', body: { errno: 'EISDIR' } });
    await manager.acquire(a, { ...acq('S', ALICE), ino: '01920000-0000-7000-8000-0000000000ff' });
    expect(notifier.last('c-alice')).toMatchObject({ t: 'lock.denied', body: { errno: 'ENOENT' } });
    store.inodes.set(FILE, { type: 'f', mode: 0o644, uid: ALICE, gid: ALICE, lockFence: 0 });
    await manager.acquire(b, acq('X', BOB)); // X needs w
    expect(notifier.last('c-bob')).toMatchObject({ t: 'lock.denied', body: { errno: 'EACCES' } });
    await manager.acquire(b, acq('S', BOB)); // S needs r
    expect(notifier.last('c-bob')?.t).toBe('lock.granted');
  });

  it('VFS-09 a principal without a live su grant is refused EACCES principal; a granted one is accepted', async () => {
    const { manager, notifier, b } = setup();
    await manager.acquire(b, acq('S', ALICE));
    expect(notifier.last('c-bob')).toMatchObject({
      t: 'lock.denied',
      body: { errno: 'EACCES', reason: 'principal' },
    });
    const su = conn('c-su', 'os-su', BOB, [ALICE]);
    await manager.acquire(su, acq('S', ALICE));
    expect(notifier.last('c-su')?.t).toBe('lock.granted');
  });

  it('VFS-09 the lease after MAX_LEASES per OS session is refused EAGAIN lease-limit, a re-acquire is not', async () => {
    const { manager, notifier, a } = setup({ maxLeases: 1 });
    await manager.acquire(a, acq('S', ALICE));
    await manager.acquire(a, { ...acq('S', ALICE), ino: FILE2 });
    expect(notifier.last('c-alice')).toMatchObject({
      t: 'lock.denied',
      body: { errno: 'EAGAIN', reason: 'lease-limit' },
    });
    await manager.acquire(a, acq('X', ALICE));
    expect(notifier.last('c-alice')?.t).toBe('lock.granted');
  });

  it('VFS-09 a database failure during acquire answers lock.denied EAGAIN and is reported', async () => {
    const { manager, notifier, store, a, errors } = setup();
    store.failNext = 'acquire';
    await manager.acquire(a, acq('X', ALICE));
    expect(notifier.last('c-alice')).toMatchObject({ t: 'lock.denied', body: { errno: 'EAGAIN' } });
    expect(errors).toContain('acquire');
  });

  it('VFS-09 a duplicate reqId of a queued request is refused instead of queued twice', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const body = acq('X', BOB, { wait: true });
    await manager.acquire(b, body);
    await manager.acquire(b, body);
    expect(notifier.last('c-bob')).toMatchObject({ t: 'lock.denied', body: { errno: 'EAGAIN' } });
    expect(manager.waitingOn(FILE)).toBe(1);
  });
});

describe('VFS-09 waiters, fairness and timeouts (§3.14.1)', () => {
  it('VFS-09 waiters queue FIFO and a new S request queues behind a waiting X so writers are not starved', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('S', ALICE));
    await manager.acquire(b, acq('X', BOB, { wait: true }));
    expect(notifier.last('c-bob')).toMatchObject({ t: 'lock.queued', body: { position: 1 } });
    const carol = conn('c-carol', 'os-carol', BOB);
    await manager.acquire(carol, acq('S', BOB, { wait: true }));
    expect(notifier.last('c-carol')).toMatchObject({ t: 'lock.queued', body: { position: 2 } });
    const dave = conn('c-dave', 'os-dave', BOB);
    await manager.acquire(dave, acq('S', BOB, { wait: false }));
    expect(notifier.last('c-dave')).toMatchObject({
      t: 'lock.denied',
      body: { errno: 'EBUSY', holder: { username: 'alice' } },
    });

    const held = manager.leasesOf('os-alice')[0];
    if (held === undefined) throw new Error('alice holds S');
    await manager.releaseLease(a, held.leaseId);
    expect(notifier.last('c-bob')?.t).toBe('lock.granted');
    // carol hears the release but stays queued behind bob's X
    expect(notifier.to('c-carol').map((f) => f.t)).toEqual(['lock.queued', 'lock.released']);
    expect(manager.waitingOn(FILE)).toBe(1);
  });

  it('VFS-09 a waiter whose timeoutMs passes gets lock.denied ETIMEDOUT and leaves the queue', async () => {
    const { manager, notifier, clock, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    await manager.acquire(b, acq('X', BOB, { wait: true, timeoutMs: 2_000 }));
    await clock.advance(1_999);
    expect(notifier.last('c-bob')?.t).toBe('lock.queued');
    await clock.advance(1);
    expect(notifier.last('c-bob')).toMatchObject({
      t: 'lock.denied',
      body: { errno: 'ETIMEDOUT' },
    });
    expect(manager.waitingOn(FILE)).toBe(0);
  });

  it('VFS-09 lock.release with a reqId cancels a queued request with ECANCELED; an unknown reqId is ignored', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const body = acq('X', BOB, { wait: true });
    await manager.acquire(b, body);
    expect(manager.cancelRequest(b, body.reqId)).toBe(true);
    expect(notifier.last('c-bob')).toMatchObject({
      t: 'lock.denied',
      body: { errno: 'ECANCELED', reqId: body.reqId },
    });
    expect(manager.cancelRequest(b, body.reqId)).toBe(false);
  });

  it('VFS-09 when the X head of the queue is cancelled, compatible S waiters behind it are granted', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('S', ALICE));
    const x = acq('X', BOB, { wait: true });
    await manager.acquire(b, x);
    const carol = conn('c-carol', 'os-carol', BOB);
    await manager.acquire(carol, acq('S', BOB, { wait: true }));
    manager.cancelRequest(b, x.reqId);
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(notifier.last('c-carol')?.t).toBe('lock.granted');
  });
});

describe('VFS-09 crash expiry, heartbeats and the sweeper (§3.14.2, §3.14.5, §5.6)', () => {
  it('VFS-09 after the holder crashes, the waiter acquires within TTL + 0.5 s of the last renewal', async () => {
    const { manager, notifier, clock, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const first = granted(notifier.last('c-alice'));
    await clock.advance(5_000);
    const hb = await manager.heartbeat('os-alice', [
      { leaseId: first.leaseId, ino: FILE, fence: first.fence },
    ]);
    expect(hb).toEqual({ renewed: [first.leaseId], lost: [] });
    const lastRenewal = clock.now();
    // alice's renderer is killed: no more hb, the socket closes abnormally (leases stay).
    await manager.connectionClosed({ connId: 'c-alice', osSessionId: 'os-alice' }, false);
    await manager.acquire(b, acq('X', BOB, { wait: true }));
    expect(notifier.last('c-bob')?.t).toBe('lock.queued');

    await clock.advance(TTL - 1);
    expect(notifier.last('c-bob')?.t).toBe('lock.queued');
    await clock.advanceTo(lastRenewal + TTL + 500);
    const g = granted(notifier.last('c-bob'));
    expect(g.fence).toBeGreaterThan(first.fence);
    const expiredAt = clock.now();
    expect(expiredAt - lastRenewal).toBeLessThanOrEqual(TTL + 500);
    expect(notifier.sent.some((s) => s.to === 'os-alice' && s.frame.t === 'lock.expired')).toBe(
      true,
    );
    expect(
      notifier.to('c-bob').some((f) => f.t === 'lock.released' && f.body.reason === 'expired'),
    ).toBe(true);
  });

  it('VFS-09 crash expiry works on the production index (dsa/heap, or its Map stand-in until it ships)', async () => {
    const { store, notifier, clock, a, b } = setup();
    const prod = new LockManager({ store, notifier, clock, ttlMs: TTL });
    await prod.acquire(a, acq('X', ALICE));
    await prod.acquire(b, acq('X', BOB, { wait: true }));
    await clock.advance(TTL + 1);
    expect(notifier.last('c-bob')?.t).toBe('lock.granted');
    expect(prod.holdersOf(FILE).map((l) => l.holderUid)).toEqual([BOB]);
  });

  it('VFS-09 a client that stops sending hb loses the lease at the TTL even with the socket open (pongs never renew)', async () => {
    const { manager, notifier, clock, a } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    await clock.advance(TTL + 100);
    expect(manager.leasesOf('os-alice')).toHaveLength(0);
    const hb = await manager.heartbeat('os-alice', [
      { leaseId: g.leaseId, ino: FILE, fence: g.fence },
    ]);
    expect(hb.renewed).toEqual([]);
    expect(hb.lost).toEqual([{ leaseId: g.leaseId, ino: FILE, fence: g.fence }]);
  });

  it('VFS-09 heartbeats every TTL/3 keep a lease alive indefinitely, and an applied op renews every lease of the session', async () => {
    const { manager, notifier, clock, a } = setup();
    expect(manager.hbMs).toBe(TTL / 3);
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    const ref: LeaseRef = { leaseId: g.leaseId, ino: FILE, fence: g.fence };
    for (let i = 0; i < 10; i++) {
      await clock.advance(manager.hbMs);
      await manager.heartbeat('os-alice', [ref]);
    }
    expect(manager.leasesOf('os-alice')).toHaveLength(1);
    await clock.advance(TTL - 1_000);
    await manager.renewSession('os-alice');
    await clock.advance(TTL - 1_000);
    expect(manager.leasesOf('os-alice')).toHaveLength(1);
    await manager.renewSession('os-nobody'); // no leases: no database round trip
    expect(await manager.heartbeat('os-alice', [])).toEqual({ renewed: [], lost: [] });
  });

  it('VFS-09 an acquire deletes an expired holder row itself and tells the holder lock.expired', async () => {
    const { manager, notifier, clock, store, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    manager.stop(); // the sweeper never runs: acquire step 2 must do it
    await clock.advance(TTL + 1);
    await manager.acquire(b, acq('X', BOB));
    expect(notifier.last('c-bob')?.t).toBe('lock.granted');
    expect(notifier.sent.some((s) => s.to === 'os-alice' && s.frame.t === 'lock.expired')).toBe(
      true,
    );
    expect([...store.rows.values()].map((r) => r.holderUid)).toEqual([BOB]);
  });

  it('VFS-09 the index is rebuilt from the locks table at start, so a lease from before a restart still expires on time', async () => {
    const { store, clock, notifier } = setup();
    store.rows.set('01900000-0000-7000-8000-00000000aaaa', {
      leaseId: '01900000-0000-7000-8000-00000000aaaa',
      ino: FILE,
      osSessionId: 'os-alice',
      holderUid: ALICE,
      mode: 'X',
      fence: 7,
      expiresAt: clock.now() + 4_000,
    });
    const fresh = new LockManager({
      store,
      notifier,
      clock,
      ttlMs: TTL,
      createHeap: testHeapFactory,
    });
    await fresh.start();
    expect(fresh.holdersOf(FILE)).toHaveLength(1);
    expect(clock.nextAt()).toBe(clock.now() + 4_000);
    await clock.advance(4_000);
    expect(store.rows.size).toBe(0);
    expect(fresh.holdersOf(FILE)).toHaveLength(0);
  });

  it('VFS-09 when the process clock runs ahead of the database clock the sweeper re-reads and retries without spinning', async () => {
    const { manager, store, clock, a } = setup({ dbSkewMs: 300 });
    await manager.acquire(a, acq('X', ALICE));
    await clock.advance(TTL + 1_000);
    expect(store.rows.size).toBe(0);
    const sweeps = store.calls.filter((c) => c === 'expire').length;
    expect(sweeps).toBeGreaterThan(1);
    expect(sweeps).toBeLessThan(12);
  });

  it('VFS-09 a failed sweep is retried after errorRetryMs and reported', async () => {
    const { manager, store, clock, a, errors } = setup();
    await manager.acquire(a, acq('X', ALICE));
    store.failNext = 'expire';
    await clock.advance(TTL);
    expect(store.rows.size).toBe(1);
    expect(errors).toContain('sweep');
    await clock.advance(1_000);
    expect(store.rows.size).toBe(0);
  });

  it('VFS-09 hello.heldLeases returns kept leases within the TTL and lost leases after it', async () => {
    const { manager, notifier, clock, a } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    await manager.acquire(a, { ...acq('S', ALICE), ino: FILE2 });
    const g2 = granted(notifier.last('c-alice'));
    await manager.connectionClosed({ connId: 'c-alice', osSessionId: 'os-alice' }, false);
    await clock.advance(TTL - 2_000);
    const again = await manager.verifyHeld('os-alice', [
      { leaseId: g.leaseId, ino: FILE, fence: g.fence },
      { leaseId: g2.leaseId, ino: FILE2, fence: g2.fence + 1 }, // wrong fence: lost
    ]);
    expect(again.kept.map((k) => k.leaseId)).toEqual([g.leaseId]);
    expect(again.kept[0]).toMatchObject({ mode: 'X', fence: g.fence, ino: FILE });
    expect(again.lost.map((l) => l.leaseId)).toEqual([g2.leaseId]);
    await clock.advance(TTL + 1);
    const late = await manager.verifyHeld('os-alice', [
      { leaseId: g.leaseId, ino: FILE, fence: g.fence },
    ]);
    expect(late.kept).toEqual([]);
    expect(late.lost).toHaveLength(1);
    expect(await manager.verifyHeld('os-alice', [])).toEqual({ kept: [], lost: [] });
  });
});

describe('VFS-09 release paths (§3.14.5)', () => {
  it('PROC-07 kill of a lease holder releases its lease: waiters hear lock.released and the next one is granted', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    await manager.acquire(b, acq('X', BOB, { wait: true }));
    notifier.clear();
    expect(await manager.releaseLease(a, g.leaseId)).toBe(true);
    expect(notifier.to('c-alice')).toEqual([]); // nothing to the sender
    expect(notifier.to('c-bob').map((f) => f.t)).toEqual(['lock.released', 'lock.granted']);
    expect(await manager.releaseLease(a, g.leaseId)).toBe(false);
  });

  it('VFS-09 a denied reader is told lock.released when the writer lets go ("Available — open for writing")', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    await manager.acquire(b, acq('X', BOB));
    await manager.releaseLease(a, g.leaseId);
    expect(notifier.last('c-bob')).toMatchObject({
      t: 'lock.released',
      body: { ino: FILE, reason: 'released' },
    });
  });

  it('BOOT-12 a clean bye releases the OS session leases at once and an abnormal close keeps them until the TTL', async () => {
    const { manager, notifier, clock, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    await manager.acquire(b, { ...acq('X', BOB), ino: FILE2 });
    await manager.connectionClosed({ connId: 'c-bob', osSessionId: 'os-bob' }, false);
    expect(manager.leasesOf('os-bob')).toHaveLength(1);
    const watcher = conn('c-w', 'os-w', BOB);
    await manager.acquire(watcher, acq('S', BOB));
    await manager.connectionClosed({ connId: 'c-alice', osSessionId: 'os-alice' }, true);
    expect(manager.leasesOf('os-alice')).toHaveLength(0);
    expect(notifier.last('c-w')).toMatchObject({
      t: 'lock.released',
      body: { reason: 'session-closed' },
    });
    await clock.advance(TTL + 1);
    expect(manager.leasesOf('os-bob')).toHaveLength(0);
    await manager.connectionClosed({ connId: 'c-x', osSessionId: null }, true); // before hello: nothing
  });

  it('VFS-09 revoking an auth session releases every lease of its OS sessions and grants the waiters', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    await manager.acquire(b, acq('X', BOB, { wait: true }));
    const rows = await manager.releaseAuthSessions(['auth-alice']);
    expect(rows).toHaveLength(1);
    expect(
      notifier.sent.some(
        (s) =>
          s.to === 'os-alice' && s.frame.t === 'lock.expired' && s.frame.body.reason === 'revoked',
      ),
    ).toBe(true);
    expect(notifier.last('c-bob')?.t).toBe('lock.granted');
    expect(await manager.releaseAuthSessions([])).toEqual([]);
  });

  it('VFS-09 a newer kernel epoch releases the old OS session leases of the same device and uid, never another device or user', async () => {
    const { manager, store, a, b } = setup();
    store.sessions.set('os-alice-2', {
      authSessionId: 'auth-alice',
      deviceId: 'dev-a',
      ownerUid: ALICE,
      kernelEpoch: 4,
    });
    store.sessions.set('os-alice-other', {
      authSessionId: 'auth-alice',
      deviceId: 'dev-z',
      ownerUid: ALICE,
      kernelEpoch: 1,
    });
    await manager.acquire(a, acq('S', ALICE));
    await manager.acquire(conn('c-a3', 'os-alice-other', ALICE), acq('S', ALICE));
    await manager.acquire(b, acq('S', BOB));
    const released = await manager.releaseDevicePredecessors({
      deviceId: 'dev-a',
      uid: ALICE,
      osSessionId: 'os-alice-2',
      kernelEpoch: 4,
    });
    expect(released.map((r) => r.osSessionId)).toEqual(['os-alice']);
    expect(manager.leasesOf('os-alice-other')).toHaveLength(1);
    expect(manager.leasesOf('os-bob')).toHaveLength(1);
  });

  it('VFS-09 closing a connection drops its queued requests and interests without replying', async () => {
    const { manager, notifier, a, b } = setup();
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    await manager.acquire(b, acq('X', BOB, { wait: true, timeoutMs: 60_000 }));
    await manager.connectionClosed({ connId: 'c-bob', osSessionId: 'os-bob' }, false);
    notifier.clear();
    await manager.releaseLease(a, g.leaseId);
    expect(notifier.to('c-bob')).toEqual([]);
    expect(manager.waitingOn(FILE)).toBe(0);
  });

  it('VFS-09 directory watchers are told when a lease on an inode in the directory ends', async () => {
    const { manager, notifier, a } = setup();
    notifier.watchers.set(FILE, ['c-files-view']);
    await manager.acquire(a, acq('X', ALICE));
    const g = granted(notifier.last('c-alice'));
    await manager.releaseLease(a, g.leaseId);
    expect(notifier.last('c-files-view')).toMatchObject({ t: 'lock.released' });
  });

  it('VFS-09 the TTL must be within 15..120 s', () => {
    const { store, notifier } = setup();
    expect(() => new LockManager({ store, notifier, ttlMs: 10_000 })).toThrow(RangeError);
    expect(() => new LockManager({ store, notifier, ttlMs: 121_000 })).toThrow(RangeError);
  });
});
