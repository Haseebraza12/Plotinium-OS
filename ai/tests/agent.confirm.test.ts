import { SubmitResult } from '@plotinium/protocol';
import type { PlanStep } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { FROZEN_NOW, QUOTAS, TZ, USERS, buildFxAgt } from '../eval/fixtures/fx-agt.ts';
import type { ResolvedOp } from '../src/agent/apply.ts';
import {
  type ConfirmTty,
  type PredicateInput,
  type TtyRead,
  abiReasons,
  confirmOnTty,
  interpretAnswer,
  needsConfirmation,
  opsRequireConfirmation,
} from '../src/agent/confirm.ts';
import {
  GrantTable,
  generateTokenKey,
  grantHash,
  issueToken,
  verifyToken,
} from '../src/agent/token.ts';
import { authorizeBatch, submitPlan, tokenAfterConfirm } from '../src/agent/submit.ts';
import type { ValidateInput } from '../src/agent/validator.ts';
import { type Schema, parseWith } from '../src/util/schema.ts';
import { posixOracle } from './doubles.ts';

const NO_FLAGS = {
  unlicensed: false,
  ungrounded: false,
  suspicious: false,
  edited: false,
  elevation: false,
};
const op = (o: Partial<ResolvedOp>): Pick<ResolvedOp, 'call' | 'kind' | 'overwrites'> => ({
  call: 'rename',
  kind: 'modify',
  ...o,
});
const pred = (p: Partial<PredicateInput>): PredicateInput => ({
  ops: [],
  affectedInodes: 1,
  systemPath: false,
  flags: NO_FLAGS,
  ...p,
});

