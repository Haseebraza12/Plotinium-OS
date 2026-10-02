/**
 * The pure inbound router (offline-and-sync.md §4.1, §4.3, §4.5, §6; SYN-01, SYN-02, SYN-03, SYN-13).
 * Every `send` action it produces is parsed with the protocol's S2CFrame schema.
 */
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { MAX_PAYLOAD, S2CFrame, type OpSubmit } from '@plotinium/protocol';

import {
  initialRouterState,
  laneOf,
  negotiateProto,
  noteProtocolError,
  routeFrame,
  type RouterAction,
  type RouterState,
} from './router.ts';
import { sha, uid7, writeOp } from './tests/fake-db.ts';

const OS = uid7(3, 1);
const DEV = uid7(4, 1);
const T0 = 1_000_000;

const hello = {
  proto: 1,
  build: { name: 'Plotinium', version: '0.3.0', build: 'abc1234', date: '2026-11-14' },
  osSessionId: OS,
  deviceId: DEV,
  kernelEpoch: 3,
  lamport: 7,
  outbox: { pending: 2, held: 0 },
  heldLeases: [],
  resume: [{ ownerUid: 1001, fromSeq: 0 }],
};

const frame = (t: string, body: unknown, id = 1, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, t, id, body, ...extra });

function sends(actions: readonly RouterAction[]) {
  return actions.flatMap((a) => {
    if (a.kind !== 'send') return [];
    v.parse(S2CFrame, { v: 1, t: a.frame.t, id: 1, body: a.frame.body });
    return [a.frame];
  });
}

function open(): RouterState {
  const r = routeFrame(initialRouterState, frame('hello', hello), T0);
  expect(r.state.phase).toBe('open');
  return r.state;
}

const op = (n: number): OpSubmit =>
  writeOp({
    opId: uid7(0x9100, n),
    osSessionId: OS,
    cseq: n,
    principal: 1001,
    ino: uid7(2, 1),
    sha: sha(n),
    size: n,
    baseVersion: 1,
  });

describe('SYN-13 handshake and protocol negotiation', () => {
  it('SYN-13 hello is accepted as the first frame with the negotiated protocol', () => {
    const r = routeFrame(initialRouterState, frame('hello', hello, 1), T0);
    expect(r.actions).toEqual([{ kind: 'hello', frameId: 1, proto: 1, body: hello }]);
    expect(r.state).toMatchObject({ phase: 'open', proto: 1 });
  });

  it('SYN-13 the server accepts protocol N and N-1, speaks N to a newer client, and N-2 is upgrade-required', () => {
    expect(negotiateProto(3, 3)).toBe(3);
    expect(negotiateProto(2, 3)).toBe(2);
    expect(negotiateProto(4, 3)).toBe(3);
    expect(negotiateProto(1, 3)).toBeNull();
    expect(negotiateProto(1)).toBe(1);
  });

  it('SYN-13 any frame before hello, or a second hello, is refused with error forbidden', () => {
    const early = routeFrame(
      initialRouterState,
      frame('hb', { t: 1, leases: [], lamport: 0 }, 4),
      T0,
    );
    expect(sends(early.actions)).toEqual([
      { t: 'error', body: { code: 'forbidden', msg: 'hello must be the first frame', refId: 4 } },
    ]);
    const twice = routeFrame(open(), frame('hello', hello, 2), T0);
    expect(sends(twice.actions)[0]).toMatchObject({
      t: 'error',
      body: { code: 'forbidden', refId: 2 },
    });
  });
});

