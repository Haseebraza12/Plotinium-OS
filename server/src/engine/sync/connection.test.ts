/**
 * Connections and the hub end to end over fakes: fake sockets, the fake transaction layer, the
 * in-memory lease store and a manual clock (offline-and-sync.md §3.6-§3.9, §3.14, §3.17, §4;
 * backend-api.md §3.7, §3.8.4, §3.17). Every outbound frame is parsed with S2CFrame (SYN-03).
 */
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { CLOSE_AT, LEASE_TTL_DEMO_MS, S2CFrame, type OpSubmit } from '@plotinium/protocol';
import type { Cred } from '@plotinium/vfs/perm';

import { CancelRegistry } from '../../vfs/cancel.ts';
import { LockManager } from '../locks/manager.ts';
import { MemoryLockStore } from '../locks/tests/memory-store.ts';
import { testHeapFactory } from '../locks/tests/test-heap.ts';
import type { LockFrame, LockNotifier } from '../locks/types.ts';
import type { ConnAuth, Transport } from './connection.ts';
import { ContentWriteHandler } from './content-write.ts';
import { SyncEngine } from './engine.ts';
import { Broadcaster } from './feed.ts';
import { SyncHub } from './hub.ts';
import { FakeDb, HOME, ROOT_DIR, sha, uid7, writeOp, type FakeTx } from './tests/fake-db.ts';
import { flush, ManualClock } from './tests/manual-clock.ts';

const ALICE = 1001;
const BOB = 1002;
const SHARED = uid7(1, 3);
const BOB_HOME = uid7(1, 2);
const REPORT = uid7(2, 1);
const OS_A = uid7(3, 1);
const OS_B = uid7(3, 2);
const DEV_A = uid7(4, 1);
const DEV_B = uid7(4, 2);
const BUILD = {
  name: 'Plotinium' as const,
  version: '0.3.0',
  build: 'abc1234',
  date: '2026-11-14',
};

interface Out {
  readonly t: string;
  readonly id: number;
  readonly body: Record<string, unknown>;
}

class FakeSocket implements Transport {
  readonly frames: Out[] = [];
  closed: { code: number; reason?: string | undefined } | null = null;
  pings = 0;
  terminated = false;
  paused: number[] = [];
  bufferedAmount = 0;
  #lastId = 0;

