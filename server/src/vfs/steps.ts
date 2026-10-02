/**
 * The Kysely implementation of TxSteps: the SQL of vfsTxn (database.md §4.8, §4.11, §4.12).
 * Every statement is a typed `sql` template with bind parameters; nothing is concatenated.
 * Primary owner R2, secondary reviewer R5. Covered by the DB-gated tests in vfs/steps.test.ts.
 */
import { sql, type Kysely, type Transaction } from 'kysely';

import { isErrno } from '../errno.ts';
import type { DB } from '../db/types.gen.ts';
import type { TxSteps } from './tx.ts';
import type { ArmedFault, BodyResult, InodeRow, OpContext, StoredOp, VfsError } from './types.ts';

type Tx = Transaction<DB>;

interface StoredRow {
  uid: number;
  status: string;
  errno: string | null;
  result: unknown;
}

function toStored(row: StoredRow | undefined): StoredOp | null {
  // 'pending' never commits (probe P9); treat it like a missing row.
  if (row === undefined || row.status === 'pending') return null;
  return {
    uid: row.uid,
    status: row.status as StoredOp['status'],
    errno: isErrno(row.errno) ? row.errno : null,
    result: row.result,
  };
}

export function kyselySteps(db: Kysely<DB>): TxSteps<Tx> {
  return {
    begin(fn) {
      return db.transaction().setIsolationLevel('read committed').execute(fn);
    },

    async setLocalTimeouts(tx, t) {
      await sql`SELECT set_config('lock_timeout', ${`${t.lockTimeoutMs}ms`}, true),
                       set_config('statement_timeout', ${`${t.statementTimeoutMs}ms`}, true)`.execute(
        tx,
      );
    },

    async backendPid(tx) {
      const r = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
      const pid = r.rows[0]?.pid;
      if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
      return pid;
    },

    async insertOpLog(tx, op: OpContext) {
      const r = await sql<{ op_id: string }>`
        INSERT INTO op_log (op_id, uid, os_session_id, cseq, lamport, call, args, base, client_ts)
        VALUES (${op.opId}, ${op.principal.uid}, ${op.osSessionId}, ${op.cseq}, ${op.lamport}, ${op.call},
                ${JSON.stringify(op.args ?? null)}::jsonb, ${JSON.stringify(op.base ?? null)}::jsonb,
                ${op.clientTs ?? null})
        ON CONFLICT (op_id) DO NOTHING
        RETURNING op_id`.execute(tx);
      return r.rows.length === 1;
    },

    async readStoredOp(tx, opId) {
      const r = await sql<StoredRow>`
        SELECT uid, status, errno, result FROM op_log WHERE op_id = ${opId}`.execute(tx);
      return toStored(r.rows[0]);
    },

    async lockUsers(tx, owners) {
      await sql`SELECT uid FROM users WHERE uid = ANY(${[...owners]}::int[]) ORDER BY uid FOR UPDATE`.execute(
        tx,
      );
    },

    async renameLock(tx) {
      await sql`SELECT pg_advisory_xact_lock(plt_rename_lock_key())`.execute(tx);
    },

    async lockInodes(tx, inos) {
      const r = await sql<InodeRow>`
        SELECT ino, type, mode, uid, gid, version, lock_fence
        FROM inodes WHERE ino = ANY(${[...inos]}::uuid[])
        ORDER BY ino FOR UPDATE`.execute(tx);
      return r.rows;
    },

    async armFault(tx, fault: ArmedFault) {
      await sql`SELECT set_config('plotinium.fault_on', ${fault.on}, true),
                       set_config('plotinium.fault_after', ${String(fault.after)}, true)`.execute(
        tx,
      );
    },

    async writeFeed(tx, owners, opId) {
      if (owners.length === 0) return;
      await sql`
        WITH o AS (UPDATE users SET feed_seq = feed_seq + 1 WHERE uid = ANY(${[...owners]}::int[])
                   RETURNING uid, feed_seq)
        INSERT INTO feed (owner_uid, owner_seq, op_id) SELECT uid, feed_seq, ${opId} FROM o`.execute(
        tx,
      );
    },

    async finishOpLog(tx, opId, r: BodyResult<unknown>) {
      await sql`
        UPDATE op_log SET status = ${r.status}, errno = ${r.errno ?? null},
                          result = ${JSON.stringify(r.result ?? null)}::jsonb,
                          effects = ${JSON.stringify(r.effects ?? null)}::jsonb,
                          applied_at = now()
        WHERE op_id = ${opId}`.execute(tx);
    },

    async recordRejection(op, err: VfsError) {
      const result = { errno: err.errno, ...err.detail };
      const inserted = await sql<{ op_id: string }>`
        INSERT INTO op_log (op_id, uid, os_session_id, cseq, lamport, call, args, base, client_ts,
                            status, errno, result)
        VALUES (${op.opId}, ${op.principal.uid}, ${op.osSessionId}, ${op.cseq}, ${op.lamport}, ${op.call},
                ${JSON.stringify(op.args ?? null)}::jsonb, ${JSON.stringify(op.base ?? null)}::jsonb,
                ${op.clientTs ?? null}, 'rejected', ${err.errno}, ${JSON.stringify(result)}::jsonb)
        ON CONFLICT (op_id) DO NOTHING
        RETURNING op_id`.execute(db);
      if (inserted.rows.length === 1) return null;
      const r = await sql<StoredRow>`
        SELECT uid, status, errno, result FROM op_log WHERE op_id = ${op.opId}`.execute(db);
      return toStored(r.rows[0]);
    },
  };
}