describe('SYN-01 SYN-03 frame validation (§4.1)', () => {
  it('SYN-01 a frame larger than MAX_PAYLOAD closes with 1009', () => {
    const big = frame('hb', { t: 1, leases: [], lamport: 0, pad: 'x'.repeat(MAX_PAYLOAD) });
    const r = routeFrame(open(), big, T0);
    expect(r.actions).toEqual([{ kind: 'close', code: 1009, reason: 'message-too-big' }]);
    expect(r.state.phase).toBe('closed');
    expect(routeFrame(r.state, frame('hb', {}), T0).actions).toEqual([]);
  });

  it('SYN-03 bad JSON, non-objects, binary frames, wrong envelopes, unknown types and schema failures get error frames', () => {
    const s = open();
    expect(sends(routeFrame(s, '{nope', T0).actions)[0]).toMatchObject({
      t: 'error',
      body: { code: 'bad-frame' },
    });
    expect(sends(routeFrame(s, '[1,2]', T0).actions)[0]).toMatchObject({
      t: 'error',
      body: { code: 'bad-frame' },
    });
    expect(sends(routeFrame(s, 'null', T0).actions)[0]).toMatchObject({
      t: 'error',
      body: { code: 'bad-frame' },
    });
    expect(sends(routeFrame(s, frame('hb', {}), T0, true).actions)[0]).toMatchObject({
      t: 'error',
      body: { code: 'bad-frame', msg: 'text frames only' },
    });
    expect(
      sends(routeFrame(s, JSON.stringify({ v: 2, t: 'hb', id: 9, body: {} }), T0).actions)[0],
    ).toMatchObject({ t: 'error', body: { code: 'bad-frame', refId: 9 } });
    expect(sends(routeFrame(s, frame('lock.steal', {}, 5), T0).actions)[0]).toMatchObject({
      t: 'error',
      body: { code: 'unknown-type', refId: 5 },
    });
    const schema = sends(
      routeFrame(s, frame('hb', { t: -1, leases: [], lamport: 0 }, 6), T0).actions,
    )[0];
    expect(schema).toMatchObject({ t: 'error', body: { code: 'schema', refId: 6 } });
  });

  it('SYN-03 three protocol errors within 60 s end with bye protocol-error and close 1008; spaced errors do not', () => {
    let s = open();
    let r = routeFrame(s, '{', T0);
    r = routeFrame(r.state, '{', T0 + 1_000);
    expect(r.actions.some((a) => a.kind === 'close')).toBe(false);
    r = routeFrame(r.state, '{', T0 + 2_000);
    expect(sends(r.actions).map((f) => f.t)).toEqual(['error', 'bye']);
    expect(r.actions.at(-1)).toEqual({ kind: 'close', code: 1008, reason: 'protocol-error' });
    expect(r.state.phase).toBe('closed');

    s = open();
    let spaced = routeFrame(s, '{', T0);
    spaced = routeFrame(spaced.state, '{', T0 + 61_000);
    spaced = routeFrame(spaced.state, '{', T0 + 122_000);
    expect(spaced.state.phase).toBe('open');
    const limit = noteProtocolError(spaced.state, T0 + 122_500, {
      kind: 'send',
      frame: { t: 'error', body: { code: 'limit', msg: 'x' } },
    });
    expect(limit.state.phase).toBe('open');
  });
});