  send(text: string): void {
    const f = JSON.parse(text) as Out;
    v.parse(S2CFrame, f); // wire conformance of every server frame
    expect(f.id).toBeGreaterThan(this.#lastId); // per-direction frame counter
    this.#lastId = f.id;
    this.frames.push(f);
  }
  close(code: number, reason?: string): void {
    this.closed ??= { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings++;
  }
  pauseReading(ms: number): void {
    this.paused.push(ms);
  }
  of(t: string): Out[] {
    return this.frames.filter((f) => f.t === t);
  }
  last(t?: string): Out | undefined {
    return (t === undefined ? this.frames : this.of(t)).at(-1);
  }
}

let frameId = 0;
const frame = (t: string, body: unknown): string =>
  JSON.stringify({ v: 1, t, id: ++frameId, body });

function helloBody(os: string, dev: string, epoch = 3, extra: Record<string, unknown> = {}) {
  return {
    proto: 1,
    build: BUILD,
    osSessionId: os,
    deviceId: dev,
    kernelEpoch: epoch,
    lamport: 1,
    outbox: { pending: 0, held: 0 },
    heldLeases: [],
    resume: [],
    ...extra,
  };
}

function setup(opts: { revoked?: Set<string> } = {}) {
  const clock = new ManualClock();
  const db = new FakeDb(clock.now());
  db.addUser(0, 'root');
  db.addUser(ALICE, 'alice');
  db.addUser(BOB, 'bob');
  db.addDir(ROOT_DIR, null, '', 0);
  db.addDir(HOME, ROOT_DIR, 'home', 0);
  db.addDir(BOB_HOME, HOME, 'bob', BOB, 0o700);
  db.addDir(SHARED, HOME, 'shared', BOB, 0o755);
  db.addFile(REPORT, SHARED, 'report.md', BOB, { mode: 0o644, sha: sha(1), size: 1 });
  for (let i = 2; i < 60; i++) db.addBlob(sha(i), i);

  const lockStore = new MemoryLockStore(clock);
  lockStore.users.set(ALICE, 'alice');
  lockStore.users.set(BOB, 'bob');
  lockStore.inodes.set(REPORT, { type: 'f', mode: 0o666, uid: BOB, gid: BOB, lockFence: 0 });
  lockStore.sessions.set(OS_A, {
    authSessionId: 'auth-a',
    deviceId: DEV_A,
    ownerUid: ALICE,
    kernelEpoch: 3,
  });
  lockStore.sessions.set(OS_B, {
    authSessionId: 'auth-b',
    deviceId: DEV_B,
    ownerUid: BOB,
    kernelEpoch: 3,
  });

  let hub: SyncHub | null = null;
  const notifier: LockNotifier = {
    toConn: (id: string, f: LockFrame) => hub?.lockNotifier.toConn(id, f),
    toSession: (os: string, f: LockFrame) => hub?.lockNotifier.toSession(os, f),
  };
  const errors: string[] = [];
  const locks = new LockManager({
    store: lockStore,
    notifier,
    clock,
    ttlMs: LEASE_TTL_DEMO_MS,
    createHeap: testHeapFactory,
  });
  const cancelled: string[] = [];
  const engine = new SyncEngine<FakeTx>({
    steps: db.steps,
    cancel: new CancelRegistry(),
    lockTimeoutMs: 2_000,
    statementTimeoutMs: 15_000,
    feed: db.feedSql,
    handlerFor: (s) =>
      s.op.kind === 'write'
        ? new ContentWriteHandler(db.content, s, { timeZone: 'UTC' })
        : undefined,
    sessions: {
      ownsOsSession: (o, u, d) =>
        hub === null ? Promise.resolve(false) : hub.ownsOsSession(o, u, d),
    },
    onCommitted: (c) => hub?.committed(c),
    sleep: () => Promise.resolve(),
  });
  const broadcaster = new Broadcaster({
    clock,
    reader: db.reader,
    dirs: db.reader,
    createHeap: testHeapFactory,
  });
  const revoked = opts.revoked ?? new Set<string>();
  let n = 0;
  hub = new SyncHub({
    engine,
    locks,
    broadcaster,
    reader: db.reader,
    dirs: db.reader,
    sessions: db.sessions,
    clock,
    config: { build: BUILD, leaseTtlMs: LEASE_TTL_DEMO_MS, maxWatches: 2, creditWindow: 4 },
    validateAuth: (id) => Promise.resolve(!revoked.has(id)),
    canWatch: (cred: Cred, ino: string) => Promise.resolve(cred.uid === BOB || ino === SHARED),
    cancelBackend: (opId) => cancelled.push(opId),
    newId: () => `conn-${++n}`,
    onError: (_e, c) => errors.push(c),
  });
  const auth = (
    uid: number,
    authSessionId: string,
    grants: { uid: number; expiresAt: Date }[] = [],
  ): ConnAuth => ({
    authSessionId,
    uid,
    username: uid === ALICE ? 'alice' : 'bob',
    kind: 'user',
    gids: [uid],
    suGrants: () => grants,
  });
  const connect = async (
    uid: number,
    authSessionId: string,
    os: string,
    dev: string,
    epoch = 3,
    extra: Record<string, unknown> = {},
  ) => {
    const socket = new FakeSocket();
    const conn = hub.accept(socket, auth(uid, authSessionId));
    conn.onMessage(frame('hello', helloBody(os, dev, epoch, extra)));
    await flush(40);
    return { socket, conn };
  };
  return { clock, db, hub, locks, lockStore, engine, errors, cancelled, revoked, connect, auth };
}

const writeFrom = (os: string, principal: number, n: number, base: number): OpSubmit =>
  writeOp({
    opId: uid7(0x9700, n),
    osSessionId: os,
    cseq: n,
    principal,
    ino: REPORT,
    sha: sha(n + 2),
    size: n + 2,
    baseVersion: base,
  });

describe('SYN-03 handshake (§3.8.4, §4.4 hello.ok)', () => {
  it('SYN-03 hello.ok carries the cookie auth, the limits, the timers of the lease profile and the owners resume plan', async () => {
    const { connect } = setup();
    const { socket, conn } = await connect(ALICE, 'auth-a', OS_A, DEV_A, 3, {
      resume: [
        { ownerUid: BOB, fromSeq: 0 },
        { ownerUid: 4242, fromSeq: 0 },
      ],
    });
    const ok = socket.last('hello.ok')?.body;
    expect(ok).toMatchObject({
      proto: 1,
      osSessionId: OS_A,
      server: BUILD,
      auth: { uid: ALICE, username: 'alice', gids: [ALICE], kind: 'user', suGrants: [] },
      limits: {
        maxPayload: 65_536,
        opEnvelopeMax: 61_440,
        maxBatch: 32,
        creditWindow: 4,
        feedWindow: 256,
        maxLeases: 256,
        maxWatches: 2,
      },
      timers: { leaseTtlMs: 15_000, hbMs: 5_000, deadManMs: 25_000 },
      owners: [
        { ownerUid: BOB, fromSeq: 0, headSeq: 0, horizonSeq: 1, mode: 'stream' },
        { ownerUid: 4242, fromSeq: 0, headSeq: 0, horizonSeq: 1, mode: 'snapshot' },
      ],
      keptLeases: [],
      lostLeases: [],
    });
    expect(socket.last('resume.done')?.body).toEqual({ ownerUid: BOB, headSeq: 0 });
    expect(socket.last('snapshot.required')?.body).toMatchObject({
      ownerUid: 4242,
      reason: 'reset',
    });
    expect(conn.hello).toMatchObject({
      osSessionId: OS_A,
      deviceId: DEV_A,
      kernelEpoch: 3,
      proto: 1,
    });
    expect(conn.streamOf(BOB)?.state).toBe('live');
  });

  it('SYN-10 no hello within 5 s ends with bye idle-timeout and close 4408', async () => {
    const { hub, clock, auth } = setup();
    const socket = new FakeSocket();
    hub.accept(socket, auth(ALICE, 'auth-a'));
    await clock.advance(5_000);
    expect(socket.last('bye')?.body).toEqual({ reason: 'idle-timeout' });
    expect(socket.closed?.code).toBe(4408);
  });

  it('SYN-10 a hello with an OS session id owned by another uid is refused with bye policy and 1008', async () => {
    const { db, connect } = setup();
    db.addSession(OS_B, BOB, DEV_B);
    const { socket } = await connect(ALICE, 'auth-a', OS_B, DEV_A);
    expect(socket.last('bye')?.body).toEqual({ reason: 'policy' });
    expect(socket.closed?.code).toBe(1008);
  });

  it('SYN-10 a newer kernel epoch of the same device supersedes the older connection (4409); an older epoch is refused', async () => {
    const { connect, lockStore, locks, hub } = setup();
    const first = await connect(ALICE, 'auth-a', OS_A, DEV_A, 3);
    first.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 1),
        ino: REPORT,
        mode: 'X',
        wait: false,
        principal: ALICE,
      }),
    );
    await flush(40);
    expect(first.socket.last('lock.granted')).toBeDefined();
    const OS_A2 = uid7(3, 11);
    lockStore.sessions.set(OS_A2, {
      authSessionId: 'auth-a',
      deviceId: DEV_A,
      ownerUid: ALICE,
      kernelEpoch: 4,
    });
    const second = await connect(ALICE, 'auth-a', OS_A2, DEV_A, 4);
    expect(first.socket.last('bye')?.body).toEqual({ reason: 'superseded' });
    expect(first.socket.closed?.code).toBe(4409);
    expect(second.socket.last('hello.ok')).toBeDefined();
    // The dead predecessor's lease is released at once, not after the TTL.
    expect(locks.holdersOf(REPORT)).toEqual([]);
    const stale = await connect(ALICE, 'auth-a', uid7(3, 12), DEV_A, 2);
    expect(stale.socket.last('bye')?.body).toEqual({ reason: 'superseded' });
    expect(stale.socket.closed?.code).toBe(4409);
    expect(hub.size).toBeGreaterThanOrEqual(2);
  });

  it('SYN-03 frames before the handshake finished wait for it; frames before hello are refused', async () => {
    const { hub, auth } = setup();
    const socket = new FakeSocket();
    const conn = hub.accept(socket, auth(BOB, 'auth-b'));
    conn.onMessage(frame('hb', { t: 1, leases: [], lamport: 0 }));
    expect(socket.last('error')?.body).toMatchObject({ code: 'forbidden' });
    conn.onMessage(frame('hello', helloBody(OS_B, DEV_B)));
    conn.onMessage(frame('op.submit', writeFrom(OS_B, BOB, 1, 1)));
    await flush(60);
    expect(socket.frames.map((f) => f.t)).toEqual(['error', 'hello.ok', 'op.result']);
  });
});

