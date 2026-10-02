/**
 * vfsTxn control flow against a FAKE executor (database.md §3.8-§3.9, §4.8): lock order, retries,
 * duplicates, rejections, cancellation and publish-after-commit. The real SQL of each step is
 * exercised against PostgreSQL in steps.test.ts (DB-gated).
 */
import { describe, expect, it } from 'vitest';

import { CancelRegistry } from './cancel.ts';
import { backoffMs, MAX_ATTEMPTS, runWithRetries } from './retry.ts';
import { vfsTxn, type OpHandler, type TxSteps, type VfsTxnDeps } from './tx.ts';
import {
  VfsError,
  type BodyResult,
  type InodeRow,
  type OpContext,
  type StoredOp,
  type TxOutcome,
} from './types.ts';

interface FakeTx {
  readonly attempt: number;
}

const pg = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(code), { code, ...extra });

class FakeSteps implements TxSteps<FakeTx> {
  readonly calls: string[] = [];
  attempt = 0;
  fresh = true;
  stored: StoredOp | null = null;
  rejectionConflict: StoredOp | null = null;
  readonly rejections: { opId: string; errno: string; reason: string | undefined }[] = [];
  /** step name -> error factory (by attempt), or undefined to succeed */
  readonly fail = new Map<string, (attempt: number) => unknown>();
  lockUsersArgs: number[][] = [];
  lockInodesArgs: string[][] = [];

  #maybeFail(step: string): void {
    const f = this.fail.get(step);
    const e = f?.(this.attempt);
    if (e !== undefined) throw e instanceof Error ? e : Object.assign(new Error('fake failure'), e);
  }

  async begin<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    this.attempt++;
    this.calls.push(`begin#${this.attempt}`);
    try {
      const r = await fn({ attempt: this.attempt });
      this.calls.push('commit');
      return r;
    } catch (e) {
      this.calls.push('rollback');
      throw e;
    }
  }
  setLocalTimeouts(): Promise<void> {
    this.calls.push('set-local');
    return Promise.resolve();
  }
  backendPid(): Promise<number> {
    return Promise.resolve(4242);
  }
  insertOpLog(): Promise<boolean> {
    this.calls.push('L0');
    return Promise.resolve(this.fresh);
  }
  readStoredOp(): Promise<StoredOp | null> {
    this.calls.push('read-stored');
    return Promise.resolve(this.stored);
  }
  lockUsers(_tx: FakeTx, owners: readonly number[]): Promise<void> {
    this.calls.push(`L1:${owners.join(',')}`);
    this.lockUsersArgs.push([...owners]);
    this.#maybeFail('L1');
    return Promise.resolve();
  }
  renameLock(): Promise<void> {
    this.calls.push('L2');
    return Promise.resolve();
  }
  lockInodes(_tx: FakeTx, inos: readonly string[]): Promise<readonly InodeRow[]> {
    this.calls.push(`L34:${inos.join(',')}`);
    this.lockInodesArgs.push([...inos]);
    return Promise.resolve(
      inos.map((ino): InodeRow => ({
        ino,
        type: ino.startsWith('d') ? 'd' : 'f',
        mode: 493,
        uid: 1001,
        gid: 100,
        version: 1,
        lock_fence: 0,
      })),
    );
  }
  armFault(): Promise<void> {
    this.calls.push('arm-fault');
    return Promise.resolve();
  }
  writeFeed(_tx: FakeTx, owners: readonly number[]): Promise<void> {
    this.calls.push(`feed:${owners.join(',')}`);
    return Promise.resolve();
  }
  finishOpLog(): Promise<void> {
    this.calls.push('finish');
    return Promise.resolve();
  }
  recordRejection(op: OpContext, err: VfsError): Promise<StoredOp | null> {
    this.calls.push(`record:${err.errno}`);
    this.rejections.push({ opId: op.opId, errno: err.errno, reason: err.reason });
    return Promise.resolve(this.rejectionConflict);
  }
}

