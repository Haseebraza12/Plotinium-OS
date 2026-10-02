/**
 * The two ops that change no inode (offline-and-sync.md §4.2; window-manager.md session layout;
 * syscall-abi.md §3.7 audit; AGT-08). They still run through vfsTxn for L0 idempotency and the
 * op_log outcome, but lock no inode and write no feed row.
 *
 *   session.layout   the OS session's window layout, last writer wins by `rev` (an older rev is
 *                    applied as a no-op so a resend never regresses the layout); only the OS
 *                    session's owner may write it
 *   audit.append     kernel audit records mirrored into audit_log (INSERT only). Every record must
 *                    name the op's OS session and the op's principal or login uid (EACCES
 *                    otherwise): a client cannot write audit rows for someone else.
 */
import { sql } from 'kysely';

import type { OpSubmit } from '@plotinium/protocol';

import type { StoredResult } from '../../engine/sync/outcome.ts';
import type { OpHandler } from '../tx.ts';
import { VfsError, type BodyResult, type LockPlan, type Locked, type OpContext } from '../types.ts';
import type { Tx } from './common.ts';

type LayoutOp = Extract<OpSubmit['op'], { kind: 'session.layout' }>;
type AuditOp = Extract<OpSubmit['op'], { kind: 'audit.append' }>;

const EMPTY_PLAN: LockPlan = {
  owners: [],
  renameLock: false,
  dirs: [],
  files: [],
  subtreeRoots: [],
};

function applied(): BodyResult<StoredResult> {
  return { status: 'applied', result: {}, effects: { changes: [], dirs: [] }, owners: [] };
}

export class SessionLayoutHandler implements OpHandler<Tx, StoredResult> {
  readonly #op: LayoutOp;
  #ctx: OpContext | null = null;

  constructor(op: LayoutOp) {
    this.#op = op;
  }

  plan(): Promise<LockPlan> {
    return Promise.resolve(EMPTY_PLAN);
  }

  recheck(_tx: Tx, op: OpContext): Promise<void> {
    this.#ctx = op;
    return Promise.resolve();
  }

  async body(tx: Tx, _locked: Locked): Promise<BodyResult<StoredResult>> {
    const ctx = this.#ctx;
    if (ctx === null) throw new VfsError('EIO', { reason: 'server' });
    const r = await sql<{ owner_uid: number }>`
      SELECT owner_uid FROM os_sessions WHERE os_session_id = ${ctx.osSessionId}::uuid FOR UPDATE`.execute(
      tx,
    );
    const owner = r.rows[0]?.owner_uid;
    if (owner === undefined) throw new VfsError('ENOENT', { reason: 'os-session' });
    if (owner !== ctx.principal.realUid) throw new VfsError('EACCES', { reason: 'principal' });
    await sql`
      UPDATE os_sessions SET window_layout = ${JSON.stringify(this.#op.layout)}::jsonb,
                             layout_rev = ${this.#op.rev}, updated_at = now()
      WHERE os_session_id = ${ctx.osSessionId}::uuid AND layout_rev <= ${this.#op.rev}`.execute(tx);
    return applied();
  }
}

export class AuditAppendHandler implements OpHandler<Tx, StoredResult> {
  readonly #op: AuditOp;
  #ctx: OpContext | null = null;

  constructor(op: AuditOp) {
    this.#op = op;
  }

  plan(): Promise<LockPlan> {
    return Promise.resolve(EMPTY_PLAN);
  }

  recheck(_tx: Tx, op: OpContext): Promise<void> {
    for (const rec of this.#op.records) {
      if (rec.osSessionId !== op.osSessionId)
        throw new VfsError('EACCES', { reason: 'principal', field: 'osSessionId' });
      if (rec.uid !== op.principal.uid && rec.uid !== op.principal.realUid)
        throw new VfsError('EACCES', { reason: 'principal', field: 'uid' });
      if (rec.actor === 'agent' && rec.promptId === undefined)
        throw new VfsError('EINVAL', { reason: 'schema', field: 'promptId' });
    }
    this.#ctx = op;
    return Promise.resolve();
  }

  async body(tx: Tx, _locked: Locked): Promise<BodyResult<StoredResult>> {
    const ctx = this.#ctx;
    if (ctx === null) throw new VfsError('EIO', { reason: 'server' });
    const rows = this.#op.records.map((r) => {
      const {
        auditId,
        t,
        osSessionId,
        pid,
        uid,
        ruid,
        actor,
        call,
        argsDigest,
        argsSummary,
        outcome,
        errno,
        promptId,
        planHash,
        txnId,
        opId,
        ...rest
      } = r;
      return JSON.stringify({
        ts: new Date(t).toISOString(),
        uid,
        real_uid: ruid ?? ctx.principal.realUid,
        actor,
        os_session_id: osSessionId,
        pid,
        syscall: call,
        args: { digest: argsDigest, summary: argsSummary },
        errno: errno ?? null,
        outcome,
        prompt_id: promptId ?? null,
        plan_hash: planHash ?? null,
        op_id: opId ?? null,
        txn_id: txnId ?? null,
        detail: { auditId, ...rest },
      });
    });
    await sql`
      INSERT INTO audit_log (ts, uid, real_uid, actor, os_session_id, pid, syscall, args, errno,
                             outcome, prompt_id, plan_hash, op_id, txn_id, detail)
      SELECT (r->>'ts')::timestamptz, (r->>'uid')::int, (r->>'real_uid')::int, r->>'actor',
             (r->>'os_session_id')::uuid, (r->>'pid')::int, r->>'syscall', r->'args', r->>'errno',
             r->>'outcome', (r->>'prompt_id')::uuid, decode(r->>'plan_hash', 'hex'),
             (r->>'op_id')::uuid, (r->>'txn_id')::uuid, r->'detail'
      FROM unnest(${rows}::jsonb[]) AS r`.execute(tx);
    return applied();
  }
}