describe('confirmation predicate (AGT-03)', () => {
  it('AGT-03 the predicate requires confirmation for a delete', () => {
    expect(needsConfirmation(pred({ ops: [op({ call: 'unlink', kind: 'delete' })] }))).toEqual({
      required: true,
      reasons: ['delete'],
    });
  });

  it('AGT-03 the predicate requires confirmation for an overwrite', () => {
    expect(needsConfirmation(pred({ ops: [op({ overwrites: 'ino' })] }))).toEqual({
      required: true,
      reasons: ['overwrite'],
    });
  });

  it('AGT-03 the predicate requires confirmation for chmod', () => {
    expect(needsConfirmation(pred({ ops: [op({ call: 'chmod' })] }))).toEqual({
      required: true,
      reasons: ['chmod'],
    });
  });

  it('AGT-03 the predicate requires confirmation for chown', () => {
    expect(needsConfirmation(pred({ ops: [op({ call: 'chown' })] }))).toEqual({
      required: true,
      reasons: ['chown'],
    });
  });

  it('AGT-03 the predicate requires confirmation above 20 affected inodes and not at exactly 20', () => {
    expect(needsConfirmation(pred({ affectedInodes: 20 }))).toEqual({
      required: false,
      reasons: [],
    });
    expect(needsConfirmation(pred({ affectedInodes: 21 }))).toEqual({
      required: true,
      reasons: ['over-20-inodes'],
    });
  });

  it('AGT-03 the predicate requires confirmation for unlicensed, ungrounded, suspicious, edited and elevated plans', () => {
    for (const flag of ['unlicensed', 'ungrounded', 'suspicious', 'edited', 'elevation'] as const) {
      const r = needsConfirmation(pred({ flags: { ...NO_FLAGS, [flag]: true } }));
      expect(r).toEqual({ required: true, reasons: [flag] });
      expect(abiReasons(r.reasons)).toEqual([]);
    }
    expect(needsConfirmation(pred({ systemPath: true })).reasons).toEqual(['system-path']);
    expect(needsConfirmation(pred({ ops: [op({ call: 'mkdir', kind: 'create' })] })).required).toBe(
      false,
    );
  });

  it('AGT-03 an empty answer, anything but y/yes, EOF or a timeout means N (default N)', () => {
    const line = (text: string): TtyRead => ({ kind: 'line', text });
    expect(interpretAnswer(line('y')).granted).toBe(true);
    expect(interpretAnswer(line(' YES ')).granted).toBe(true);
    expect(interpretAnswer(line(''))).toMatchObject({
      granted: false,
      errno: 'ECANCELED',
      outcome: 'declined',
    });
    expect(interpretAnswer(line('yep'))).toMatchObject({ granted: false, outcome: 'declined' });
    expect(interpretAnswer({ kind: 'eof' })).toMatchObject({ granted: false, outcome: 'declined' });
    expect(interpretAnswer({ kind: 'timeout' })).toMatchObject({
      granted: false,
      errno: 'ECANCELED',
      outcome: 'confirm_timeout',
    });
    expect(interpretAnswer(line('e'))).toEqual({ granted: false, answer: 'edit' });
  });

  it('AGT-03 piped input cannot confirm: without a controlling TTY in the foreground the plan is refused with ENOTTY', async () => {
    let read = false;
    const tty: ConfirmTty = {
      interactive: () => false,
      flushTypeAhead: () => undefined,
      write: () => undefined,
      secureReadLine: () => {
        read = true;
        return Promise.resolve({ kind: 'line', text: 'y' });
      },
    };
    expect(await confirmOnTty(tty, 'Plan')).toMatchObject({
      granted: false,
      errno: 'ENOTTY',
      outcome: 'no_tty',
    });
    expect(read).toBe(false);
  });

  it('AGT-03 type-ahead typed before the prompt is discarded before the kernel reads the answer', async () => {
    const events: string[] = [];
    const tty: ConfirmTty = {
      interactive: () => true,
      flushTypeAhead: () => events.push('flush'),
      write: (t) =>
        events.push(`write:${t.includes('Proceed? [y/N/e=edit]') ? 'prompt' : 'other'}`),
      secureReadLine: (ms) => {
        events.push(`read:${ms}`);
        return Promise.resolve({ kind: 'line', text: 'y' });
      },
    };
    expect(await confirmOnTty(tty, 'Plan · 1 step')).toEqual({ granted: true, answer: 'y' });
    expect(events).toEqual(['flush', 'write:prompt', 'read:120000']);
  });

  it('AGT-03 batch recomputes the predicate over the ops it received', () => {
    const ctx = {
      home: '/home/alice',
      affectedInodes: 1,
      exists: (p: string) => p === '/home/alice/x',
    };
    expect(opsRequireConfirmation([{ op: 'mkdir', path: '/home/alice/n' }], ctx)).toBe(false);
    expect(opsRequireConfirmation([{ op: 'unlink', path: '/home/alice/n' }], ctx)).toBe(true);
    expect(
      opsRequireConfirmation(
        [{ op: 'rename', from: '/home/alice/n', to: '/home/alice/.trash/t/1-n' }],
        ctx,
      ),
    ).toBe(true);
    expect(opsRequireConfirmation([{ op: 'write', path: '/home/alice/x', text: '' }], ctx)).toBe(
      true,
    );
    expect(opsRequireConfirmation([{ op: 'copy', from: '/a', to: '/home/alice/y' }], ctx)).toBe(
      false,
    );
    expect(
      opsRequireConfirmation([{ op: 'symlink', target: 't', path: '/home/alice/x' }], ctx),
    ).toBe(true);
    expect(opsRequireConfirmation([{ op: 'utimes', path: '/bin/x', mtime: 'now' }], ctx)).toBe(
      true,
    );
    expect(
      opsRequireConfirmation(
        [{ op: 'chmod', path: '/home/alice/x', mode: { op: 'set', bits: 0o600 } }],
        ctx,
      ),
    ).toBe(true);
    expect(
      opsRequireConfirmation([{ op: 'mkdir', path: '/home/alice/n' }], {
        ...ctx,
        affectedInodes: 21,
      }),
    ).toBe(true);
  });
});