function op(overrides: Partial<OpContext> = {}): OpContext {
  return {
    opId: '0192f2a0-0000-7000-8000-000000000001',
    principal: { uid: 1001, realUid: 1001, gids: [100] },
    osSessionId: '0192f2a0-0000-7000-8000-0000000000aa',
    cseq: 7,
    lamport: 42,
    call: 'rename',
    args: { from: 'a', to: 'b' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

type R = { ok: true };
const APPLIED: BodyResult<R> = {
  status: 'applied',
  result: { ok: true },
  effects: { changes: 1 },
  owners: [1002, 1001, 1002],
};

function handler(
  overrides: Partial<OpHandler<FakeTx, R>> = {},
): OpHandler<FakeTx, R> & { bodyCalls: number } {
  const h = {
    bodyCalls: 0,
    plan: () =>
      Promise.resolve({
        owners: [1002, 1001],
        renameLock: true,
        dirs: ['d2', 'd1'],
        files: ['f2', 'f1'],
        subtreeRoots: [],
      }),
    recheck: () => Promise.resolve(),
    body: () => {
      h.bodyCalls++;
      return Promise.resolve(APPLIED);
    },
    ...overrides,
  };
  return h;
}

function deps(
  steps: FakeSteps,
  extra: Partial<VfsTxnDeps<FakeTx>> = {},
): VfsTxnDeps<FakeTx> & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    steps,
    cancel: new CancelRegistry(),
    lockTimeoutMs: 2000,
    statementTimeoutMs: 15000,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.999,
    sleeps,
    ...extra,
  };
}

async function errnoOf(p: Promise<unknown>): Promise<VfsError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VfsError) return e;
    throw e;
  }
  throw new Error('expected a VfsError');
}

