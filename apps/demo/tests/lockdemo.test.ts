import { describe, expect, it } from 'vitest';

import type { Program } from '@plotinium/kernel/sys';
import { SysError } from '@plotinium/kernel/sys';

import lockdemo, { parseLock } from '../cmd/lockdemo.ts';
import type { FakeProc } from './fakesys.ts';
import { block, FakeKernel } from './fakesys.ts';

const program = lockdemo as unknown as Program<unknown>;
/** The demo lease profile: TTL 15 s, heartbeat every TTL / 3 (offline-and-sync.md §3.14, C6). */
const TTL = 15_000;

interface Lease {
  readonly leaseId: string;
  readonly pid: number;
  readonly holder: string;
  readonly mode: 'S' | 'X';
  readonly fence: number;
  renewedAt: number;
  expiresAt: number;
}

/**
 * A lease table on the fake kernel: the "kernel heartbeat" renews a lease whose holder is alive
 * every TTL / 3; a crashed holder stops renewing and its lease expires; a holder that exits is
 * released at once (PROC-07).
 */
function withLeases(k: FakeKernel, holderOf: (p: FakeProc) => string): Map<string, Lease[]> {
  const table = new Map<string, Lease[]>();
  const crashed = new Set<number>();
  /** First attempt time of each blocked `pid:path` wait (for --timeout and the queued count). */
  const waits = new Map<string, number>();
  let fence = 6;
  let ids = 0;
  const live = (path: string): Lease[] => {
    const now = k.epochNow;
    const list = (table.get(path) ?? []).filter((l) => {
      const alive = k.procs.get(l.pid)?.state === 'run' && !crashed.has(l.pid);
      if (alive) {
        while (now - l.renewedAt >= TTL / 3) {
          l.renewedAt += TTL / 3;
          l.expiresAt = l.renewedAt + TTL;
        }
      }
      return l.expiresAt > now;
    });
    table.set(path, list);
    return list;
  };
  k.onExit = (p) => {
    if (p.status?.kind === 'signaled' && p.status.signal === 'SIGKILL') {
      crashed.add(p.pid);
      return;
    }
    for (const [path, list] of table)
      table.set(
        path,
        list.filter((l) => l.pid !== p.pid),
      );
  };
  k.on('lock.acquire', (a, p) => {
    const path = 'path' in a ? a.path : '';
    const held = live(path);
    const conflict = held.some((l) => l.pid !== p.pid && (l.mode === 'X' || a.mode === 'X'));
    if (conflict) {
      if (a.wait !== true) throw new SysError('EBUSY', undefined, { reason: 'lease' });
      const deadline = a.timeoutMs === undefined ? null : k.epochNow + a.timeoutMs;
      const key = `${String(p.pid)}:${path}`;
      const first = waits.get(key) ?? k.epochNow;
      waits.set(key, first);
      if (a.timeoutMs !== undefined && k.epochNow >= first + a.timeoutMs) {
        waits.delete(key);
        throw new SysError('ETIMEDOUT');
      }
      const expiry = Math.min(...held.map((l) => l.expiresAt));
      return block(Math.min(expiry, deadline ?? expiry) - k.epoch0 + 1);
    }
    waits.delete(`${String(p.pid)}:${path}`);
    fence++;
    const now = k.epochNow;
    const lease: Lease = {
      leaseId: `0190-lease-${String(++ids)}`,
      pid: p.pid,
      holder: holderOf(p),
      mode: a.mode,
      fence,
      renewedAt: now,
      expiresAt: now + TTL,
    };
    table.set(path, [...held, lease]);
    return { leaseId: lease.leaseId, fence, expiresAt: lease.expiresAt, scope: 'server' };
  });
  k.on('lock.status', (a) => {
    const held = live(a.path);
    return {
      holders: held.map((l) => ({
        path: a.path,
        holder: l.holder,
        mode: l.mode,
        expiresAt: l.expiresAt,
        scope: 'server' as const,
      })),
      queued: [...waits.keys()].filter((key) => key.endsWith(`:${a.path}`)).length,
    };
  });
  k.on('lock.release', (a) => {
    for (const [path, list] of table) {
      const next = list.filter((l) => l.leaseId !== a.leaseId);
      if (next.length === list.length) continue;
      table.set(path, next);
      return {};
    }
    throw new SysError('EINVAL', undefined, { reason: 'unknown-lease' });
  });
  return table;
}

const PLAN = '/home/shared/plan.md';

