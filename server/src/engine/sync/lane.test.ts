/**
 * The per-connection op lane: credit window, FIFO one-at-a-time, head-of-line retry, kill of a
 * queued or running op, close and drain (offline-and-sync.md §3.6, §3.9, §3.13.3, §5.3).
 */
import { describe, expect, it } from 'vitest';

import type { OpResult, OpSubmit } from '@plotinium/protocol';

import { ProtocolViolation } from './engine.ts';
import { OpLane, type LaneDeps } from './lane.ts';
import { retry } from './outcome.ts';
import { sha, uid7, writeOp } from './tests/fake-db.ts';

const op = (n: number): OpSubmit =>
  writeOp({
    opId: uid7(0x9300, n),
    osSessionId: uid7(3, 1),
    cseq: n,
    principal: 1001,
    ino: uid7(2, 1),
    sha: sha(n),
    size: n,
    baseVersion: 1,
  });

interface Pending {
  readonly submit: OpSubmit;
  readonly signal: AbortSignal;
  resolve(r: OpResult): void;
  reject(e: unknown): void;
}

function harness(creditWindow = 4) {
  const running: Pending[] = [];
  const replies: OpResult[] = [];
  const cancelled: string[] = [];
  const killed: string[] = [];
  const failures: unknown[] = [];
  const deps: LaneDeps = {
    creditWindow,
    apply: (submit, signal) =>
      new Promise<OpResult>((resolve, reject) => {
        running.push({ submit, signal, resolve, reject });
      }),
    rejectKilled: (submit) => {
      killed.push(submit.opId);
      return Promise.resolve({
        opId: submit.opId,
        status: 'rejected',
        duplicate: false,
        errno: 'ECANCELED',
        reason: 'killed',
        lamport: 1,
      });
    },
    cancelRunning: (opId) => cancelled.push(opId),
    reply: (r) => replies.push(r),
    fail: (e) => failures.push(e),
    lamport: () => 5,
  };
  const lane = new OpLane(deps);
  const applied = (n: number): OpResult => ({
    opId: op(n).opId,
    status: 'applied',
    duplicate: false,
    lamport: n,
  });
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { lane, running, replies, cancelled, killed, failures, applied, tick };
}