describe('DB-03 vfsTxn lock order and retries (database.md §3.8, §3.9)', () => {
  it('DB-03 vfsTxn takes L0, L1 in uid order, L2 for a directory move, L3 then L4 in ino order, and publishes only after COMMIT', async () => {
    const steps = new FakeSteps();
    const published: TxOutcome<R>[] = [];
    const out = await vfsTxn(deps(steps), op(), handler(), {
      publishAfterCommit: (_op, o) => {
        steps.calls.push('publish');
        published.push(o);
      },
    });
    expect(out.kind).toBe('applied');
    expect(steps.calls).toEqual([
      'begin#1',
      'set-local',
      'L0',
      'L1:1001,1002',
      'L2',
      'L34:d1,d2',
      'L34:f1,f2',
      'feed:1001,1002',
      'finish',
      'commit',
      'publish',
    ]);
    expect(published).toHaveLength(1);
  });

  it('DB-03 vfsTxn skips L2 when no directory changes parent and always includes the actor in L1', async () => {
    const steps = new FakeSteps();
    await vfsTxn(
      deps(steps),
      op({ principal: { uid: 1005, realUid: 1005, gids: [100] } }),
      handler({
        plan: () =>
          Promise.resolve({
            owners: [1002],
            renameLock: false,
            dirs: ['d1'],
            files: [],
            subtreeRoots: [],
          }),
      }),
    );
    expect(steps.calls).not.toContain('L2');
    expect(steps.lockUsersArgs[0]).toEqual([1002, 1005]);
  });

  it('DB-03 vfsTxn retries 40P01 with jitter for at most 5 attempts and maps exhaustion to EAGAIN', async () => {
    const steps = new FakeSteps();
    steps.fail.set('L1', () => pg('40P01'));
    const d = deps(steps);
    const h = handler();
    const err = await errnoOf(vfsTxn(d, op(), h));
    expect(err.errno).toBe('EAGAIN');
    expect(err.reason).toBe('retry-exhausted');
    expect(steps.attempt).toBe(MAX_ATTEMPTS);
    expect(d.sleeps).toHaveLength(MAX_ATTEMPTS - 1);
    d.sleeps.forEach((ms, i) => expect(ms).toBeLessThanOrEqual(Math.min(250, 10 * 2 ** (i + 2))));
    expect(h.bodyCalls).toBe(0);
    expect(steps.rejections).toEqual([]); // transient: a resend retries
  });

  it('DB-03 a row lock held longer than lock_timeout maps to EBUSY after 5 attempts', async () => {
    const steps = new FakeSteps();
    steps.fail.set('L1', () => pg('55P03'));
    const err = await errnoOf(vfsTxn(deps(steps), op(), handler()));
    expect(err.errno).toBe('EBUSY');
    expect(err.reason).toBe('lock-timeout');
    expect(steps.attempt).toBe(5);
    expect(steps.rejections).toEqual([]);
  });

  it('DB-03 a serialization failure on the first attempt commits on the second, in a fresh transaction', async () => {
    const steps = new FakeSteps();
    steps.fail.set('L1', (attempt) => (attempt === 1 ? pg('40001') : undefined));
    const out = await vfsTxn(deps(steps), op(), handler());
    expect(out.kind).toBe('applied');
    expect(steps.calls.filter((c) => c.startsWith('begin#'))).toEqual(['begin#1', 'begin#2']);
    expect(steps.calls.filter((c) => c === 'rollback')).toHaveLength(1);
    expect(steps.calls.filter((c) => c === 'L0')).toHaveLength(2); // L0 re-runs: the retry is idempotent
  });

  it('DB-03 a new owner found by the re-plan restarts the attempt with the larger L1 set', async () => {
    const steps = new FakeSteps();
    const extras: number[][] = [];
    const h = handler({
      plan: (_tx, extraOwners) => {
        extras.push([...extraOwners]);
        return Promise.resolve({
          owners: [1001],
          renameLock: false,
          dirs: ['d1'],
          files: [],
          subtreeRoots: [],
        });
      },
      replan: () => Promise.resolve({ dirs: ['d1'], owners: [1001, 1009] }),
    });
    const out = await vfsTxn(deps(steps), op(), h);
    expect(out.kind).toBe('applied');
    expect(extras).toEqual([[], [1001, 1009]]);
    expect(steps.lockUsersArgs).toEqual([[1001], [1001, 1009]]);
  });

  it('DB-03 the re-plan locks directories that appeared between plan and lock, then stops when stable', async () => {
    const steps = new FakeSteps();
    let round = 0;
    const h = handler({
      plan: () =>
        Promise.resolve({
          owners: [1001],
          renameLock: false,
          dirs: ['d5', 'd1'],
          files: ['f1'],
          subtreeRoots: [],
        }),
      replan: () => {
        round++;
        return Promise.resolve({
          dirs: round === 1 ? ['d1', 'd5', 'd3', 'd2'] : ['d1', 'd2', 'd3', 'd5'],
          owners: [1001],
        });
      },
    });
    await vfsTxn(deps(steps), op(), h);
    expect(steps.lockInodesArgs).toEqual([['d1', 'd5'], ['f1'], ['d2', 'd3']]);
    expect(round).toBe(2);
  });

  it('DB-03 the full-jitter delay before attempt n is at most min(250, 10 * 2^n) ms', () => {
    for (let n = 2; n <= 8; n++) {
      expect(backoffMs(n, () => 0)).toBe(0);
      expect(backoffMs(n, () => 0.9999999)).toBeLessThan(Math.min(250, 10 * 2 ** n));
    }
    expect(backoffMs(9, () => 0.5)).toBe(125);
  });

  it('DB-03 runWithRetries never retries a non-retryable error', async () => {
    let calls = 0;
    await expect(
      runWithRetries(
        () => {
          calls++;
          return Promise.reject(pg('23505'));
        },
        { signal: new AbortController().signal, sleep: () => Promise.resolve() },
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
  });
});

describe('OFF-02 exactly once (database.md §3.9.3, §5.5)', () => {
  it('OFF-02 a duplicate opId returns the stored result and runs neither plan nor body', async () => {
    const steps = new FakeSteps();
    steps.fresh = false;
    steps.stored = { uid: 1001, status: 'applied', errno: null, result: { ok: true, stored: 1 } };
    let planned = false;
    const h = handler({
      plan: () => {
        planned = true;
        return Promise.resolve({
          owners: [],
          renameLock: false,
          dirs: [],
          files: [],
          subtreeRoots: [],
        });
      },
    });
    let published = 0;
    const out = await vfsTxn(deps(steps), op(), h, { publishAfterCommit: () => published++ });
    expect(out).toEqual({
      kind: 'duplicate',
      status: 'applied',
      errno: null,
      result: { ok: true, stored: 1 },
    });
    expect(planned).toBe(false);
    expect(h.bodyCalls).toBe(0);
    expect(published).toBe(0);
  });

  it('OFF-02 an opId owned by another uid returns EINVAL without revealing or recording anything', async () => {
    const steps = new FakeSteps();
    steps.fresh = false;
    steps.stored = { uid: 2002, status: 'applied', errno: null, result: { secret: 'other user' } };
    const err = await errnoOf(vfsTxn(deps(steps), op(), handler()));
    expect(err.errno).toBe('EINVAL');
    expect(JSON.stringify(err.detail)).not.toContain('other user');
    expect(steps.rejections).toEqual([]);
  });

  it('OFF-02 when a concurrent attempt of the same op committed first, the rejection path returns its stored outcome', async () => {
    const steps = new FakeSteps();
    steps.rejectionConflict = {
      uid: 1001,
      status: 'applied',
      errno: null,
      result: { first: true },
    };
    const out = await vfsTxn(
      deps(steps),
      op(),
      handler({ body: () => Promise.reject(new VfsError('EEXIST')) }),
    );
    expect(out).toEqual({
      kind: 'duplicate',
      status: 'applied',
      errno: null,
      result: { first: true },
    });
  });
});

describe('DB-02 rejections and fault injection (database.md §3.9.3, §3.14)', () => {
  it('DB-02 an injected fault rolls back and is recorded as a deterministic EIO rejection after the rollback', async () => {
    const steps = new FakeSteps();
    const audits: string[] = [];
    const h = handler({
      body: () =>
        Promise.reject(
          pg('P0001', {
            hint: 'plotinium.fault',
            message: 'injected fault at node op 500 on inodes',
          }),
        ),
    });
    const err = await errnoOf(
      vfsTxn(deps(steps), op({ fault: { after: 499, on: 'inodes' } }), h, {
        auditAfterRollback: (_op, e) => {
          audits.push(e.errno);
          return Promise.resolve();
        },
      }),
    );
    expect(err.errno).toBe('EIO');
    expect(err.reason).toBe('injected');
    const rollback = steps.calls.indexOf('rollback');
    const record = steps.calls.indexOf('record:EIO');
    expect(rollback).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(rollback); // recorded AFTER the rollback, in its own statement
    expect(steps.attempt).toBe(1); // never retried: the fault is one-shot
    expect(audits).toEqual(['EIO']);
  });

  it('DB-02 the fault GUCs are armed after the permission re-check and immediately before the body', async () => {
    const steps = new FakeSteps();
    const h = handler({
      recheck: () => {
        steps.calls.push('recheck');
        return Promise.resolve();
      },
      body: () => {
        steps.calls.push('body');
        return Promise.resolve(APPLIED);
      },
    });
    await vfsTxn(deps(steps), op({ fault: { after: 0, on: 'dentries' } }), h);
    const i = steps.calls.indexOf('arm-fault');
    expect(steps.calls[i - 1]).toBe('recheck');
    expect(steps.calls[i + 1]).toBe('body');
  });

  it('DB-02 a deterministic errno from the re-check is recorded once and not retried', async () => {
    const steps = new FakeSteps();
    const err = await errnoOf(
      vfsTxn(deps(steps), op(), handler({ recheck: () => Promise.reject(new VfsError('EACCES')) })),
    );
    expect(err.errno).toBe('EACCES');
    expect(steps.rejections).toEqual([{ opId: op().opId, errno: 'EACCES', reason: undefined }]);
  });
});

describe('AGT-09 cancellation (database.md §3.9.5)', () => {
  it('AGT-09 an op killed during its body rolls back, is never retried and is recorded as ECANCELED killed', async () => {
    const controller = new AbortController();
    const steps = new FakeSteps();
    const h = handler({
      body: () => {
        controller.abort();
        return Promise.resolve(APPLIED);
      },
    });
    const err = await errnoOf(vfsTxn(deps(steps), op({ signal: controller.signal }), h));
    expect(err.errno).toBe('ECANCELED');
    expect(err.reason).toBe('killed');
    expect(steps.attempt).toBe(1);
    expect(steps.calls).not.toContain('commit');
    expect(steps.rejections.map((r) => r.errno)).toEqual(['ECANCELED']);
  });

  it('AGT-09 a statement_timeout maps to ETIMEDOUT and is not recorded, while pg_cancel_backend with the flag is ECANCELED', async () => {
    const steps = new FakeSteps();
    const timeout = await errnoOf(
      vfsTxn(deps(steps), op(), handler({ body: () => Promise.reject(pg('57014')) })),
    );
    expect(timeout.errno).toBe('ETIMEDOUT');
    expect(steps.rejections).toEqual([]);

    const steps2 = new FakeSteps();
    const d = deps(steps2);
    const h = handler({
      body: () => {
        expect(d.cancel.markCancelled(op().opId)).toBe(4242); // the backend pid bound for this attempt
        return Promise.reject(pg('57014'));
      },
    });
    const killed = await errnoOf(vfsTxn(d, op(), h));
    expect(killed.errno).toBe('ECANCELED');
    expect(steps2.rejections.map((r) => r.errno)).toEqual(['ECANCELED']);
    expect(d.cancel.size).toBe(0);
  });

  it('AGT-09 an op aborted before it starts never opens a transaction', async () => {
    const controller = new AbortController();
    controller.abort();
    const steps = new FakeSteps();
    const err = await errnoOf(vfsTxn(deps(steps), op({ signal: controller.signal }), handler()));
    expect(err.errno).toBe('ECANCELED');
    expect(steps.attempt).toBe(0);
  });
});
