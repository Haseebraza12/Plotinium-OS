/**
 * The per-owner feed inside vfsTxn, with the sequence numbers kept (offline-and-sync.md §3.8.2,
 * §3.10 step 8; database.md §3.15; SYN-05, SYN-17; INV-S3).
 *
 * vfsTxn already takes L1 (`users` rows of the actor and every affected owner, FOR UPDATE in uid
 * order) and then writes one `feed(owner_uid, owner_seq, op_id)` row per affected owner under
 * those row locks, which is what makes each owner's feed gap-free and commit-ordered. Its
 * `writeFeed` step does not return the numbers, but `op.result.ownerSeqs`, the broadcaster and the
 * stored tombstone need them. `capturingSteps` decorates the TxSteps of ONE op:
 *
 *   writeFeed    -> the same statement with RETURNING owner_uid, owner_seq, committed_at
 *   finishOpLog  -> merges {ownerSeqs, commitTime, lamport} into op_log.result, so a duplicate
 *                   (possibly years later) returns exactly what the first reply carried
 *
 * Nothing else changes: L0 dedup, the lock order, retries and rejection recording stay vfsTxn's.
 */
import { sql, type Transaction } from 'kysely';

import type { FeedCursor } from '@plotinium/protocol';

import type { DB } from '../../db/types.gen.ts';
import type { TxSteps } from '../../vfs/tx.ts';
import type { BodyResult, Uid } from '../../vfs/types.ts';

export interface FeedWrite {
  /** One cursor per affected owner, ascending uid. */
  readonly cursors: readonly FeedCursor[];
  /** The transaction's timestamp (`now()`), the op's commit time for clients (§3.5). */
  readonly committedAt: number;
}

/** The feed statement with RETURNING (Kysely implementation: `kyselyFeedSql`). */
export interface FeedSql<Tx> {
  writeFeedReturning(tx: Tx, owners: readonly Uid[], opId: string): Promise<FeedWrite>;
}

export interface Captured extends FeedWrite {
  readonly lamport: number;
}

export interface CapturingSteps<Tx> {
  readonly steps: TxSteps<Tx>;
  /** The feed write of the attempt that committed (null before a successful finishOpLog). */
  captured(): Captured | null;
}

/** Decorates `base` for one op whose server Lamport value is `lamport`. */
export function capturingSteps<Tx>(
  base: TxSteps<Tx>,
  feed: FeedSql<Tx>,
  lamport: number,
): CapturingSteps<Tx> {
  let pending: FeedWrite | null = null;
  let done: Captured | null = null;
  const steps: TxSteps<Tx> = {
    begin: (fn) => base.begin(fn),
    setLocalTimeouts: (tx, t) => base.setLocalTimeouts(tx, t),
    backendPid: (tx) => base.backendPid(tx),
    insertOpLog: (tx, op) => base.insertOpLog(tx, op),
    readStoredOp: (tx, opId) => base.readStoredOp(tx, opId),
    lockUsers: (tx, owners) => base.lockUsers(tx, owners),
    renameLock: (tx) => base.renameLock(tx),
    lockInodes: (tx, inos) => base.lockInodes(tx, inos),
    armFault: (tx, fault) => base.armFault(tx, fault),
    recordRejection: (op, err) => base.recordRejection(op, err),
    async writeFeed(tx, owners, opId) {
      pending = await feed.writeFeedReturning(tx, owners, opId);
    },
    async finishOpLog(tx, opId, r: BodyResult<unknown>) {
      const w = pending ?? { cursors: [], committedAt: Date.now() };
      const extra = {
        ownerSeqs: w.cursors,
        commitTime: new Date(w.committedAt).toISOString(),
        lamport,
      };
      const result =
        typeof r.result === 'object' && r.result !== null && !Array.isArray(r.result)
          ? { ...(r.result as Record<string, unknown>), ...extra }
          : extra;
      await base.finishOpLog(tx, opId, { ...r, result });
      done = { ...w, lamport };
    },
  };
  return { steps, captured: () => done };
}

interface FeedRow {
  owner_uid: number;
  owner_seq: number | string;
  committed_at: Date | string;
}

const toMs = (t: Date | string): number => (t instanceof Date ? t.getTime() : Date.parse(t));

/** database.md §3.15, with RETURNING. The users rows are already locked at L1 by vfsTxn. */
export const kyselyFeedSql: FeedSql<Transaction<DB>> = {
  async writeFeedReturning(tx, owners, opId) {
    if (owners.length === 0) {
      const t = await sql<{ now: Date | string }>`SELECT now() AS now`.execute(tx);
      const now = t.rows[0]?.now;
      return { cursors: [], committedAt: now === undefined ? Date.now() : toMs(now) };
    }
    const r = await sql<FeedRow>`
      WITH o AS (UPDATE users SET feed_seq = feed_seq + 1 WHERE uid = ANY(${[...owners]}::int[])
                 RETURNING uid, feed_seq),
           f AS (INSERT INTO feed (owner_uid, owner_seq, op_id) SELECT uid, feed_seq, ${opId} FROM o
                 RETURNING owner_uid, owner_seq, committed_at)
      SELECT owner_uid, owner_seq, committed_at FROM f ORDER BY owner_uid`.execute(tx);
    const first = r.rows[0];
    return {
      cursors: r.rows.map((row) => ({ ownerUid: row.owner_uid, seq: Number(row.owner_seq) })),
      committedAt: first === undefined ? Date.now() : toMs(first.committed_at),
    };
  },
};