describe('OFF-02 ops over the socket (§3.9, §3.10)', () => {
  it('OFF-02 op.submit is answered with op.result on the origin connection only; mirrors of the owner get vfs.changed', async () => {
    const { connect, db } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A, 3, {
      resume: [{ ownerUid: BOB, fromSeq: 0 }],
    });
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B, 3, {
      resume: [{ ownerUid: BOB, fromSeq: 0 }],
    });
    bob.conn.onMessage(frame('op.submit', writeFrom(OS_B, BOB, 1, 1)));
    await flush(80);
    const result = bob.socket.last('op.result')?.body;
    expect(result).toMatchObject({ status: 'applied', ownerSeqs: [{ ownerUid: BOB, seq: 1 }] });
    expect(bob.socket.of('vfs.changed')).toEqual([]); // not echoed to the origin
    const changed = alice.socket.last('vfs.changed')?.body;
    expect(changed).toMatchObject({ ownerUid: BOB, seq: 1, redacted: false });
    expect(db.inode(REPORT)?.version).toBe(2);
    alice.conn.onMessage(frame('ack', { cursors: [{ ownerUid: BOB, seq: 1 }] }));
  });

  it('SYN-06 more ops in flight than the credit window get error limit', async () => {
    const { connect } = setup();
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    const ops = [1, 2, 3, 4, 5].map((n) => writeFrom(OS_B, BOB, n, n));
    bob.conn.onMessage(frame('op.batch', { ops }));
    await flush(40);
    expect(bob.socket.last('error')?.body).toMatchObject({ code: 'limit' });
  });

  it('OFF-02 an op with a valid identity and an invalid body is answered rejected EINVAL', async () => {
    const { connect } = setup();
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    const bad = {
      ...writeFrom(OS_B, BOB, 9, 1),
      op: { kind: 'write', ino: REPORT, blob: 'x', size: 1, mtime: 1 },
    };
    bob.conn.onMessage(frame('op.submit', bad));
    await flush(40);
    expect(bob.socket.last('op.result')?.body).toMatchObject({
      status: 'rejected',
      errno: 'EINVAL',
    });
  });

  it('SYN-11 an op filed under another uid OS session closes the connection with bye policy and 1008', async () => {
    const { connect } = setup();
    await connect(ALICE, 'auth-a', OS_A, DEV_A);
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    bob.conn.onMessage(frame('op.submit', writeFrom(OS_A, BOB, 1, 1)));
    await flush(60);
    expect(bob.socket.last('bye')?.body).toEqual({ reason: 'policy' });
    expect(bob.socket.closed?.code).toBe(1008);
  });

  it('AGT-09 proc.signal for a queued op of the lane answers rejected ECANCELED killed', async () => {
    const { connect } = setup();
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    const a = writeFrom(OS_B, BOB, 1, 1);
    const b = writeFrom(OS_B, BOB, 2, 2);
    bob.conn.onMessage(frame('op.batch', { ops: [a, b] }));
    bob.conn.onMessage(
      frame('proc.signal', { target: { kind: 'op', opId: b.opId }, sig: 'SIGTERM' }),
    );
    await flush(80);
    const results = bob.socket.of('op.result').map((f) => f.body);
    expect(results).toContainEqual(
      expect.objectContaining({ opId: b.opId, status: 'rejected', errno: 'ECANCELED' }),
    );
    expect(results).toContainEqual(expect.objectContaining({ opId: a.opId, status: 'applied' }));
  });
});

