import type { C2SFrame, OpSubmit } from '@plotinium/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxRec } from '../../store/records.ts';
import { cursorSeq } from '../results.ts';
import { StoreSyncStorage } from '../storage.ts';
import { FakeClock, settle } from './doubles/clock.ts';
import { ALICE, BOB, HOME, fileRec, outboxRec, sha, tid, undoRec } from './doubles/device.ts';
import type { Seed } from './doubles/device.ts';
import { FakeServer } from './doubles/fake-server.ts';
import type { Decision } from './doubles/fake-server.ts';
import { Harness, seededRandom } from './doubles/harness.ts';

/** `n` offline creates in alice's home, each with its undo record and outbox op. */
function creates(
  n: number,
  first = 0,
  over: (i: number) => Partial<Parameters<typeof outboxRec>[0]> = () => ({}),
): Seed {
  const inodes = [];
  const dentries = [];
  const undo = [];
  const outbox: OutboxRec[] = [];
  for (let i = first; i < first + n; i++) {
    const ino = tid(0x10000 + i);
    const opId = tid(0x20000 + i);
    const name = `f${i}`;
    inodes.push(fileRec(ino, ALICE));
    dentries.push({ parent: HOME.alice, name, ino, dtype: 'f' as const });
    undo.push(undoRec(opId, { created: { inodes: [ino], dentries: [[HOME.alice, name]] } }));
    outbox.push(
      outboxRec({
        opId,
        cseq: i + 1,
        op: { kind: 'create', parentIno: HOME.alice, name, ino, type: 'f', mode: 0o644, mtime: 0 },
        touches: [ino],
        ...over(i),
      }),
    );
  }
  return { inodes, dentries, undo, outbox };
}

const opIno = (op: OpSubmit): string =>
  op.op.kind === 'create' || op.op.kind === 'write' ? op.op.ino : op.opId;