describe('SYN-02 lanes and actions (§3.6, §4.3)', () => {
  it('SYN-02 op.submit and op.batch become op-lane actions; everything else is control-lane', () => {
    const s = open();
    const one = routeFrame(s, frame('op.submit', op(1), 10), T0);
    expect(one.actions).toEqual([{ kind: 'ops', frameId: 10, ops: [op(1)] }]);
    const batch = routeFrame(s, frame('op.batch', { ops: [op(1), op(2)] }, 11), T0);
    expect(batch.actions).toEqual([{ kind: 'ops', frameId: 11, ops: [op(1), op(2)] }]);
    expect(laneOf(one.actions[0] as RouterAction)).toBe('op');
    const hb = routeFrame(s, frame('hb', { t: 5, leases: [], lamport: 3 }, 12), T0);
    expect(hb.actions).toEqual([
      { kind: 'hb', frameId: 12, body: { t: 5, leases: [], lamport: 3 } },
    ]);
    expect(laneOf(hb.actions[0] as RouterAction)).toBe('control');
  });

  it('SYN-06 an op.batch of more than 32 ops is a schema error, never a partial apply', () => {
    const ops = Array.from({ length: 33 }, (_, i) => op(i + 1));
    const r = routeFrame(open(), frame('op.batch', { ops }, 13), T0);
    expect(sends(r.actions)[0]).toMatchObject({ t: 'error', body: { code: 'schema', refId: 13 } });
    expect(r.actions.some((a) => a.kind === 'ops')).toBe(false);
  });

  it('OFF-02 an op with a valid identity but an invalid body becomes a persisted EINVAL; valid siblings still run', () => {
    const bad = {
      ...op(2),
      op: { kind: 'write', ino: uid7(2, 1), blob: 'nope', size: 1, mtime: 1 },
    };
    const r = routeFrame(open(), frame('op.batch', { ops: [op(1), bad] }, 14), T0);
    expect(r.actions[0]).toMatchObject({
      kind: 'invalid-ops',
      frameId: 14,
      ops: [{ opId: bad.opId, cseq: 2, kind: 'write' }],
    });
    expect(r.actions[1]).toEqual({ kind: 'ops', frameId: 14, ops: [op(1)] });
    const noId = { ...op(3), opId: 'not-a-uuid', op: { kind: 'write' } };
    const refused = routeFrame(open(), frame('op.submit', noId, 15), T0);
    expect(sends(refused.actions)[0]).toMatchObject({ t: 'error', body: { code: 'schema' } });
    const weird = { ...op(4), op: { kind: 'Not A Call!' } };
    const w = routeFrame(open(), frame('op.submit', weird, 16), T0);
    expect(w.actions[0]).toMatchObject({ kind: 'invalid-ops', ops: [{ kind: undefined }] });
  });

  it('SYN-02 control frames map to their actions and a piggy-backed ack comes first', () => {
    const s = open();
    const reqId = uid7(0x9200, 1);
    const ino = uid7(2, 1);
    const cases: [string, unknown, RouterAction['kind']][] = [
      ['ack', { cursors: [{ ownerUid: 1, seq: 2 }] }, 'ack'],
      ['lock.acquire', { reqId, ino, mode: 'X', wait: false, principal: 1001 }, 'lock.acquire'],
      ['lock.release', { reqId }, 'lock.release'],
      ['watch', { ino }, 'watch'],
      ['unwatch', { ino }, 'unwatch'],
      ['resume', { cursors: [{ ownerUid: 1, fromSeq: 0 }] }, 'resume'],
      ['proc.signal', { target: { kind: 'op', opId: reqId }, sig: 'SIGTERM' }, 'proc.signal'],
    ];
    for (const [t, body, kind] of cases) {
      const r = routeFrame(s, frame(t, body, 20), T0);
      expect(r.actions.map((a) => a.kind)).toEqual([kind]);
    }
    const piggy = routeFrame(
      s,
      frame('hb', { t: 1, leases: [], lamport: 0 }, 21, { ack: [{ ownerUid: 7, seq: 9 }] }),
      T0,
    );
    expect(piggy.actions.map((a) => a.kind)).toEqual(['ack', 'hb']);
    expect(piggy.actions[0]).toEqual({ kind: 'ack', cursors: [{ ownerUid: 7, seq: 9 }] });
    const both = routeFrame(s, frame('lock.release', { leaseId: reqId, reqId }, 22), T0);
    expect(sends(both.actions)[0]).toMatchObject({ t: 'error', body: { code: 'schema' } });
  });

  it('BOOT-12 bye ends the connection: the server releases leases and closes 1000', () => {
    const r = routeFrame(open(), frame('bye', { reason: 'reboot' }, 30), T0);
    expect(r.actions).toEqual([
      { kind: 'bye', frameId: 30, reason: 'reboot' },
      { kind: 'close', code: 1000, reason: 'reboot', afterBye: true },
    ]);
    expect(r.state.phase).toBe('closed');
  });

  it('UI-166 the close after a client bye carries the client reason, not "shutdown"', () => {
    for (const reason of ['shutdown', 'reboot', 'logout', 'takeover', 'update'] as const) {
      const r = routeFrame(open(), frame('bye', { reason }, 31), T0);
      expect(r.actions.at(-1)).toEqual({ kind: 'close', code: 1000, reason, afterBye: true });
    }
  });
});