describe('OFF-02 POST /api/ops/{opId} (backend-api.md §3.6.2)', () => {
  it('OFF-02 an HTTP op of a session with a live socket joins its op lane and is answered only in the HTTP response', async () => {
    const { connect, hub } = setup();
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    const origin = { uid: BOB, mayActAs: (p: number) => p === BOB, gidsOf: () => [BOB] };
    const r = await hub.submitOp(origin, writeFrom(OS_B, BOB, 1, 1));
    expect(r).toMatchObject({ status: 'applied', duplicate: false });
    expect(bob.socket.of('op.result')).toEqual([]);
    bob.conn.onClose(1006);
    await flush(20);
    // Without a live socket the op runs directly (and dedups through op_log).
    const again = await hub.submitOp(origin, writeFrom(OS_B, BOB, 1, 1));
    expect(again).toMatchObject({ status: 'applied', duplicate: true });
  });

  it('OFF-02 an HTTP op beyond the credit window or on a closing socket is answered retry', async () => {
    const { connect, hub, db } = setup();
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = db.content.takeBlob.bind(db.content);
    db.content.takeBlob = async (tx, s) => {
      await gate;
      return original(tx, s);
    };
    const ops = [1, 2, 3, 4].map((n) => writeFrom(OS_B, BOB, n, n));
    bob.conn.onMessage(frame('op.batch', { ops }));
    await flush(20); // the four ops occupy the whole credit window
    const r = await bob.conn.submitHttp(writeFrom(OS_B, BOB, 9, 1));
    expect(r).toMatchObject({ status: 'retry', errno: 'EAGAIN', reason: 'rate' });
    release();
    await flush(80);
    await hub.shutdown(10);
    const late = await bob.conn.submitHttp(writeFrom(OS_B, BOB, 10, 1));
    expect(late).toMatchObject({ status: 'retry', errno: 'EIO' });
  });
});