describe('lockdemo (VFS-09 two-user contention)', () => {
  it('VFS-09 lockdemo takes an X lease, reports its fence and releases it after --hold', () => {
    const k = new FakeKernel();
    const table = withLeases(k, () => 'alice@lab-pc-3');
    const r = k.run(program, ['lockdemo', '--hold', '12', '-i', '5', PLAN]);
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe(
      `lockdemo: acquired X lease on ${PLAN} (fence 7, scope server, expires in 15 s)`,
    );
    expect(lines.slice(1, -1)).toEqual([
      `lockdemo: holding X lease on ${PLAN} for 5.0 s (fence 7, expires in 15 s, 0 waiting)`,
      `lockdemo: holding X lease on ${PLAN} for 10.0 s (fence 7, expires in 15 s, 0 waiting)`,
    ]);
    expect(lines.at(-1)).toBe(`lockdemo: released X lease on ${PLAN} after 12.0 s`);
    expect(k.callsOf('lock.acquire')).toEqual([{ path: PLAN, mode: 'X', wait: false }]);
    expect(table.get(PLAN)).toEqual([]);
  });

  it('VFS-09 without --wait a held lease is reported with its holder and expiry, and lockdemo exits 1', () => {
    const k = new FakeKernel();
    withLeases(k, (p) => (p.argv.includes('-s') ? 'bob@lab-pc-4' : 'alice@lab-pc-3'));
    const alice = k.start(program, ['lockdemo', '-i', '0', PLAN]);
    k.runUntil(() => alice.out.includes('acquired'));
    k.time += 3_000;
    const bob = k.start(program, ['lockdemo', '-s', PLAN]);
    k.runUntil(() => bob.state !== 'run');
    expect(k.statusOf(bob)).toBe(1);
    expect(bob.err).toBe(`lockdemo: ${PLAN} is locked by alice@lab-pc-3 (X, expires in 12 s)\n`);
  });

  it('VFS-09 with --wait the second user gets the lease within the TTL after the holder crashes', () => {
    const k = new FakeKernel();
    withLeases(k, (p) => (p.argv.includes('--wait') ? 'bob@lab-pc-4' : 'alice@lab-pc-3'));
    const alice = k.start(program, ['lockdemo', '-i', '0', PLAN]);
    k.runUntil(() => alice.out.includes('acquired'));
    k.time += 20_000;
    const bob = k.start(program, ['lockdemo', '--wait', '--hold', '1', '-i', '0', PLAN]);
    k.runUntil(() => bob.out.includes('waiting'));
    expect(bob.out).toMatch(
      new RegExp(
        `^lockdemo: waiting for an X lease on ${PLAN}; held by alice@lab-pc-3 \\(X, expires in 1[0-5] s\\)\\n$`,
      ),
    );
    // The examiner ends alice's renderer: no release, the heartbeat stops.
    const crashedAt = k.time;
    k.crash(alice);
    k.runUntil(() => bob.state !== 'run');
    expect(k.statusOf(bob)).toBe(0);
    const acquired = /acquired X lease on \S+ after (\d+\.\d) s/.exec(bob.out);
    expect(acquired).not.toBeNull();
    expect(Number(acquired?.[1]) * 1000).toBeLessThanOrEqual(TTL + 1000);
    expect(k.time - crashedAt).toBeGreaterThan(0);
    expect(bob.out.trimEnd().split('\n').at(-1)).toBe(
      `lockdemo: released X lease on ${PLAN} after 1.0 s`,
    );
  });

  it('PROC-07 SIGTERM releases the lease with lock.release and lockdemo exits 143', () => {
    const k = new FakeKernel();
    const table = withLeases(k, () => 'alice@lab-pc-3');
    const p = k.start(program, ['lockdemo', '-i', '0', PLAN]);
    k.runUntil(() => p.out.includes('acquired'));
    k.time += 4_000;
    k.signal(p, 'SIGTERM');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(143);
    expect(k.callsOf('lock.release')).toHaveLength(1);
    expect(table.get(PLAN)).toEqual([]);
    expect(p.out.trimEnd().split('\n').at(-1)).toMatch(
      /^lockdemo: released X lease on \/home\/shared\/plan\.md after \d+\.\d s$/,
    );
  });

  it('VFS-09 --timeout ends a wait that is not granted with a timed-out message', () => {
    const k = new FakeKernel();
    withLeases(k, (p) => (p.argv.includes('--wait') ? 'bob@lab-pc-4' : 'alice@lab-pc-3'));
    const alice = k.start(program, ['lockdemo', '-i', '0', PLAN]);
    k.runUntil(() => alice.out.includes('acquired'));
    const bob = k.start(program, ['lockdemo', '--wait', '--timeout', '20', PLAN]);
    k.runUntil(() => bob.state !== 'run');
    expect(k.statusOf(bob)).toBe(1);
    expect(k.callsOf('lock.acquire', bob.pid)).toEqual([
      { path: PLAN, mode: 'X', wait: true, timeoutMs: 20_000 },
    ]);
    expect(bob.err).toBe(`lockdemo: timed out after 20 s waiting for an X lease on ${PLAN}\n`);
    k.signal(alice, 'SIGINT');
    k.runUntil(() => alice.state !== 'run');
    expect(k.statusOf(alice)).toBe(130);
  });

  it('VFS-09 shared leases coexist and a denied path is reported with the errno text', () => {
    const k = new FakeKernel();
    withLeases(k, () => 'alice@lab-pc-3');
    const a = k.start(program, ['lockdemo', '-s', '--hold', '2', '-i', '0', PLAN]);
    const b = k.start(program, ['lockdemo', '-s', '--hold', '2', '-i', '0', PLAN]);
    k.runUntil(() => a.state !== 'run' && b.state !== 'run');
    expect([k.statusOf(a), k.statusOf(b)]).toEqual([0, 0]);
    k.fail('lock.acquire', 'EACCES');
    const denied = k.run(program, ['lockdemo', '/root/secret']);
    expect(denied.status).toBe(1);
    expect(denied.err).toBe("lockdemo: cannot lock '/root/secret': Permission denied\n");
  });

  it('SYS-02 lockdemo checks its operands and options', () => {
    const k = new FakeKernel();
    for (const argv of [
      ['lockdemo'],
      ['lockdemo', '-x', '-s', PLAN],
      ['lockdemo', '-t', '5', PLAN],
      ['lockdemo', 'a', 'b'],
      ['lockdemo', '--hold', '0', PLAN],
    ]) {
      const r = k.run(program, argv);
      expect(r.status).toBe(2);
      expect(r.err).toContain('Usage: lockdemo [-x | -s]');
    }
    expect(parseLock([PLAN])).toEqual({
      path: PLAN,
      mode: 'X',
      wait: false,
      timeout: null,
      hold: null,
      interval: 5,
    });
  });
});
