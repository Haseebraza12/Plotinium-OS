import { describe, expect, it } from 'vitest';

import { formatBootLine, messageOf, subOf, toKlogEntry } from '../src/core/klog/format.ts';
import { ArrayRing, createKlogRing, Klog, KLOG_SIZE } from '../src/core/klog/klog.ts';
import type { KlogRecord } from '../src/core/klog/records.ts';
import { levelOf } from '../src/core/klog/records.ts';

describe('klog ring', () => {
  it('PROC-06 the ring keeps the newest records, counts overwrites and never loses a follower record', () => {
    const klog = new Klog(new ArrayRing<KlogRecord>(3));
    const followed: number[] = [];
    const stop = klog.follow((r) => followed.push(r.seq));
    for (let i = 0; i < 5; i++) klog.line(i, 'test', 'info', `line ${String(i)}`);
    expect(klog.size).toBe(3);
    expect(klog.dropped).toBe(2);
    expect(klog.lastSeq).toBe(5);
    expect(klog.read().map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(followed).toEqual([1, 2, 3, 4, 5]);
    stop();
    klog.line(6, 'test', 'info', 'after unfollow');
    expect(followed).toHaveLength(5);
  });

  it('PROC-06 a throwing follower does not break the log', () => {
    const klog = new Klog(new ArrayRing<KlogRecord>(4));
    klog.follow(() => {
      throw new Error('bad follower');
    });
    expect(() => klog.line(0, 'x', 'info', 'still logged')).not.toThrow();
    expect(klog.size).toBe(1);
  });

  it('SYS-02 read filters by since, level and limit (newest without since, first after since)', () => {
    const klog = new Klog(new ArrayRing<KlogRecord>(10));
    for (let i = 0; i < 6; i++) klog.line(i, 's', i % 2 === 0 ? 'info' : 'warn', `m${String(i)}`);
    expect(klog.read({ level: 'warn' }).map((r) => r.seq)).toEqual([2, 4, 6]);
    expect(klog.read({ limit: 2 }).map((r) => r.seq)).toEqual([5, 6]);
    expect(klog.read({ since: 2, limit: 2 }).map((r) => r.seq)).toEqual([3, 4]);
    expect(klog.read({ filter: (r) => r.seq === 1 })).toHaveLength(1);
  });

  it('PROC-06 the default ring holds 8192 entries and the array ring rejects a bad capacity', () => {
    expect(new Klog().capacity).toBe(KLOG_SIZE);
    expect(createKlogRing(16).capacity).toBe(16);
    expect(() => new ArrayRing(0)).toThrow(RangeError);
    const ring = new ArrayRing<number>(2);
    expect(ring.at(0)).toBeUndefined();
    ring.push(1);
    expect(ring.at(-1)).toBeUndefined();
    expect(ring.at(1)).toBeUndefined();
  });
});

describe('klog format', () => {
  it('BOOT-05 verbose lines carry WARN and DEGRADED text prefixes, not colour alone', () => {
    expect(formatBootLine(0.058, 'kernel', 'info', 'ready')).toBe('[    0.058] kernel: ready');
    expect(formatBootLine(0.402, 'sync', 'warn', 'offline')).toBe('[    0.402] sync: WARN offline');
    expect(formatBootLine(0.405, 'lockd', 'degraded', 'local only')).toBe(
      '[    0.405] lockd: DEGRADED local only',
    );
    expect(formatBootLine(1.5, 'svc', 'panic', 'cycle')).toBe(
      '[    1.500] svc: KERNEL PANIC: cycle',
    );
    expect(formatBootLine(2, 'x', 'fail', 'y')).toBe('[    2.000] x: FAIL y');
  });

  it('SYS-02 dmesg entries carry epoch timestamps, subsystem, level, message and pid', () => {
    const proc = {
      kind: 'proc',
      seq: 7,
      t: 10,
      pid: 12,
      uid: 1001,
      from: 'READY',
      to: 'RUNNING',
      reason: 'dispatch',
    } as const;
    expect(toKlogEntry(proc, 1_000)).toEqual({
      seq: 7,
      t: 1_010,
      sub: 'proc',
      level: 'info',
      msg: 'pid 12 READY → RUNNING (dispatch)',
      pid: 12,
    });
    const trace = {
      kind: 'trace',
      seq: 1,
      t: 0,
      pid: 0,
      uid: 0,
      call: 'stat',
      errno: 'ENOENT',
      us: 12.4,
    } as const;
    expect(toKlogEntry(trace, 0)).toEqual({
      seq: 1,
      t: 0,
      sub: 'trace',
      level: 'warn',
      msg: 'pid 0 uid 0 stat → ENOENT 12 µs',
    });
    const long = {
      kind: 'line',
      seq: 2,
      t: 0,
      sub: 'a-very-long-subsystem-name-over-32-chars',
      level: 'info',
      msg: 'x'.repeat(2_000),
    } as const;
    const e = toKlogEntry(long, 0);
    expect(e.sub.length).toBe(32);
    expect(e.msg.length).toBe(1_024);
  });

  it('PROC-06 spawn, annotation, reap and memory records render readably', () => {
    expect(messageOf({ kind: 'proc', t: 0, pid: 5, from: null, to: 'NEW', reason: 'spawn' })).toBe(
      'pid 5 NEW (spawn)',
    );
    expect(
      messageOf({
        kind: 'proc',
        t: 0,
        pid: 5,
        from: 'BLOCKED',
        to: 'BLOCKED',
        reason: 'annotate',
        waitingOn: 'sigcont',
      }),
    ).toBe('pid 5 BLOCKED (waiting on sigcont) (annotate)');
    expect(
      messageOf({
        kind: 'proc',
        t: 0,
        pid: 5,
        from: 'TERMINATED',
        to: null,
        reason: 'reaped',
        by: 1,
      }),
    ).toBe('pid 5 TERMINATED → (reaped) (reaped) by 1');
    expect(
      messageOf({
        kind: 'proc',
        t: 0,
        pid: 5,
        from: 'RUNNING',
        to: 'TERMINATED',
        reason: 'exit',
        exitCode: 0,
        detail: 'ok',
      }),
    ).toBe('pid 5 RUNNING → TERMINATED (exit) exit 0 · ok');
    const mem = {
      kind: 'mem',
      t: 0,
      ev: 'page-out',
      pid: 3,
      pageId: 2,
      bytes: 4096,
      ms: 1.25,
      detail: 'opfs',
    } as const;
    expect(messageOf(mem)).toBe('page-out · pid 3 · page 2 · 4096 B · 1.3 ms · opfs');
    expect(subOf(mem)).toBe('mm');
    expect(levelOf(mem)).toBe('info');
    expect(toKlogEntry({ ...mem, seq: 1 }, 0).pid).toBe(3);
    expect(
      toKlogEntry({ kind: 'line', seq: 1, t: 0, sub: 's', level: 'info', msg: 'm' }, 0).pid,
    ).toBeUndefined();
  });
});