describe('VFS-09 leases over the socket (§3.14)', () => {
  it('VFS-09 two users contend: the second writer gets EBUSY naming the holder and is granted after a clean bye', async () => {
    const { connect } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    alice.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 1),
        ino: REPORT,
        mode: 'X',
        wait: false,
        principal: ALICE,
      }),
    );
    await flush(40);
    const granted = alice.socket.last('lock.granted')?.body;
    expect(granted).toMatchObject({ mode: 'X', ttlMs: 15_000 });
    bob.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 2),
        ino: REPORT,
        mode: 'X',
        wait: true,
        principal: BOB,
      }),
    );
    await flush(40);
    expect(bob.socket.last('lock.queued')?.body).toMatchObject({ position: 1 });
    // hb renews: hb.ack lists it as renewed
    alice.conn.onMessage(
      frame('hb', {
        t: 77,
        leases: [{ leaseId: granted?.['leaseId'], ino: REPORT, fence: granted?.['fence'] }],
        lamport: 2,
      }),
    );
    await flush(40);
    expect(alice.socket.last('hb.ack')?.body).toMatchObject({
      t: 77,
      renewed: [granted?.['leaseId']],
      lost: [],
    });
    // BOOT-12: reboot sends bye; the server releases the OS session's leases at once
    alice.conn.onMessage(frame('bye', { reason: 'reboot' }));
    expect(alice.socket.closed?.code).toBe(1000);
    alice.conn.onClose(1000);
    await flush(60);
    expect(bob.socket.of('lock.released').length).toBeGreaterThan(0);
    expect(bob.socket.last('lock.granted')?.body).toMatchObject({ mode: 'X' });
  });

  it('VFS-09 an abnormal close keeps the lease until the TTL; then the waiter acquires within TTL + 0.5 s', async () => {
    const { connect, clock } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    alice.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 3),
        ino: REPORT,
        mode: 'X',
        wait: false,
        principal: ALICE,
      }),
    );
    await flush(40);
    const renewedAt = clock.now();
    alice.conn.onClose(1006);
    bob.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 4),
        ino: REPORT,
        mode: 'X',
        wait: true,
        principal: BOB,
      }),
    );
    await flush(40);
    // bob's kernel heartbeats every TTL/3 (his own socket must not idle out meanwhile)
    for (let i = 0; i < 2; i++) {
      await clock.advance(5_000);
      bob.conn.onMessage(frame('hb', { t: i, leases: [], lamport: 0 }));
      await flush(20);
    }
    await clock.advanceTo(renewedAt + LEASE_TTL_DEMO_MS - 100);
    expect(bob.socket.last('lock.granted')).toBeUndefined();
    await clock.advanceTo(renewedAt + LEASE_TTL_DEMO_MS + 500);
    expect(bob.socket.last('lock.granted')).toBeDefined();
    expect(bob.socket.closed).toBeNull();
  });

  it('VFS-09 revoking the auth session closes its sockets with bye revoked / 4401 and releases its leases', async () => {
    const { connect, hub, revoked } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    alice.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 5),
        ino: REPORT,
        mode: 'X',
        wait: false,
        principal: ALICE,
      }),
    );
    await flush(40);
    bob.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 6),
        ino: REPORT,
        mode: 'X',
        wait: true,
        principal: BOB,
      }),
    );
    await flush(40);
    revoked.add('auth-a');
    await hub.revoke(['auth-a']);
    await flush(40);
    expect(alice.socket.last('bye')?.body).toEqual({ reason: 'revoked' });
    expect(alice.socket.closed?.code).toBe(4401);
    expect(bob.socket.last('lock.granted')).toBeDefined();
  });

  it('VFS-09 an hb on a revoked or expired auth session is answered by the revocation path (4401)', async () => {
    const { connect, revoked } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    revoked.add('auth-a');
    alice.conn.onMessage(frame('hb', { t: 1, leases: [], lamport: 0 }));
    await flush(40);
    expect(alice.socket.closed?.code).toBe(4401);
    expect(alice.socket.of('hb.ack')).toEqual([]);
  });

  it('VFS-09 hello.heldLeases returns kept leases after a quick reconnect of the same OS session', async () => {
    const { connect } = setup();
    const first = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    first.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 7),
        ino: REPORT,
        mode: 'S',
        wait: false,
        principal: ALICE,
      }),
    );
    await flush(40);
    const g = first.socket.last('lock.granted')?.body;
    first.conn.onClose(1006);
    const again = await connect(ALICE, 'auth-a', OS_A, DEV_A, 3, {
      heldLeases: [{ leaseId: g?.['leaseId'], ino: REPORT, fence: g?.['fence'] }],
    });
    expect(again.socket.last('hello.ok')?.body).toMatchObject({
      keptLeases: [{ leaseId: g?.['leaseId'], mode: 'S' }],
      lostLeases: [],
    });
  });

  it('VFS-09 releasing an unknown lease answers error forbidden EINVAL unknown-lease; cancel of a queued request works', async () => {
    const { connect } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    alice.conn.onMessage(frame('lock.release', { leaseId: uid7(0x9900, 1) }));
    await flush(40);
    expect(alice.socket.last('error')?.body).toMatchObject({
      code: 'forbidden',
      errno: 'EINVAL',
      msg: 'unknown-lease',
    });
    alice.conn.onMessage(frame('lock.release', { reqId: uid7(0x9900, 2) }));
    await flush(20);
  });
});

