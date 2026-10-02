import { BACKOFF_CAP_MS, CREDIT_WINDOW, MAX_BATCH, OP_ENVELOPE_MAX } from '@plotinium/protocol';
import type { VfsOp } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { fullJitter, nextDelayMs } from '../backoff.ts';
import { Lamport, lamportMerge, lamportTick, metaNumber } from '../lamport.ts';
import { isConnected, isSyncing, netStateOf, transition } from '../machine.ts';
import type { SyncEvent } from '../machine.ts';
import {
  OutboxQueue,
  fencedIno,
  isContentBearing,
  jsonBytes,
  singleContent,
  toSubmit,
} from '../outbox.ts';
import { planSend } from '../sender.ts';
import type { SendContext } from '../sender.ts';
import { degradedOf, netStatusOf, sameStatus, statusLabel } from '../status.ts';
import type { StatusInput } from '../status.ts';
import { decodeFrame } from '../syncd.ts';
import type { SyncState } from '../types.ts';
import { ALICE, BOB, outboxRec, sha, tid } from './doubles/device.ts';

/** A seeded linear congruential generator in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('backoff (full jitter, §3.7 rule 1, §5.5)', () => {
  it('SYN-10 back-off delays stay within bounds for every n and the expected delay doubles until the cap', () => {
    const rnd = seeded(7);
    for (let n = 0; n < 40; n++) {
      for (let i = 0; i < 50; i++) {
        const d = nextDelayMs(n, null, 0, rnd);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.min(BACKOFF_CAP_MS, 500 * 2 ** n));
      }
    }
    expect(fullJitter(0, () => 0.999_999)).toBeLessThan(500);
    expect(fullJitter(3, () => 0.5)).toBe(2_000);
    expect(fullJitter(50, () => 0.5)).toBe(15_000);
    expect(fullJitter(-3, () => 0.5)).toBe(250);
  });

  it('SYN-10 1012 resets the exponent, 1013 waits at least 5 s, 4429 honours retryAfterMs, 4508 reconnects at once once', () => {
    const half = (): number => 0.5;
    expect(nextDelayMs(8, 1012, 0, half)).toBe(250);
    expect(nextDelayMs(0, 1013, 0, half)).toBe(5_000);
    expect(nextDelayMs(10, 1013, 0, half)).toBe(15_000);
    expect(nextDelayMs(0, 4429, 9_000, half)).toBe(9_000);
    expect(nextDelayMs(0, 4508, 0, half)).toBe(0);
    expect(nextDelayMs(1, 4508, 0, half)).toBe(500);
    expect(nextDelayMs(0, null, 0)).toBeLessThan(500);
  });
});

describe('connection state machine (§3.7)', () => {
  const run = (s: SyncState, ...events: SyncEvent[]): SyncState => events.reduce(transition, s);

  it('OFF-04 the machine walks IDLE → CONNECTING → HANDSHAKING → RESUMING → LIVE and maps to NetStatus', () => {
    const path: SyncState[] = [];
    let s: SyncState = 'IDLE';
    for (const e of [
      { type: 'connect', online: true },
      { type: 'open' },
      { type: 'hello.ok' },
      { type: 'resumed' },
    ] as SyncEvent[]) {
      s = transition(s, e);
      path.push(s);
    }
    expect(path).toEqual(['CONNECTING', 'HANDSHAKING', 'RESUMING', 'LIVE']);
    expect(path.map(netStateOf)).toEqual(['connecting', 'connecting', 'resuming', 'online']);
    expect(netStateOf('OFFLINE')).toBe('offline');
    expect(netStateOf('BACKOFF')).toBe('connecting');
    expect(netStateOf('AUTH_REQUIRED')).toBe('auth-required');
    expect(netStateOf('IDLE')).toBe('connecting');
    for (const s2 of ['SUPERSEDED', 'CLOSING', 'CLOSED'] as const)
      expect(netStateOf(s2)).toBeNull();
  });

  it('OFF-04 the offline event moves every state but CLOSING, CLOSED and SUPERSEDED to OFFLINE at once', () => {
    for (const s of [
      'IDLE',
      'CONNECTING',
      'HANDSHAKING',
      'RESUMING',
      'LIVE',
      'BACKOFF',
      'AUTH_REQUIRED',
    ] as const) {
      expect(transition(s, { type: 'offline' })).toBe('OFFLINE');
    }
    for (const s of ['CLOSING', 'CLOSED', 'SUPERSEDED'] as const)
      expect(transition(s, { type: 'offline' })).toBe(s);
    expect(run('IDLE', { type: 'connect', online: false })).toBe('OFFLINE');
    expect(run('OFFLINE', { type: 'online' })).toBe('CONNECTING');
    expect(run('OFFLINE', { type: 'visible' })).toBe('CONNECTING');
    expect(run('OFFLINE', { type: 'probe-ok' })).toBe('CONNECTING');
    expect(run('OFFLINE', { type: 'timer' })).toBe('OFFLINE');
  });

  it('SYN-10 close codes: 4401 needs a sign-in, 4409 supersedes, others back off; a failed upgrade asks auth first', () => {
    for (const s of ['HANDSHAKING', 'RESUMING', 'LIVE'] as const) {
      expect(transition(s, { type: 'close', code: 4401, beforeOpen: false })).toBe('AUTH_REQUIRED');
      expect(transition(s, { type: 'close', code: 4409, beforeOpen: false })).toBe('SUPERSEDED');
      expect(transition(s, { type: 'close', code: 1012, beforeOpen: false })).toBe('BACKOFF');
      expect(transition(s, { type: 'timeout' })).toBe('BACKOFF');
    }
    expect(
      transition('CONNECTING', { type: 'close', code: 1006, beforeOpen: true, unauthorised: true }),
    ).toBe('AUTH_REQUIRED');
    expect(transition('CONNECTING', { type: 'close', code: 1006, beforeOpen: true })).toBe(
      'BACKOFF',
    );
    expect(transition('CONNECTING', { type: 'timeout' })).toBe('BACKOFF');
    expect(transition('BACKOFF', { type: 'timer' })).toBe('CONNECTING');
    expect(transition('BACKOFF', { type: 'online' })).toBe('CONNECTING');
    expect(transition('AUTH_REQUIRED', { type: 'signed-in' })).toBe('CONNECTING');
    expect(transition('AUTH_REQUIRED', { type: 'timer' })).toBe('AUTH_REQUIRED');
    expect(transition('SUPERSEDED', { type: 'online' })).toBe('SUPERSEDED');
    expect(transition('IDLE', { type: 'timer' })).toBe('IDLE');
    expect(transition('HANDSHAKING', { type: 'resumed' })).toBe('HANDSHAKING');
    expect(transition('RESUMING', { type: 'open' })).toBe('RESUMING');
    expect(transition('LIVE', { type: 'open' })).toBe('LIVE');
    expect(transition('CONNECTING', { type: 'visible' })).toBe('CONNECTING');
  });

  it('BOOT-12 shutdown goes through CLOSING when connected and straight to CLOSED otherwise', () => {
    expect(run('LIVE', { type: 'shutdown' })).toBe('CLOSING');
    expect(run('LIVE', { type: 'shutdown' }, { type: 'offline' }, { type: 'closed' })).toBe(
      'CLOSED',
    );
    expect(run('CLOSING', { type: 'close', code: 1000, beforeOpen: false })).toBe('CLOSED');
    expect(run('BACKOFF', { type: 'shutdown' })).toBe('CLOSED');
    expect(isConnected('LIVE') && isConnected('HANDSHAKING') && !isConnected('CONNECTING')).toBe(
      true,
    );
    expect(isSyncing('RESUMING') && isSyncing('LIVE') && !isSyncing('HANDSHAKING')).toBe(true);
  });
});

describe('taskbar status (§3.15.2)', () => {
  const base: StatusInput = {
    state: 'LIVE',
    queued: 0,
    waitingForSignIn: 0,
    parked: 0,
    failures: 0,
    retryInMs: null,
    upgradeRequired: false,
    lastAckAt: null,
    leaseTtlMs: 30_000,
    serverBuild: 'abc1234',
  };

  it('OFF-04 labels follow the table of §3.15.2', () => {
    expect(statusLabel(base)).toBe('Online');
    expect(statusLabel({ ...base, queued: 3 })).toBe('Syncing · 3 ops');
    expect(statusLabel({ ...base, state: 'RESUMING', queued: 1 })).toBe('Syncing · 1 op');
    expect(statusLabel({ ...base, state: 'BACKOFF', queued: 4, failures: 2 })).toBe(
      'Reconnecting…',
    );
    expect(
      statusLabel({ ...base, state: 'BACKOFF', queued: 4, failures: 3, retryInMs: 7_200 }),
    ).toBe('Offline · 4 queued (retry in 8 s)');
    expect(statusLabel({ ...base, state: 'CONNECTING', queued: 4, failures: 5 })).toBe(
      'Offline · 4 queued',
    );
    expect(statusLabel({ ...base, state: 'OFFLINE', queued: 2 })).toBe('Offline · 2 queued');
    expect(statusLabel({ ...base, state: 'AUTH_REQUIRED', queued: 2 })).toBe(
      'Sign in to sync · 2 queued',
    );
    expect(
      statusLabel({ ...base, state: 'OFFLINE', queued: 1, waitingForSignIn: 2, parked: 1 }),
    ).toBe('Offline · 1 queued · 2 waiting for sign-in · 1 parked');
    expect(statusLabel({ ...base, state: 'OFFLINE', upgradeRequired: true })).toBe(
      'Restart to update required to sync',
    );
    expect(statusLabel({ ...base, state: 'CLOSING' })).toBe('Stopping');
  });

  it('OFF-04 NetStatus lists sync and lockd as degraded whenever sync is not LIVE', () => {
    expect(netStatusOf(base)).toEqual({
      state: 'online',
      queuedOps: 0,
      lastAckAt: null,
      degraded: [],
      leaseTtlMs: 30_000,
      serverBuild: 'abc1234',
    });
    const off = netStatusOf({
      ...base,
      state: 'OFFLINE',
      queued: 2,
      waitingForSignIn: 1,
      extraDegraded: ['lockd', 'lockd'],
    });
    expect(off).toMatchObject({ state: 'offline', queuedOps: 3, degraded: ['sync', 'lockd'] });
    expect(degradedOf({ ...base, extraDegraded: ['sync'] })).toEqual(['sync']);
    expect(netStatusOf({ ...base, state: 'CLOSED' })).toBeNull();
    expect(netStatusOf({ ...base, state: 'LIVE', upgradeRequired: true })?.state).toBe('offline');
    expect(netStatusOf({ ...base, leaseTtlMs: null })?.leaseTtlMs).toBe(30_000);
    const a = netStatusOf(base);
    expect(sameStatus(a, netStatusOf(base))).toBe(true);
    expect(sameStatus(a, netStatusOf({ ...base, queued: 1 }))).toBe(false);
    expect(sameStatus(a, netStatusOf({ ...base, state: 'OFFLINE' }))).toBe(false);
    expect(sameStatus(null, null)).toBe(true);
    expect(sameStatus(a, null)).toBe(false);
  });
});

describe('Lamport counter (§3.5)', () => {
  it('SYN-03 the counter ticks locally and merges max(L, received), never going back', () => {
    expect(lamportTick(4)).toBe(5);
    expect(lamportMerge(4, 9)).toBe(9);
    expect(lamportMerge(9, 4)).toBe(9);
    expect(lamportMerge(9, -1)).toBe(9);
    expect(lamportMerge(9, Number.NaN)).toBe(9);
    const l = new Lamport(-5);
    expect(l.value).toBe(0);
    expect(l.observe(12)).toBe(12);
    expect(l.observe(3)).toBe(12);
    expect(metaNumber(undefined)).toBe(0);
    expect(metaNumber({ k: 'lamport', v: 'x' })).toBe(0);
    expect(metaNumber({ k: 'lamport', v: 7 })).toBe(7);
  });
});

function create(n: number, extra: Partial<Extract<VfsOp, { kind: 'create' }>> = {}): VfsOp {
  return {
    kind: 'create',
    parentIno: tid(2),
    name: `f${n}`,
    ino: tid(1000 + n),
    type: 'f',
    mode: 0o644,
    mtime: 0,
    ...extra,
  };
}

function queueOf(
  n: number,
  over: (i: number) => Partial<Parameters<typeof outboxRec>[0]> = () => ({}),
): OutboxQueue {
  const q = new OutboxQueue();
  q.load(
    Array.from({ length: n }, (_, i) => ({
      ...outboxRec({
        opId: tid(5000 + i),
        cseq: i + 1,
        op: create(i),
        touches: [tid(1000 + i)],
        ...over(i),
      }),
      seq: i + 1,
    })),
  );
  return q;
}

const ctx = (over: Partial<SendContext> = {}): SendContext => ({
  credit: CREDIT_WINDOW,
  inflight: 0,
  httpBusy: false,
  allowed: (p) => p === ALICE,
  blob: () => 'ready',
  ...over,
});

describe('send loop (§5.2, §3.9)', () => {
  it('OFF-02 replay packs ops in cseq order into one frame bounded by the credit window and MAX_BATCH', () => {
    const q = queueOf(40);
    const p = planSend(q, ctx());
    expect(p.frame.map((e) => e.rec.cseq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(planSend(q, ctx({ credit: 64 })).frame).toHaveLength(MAX_BATCH);
    expect(planSend(q, ctx({ credit: 0 })).frame).toHaveLength(0);
    for (const e of p.frame) e.sent = true;
    expect(planSend(q, ctx({ credit: 3 })).frame.map((e) => e.rec.cseq)).toEqual([17, 18, 19]);
  });

  it('OFF-02 a frame never exceeds MAX_PAYLOAD bytes', () => {
    const big = 'x'.repeat(20_000);
    const q = queueOf(5, (i) => ({ op: create(i, { symlinkTarget: big }) }));
    const p = planSend(q, ctx());
    expect(p.frame.length).toBe(3);
    expect(p.frame.reduce((n, e) => n + q.sizeOf(e), 0)).toBeLessThan(65_536);
  });

  it('SYN-11 an op whose principal the connection cannot authorise is held and skipped, later ops still go', () => {
    const q = queueOf(3, (i) => (i === 0 ? { principal: BOB } : {}));
    const p = planSend(q, ctx());
    expect(p.holds.map((h) => [h.entry.rec.cseq, h.reason])).toEqual([[1, 'principal-auth']]);
    expect(p.frame.map((e) => e.rec.cseq)).toEqual([2, 3]);
    const first = q.all()[0];
    if (first !== undefined) first.held = 'principal-auth';
    expect(planSend(q, ctx()).holds).toHaveLength(0);
  });

  it('OFF-02 an op is never sent before its blobs: the scan uploads them and stops to keep order', () => {
    const q = queueOf(3, (i) => (i === 1 ? { blobs: [sha(1), sha(2)] } : {}));
    const p = planSend(q, ctx({ blob: (s) => (s === sha(1) ? 'uploading' : 'unknown') }));
    expect(p.frame.map((e) => e.rec.cseq)).toEqual([1]);
    expect(p.upload).toEqual([sha(2)]);
    expect(p.holds.map((h) => h.reason)).toEqual(['blob-upload']);
  });

  it('OFF-02 an op larger than 60 KB goes through POST /api/ops/{opId} only at the head of an empty window', () => {
    const huge = 'y'.repeat(OP_ENVELOPE_MAX);
    const q = queueOf(3, (i) => (i === 1 ? { op: create(i, { symlinkTarget: huge }) } : {}));
    const first = planSend(q, ctx());
    expect(first.frame.map((e) => e.rec.cseq)).toEqual([1]);
    expect(first.http).toBeNull();
    for (const e of first.frame) e.sent = true;
    expect(planSend(q, ctx({ inflight: 1, credit: 15 })).http).toBeNull();
    const head = q.all()[0];
    if (head !== undefined) head.sent = false;
    q.remove(tid(5000));
    const second = planSend(q, ctx());
    expect(second.frame).toHaveLength(0);
    expect(second.http?.rec.cseq).toBe(2);
    expect(planSend(q, ctx({ httpBusy: true })).http).toBeNull();
  });

  it('OFF-02 parked, reserved and locked records are never sent and keep the order behind them', () => {
    const q = queueOf(4, (i) => (i === 0 ? { state: 'parked' } : {}));
    const [, second, third] = q.all();
    if (second === undefined || third === undefined) throw new Error('queue');
    expect(planSend(q, ctx()).frame.map((e) => e.rec.cseq)).toEqual([2, 3, 4]);
    third.reserved = true;
    expect(planSend(q, ctx()).frame.map((e) => e.rec.cseq)).toEqual([2]);
    third.reserved = false;
    second.locked = true;
    expect(planSend(q, ctx()).frame).toHaveLength(0);
  });

  it('OFF-02 the queue keeps memory state across reloads and reports its summary', () => {
    const q = queueOf(3);
    const [a, b] = q.all();
    if (a === undefined || b === undefined) throw new Error('queue');
    a.sent = true;
    b.held = 'principal-auth';
    const reloaded = q.all().map((e) => ({ ...e.rec, attempts: 2 }));
    q.load(reloaded.slice(1));
    expect(q.get(a.rec.opId)?.sent).toBe(true);
    expect(q.summary()).toEqual({ pending: 1, inflight: 1, held: 1, parked: 0, reverted: 0 });
    q.resetSent();
    q.clearHolds('principal-auth');
    expect(q.summary()).toEqual({ pending: 3, inflight: 0, held: 0, parked: 0, reverted: 0 });
    q.update({ ...b.rec, state: 'parked' });
    q.update({ ...b.rec, opId: tid(999_999) });
    expect(q.summary().parked).toBe(1);
    q.load([]);
    expect(q.size).toBe(0);
  });

  it('SYN-03 op.submit bodies carry opId, cseq, lamport, principal, base, fences and blobs', () => {
    const rec = {
      ...outboxRec({
        opId: tid(1),
        cseq: 7,
        op: { kind: 'write', ino: tid(3), blob: sha(9), size: 4, mtime: 5 },
        touches: [tid(3)],
        blobs: [sha(9)],
        fence: 42,
      }),
      seq: 1,
    };
    const body = toSubmit(rec);
    expect(body).toMatchObject({
      opId: tid(1),
      osSessionId: rec.osSessionId,
      cseq: 7,
      lamport: 7,
      principal: ALICE,
      fences: [{ ino: tid(3), fence: 42 }],
      blobs: [sha(9)],
    });
    expect(body.clientTime).toBe(new Date(rec.createdAt).toISOString());
    expect(jsonBytes(body)).toBe(new TextEncoder().encode(JSON.stringify(body)).length);
    const { fence: _fence, ...unfenced } = rec;
    const plain = toSubmit({ ...unfenced, blobs: [] });
    expect(plain.fences).toBeUndefined();
    expect(plain.blobs).toBeUndefined();
  });

  it('VFS-10 content-bearing ops are recognised for parking and single-content copies', () => {
    const w: VfsOp = { kind: 'write', ino: tid(3), blob: sha(1), size: 2, mtime: 0 };
    expect(isContentBearing(w)).toBe(true);
    expect(isContentBearing(create(1))).toBe(false);
    expect(isContentBearing(create(1, { blob: sha(2), size: 3 }))).toBe(true);
    expect(
      isContentBearing({
        kind: 'copy',
        srcIno: tid(1),
        toParentIno: tid(2),
        toName: 'c',
        recursive: false,
      }),
    ).toBe(true);
    expect(isContentBearing({ kind: 'batch', ops: [w] })).toBe(true);
    expect(
      isContentBearing({ kind: 'batch', ops: [{ kind: 'utimes', ino: tid(1), mtime: 0 }] }),
    ).toBe(false);
    for (const op of [
      { kind: 'unlink', parentIno: tid(2), name: 'a', ino: tid(1), recursive: false },
      {
        kind: 'rename',
        ino: tid(1),
        fromParentIno: tid(2),
        fromName: 'a',
        toParentIno: tid(2),
        toName: 'b',
      },
      { kind: 'link', ino: tid(1), parentIno: tid(2), name: 'l' },
      { kind: 'chmod', ino: tid(1), change: { absolute: 0o600 }, recursive: false },
      { kind: 'chown', ino: tid(1), uid: 1, recursive: false },
      { kind: 'utimes', ino: tid(1), mtime: 0 },
      { kind: 'session.layout', layout: {}, rev: 1 },
    ] as VfsOp[]) {
      expect(isContentBearing(op)).toBe(false);
      expect(fencedIno(op)).toBe(op.kind === 'session.layout' ? undefined : tid(1));
    }
    expect(fencedIno(create(1))).toBeUndefined();
    expect(singleContent(w)).toEqual({ ino: tid(3), blob: sha(1), size: 2 });
    expect(singleContent(create(1, { blob: sha(2) }))).toEqual({
      ino: tid(1001),
      blob: sha(2),
      size: 0,
      name: 'f1',
    });
    expect(singleContent(create(1))).toBeNull();
  });
});

describe('frame decoding', () => {
  it('SYN-03 only v1 server frames with a known type and an object body decode', () => {
    expect(decodeFrame('{"v":1,"t":"hb.ack","id":1,"body":{"t":1}}')?.t).toBe('hb.ack');
    for (const bad of [
      'not json',
      '[]',
      '{"v":2,"t":"hb.ack","id":1,"body":{}}',
      '{"v":1,"t":"nope","id":1,"body":{}}',
      '{"v":1,"t":"hb.ack","id":"1","body":{}}',
      '{"v":1,"t":"hb.ack","id":1,"body":[]}',
    ]) {
      expect(decodeFrame(bad)).toBeNull();
    }
  });
});

describe('product bindings (ports.ts)', () => {
  it('SYN-15 the kernel-worker clock runs timers and can cancel them', async () => {
    const { systemClock } = await import('../ports.ts');
    expect(systemClock.now()).toBeGreaterThan(0);
    expect(systemClock.mono()).toBeGreaterThanOrEqual(0);
    const fired: string[] = [];
    systemClock.after(0, () => fired.push('a'));
    systemClock.after(0, () => fired.push('b')).cancel();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(fired).toEqual(['a']);
  });

  it('SYN-01 the browser socket binding forwards open, text messages and close, and sends and closes', async () => {
    const { browserSocket, HttpUnavailable } = await import('../ports.ts');
    const made: FakeWs[] = [];
    class FakeWs {
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      readonly sent: string[] = [];
      closed: [number | undefined, string | undefined] | null = null;
      readonly url: string;
      constructor(url: string) {
        this.url = url;
        made.push(this);
      }
      send(d: string): void {
        this.sent.push(d);
      }
      close(code?: number, reason?: string): void {
        this.closed = [code, reason];
      }
    }
    const saved = globalThis.WebSocket;
    Object.assign(globalThis, { WebSocket: FakeWs });
    try {
      const events: string[] = [];
      const s = browserSocket('wss://x/ws', {
        onOpen: () => events.push('open'),
        onMessage: (d) => events.push(`msg:${d}`),
        onClose: (c) => events.push(`close:${c}`),
      });
      const ws = made[0];
      if (ws === undefined) throw new Error('no socket');
      ws.onopen?.();
      ws.onmessage?.({ data: 'hi' });
      ws.onmessage?.({ data: new ArrayBuffer(2) });
      ws.onclose?.({ code: 1006, reason: '' });
      s.send('frame');
      s.close(1000, 'bye');
      expect(events).toEqual(['open', 'msg:hi', 'close:1006']);
      expect(ws.sent).toEqual(['frame']);
      expect(ws.closed).toEqual([1000, 'bye']);
      expect(new HttpUnavailable().name).toBe('HttpUnavailable');
    } finally {
      Object.assign(globalThis, { WebSocket: saved });
    }
  });
});