describe('plan tokens (AGT-03)', () => {
  const claims = {
    pid: 42,
    planId: '0192f0c1-0000-7000-8000-00000000abcd',
    planHash: 'a'.repeat(64),
    dryRunHash: 'b'.repeat(64),
  };

  it('AGT-03 a confirm token has the ABI format and verifies only with the same claims', async () => {
    const key = await generateTokenKey();
    expect(key.extractable).toBe(false);
    const t = await issueToken(key, claims, 1_000);
    expect(t.token).toMatch(/^[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(t.exp).toBe(121_000);
    expect((await verifyToken(key, t.token, claims, 2_000)).ok).toBe(true);
    expect((await verifyToken(key, t.token, { ...claims, pid: 43 }, 2_000)).ok).toBe(false);
    expect(
      (await verifyToken(key, t.token, { ...claims, planHash: 'c'.repeat(64) }, 2_000)).ok,
    ).toBe(false);
    expect((await verifyToken(key, t.token, claims, 121_001)).ok).toBe(false);
    expect((await verifyToken(key, 'garbage', claims, 2_000)).ok).toBe(false);
    const forged = t.token.replace(/\.\d+\./, '.999999999999.');
    expect((await verifyToken(key, forged, claims, 2_000)).ok).toBe(false);
    const other = await generateTokenKey();
    expect((await verifyToken(other, t.token, claims, 2_000)).ok).toBe(false);
    const g = await issueToken(key, { ...claims, grantHash: grantHash([['rename', 'x']]) }, 1_000);
    expect((await verifyToken(key, g.token, claims, 2_000)).ok).toBe(false);
  });

  it('AGT-03 a confirm token is single-use, pid-bound and expires after 120 s', async () => {
    const grants = new GrantTable(await generateTokenKey());
    const pairs: Array<[string, string]> = [['rename', 'ino-1']];
    const versions = new Map([['ino-1', 3]]);
    const check = (pid: number, token: string | undefined, now: number) =>
      grants.check(
        { pid, token, planId: claims.planId, pairs, versionOf: (i) => versions.get(i) },
        now,
      );
    const t1 = await grants.issue(claims, pairs, [{ ino: 'ino-1', version: 3 }], 0);
    expect((await check(7, t1.token, 1)).ok).toBe(false);
    expect((await check(42, t1.token, 1)).ok).toBe(true);
    const again = await check(42, t1.token, 2);
    expect(!again.ok && again.error.reason).toBe('no-token');
    await grants.issue(claims, pairs, [{ ino: 'ino-1', version: 3 }], 0);
    const expired = await check(
      42,
      (await grants.issue(claims, pairs, [{ ino: 'ino-1', version: 3 }], 0)).token,
      120_001,
    );
    expect(!expired.ok && expired.error.errno).toBe('EPERM');
    expect(grants.size).toBe(0);
    const t2 = await grants.issue(claims, pairs, [{ ino: 'ino-1', version: 3 }], 0);
    const outside = await grants.check(
      {
        pid: 42,
        token: t2.token,
        planId: claims.planId,
        pairs: [['unlink', 'ino-9']],
        versionOf: () => 3,
      },
      1,
    );
    expect(!outside.ok && outside.error.reason).toBe('outside-grant');
    versions.set('ino-1', 4);
    const stale = await check(42, t2.token, 1);
    expect(!stale.ok && stale.error).toMatchObject({ errno: 'EAGAIN', reason: 'stale-plan' });
    expect((await check(42, undefined, 1)).ok).toBe(false);
  });
});

describe('submit and the batch gate (AGT-03)', () => {
  const A = USERS.alice;
  const input = (steps: PlanStep[], request: string): ValidateInput => ({
    requestId: '0192f0c1-0000-7000-8000-0000000000aa',
    steps,
    request,
    clarifications: [],
    cred: { uid: A.uid, gid: A.gid, groups: [...A.groups] },
    home: A.home,
    cwd: A.home,
    umask: 0o022,
    now: FROZEN_NOW,
    tz: TZ,
    txnId: '0192f0c1-0000-7000-8000-000000000001',
    snapshot: buildFxAgt().tree.snapshot,
    oracle: posixOracle,
    quota: {
      quota: (uid) =>
        QUOTAS[uid] ?? { usedBytes: 0, quotaBytes: null, usedInodes: 0, quotaInodes: null },
    },
  });
  const planId = '0192f0c1-0000-7000-8000-00000000abcd';

  it('AGT-03 a plan that needs no confirmation gets its token at submit and matches the ABI SubmitResult', async () => {
    const grants = new GrantTable(await generateTokenKey());
    const r = await submitPlan(
      input(
        [
          {
            id: 's1',
            op: 'mkdir',
            args: { path: '~/reports' },
            span: 'a new folder called reports',
          },
        ],
        'a new folder called reports',
      ),
      planId,
      42,
      grants,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result.confirm).toEqual({ required: false, reasons: [] });
    expect(r.value.result.token).toBeDefined();
    expect(parseWith(SubmitResult as unknown as Schema<unknown>, r.value.result).ok).toBe(true);
  });

  it('AGT-03 a destructive plan gets no token at submit; only a kernel-confirmed y issues one', async () => {
    const grants = new GrantTable(await generateTokenKey());
    const r = await submitPlan(
      input(
        [{ id: 's1', op: 'unlink', args: { path: '~/tmp/cache.tmp' }, span: 'delete cache.tmp' }],
        'delete cache.tmp',
      ),
      planId,
      42,
      grants,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result.confirm).toEqual({ required: true, reasons: ['delete'] });
    expect(r.value.result.token).toBeUndefined();
    expect(parseWith(SubmitResult as unknown as Schema<unknown>, r.value.result).ok).toBe(true);
    const t = await tokenAfterConfirm(r.value, 42, grants, FROZEN_NOW);
    expect(t.granted).toBe(true);
    expect(t.expiresAt).toBe(FROZEN_NOW + 120_000);
    const bad = await submitPlan(
      input(
        [{ id: 's1', op: 'unlink', args: { path: '~/tmp/cache.tmp' }, span: 'tidy up' }],
        'tidy up',
      ),
      planId,
      42,
      grants,
    );
    expect(bad.ok).toBe(false);
  });

  it('AGT-03 batch without a valid token is refused with EPERM even when called directly', async () => {
    const grants = new GrantTable(await generateTokenKey());
    const base = {
      pid: 42,
      ops: [{ op: 'unlink' as const, path: '/home/alice/tmp/cache.tmp' }],
      pairs: [['unlink', 'ino']] as Array<[string, string]>,
      home: '/home/alice',
      affectedInodes: 1,
      exists: () => false,
      versionOf: () => 1,
    };
    const user = await authorizeBatch({ ...base, callerClass: 'user' }, grants, 0);
    expect(!user.ok && user.error).toMatchObject({ errno: 'EPERM', reason: 'no-token' });
    const agent = await authorizeBatch(
      { ...base, callerClass: 'agent', ops: [{ op: 'mkdir', path: '/home/alice/x' }] },
      grants,
      0,
    );
    expect(!agent.ok && agent.error.errno).toBe('EPERM');
    const plain = await authorizeBatch(
      { ...base, callerClass: 'user', ops: [{ op: 'mkdir', path: '/home/alice/x' }] },
      grants,
      0,
    );
    expect(plain.ok).toBe(true);
    const forged = await authorizeBatch(
      { ...base, callerClass: 'agent', token: `${planId}.999.${'A'.repeat(43)}`, planId },
      grants,
      0,
    );
    expect(!forged.ok && forged.error.errno).toBe('EPERM');
  });
});

describe('atomic execution inputs (AGT-05)', () => {
  const A = USERS.alice;
  const planId = '0192f0c1-0000-7000-8000-00000000abcd';
  const validate = (steps: PlanStep[], request: string): ValidateInput => ({
    requestId: '0192f0c1-0000-7000-8000-0000000000aa',
    steps,
    request,
    clarifications: [],
    cred: { uid: A.uid, gid: A.gid, groups: [...A.groups] },
    home: A.home,
    cwd: A.home,
    umask: 0o022,
    now: FROZEN_NOW,
    tz: TZ,
    txnId: '0192f0c1-0000-7000-8000-000000000001',
    snapshot: buildFxAgt().tree.snapshot,
    oracle: posixOracle,
    quota: {
      quota: (uid) =>
        QUOTAS[uid] ?? { usedBytes: 0, quotaBytes: null, usedInodes: 0, quotaInodes: null },
    },
  });

  it('AGT-05 every op of a plan, trash moves included, travels in ONE batch with one fingerprint', async () => {
    const grants = new GrantTable(await generateTokenKey());
    const steps: PlanStep[] = [
      { id: 's1', op: 'mkdir', args: { path: '~/old' }, span: 'make old' },
      {
        id: 's2',
        op: 'rename',
        args: { from: '~/todo.txt', to: '~/old/todo.txt' },
        span: 'move todo.txt into old',
      },
      { id: 's3', op: 'unlink', args: { path: '~/tmp/cache.tmp' }, span: 'delete cache.tmp' },
    ];
    const r = await submitPlan(
      validate(steps, 'make old, move todo.txt into old, delete cache.tmp'),
      planId,
      42,
      grants,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.value.result.dryRun.ops.map((o) => o.op);
    expect(ops).toEqual(['mkdir', 'rename', 'mkdir', 'mkdir', 'rename']);
    // The fingerprint covers every existing inode the plan reads or writes, parents included.
    const fx = buildFxAgt();
    const inos = new Set(r.value.result.expectedVersions.map((e) => e.ino));
    for (const p of [A.home, `${A.home}/todo.txt`, `${A.home}/tmp`, `${A.home}/tmp/cache.tmp`])
      expect(inos.has(fx.tree.inoOf(p) ?? '')).toBe(true);
  });

  it('AGT-05 a change between dry run and commit returns EAGAIN stale-plan and nothing changes', async () => {
    const grants = new GrantTable(await generateTokenKey());
    const r = await submitPlan(
      validate(
        [{ id: 's1', op: 'mkdir', args: { path: '~/fresh' }, span: 'make fresh' }],
        'make fresh',
      ),
      planId,
      42,
      grants,
    );
    expect(r.ok && r.value.result.token).toBeDefined();
    if (!r.ok || r.value.result.token === undefined) return;
    const res = await authorizeBatch(
      {
        pid: 42,
        callerClass: 'agent',
        ops: r.value.result.dryRun.ops,
        token: r.value.result.token,
        planId,
        pairs: r.value.dryRun.grant,
        home: A.home,
        affectedInodes: r.value.dryRun.affectedInodes,
        exists: () => false,
        versionOf: () => 999,
      },
      grants,
      FROZEN_NOW + 1,
    );
    expect(!res.ok && res.error).toMatchObject({ errno: 'EAGAIN', reason: 'stale-plan' });
  });
});
