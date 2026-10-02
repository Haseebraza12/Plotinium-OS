/**
 * From a plan to the records of its transaction (virtual-file-system.md §3.11 phase 1 steps 6–7,
 * §3.14.1): the outbox op and the undo record share the op's id and are written in the same
 * transaction as the change (coupling invariant I10). tmpfs-only plans get neither (§3.3.4).
 */
import type { Errno } from '@plotinium/protocol';

import { fastFail, tmpfsExceeds } from '../quota/quota.ts';
import type { OutboxRec, TmpfsUsage, UndoRec, UserRec, Uuid } from '../store/records.ts';
import type { Plan } from './plan.ts';

export interface CommitMeta {
  readonly opId: Uuid;
  readonly osSessionId: Uuid;
  /** Effective uid of the calling process. */
  readonly principal: number;
  readonly now: number;
  /** A process is BLOCKED on the op's result (bulk calls while syncd is LIVE, PVFS-05). */
  readonly awaitSync: boolean;
  /** The lease fence when the writer holds X (§3.16.3). */
  readonly fence?: number;
  /** Agent batches keep their undo record after the ack for `ai undo` (AGT-10). */
  readonly keepAfterAck?: boolean;
}

/** The outbox record before the transaction allocates `cseq` and `lamport` (§3.14.1). */
export type OutboxDraft = Omit<OutboxRec, 'cseq' | 'lamport' | 'seq'>;

export interface Commit {
  readonly plan: Plan;
  readonly outbox: OutboxDraft | null;
  readonly undo: UndoRec | null;
}

export function prepareCommit(plan: Plan, meta: CommitMeta): Commit {
  if (!plan.synced || plan.wire === null) return { plan, outbox: null, undo: null };
  const outbox: OutboxDraft = {
    opId: meta.opId,
    principal: meta.principal,
    osSessionId: meta.osSessionId,
    call: plan.call,
    op: plan.wire.op,
    base: plan.wire.base,
    blobs: [...plan.wire.blobs],
    touches: [...plan.touches],
    ...(meta.fence === undefined ? {} : { fence: meta.fence }),
    awaitSync: meta.awaitSync,
    state: 'pending',
    attempts: 0,
    createdAt: meta.now,
  };
  const undo: UndoRec = {
    opId: meta.opId,
    state: 'open',
    pre: { inodes: [...plan.pre.inodes], dentries: [...plan.pre.dentries] },
    created: {
      inodes: [...plan.created.inodes],
      dentries: plan.created.dentries.map(([p, n]) => [p, n]),
    },
    users: plan.quota.map((q) => ({ uid: q.uid, dBytes: q.dBytes, dInodes: q.dInodes })),
    pins: [...plan.pins],
    keepAfterAck: meta.keepAfterAck === true,
    summary: plan.label,
    createdAt: meta.now,
  };
  return { plan, outbox, undo };
}

/** Phase-1 fast fail (§3.8 step 1, §3.3.4): EDQUOT before any transaction opens. */
export function quotaCheck(
  plan: Plan,
  user: (uid: number) => UserRec | undefined,
  tmpfs: TmpfsUsage,
): Errno | null {
  if (fastFail(user, plan.quota)) return 'EDQUOT';
  if (tmpfsExceeds(tmpfs, plan.tmpfs)) return 'EDQUOT';
  return null;
}

/** Bulk calls wait for the server's result while syncd is LIVE (§3.11 phase 3, PVFS-05). */
export function isBulk(plan: Plan): boolean {
  if (plan.call === 'rename' || plan.call === 'batch') return true;
  const op = plan.wire?.op;
  return op !== undefined && 'recursive' in op && op.recursive;
}
