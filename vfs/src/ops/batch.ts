/**
 * `batch` (virtual-file-system.md §3.12.5, §3.12.7; AGT-03, AGT-05): ops applied sequentially on one
 * copy-on-write overlay (op i sees ops 0..i−1, so `a→b, b→c` is legal); the first failure fails the
 * whole batch with its `index` and nothing is written; one transaction and ONE outbox op of kind
 * `batch` whose base is the fingerprint. A dry run reports creates, deletes, overwrites (reported,
 * never rejected: the agent's confirmation predicate decides), mode and owner changes, moves, the
 * distinct inodes touched and the byte delta per owner.
 */
import { sha256Hex } from '@plotinium/protocol';
import type { BatchOp, ExpectedVersion } from '@plotinium/protocol';

import { contentOfText } from '../content.ts';
import { VfsError, fail } from '../errors.ts';
import { VFS_BATCH_MAX_OPS } from '../limits.ts';
import { fromModeChange } from '../perm.ts';
import { fastFail } from '../quota/quota.ts';
import type { Uuid } from '../store/records.ts';
import { planChmod, planChown, planUtimes } from './attr.ts';
import { planCopy } from './copy.ts';
import { planMkdir, planSymlink } from './create.ts';
import type { Plan, PlanBuilder } from './plan.ts';
import { planRename } from './rename.ts';
import { planUnlink } from './unlink.ts';
import { planWriteFile } from './write.ts';

export interface DryRun {
  readonly fingerprint: string;
  readonly expectedVersions: ExpectedVersion[];
  readonly creates: readonly string[];
  readonly deletes: readonly string[];
  readonly overwrites: readonly string[];
  readonly chmods: readonly { path: string; from: number; to: number }[];
  readonly chowns: readonly { path: string; uid: number; gid: number }[];
  readonly moves: readonly { from: string; to: string }[];
  /** Distinct inodes created, changed or deleted: the AGT-03 "more than 20" input. */
  readonly touchedInodes: number;
  readonly bytesDelta: Readonly<Record<number, number>>;
  readonly quotaOk: boolean;
}

function runOp(b: PlanBuilder, op: BatchOp): void {
  switch (op.op) {
    case 'mkdir':
      planMkdir(b, op.path, op.mode, op.parents === true);
      return;
    case 'write':
      planWriteFile(b, op.path, contentOfText(op.text, b.ctx.now), {
        ...(op.expectedVersion === undefined ? {} : { expectedVersion: op.expectedVersion }),
      });
      return;
    case 'rename':
      planRename(b, op.from, op.to, op.noReplace === true);
      return;
    case 'copy':
      planCopy(b, op.from, op.to, { recursive: op.recursive === true });
      return;
    case 'unlink':
      planUnlink(b, op.path, op.recursive === true);
      return;
    case 'symlink':
      planSymlink(b, op.target, op.path);
      return;
    case 'chmod': {
      const spec = fromModeChange(op.mode);
      if (spec === 'EINVAL') fail('EINVAL');
      planChmod(b, op.path, spec, op.recursive === true);
      return;
    }
    case 'chown':
      planChown(b, op.path, {
        ...(op.uid === undefined ? {} : { uid: op.uid }),
        ...(op.gid === undefined ? {} : { gid: op.gid }),
        recursive: op.recursive === true,
      });
      return;
    case 'utimes':
      planUtimes(b, op.path, { mtime: op.mtime });
      return;
  }
}

/** SHA-256 over the sorted `ino:version` lines of the committed inodes a plan changes. */
export function fingerprintOf(versions: ReadonlyMap<Uuid, number>): string {
  const lines = [...versions]
    .sort((a, c) => (a[0] < c[0] ? -1 : a[0] > c[0] ? 1 : 0))
    .map(([ino, v]) => `${ino}:${v}\n`);
  return sha256Hex(lines.join(''));
}

export interface BatchPlan {
  readonly plan: Plan;
  readonly dryRun: DryRun;
}

/**
 * Plan a batch. With `expectedVersions` (from the dry run), any committed inode whose version moved
 * gives EAGAIN `stale-plan` and nothing changes (§3.12.7).
 */
export function planBatch(
  b: PlanBuilder,
  ops: readonly BatchOp[],
  expectedVersions?: readonly ExpectedVersion[],
): BatchPlan {
  if (ops.length === 0 || ops.length > VFS_BATCH_MAX_OPS) fail('EINVAL');
  b.setBatch(undefined);
  for (const ev of expectedVersions ?? []) {
    if (b.base.inode(ev.ino)?.version !== ev.version) fail('EAGAIN', 'stale-plan');
  }
  ops.forEach((op, i) => {
    try {
      runOp(b, op);
    } catch (e) {
      throw e instanceof VfsError ? e.withIndex(i) : e;
    }
  });
  const draft = b.build('batch', 'batch');
  const fingerprint = fingerprintOf(draft.baseVersions);
  if (expectedVersions !== undefined) {
    const expected = new Map(expectedVersions.map((e) => [e.ino, e.version]));
    for (const [ino, v] of draft.baseVersions)
      if (expected.get(ino) !== v) fail('EAGAIN', 'stale-plan');
  }
  b.setBatch(fingerprint);
  const plan = b.build('batch', 'batch');
  const bytesDelta: Record<number, number> = {};
  for (const q of plan.quota) bytesDelta[q.uid] = q.dBytes;
  const touched = new Set<Uuid>(plan.created.inodes);
  for (const w of plan.writes)
    if (w.store === 'inodes') touched.add(w.op === 'del' ? w.key : w.value.ino);
  const dryRun: DryRun = {
    fingerprint,
    expectedVersions: [...plan.baseVersions].map(([ino, version]) => ({ ino, version })),
    creates: plan.notes.creates,
    deletes: plan.notes.deletes,
    overwrites: plan.notes.overwrites,
    chmods: plan.notes.chmods,
    chowns: plan.notes.chowns,
    moves: plan.notes.moves,
    touchedInodes: touched.size,
    bytesDelta,
    quotaOk: !fastFail((uid) => b.base.user(uid), plan.quota),
  };
  return { plan, dryRun };
}