describe('replay exactly once (OFF-02, §3.9–§3.11)', () => {
  it('OFF-02 exactly-once property: 60 queued ops with dropped acks, duplicated frames, transient retries and a server killed after COMMIT are applied once each and leave an empty outbox', async () => {
    for (const seed of [1, 2, 3]) {
      const n = 60;
      const h = await Harness.create({ seed: creates(n) });
      const rnd = seededRandom(seed);
      const plan = new Map<string, { retry: boolean; drop: boolean; dup: boolean; cut: boolean }>();
      for (let i = 0; i < n; i++)
        plan.set(tid(0x20000 + i), {
          retry: rnd() < 0.1,
          drop: rnd() < 0.25,
          dup: rnd() < 0.2,
          cut: rnd() < 0.05,
        });
      let aliceSeq = 0;
      h.server.decide = (op, attempt): Decision =>
        attempt === 1 && plan.get(op.opId)?.retry === true
          ? { status: 'retry', errno: 'EAGAIN', reason: 'retry-exhausted', retryAfterMs: 300 }
          : {
              status: 'applied',
              versions: [{ ino: opIno(op), version: 1 }],
              ownerSeqs: [{ ownerUid: ALICE, seq: ++aliceSeq }],
            };
      h.server.faults = {
        dropReply: (id, a) => a <= 2 && plan.get(id)?.drop === true,
        duplicateReply: (id) => plan.get(id)?.dup === true,
        closeAfterCommit: (id, a) => a === 1 && plan.get(id)?.cut === true,
      };
      h.syncd.connect();
      const done = await h.until(
        () => h.outbox().length === 0 && h.syncd.state === 'LIVE',
        1_000,
        600,
        6,
      );
      expect(done).toBe(true);
      expect(h.server.opLog.size).toBe(n);
      for (const opId of plan.keys()) expect(h.server.effects.get(opId)).toBe(1);
      expect(h.dev.dump('undo')).toEqual([]);
      for (const b of h.server.framesOf('op.batch')) expect(b.ops.length).toBeLessThanOrEqual(16);
      expect(h.server.framesOf('op.batch').length).toBeGreaterThan(0);
      // Every op's own feed entry advanced alice's cursor through the reorder buffer.
      expect(cursorSeq({ k: '', v: h.dev.meta('resume:1000') })).toBe(n);
      expect(h.label).toBe('Online');
      await h.syncd.shutdown('shutdown');
    }
  }, 120_000);

  it('OFF-02 a result whose local transaction fails is resent and applied once from the server op_log', async () => {
    const spy = vi
      .spyOn(StoreSyncStorage.prototype, 'applyResult')
      .mockRejectedValueOnce(new Error('AbortError'));
    try {
      const h = await Harness.create({ seed: creates(2) });
      h.syncd.connect();
      await h.until(() => h.outbox().length === 0 && h.syncd.state === 'LIVE');
      expect(h.outbox()).toEqual([]);
      expect([...h.server.effects.values()]).toEqual([1, 1]);
      expect(h.notices.some((n) => n.type === 'protocol-error' && n.msg === 'AbortError')).toBe(
        true,
      );
      expect(h.server.sentOf('op.result').some((r) => r.duplicate)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('OFF-02 a client crash between the send and the result delivers the op exactly once after reboot', async () => {
    const clockA = new FakeClock();
    const clockB = new FakeClock();
    const server = new FakeServer(clockB);
    server.faults = { dropReply: () => true };
    const a = await Harness.create({ seed: creates(3), clock: clockA, server });
    a.syncd.connect();
    await settle();
    await clockA.advance(100);
    expect(server.opLog.size).toBe(3);
    expect(a.outbox().every((r) => r.attempts === 1)).toBe(true);
    server.last.kill(1006); // the tab dies; its timers (clockA) never run again
    await settle();
    server.faults = {};
    const b = await Harness.create({ device: a.dev, clock: clockB, server });
    await b.live();
    expect(b.syncd.state).toBe('LIVE');
    expect(b.outbox()).toEqual([]);
    expect([...server.effects.values()]).toEqual([1, 1, 1]);
    expect(server.sentOf('op.result').filter((r) => r.duplicate).length).toBe(3);
  });

  it('OFF-02 a resent op whose first attempt was rejected returns the same errno and is never applied', async () => {
    const h = await Harness.create({ seed: creates(1) });
    h.server.decide = () => ({ status: 'rejected', errno: 'EACCES' });
    h.server.faults = { dropReply: (_id, a) => a === 1 };
    h.syncd.connect();
    await settle();
    h.server.last.kill(1006);
    await h.until(() => h.outbox().length === 0);
    expect(h.server.effects.size).toBe(0);
    expect(h.notices.find((n) => n.type === 'rejected')).toMatchObject({
      errno: 'EACCES',
      parked: false,
    });
    expect(h.dev.inode(tid(0x10000))).toBeUndefined();
  });

  it('OFF-02 ops behind a retried op are answered retry without executing and resent in order', async () => {
    const h = await Harness.create({ seed: creates(4) });
    const order: string[] = [];
    h.server.decide = (op, attempt) => {
      if (op.opId === tid(0x20001) && attempt === 1)
        return { status: 'retry', errno: 'EBUSY', reason: 'lock-timeout', retryAfterMs: 2_000 };
      order.push(op.opId);
      return { status: 'applied' };
    };
    await h.live();
    expect(order).toEqual([tid(0x20000), tid(0x20001), tid(0x20002), tid(0x20003)]);
    expect(
      h.server.sentOf('op.result').filter((r) => r.reason === 'predecessor-retry'),
    ).toHaveLength(2);
    expect(h.outbox()).toEqual([]);
  });

  it('OFF-02 an op larger than 60 KB goes through POST /api/ops/{opId} at the head of an empty window', async () => {
    const big = 'z'.repeat(62_000);
    const h = await Harness.create({
      seed: creates(3, 0, (i) =>
        i === 1
          ? {
              op: {
                kind: 'create',
                parentIno: HOME.alice,
                name: 'f1',
                ino: tid(0x10001),
                type: 'l',
                mode: 0o777,
                symlinkTarget: big,
                mtime: 0,
              },
            }
          : {},
      ),
    });
    await h.live();
    expect(h.server.posted).toEqual([tid(0x20001)]);
    expect(h.outbox()).toEqual([]);
    const wsOps = [
      ...h.server.framesOf('op.submit'),
      ...h.server.framesOf('op.batch').flatMap((b) => b.ops),
    ].map((o) => o.opId);
    expect(wsOps).toEqual([tid(0x20000), tid(0x20002)]);
  });

  it('OFF-02 a POST that fails in transit keeps the op at the head and resends it', async () => {
    let fails = 1;
    const big = 'q'.repeat(62_000);
    const clock = new FakeClock();
    const server = new FakeServer(clock);
    const h = await Harness.create({
      clock,
      server,
      seed: creates(1, 0, () => ({
        op: {
          kind: 'create',
          parentIno: HOME.alice,
          name: 'f0',
          ino: tid(0x10000),
          type: 'l',
          mode: 0o777,
          symlinkTarget: big,
          mtime: 0,
        },
      })),
      http: {
        postOp: (opId, body) => {
          if (fails-- > 0) return Promise.reject(new Error('offline'));
          return Promise.resolve(server.postOp(opId, body));
        },
      },
    });
    await h.live();
    expect(h.outbox()).toEqual([]);
    expect(server.effects.get(tid(0x20000))).toBe(1);
  });

  it('OFF-02 blobs are uploaded before their op, at most twice in parallel, and re-uploaded after blob-missing', async () => {
    const h = await Harness.create({
      seed: {
        ...creates(3, 0, (i) => ({
          blobs: [sha(0x100 + i)],
          op: {
            kind: 'create',
            parentIno: HOME.alice,
            name: `f${i}`,
            ino: tid(0x10000 + i),
            type: 'f',
            mode: 0o644,
            blob: sha(0x100 + i),
            size: 1,
            mtime: 0,
          },
        })),
        blobs: [0, 1, 2].map((i) => ({
          sha: sha(0x100 + i),
          size: 1,
          chunks: [],
          refcount: 2,
          uploaded: i === 2,
        })),
      },
    });
    h.server.decide = (op, attempt) =>
      op.opId === tid(0x20000) && attempt === 1
        ? { status: 'retry', errno: 'EAGAIN', reason: 'blob-missing', retryAfterMs: 100 }
        : { status: 'applied' };
    await h.live();
    expect(h.outbox()).toEqual([]);
    expect(h.uploads).toEqual([sha(0x100), sha(0x101), sha(0x100)]);
    expect(h.dev.blob(sha(0x100))?.uploaded).toBe(true);
  });

  it('SYN-11 an op whose principal has no su grant is held, not sent, and applies after a new grant', async () => {
    const h = await Harness.create({
      seed: creates(2, 0, (i) => (i === 0 ? { principal: BOB } : {})),
    });
    await h.live();
    expect(h.syncd.state).toBe('LIVE');
    expect(h.label).toBe('Online · 1 waiting for sign-in');
    expect(h.server.opLog.has(tid(0x20000))).toBe(false);
    h.syncd.setSuGrants([{ uid: BOB, expiresAt: new Date(h.clock.now() + 900_000).toISOString() }]);
    await h.until(() => h.outbox().length === 0);
    expect(h.server.opLog.has(tid(0x20000))).toBe(true);
    expect(h.label).toBe('Online');
  });

  it('SYN-11 a retry EACCES principal puts the op back on hold until the next grant', async () => {
    const h = await Harness.create({ seed: creates(1, 0, () => ({ principal: BOB })) });
    h.server.suGrants = [{ uid: BOB, expiresAt: new Date(h.clock.now() + 900_000).toISOString() }];
    h.server.decide = (_op, attempt) =>
      attempt === 1
        ? { status: 'retry', errno: 'EACCES', reason: 'principal', retryAfterMs: 0 }
        : { status: 'applied' };
    await h.live();
    expect(h.syncd.outbox().held).toBe(1);
    h.syncd.setSuGrants([{ uid: BOB, expiresAt: new Date(h.clock.now() + 900_000).toISOString() }]);
    await h.until(() => h.outbox().length === 0);
    expect(h.server.effects.get(tid(0x20000))).toBe(1);
  });

  it('SYN-06 a throttle pauses sending for retryAfterMs and never disconnects', async () => {
    const h = await Harness.create({ seed: creates(40) });
    h.server.creditWindow = 4;
    h.syncd.connect();
    await settle();
    h.server.last.push('throttle', { retryAfterMs: 5_000, scope: 'frames' });
    await h.clock.advance(1_000);
    const sentEarly = h.server.framesOf('op.batch').length + h.server.framesOf('op.submit').length;
    await h.clock.advance(2_000);
    expect(h.server.framesOf('op.batch').length + h.server.framesOf('op.submit').length).toBe(
      sentEarly,
    );
    await h.until(() => h.outbox().length === 0);
    expect(h.server.conns).toHaveLength(1);
  });
});

describe('synchronous commit (SYN-07, §3.13)', () => {
  async function liveWith(decide: FakeServer['decide']): Promise<{ h: Harness; opId: string }> {
    const h = await Harness.create();
    h.server.decide = decide;
    await h.live();
    const s = creates(1, 7);
    await h.dev.seed({
      inodes: s.inodes ?? [],
      dentries: s.dentries ?? [],
      undo: s.undo ?? [],
      outbox: s.outbox ?? [],
    });
    return { h, opId: tid(0x20007) };
  }

  it('DB-02 an injected server fault is returned synchronously as EIO after the local revert', async () => {
    const { h, opId } = await liveWith(() => ({
      status: 'rejected',
      errno: 'EIO',
      reason: 'injected',
    }));
    h.syncd.kick();
    const w = h.syncd.waitFor(opId);
    await h.clock.advance(100);
    await expect(w).resolves.toEqual({ sync: 'rejected', errno: 'EIO', reason: 'injected' });
    expect(h.dev.inode(tid(0x10007))).toBeUndefined();
  });

  it('DB-02 when the server does not answer within SYNC_WAIT_MS the call returns sync pending', async () => {
    const { h, opId } = await liveWith(() => ({ status: 'applied' }));
    h.server.mute = true;
    h.syncd.kick();
    const w = h.syncd.waitFor(opId);
    await settle();
    await h.clock.advance(10_001);
    await expect(w).resolves.toEqual({ sync: 'pending' });
  });

  it('SYN-07 an applied result answers the waiting caller; a conflict answers with keptAs', async () => {
    const { h, opId } = await liveWith(() => ({ status: 'applied' }));
    h.syncd.kick();
    const w = h.syncd.waitFor(opId);
    await h.clock.advance(100);
    await expect(w).resolves.toEqual({ sync: 'applied' });
    await expect(h.syncd.waitFor(tid(0x999))).resolves.toEqual({ sync: 'pending' });
  });

  it('AGT-09 killing a process waiting on a sent op sends proc.signal; an unsent op is reverted locally', async () => {
    const { h, opId } = await liveWith(() => ({ status: 'applied' }));
    h.server.mute = true;
    h.syncd.kick();
    await h.clock.advance(100);
    await h.syncd.cancelOp(opId, 'SIGKILL');
    expect(h.server.framesOf('proc.signal')).toEqual([
      { target: { kind: 'op', opId }, sig: 'SIGKILL' },
    ]);
    const off = await Harness.create({ online: false, seed: creates(1, 9) });
    off.syncd.connect();
    await off.syncd.cancelOp(tid(0x20009));
    await settle();
    expect(off.outbox()).toEqual([]);
    expect(off.dev.inode(tid(0x10009))).toBeUndefined();
    expect(off.effects.map((e) => e.kind)).toEqual(['revert']);
    await off.syncd.cancelOp(tid(0x999));
  });
});

describe('connectivity status (OFF-04, §3.7, §3.15.2)', () => {
  it('OFF-04 the queued count follows the outbox, drops to zero after replay, then shows Online; offline shows within the same tick', async () => {
    const h = await Harness.create({ online: false, seed: creates(2) });
    h.syncd.connect();
    expect(h.syncd.state).toBe('OFFLINE');
    expect(h.label).toBe('Offline · 2 queued');
    expect(h.syncd.status().status).toMatchObject({
      state: 'offline',
      queuedOps: 2,
      degraded: ['sync', 'lockd'],
    });
    h.syncd.setOnline(true);
    expect(h.label).toBe('Reconnecting…');
    await h.live();
    expect(h.syncd.status().status).toMatchObject({
      state: 'online',
      queuedOps: 0,
      degraded: [],
      serverBuild: 'abc1234',
    });
    h.syncd.setOnline(false);
    expect(h.syncd.state).toBe('OFFLINE');
    const labels = h.labels();
    expect(labels[0]).toBe('Offline · 2 queued');
    expect(labels).toContain('Reconnecting…');
    expect(labels.some((l) => l.startsWith('Syncing ·'))).toBe(true);
    expect(labels.indexOf('Online')).toBeGreaterThan(labels.indexOf('Reconnecting…'));
    expect(labels[labels.length - 1]).toBe('Offline · 0 queued');
    expect(h.statuses[h.statuses.length - 1]?.status.state).toBe('offline');
  });

  it('OFF-04 with the server unreachable the label turns Offline · n queued (retry in s s) after 3 failures', async () => {
    const h = await Harness.create({ seed: creates(1) });
    h.server.refuseUpgrade = 1006;
    h.syncd.connect();
    await h.until(() => /retry in \d+ s/.test(h.label), 500, 400);
    expect(h.label).toMatch(/^Offline · 1 queued \(retry in \d+ s\)$/);
    expect(h.syncd.state).toBe('BACKOFF');
    h.server.refuseUpgrade = null;
    h.syncd.onVisible();
    await h.until(() => h.syncd.state === 'LIVE');
    expect(h.label).toBe('Online');
  });

  it('OFF-04 a failed upgrade answered 401 by /api/auth/me shows Sign in to sync and keeps the outbox', async () => {
    const h = await Harness.create({ seed: creates(1) });
    h.server.refuseUpgrade = 1006;
    h.server.authStatus = 401;
    h.syncd.connect();
    await h.until(() => h.syncd.state === 'AUTH_REQUIRED');
    expect(h.label).toBe('Sign in to sync · 1 queued');
    expect(h.syncd.status().status?.state).toBe('auth-required');
    h.server.refuseUpgrade = null;
    h.syncd.signedIn();
    await h.live();
    expect(h.outbox()).toEqual([]);
  });

  it('SYN-10 4401 needs a sign-in, 4409 supersedes for good, 1012 reconnects fast', async () => {
    const h = await Harness.create();
    await h.live();
    h.server.last.kill(4401);
    await settle();
    expect(h.syncd.state).toBe('AUTH_REQUIRED');
    h.syncd.signedIn();
    await h.live();
    h.server.last.kill(1012);
    await settle();
    expect(h.syncd.state).toBe('BACKOFF');
    await h.clock.advance(600);
    expect(h.syncd.state).toBe('LIVE');
    h.server.last.push('bye', { reason: 'superseded' });
    h.server.last.kill(4409);
    await settle();
    expect(h.syncd.state).toBe('SUPERSEDED');
    expect(h.notices).toContainEqual({ type: 'superseded' });
    const conns = h.server.conns.length;
    await h.clock.advance(120_000);
    expect(h.server.conns.length).toBe(conns);
  });

  it('SYN-10 no hello.ok within 5 s and a silent socket for 25 s both back off and reconnect', async () => {
    const h = await Harness.create();
    h.server.mute = true;
    h.syncd.connect();
    await settle();
    expect(h.syncd.state).toBe('HANDSHAKING');
    await h.clock.advance(5_000);
    expect(h.syncd.state).not.toBe('HANDSHAKING');
    h.server.mute = false;
    await h.live();
    h.server.mute = true;
    await h.clock.advance(24_000);
    expect(h.syncd.state).toBe('LIVE');
    await h.clock.advance(1_500);
    expect(['BACKOFF', 'CONNECTING', 'HANDSHAKING']).toContain(h.syncd.state);
    h.server.mute = false;
    await h.live();
    expect(h.syncd.state).toBe('LIVE');
  });

  it('SYN-13 bye upgrade-required keeps the client offline with Restart to update and no reconnect loop', async () => {
    const h = await Harness.create();
    await h.live();
    h.server.last.push('bye', { reason: 'upgrade-required' });
    h.server.last.kill(1008);
    await settle();
    expect(h.syncd.state).toBe('OFFLINE');
    expect(h.label).toBe('Restart to update required to sync');
    const conns = h.server.conns.length;
    await h.clock.advance(180_000);
    h.syncd.onVisible();
    expect(h.server.conns.length).toBe(conns);
  });

  it('OFF-04 OFFLINE probes /api/healthz every 60 s and reconnects when it answers', async () => {
    const h = await Harness.create({ online: false });
    h.server.healthy = false;
    h.syncd.connect();
    await h.clock.advance(61_000);
    expect(h.syncd.state).toBe('OFFLINE');
    h.server.healthy = true;
    await h.clock.advance(60_000);
    await h.until(() => h.syncd.state === 'LIVE');
    expect(h.syncd.state).toBe('LIVE');
  });

  it('SYN-10 a tab that comes back visible after a silent period reconnects at once', async () => {
    const h = await Harness.create();
    await h.live();
    h.server.mute = true;
    await h.clock.advance(12_000);
    h.server.mute = false;
    const conns = h.server.conns.length;
    h.syncd.onVisible();
    await h.until(() => h.syncd.state === 'LIVE');
    expect(h.server.conns.length).toBe(conns + 1);
  });

  it('BOOT-12 shutdown waits for in-flight results, sends bye with the reason and closes', async () => {
    const h = await Harness.create();
    await h.live();
    await h.syncd.shutdown('reboot');
    expect(h.server.framesOf('bye')).toEqual([{ reason: 'reboot' }]);
    expect(h.syncd.state).toBe('CLOSED');
    const idle = await Harness.create({ online: false });
    idle.syncd.connect();
    await idle.syncd.shutdown();
    expect(idle.syncd.state).toBe('CLOSED');
  });

  it('SYN-03 hello carries the build, session, lamport, outbox counts and a resume cursor per mirrored owner', async () => {
    const h = await Harness.create({
      seed: {
        ...creates(2),
        meta: [
          { k: 'resume:1001', v: { seq: 9, updatedAt: 'x' } },
          { k: 'lamport', v: 77 },
        ],
      },
    });
    await h.live();
    const [hello] = h.server.framesOf('hello');
    expect(hello).toMatchObject({
      proto: 1,
      kernelEpoch: 1,
      lamport: 77,
      outbox: { pending: 2, held: 0 },
      heldLeases: [],
      resume: [
        { ownerUid: 0, fromSeq: 0 },
        { ownerUid: ALICE, fromSeq: 0 },
        { ownerUid: BOB, fromSeq: 9 },
      ],
    } satisfies Partial<C2SFrame<'hello'>['body']>);
    expect(h.notices.find((n) => n.type === 'server-build')).toEqual({
      type: 'server-build',
      build: 'abc1234',
      differs: false,
    });
    expect(h.dev.meta('lamport')).toBeGreaterThanOrEqual(100);
    expect(h.syncd.records()).toEqual([]);
  });

  it('SYN-02 hb frames go out every hbMs while connected and hb.ack keeps the connection alive', async () => {
    const h = await Harness.create();
    await h.live();
    const before = h.server.framesOf('hb').length;
    await h.clock.advance(15_000);
    expect(h.server.framesOf('hb').length - before).toBe(3);
    expect(h.syncd.state).toBe('LIVE');
  });

  it('SYN-03 undecodable and error frames are reported, never fatal', async () => {
    const h = await Harness.create();
    await h.live();
    h.server.last.handlers.onMessage('garbage');
    h.server.last.push('error', { code: 'schema', msg: 'bad', refId: 3 });
    await settle();
    expect(
      h.notices
        .filter((n) => n.type === 'protocol-error')
        .map((n) => (n.type === 'protocol-error' ? n.code : '')),
    ).toEqual(['bad-frame', 'schema']);
    expect(h.syncd.state).toBe('LIVE');
  });
});