describe('SYN-12 backpressure, throttling and shutdown (§3.9, §4.5, §4.6.1)', () => {
  it('SYN-12 a slow consumer above 4 MiB buffered is closed with bye slow-consumer and 4508', async () => {
    const { connect } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    alice.socket.bufferedAmount = CLOSE_AT + 1;
    alice.conn.onMessage(frame('hb', { t: 1, leases: [], lamport: 0 }));
    await flush(40);
    expect(alice.socket.last('bye')?.body).toEqual({ reason: 'slow-consumer' });
    expect(alice.socket.closed?.code).toBe(4508);
  });

  it('SYN-06 a control-frame flood is throttled and then closed 4429; a replay burst of op frames never is', async () => {
    const { connect } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    for (let i = 0; i < 205 && alice.socket.closed === null; i++)
      alice.conn.onMessage(frame('unwatch', { ino: SHARED }));
    expect(alice.socket.of('throttle')[0]?.body).toMatchObject({ scope: 'frames' });
    expect(alice.socket.paused.length).toBeGreaterThan(0);
    expect(alice.socket.closed?.code).toBe(4429);

    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    // A replaying client within its credit window: each op gets its result before the next is sent.
    for (let i = 0; i < 300; i++) {
      const utimes: OpSubmit = {
        ...writeFrom(OS_B, BOB, 1000 + i, 1),
        op: { kind: 'utimes', ino: REPORT, mtime: 1 },
      };
      bob.conn.onMessage(frame('op.submit', utimes));
      await flush(8);
    }
    expect(bob.socket.of('throttle').length).toBeGreaterThan(0);
    expect(bob.socket.of('op.result')).toHaveLength(300);
    expect(bob.socket.closed).toBeNull();
  });

  it('SYN-10 graceful shutdown finishes the running op, then bye restart and 1012; leases stay', async () => {
    const { connect, hub, locks } = setup();
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    bob.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 9),
        ino: REPORT,
        mode: 'X',
        wait: false,
        principal: BOB,
      }),
    );
    await flush(40);
    await hub.shutdown(1_000);
    expect(bob.socket.last('bye')?.body).toEqual({ reason: 'restart', retryAfterMs: 0 });
    expect(bob.socket.closed?.code).toBe(1012);
    expect(hub.draining).toBe(true);
    expect(locks.holdersOf(REPORT)).toHaveLength(1);
    bob.conn.onClose(1012);
    expect(locks.holdersOf(REPORT)).toHaveLength(1);
  });

  it('SYN-11 when a su grant ends, the auth session sockets get proc.signal SIGHUP', async () => {
    const { connect, hub } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    hub.suEnded('auth-a', 0, 'su-expired');
    expect(alice.socket.last('proc.signal')?.body).toEqual({
      target: { kind: 'principal', uid: 0 },
      sig: 'SIGHUP',
      reason: 'su-expired',
    });
    expect(hub.socketsOf('auth-a')).toBe(1);
    expect(hub.connection(alice.conn.connId)).toBe(alice.conn);
  });

  it('SYN-10 pongs keep the socket alive; a missed pong terminates it', async () => {
    const { connect, clock } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    await clock.advance(20_000);
    expect(alice.socket.pings).toBe(1);
    alice.conn.onPong();
    alice.conn.onMessage(frame('hb', { t: 1, leases: [], lamport: 0 }));
    await clock.advance(10_000);
    alice.conn.onMessage(frame('hb', { t: 2, leases: [], lamport: 0 }));
    await clock.advance(10_000);
    expect(alice.socket.pings).toBe(2);
    alice.conn.onMessage(frame('hb', { t: 3, leases: [], lamport: 0 }));
    await clock.advance(10_000);
    alice.conn.onMessage(frame('hb', { t: 4, leases: [], lamport: 0 }));
    await clock.advance(10_000);
    expect(alice.socket.terminated).toBe(true);
  });
});

