/**
 * vfsTxn(): the ONLY function that opens a mutating VFS transaction on the server.
 *
 * Spec: specs/09-database/database.md §3.6-§3.9, §4.8 (normative sketch); §11.3 rules 1, 2, 4, 6, 7;
 * DB-02, DB-03, OFF-02, AGT-05, AGT-09; DBD-03, DBD-07, DBD-14. Primary owner R2, reviewer R5.
 *
 * Per attempt (READ COMMITTED, a fresh transaction each time):
 *   SET LOCAL lock_timeout / statement_timeout; bind the backend pid in the cancel registry
 *   L0  INSERT op_log ... ON CONFLICT DO NOTHING  (0 rows: a duplicate, return the stored result)
 *       plan (lock-free reads)
 *   L1  users FOR UPDATE, ascending uid (actor + affected owners)
 *   L2  pg_advisory_xact_lock(plt_rename_lock_key())  only when a directory changes parent
 *   L3  directory inodes FOR UPDATE, ascending ino;  L4 file inodes FOR UPDATE, ascending ino
 *       re-plan until stable: new directories are locked; a new owner restarts with a larger L1
 *       re-check (permissions, leases, fences, base or fingerprint)
 *       harness only: arm the fault GUCs, immediately before the op's statements
 *       body (set-based statements), feed rows per affected owner, op_log status and result
 *   COMMIT, then publish (broadcasts, lock and indexer notifications) - never before COMMIT.
 * Retries: 40001, 40P01, 55P03 and LockSetChanged, 5 attempts, full jitter (retry.ts).
 * Failure: one errno (toErrno); deterministic rejections are recorded in op_log AFTER the
 * rollback in an autocommit statement, so a resend reproduces them (§3.9.3).
 *
 * The SQL lives behind the TxSteps interface (steps.ts has the Kysely implementation), so this
 * control flow is unit-tested with a fake executor and the SQL against real PostgreSQL.
 */
import { isDeterministic, toErrno } from '../db/errors.ts';
import type { CancelRegistry } from './cancel.ts';
import { runWithRetries, type RetryInfo } from './retry.ts';
import {
  LockSetChanged,
  VfsError,
  type ArmedFault,
  type BodyResult,
  type Ino,
  type InodeRow,
  type LockPlan,
  type Locked,
  type OpContext,
  type StoredOp,
  type TxOutcome,
  type Uid,
} from './types.ts';

/** The SQL primitives vfsTxn needs. `Tx` is the transaction handle (Kysely Transaction<DB>). */
export interface TxSteps<Tx> {
  /** Runs `fn` in a READ COMMITTED transaction; commits when it resolves, rolls back when it throws. */
  begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  setLocalTimeouts(tx: Tx, t: { lockTimeoutMs: number; statementTimeoutMs: number }): Promise<void>;
  backendPid(tx: Tx): Promise<number>;
  /** L0. True when the op_log row was inserted (a fresh op), false for a duplicate. */
  insertOpLog(tx: Tx, op: OpContext): Promise<boolean>;
  readStoredOp(tx: Tx, opId: string): Promise<StoredOp | null>;
  /** L1: `SELECT uid FROM users WHERE uid = ANY($1) ORDER BY uid FOR UPDATE` (owners sorted). */
  lockUsers(tx: Tx, owners: readonly Uid[]): Promise<void>;
  /** L2: the rename advisory lock. */
  renameLock(tx: Tx): Promise<void>;
  /** L3/L4: `SELECT ... FROM inodes WHERE ino = ANY($1) ORDER BY ino FOR UPDATE` (inos sorted). */
  lockInodes(tx: Tx, inos: readonly Ino[]): Promise<readonly InodeRow[]>;
  /** Harness only (§3.14): SET LOCAL plotinium.fault_on / fault_after. */
  armFault(tx: Tx, fault: ArmedFault): Promise<void>;
  /** One feed row per owner, gap-free under the L1 locks (§3.15). */
  writeFeed(tx: Tx, owners: readonly Uid[], opId: string): Promise<void>;
  finishOpLog(tx: Tx, opId: string, r: BodyResult<unknown>): Promise<void>;
  /**
   * After the rollback, in an autocommit statement: INSERT ... 'rejected' ... ON CONFLICT DO
   * NOTHING. Returns null when inserted, or the row that already existed (a concurrent attempt
   * of the same op committed first).
   */
  recordRejection(op: OpContext, err: VfsError): Promise<StoredOp | null>;
}