describe('SYN-06 the op lane and the credit window (§3.9, §5.3)', () => {
  it('SYN-06 ops run one at a time in arrival order and each gets its own op.result', async () => {
    const h = harness();
    expect(h.lane.enqueue([op(1), op(2), op(3)])).toBe('queued');
    await h.tick();
    expect(h.running.map((p) => p.submit.cseq)).toEqual([1]);
    expect(h.lane.unanswered).toBe(3);
    expect(h.lane.running).toBe(op(1).opId);
    h.running[0]?.resolve(h.applied(1));
    await h.tick();
    expect(h.running.map((p) => p.submit.cseq)).toEqual([1, 2]);
    h.running[1]?.resolve(h.applied(2));
    await h.tick();
    h.running[2]?.resolve(h.applied(3));
    await h.tick();
    expect(h.replies.map((r) => r.opId)).toEqual([op(1).opId, op(2).opId, op(3).opId]);
    expect(h.lane.unanswered).toBe(0);
    expect(h.lane.running).toBeNull();
  });

  it('SYN-06 more ops than the advertised credit window are refused as a whole (error limit)', async () => {
    const h = harness(2);
    expect(h.lane.enqueue([op(1), op(2)])).toBe('queued');
    expect(h.lane.enqueue([op(3)])).toBe('limit');
    await h.tick();
    h.running[0]?.resolve(h.applied(1));
    await h.tick();
    expect(h.lane.enqueue([op(3)])).toBe('queued'); // one credit came back with the result
  });

  it('OFF-02 ops behind a retried op on the same lane are answered retry predecessor-retry without executing', async () => {
    const h = harness();
    h.lane.enqueue([op(1), op(2), op(3)]);
    await h.tick();
    h.running[0]?.resolve(retry(op(1).opId, 'EBUSY', 'lock-timeout', 1, 700));
    await h.tick();
    expect(h.running).toHaveLength(1); // 2 and 3 never ran
    expect(h.replies.map((r) => [r.status, r.reason, r.retryAfterMs])).toEqual([
      ['retry', 'lock-timeout', 700],
      ['retry', 'predecessor-retry', 700],
      ['retry', 'predecessor-retry', 700],
    ]);
  });

  it('AGT-09 proc.signal removes a queued op and records it rejected ECANCELED killed', async () => {
    const h = harness();
    h.lane.enqueue([op(1), op(2)]);
    await h.tick();
    expect(h.lane.signal(op(2).opId)).toBe('queued-killed');
    await h.tick();
    expect(h.killed).toEqual([op(2).opId]);
    expect(h.replies[0]).toMatchObject({ opId: op(2).opId, errno: 'ECANCELED' });
    expect(h.lane.unanswered).toBe(1);
  });

  it('AGT-09 proc.signal of the running op aborts its signal and cancels its statement; unknown ops are ignored', async () => {
    const h = harness();
    h.lane.enqueue([op(1)]);
    await h.tick();
    expect(h.lane.signal(op(1).opId)).toBe('running-cancelled');
    expect(h.cancelled).toEqual([op(1).opId]);
    expect(h.running[0]?.signal.aborted).toBe(true);
    expect(h.lane.signal(uid7(0x9300, 999))).toBe('unknown');
  });

  it('OFF-02 closing the lane drops queued ops without replies (they are resent and deduplicated)', async () => {
    const h = harness();
    h.lane.enqueue([op(1), op(2)]);
    await h.tick();
    const closed = h.lane.close();
    h.running[0]?.resolve(h.applied(1));
    await closed;
    expect(h.replies).toEqual([]);
    expect(h.lane.enqueue([op(3)])).toBe('closed');
  });

  it('OFF-02 draining for a shutdown answers the running op and drops the rest', async () => {
    const h = harness();
    h.lane.enqueue([op(1), op(2)]);
    await h.tick();
    const drained = h.lane.drain();
    expect(h.lane.enqueue([op(3)])).toBe('closed');
    h.running[0]?.resolve(h.applied(1));
    await drained;
    expect(h.replies.map((r) => r.opId)).toEqual([op(1).opId]);
    expect(h.running).toHaveLength(1);
    await h.lane.drain();
  });

  it('SYN-11 a protocol violation from the engine fails the lane (the connection closes 1008)', async () => {
    const h = harness();
    h.lane.enqueue([op(1), op(2)]);
    await h.tick();
    h.running[0]?.reject(new ProtocolViolation('foreign session'));
    await h.tick();
    expect(h.failures[0]).toBeInstanceOf(ProtocolViolation);
    expect(h.lane.unanswered).toBe(0);
  });

  it('OFF-02 an HTTP op joins the lane in order and gets its result (and its retry) outside the socket', async () => {
    const h = harness();
    const http: OpResult[] = [];
    h.lane.enqueue([op(1)]);
    h.lane.enqueue([op(2)], (r) => http.push(r));
    h.lane.enqueue([op(3)], (r) => http.push(r));
    await h.tick();
    h.running[0]?.resolve(retry(op(1).opId, 'EBUSY', 'lock-timeout', 1, 300));
    await h.tick();
    expect(h.replies.map((r) => r.opId)).toEqual([op(1).opId]);
    expect(http.map((r) => [r.opId, r.reason])).toEqual([
      [op(2).opId, 'predecessor-retry'],
      [op(3).opId, 'predecessor-retry'],
    ]);
  });

  it('OFF-02 an HTTP op still queued when the socket closes is answered retry instead of hanging', async () => {
    const h = harness();
    const http: OpResult[] = [];
    h.lane.enqueue([op(1)]);
    h.lane.enqueue([op(2)], (r) => http.push(r));
    await h.tick();
    expect(h.lane.signal(op(2).opId)).toBe('queued-killed');
    await h.tick();
    expect(http[0]).toMatchObject({ opId: op(2).opId, errno: 'ECANCELED' });
    h.lane.enqueue([op(3)], (r) => http.push(r));
    const closed = h.lane.close();
    expect(http[1]).toMatchObject({ opId: op(3).opId, status: 'retry', errno: 'EIO' });
    h.running[0]?.resolve(h.applied(1));
    await closed;
    expect(h.replies).toEqual([]); // the socket is gone
  });

  it('SYN-11 when the engine throws, a waiting HTTP op is answered retry and the lane fails', async () => {
    const h = harness();
    const http: OpResult[] = [];
    h.lane.enqueue([op(1)], (r) => http.push(r));
    h.lane.enqueue([op(2)], (r) => http.push(r));
    await h.tick();
    h.running[0]?.reject(new ProtocolViolation('foreign session'));
    await h.tick();
    expect(http.map((r) => r.status)).toEqual(['retry', 'retry']);
    expect(h.failures).toHaveLength(1);
  });
});