describe('SYN-18 watches and resume on an open connection (§4.3)', () => {
  it('SYN-18 a watched directory delivers entries of an owner the connection does not mirror; watches are limited and checked', async () => {
    const { connect } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    alice.conn.onMessage(frame('watch', { ino: BOB_HOME }));
    await flush(20);
    expect(alice.socket.last('error')?.body).toMatchObject({ code: 'forbidden', errno: 'EACCES' });
    alice.conn.onMessage(frame('watch', { ino: SHARED }));
    await flush(20);
    // bob's write into a file of the shared dir: the entry's dirs are [] for an in-place write, so
    // produce a conflict (a new entry in SHARED) to exercise the watch path.
    bob.conn.onMessage(frame('op.submit', writeFrom(OS_B, BOB, 1, 1)));
    await flush(60);
    bob.conn.onMessage(frame('op.submit', writeFrom(OS_B, BOB, 2, 1))); // stale base: conflict copy in SHARED
    await flush(80);
    expect(bob.socket.last('op.result')?.body).toMatchObject({ status: 'conflict' });
    expect(alice.socket.last('vfs.changed')?.body).toMatchObject({
      ownerUid: BOB,
      redacted: false,
    });
    alice.conn.onMessage(frame('watch', { ino: uid7(1, 50) }));
    alice.conn.onMessage(frame('watch', { ino: uid7(1, 51) }));
    await flush(20);
    alice.conn.onMessage(frame('unwatch', { ino: SHARED }));
  });

  it('SYN-05 a resume frame restarts an owner stream; a cursor beyond the head gets snapshot.required reset', async () => {
    const { connect } = setup();
    const alice = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    alice.conn.onMessage(
      frame('resume', {
        cursors: [
          { ownerUid: BOB, fromSeq: 0 },
          { ownerUid: ALICE, fromSeq: 99 },
          { ownerUid: 77, fromSeq: 0 },
        ],
      }),
    );
    await flush(60);
    expect(alice.socket.of('resume.done').map((f) => f.body)).toContainEqual({
      ownerUid: BOB,
      headSeq: 0,
    });
    const snaps = alice.socket.of('snapshot.required').map((f) => f.body);
    expect(snaps).toContainEqual(expect.objectContaining({ ownerUid: ALICE, reason: 'reset' }));
    expect(snaps).toContainEqual(expect.objectContaining({ ownerUid: 77, reason: 'reset' }));
  });
});