/** The op-specific parts, supplied by server/src/vfs/ops/*.ts. */
export interface OpHandler<Tx, R> {
  /** Lock-free planning. `extraOwners` are owners a previous attempt's re-plan found. */
  plan(tx: Tx, extraOwners: readonly Uid[]): Promise<LockPlan>;
  /**
   * Re-collects the subtree under the locks (rm -r, cp -r, chmod -R, chown -R). Returns every
   * directory the op must hold and every affected owner. Omitted for single-object ops.
   */
  replan?(tx: Tx, locked: Locked): Promise<{ dirs: readonly Ino[]; owners: readonly Uid[] }>;
  /** Permission re-check with vfs/perm.ts, leases, fences, base or fingerprint (§3.10-§3.13). */
  recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void>;
  /** The set-based statements. MUST NOT await anything but SQL on `tx`. */
  body(tx: Tx, locked: Locked): Promise<BodyResult<R>>;
}

export interface VfsTxnHooks<R> {
  /** After COMMIT only: op.result, vfs.changed, lock and indexer notifications (C9). */
  publishAfterCommit?(op: OpContext, outcome: TxOutcome<R>): void;
  /** After the rollback: agent plans write their plan row and outcome row (§3.22). */
  auditAfterRollback?(op: OpContext, err: VfsError): Promise<void>;
  onRetry?(op: OpContext, info: RetryInfo): void;
  /** recordRejection itself failed (for example the database went away after the rollback). */
  onRecordRejectionError?(op: OpContext, error: unknown): void;
}

export interface VfsTxnDeps<Tx> {
  readonly steps: TxSteps<Tx>;
  readonly cancel: CancelRegistry;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly maxAttempts?: number;
}

/** Upper bound of re-plan rounds; convergence is bounded by the subtree depth (§5.6). */
export const MAX_REPLAN_ROUNDS = 64;

const sortedUids = (xs: Iterable<Uid>): Uid[] => [...new Set(xs)].sort((a, b) => a - b);
const sortedInos = (xs: Iterable<Ino>): Ino[] => [...new Set(xs)].sort();

export async function vfsTxn<Tx, R>(
  deps: VfsTxnDeps<Tx>,
  op: OpContext,
  handler: OpHandler<Tx, R>,
  hooks: VfsTxnHooks<R> = {},
): Promise<TxOutcome<R>> {
  const { steps, cancel } = deps;
  let outcome: TxOutcome<R>;
  try {
    outcome = await runWithRetries(
      async (_attempt, extraOwners) => {
        try {
          return await steps.begin(async (tx): Promise<TxOutcome<R>> => {
            await steps.setLocalTimeouts(tx, {
              lockTimeoutMs: deps.lockTimeoutMs,
              statementTimeoutMs: deps.statementTimeoutMs,
            });
            cancel.bind(op.opId, await steps.backendPid(tx)); // AGT-09: pg_cancel_backend target

            // L0: idempotency (exactly once, OFF-02)
            if (!(await steps.insertOpLog(tx, op)))
              return duplicateOf(await steps.readStoredOp(tx, op.opId), op);

            const plan = await handler.plan(tx, extraOwners);
            const owners = sortedUids([op.principal.uid, ...plan.owners, ...extraOwners]);
            await steps.lockUsers(tx, owners); // L1
            if (plan.renameLock) await steps.renameLock(tx); // L2
            const locked = await lockAndReplan(steps, handler, tx, { ...plan, owners }, op.signal);
            await handler.recheck(tx, op, locked);

            if (op.fault !== undefined) await steps.armFault(tx, op.fault); // harness only (§3.14)
            op.signal.throwIfAborted();
            const r = await handler.body(tx, locked);
            op.signal.throwIfAborted();

            await steps.writeFeed(tx, sortedUids(r.owners), op.opId);
            await steps.finishOpLog(tx, op.opId, r);
            return { kind: r.status, ...r };
          });
        } finally {
          cancel.release(op.opId);
        }
      },
      {
        signal: op.signal,
        ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.random === undefined ? {} : { random: deps.random }),
        onRetry: (info) => hooks.onRetry?.(op, info),
      },
    );
  } catch (e) {
    const err = op.signal.aborted
      ? new VfsError('ECANCELED', { reason: 'killed' })
      : toErrno(e, { cancelled: cancel.wasCancelled(op.opId) });
    cancel.release(op.opId, true);
    if (err.detail['collision'] !== true && isDeterministic(err)) {
      let existing: StoredOp | null = null;
      try {
        existing = await steps.recordRejection(op, err);
      } catch (recordError) {
        // Never mask the op's own errno; a failed record only means a resend re-executes.
        hooks.onRecordRejectionError?.(op, recordError);
      }
      // A concurrent attempt of the SAME op committed first: reply with its stored outcome.
      if (existing !== null && existing.uid === op.principal.uid) {
        return {
          kind: 'duplicate',
          status: existing.status,
          errno: existing.errno,
          result: existing.result,
        };
      }
    }
    await hooks.auditAfterRollback?.(op, err);
    throw err;
  }
  cancel.release(op.opId, true);
  if (outcome.kind !== 'duplicate') hooks.publishAfterCommit?.(op, outcome);
  return outcome;
}

function duplicateOf<R>(stored: StoredOp | null, op: OpContext): TxOutcome<R> {
  if (stored === null) {
    // The row vanished between L0 and the read: impossible (op_log rows are never deleted).
    throw new VfsError('EIO', { reason: 'server' });
  }
  if (stored.uid !== op.principal.uid) {
    // An op id owned by another uid: never reveal its stored result (database.md §3.9.3).
    throw new VfsError('EINVAL', { collision: true });
  }
  return { kind: 'duplicate', status: stored.status, errno: stored.errno, result: stored.result };
}

/** L3 then L4 in ino order, then re-plan until the locked set is stable (§3.8, §5.6). */
async function lockAndReplan<Tx, R>(
  steps: TxSteps<Tx>,
  handler: OpHandler<Tx, R>,
  tx: Tx,
  plan: LockPlan,
  signal: AbortSignal,
): Promise<Locked> {
  const rows = new Map<Ino, InodeRow>();
  const lockedDirs = new Set<Ino>();
  const take = async (inos: readonly Ino[]): Promise<void> => {
    const todo = sortedInos(inos.filter((i) => !rows.has(i)));
    if (todo.length === 0) return;
    for (const row of await steps.lockInodes(tx, todo)) rows.set(row.ino, row);
  };
  await take(plan.dirs); // L3
  for (const d of plan.dirs) lockedDirs.add(d);
  await take(plan.files); // L4
  let locked: Locked = { plan, rows };
  if (handler.replan === undefined) return locked;

  const owners = new Set(plan.owners);
  for (let round = 0; round < MAX_REPLAN_ROUNDS; round++) {
    signal.throwIfAborted();
    const again = await handler.replan(tx, locked);
    const newOwners = again.owners.filter((o) => !owners.has(o));
    if (newOwners.length > 0) throw new LockSetChanged(sortedUids([...owners, ...newOwners]));
    const newDirs = again.dirs.filter((d) => !lockedDirs.has(d));
    if (newDirs.length === 0) return locked;
    await take(newDirs);
    for (const d of newDirs) lockedDirs.add(d);
    locked = { plan: { ...plan, dirs: [...lockedDirs] }, rows };
  }
  throw new VfsError('EAGAIN', { reason: 'retry-exhausted', cause: 'replan' });
}