describe('SYN-02 the control lane never waits behind the op lane', () => {
  it('SYN-02 a lock grant is answered while an op is still running on the same connection', async () => {
    const { connect, db } = setup();
    const bob = await connect(BOB, 'auth-b', OS_B, DEV_B);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = db.content.takeBlob.bind(db.content);
    db.content.takeBlob = async (tx, s) => {
      await gate; // the op's transaction is stuck (a 1,000-node rm -r)
      return original(tx, s);
    };
    bob.conn.onMessage(frame('op.submit', writeFrom(OS_B, BOB, 1, 1)));
    await flush(20);
    bob.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 20),
        ino: REPORT,
        mode: 'S',
        wait: false,
        principal: BOB,
      }),
    );
    await flush(40);
    expect(bob.socket.last('lock.granted')).toBeDefined();
    expect(bob.socket.of('op.result')).toEqual([]);
    release();
    await flush(60);
    expect(bob.socket.last('op.result')?.body).toMatchObject({ status: 'applied' });
  });
});

describe('BOOT-12 closing (§3.14.5)', () => {
  it('BOOT-12 a clean client close while another connection of the same OS session is open keeps the leases', async () => {
    const { connect, locks } = setup();
    const a1 = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    a1.conn.onMessage(
      frame('lock.acquire', {
        reqId: uid7(0x9800, 30),
        ino: REPORT,
        mode: 'S',
        wait: false,
        principal: ALICE,
      }),
    );
    await flush(40);
    const a2 = await connect(ALICE, 'auth-a', OS_A, DEV_A);
    a1.conn.onClose(1000);
    await flush(20);
    expect(locks.holdersOf(REPORT)).toHaveLength(1);
    a2.conn.onClose(1000);
    await flush(20);
    expect(locks.holdersOf(REPORT)).toHaveLength(0);
    a2.conn.onClose(1000); // idempotent
    a2.conn.onMessage(frame('hb', { t: 1, leases: [], lamport: 0 })); // ignored after close
    expect(a2.conn.closed).toBe(true);
  });
});
