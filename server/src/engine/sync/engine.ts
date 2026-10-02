/**
 * The server op pipeline (offline-and-sync.md §3.10 steps 1-8, §3.11; database.md §3.8-§3.9, §3.15;
 * OFF-02, VFS-10, SYN-04, SYN-11; INV-S2, INV-S11).
 *
 *   0  Valibot schema of the frame                          (router.ts, before the lane)
 *   1  osSessionId belongs to the authenticated uid         else ProtocolViolation -> close 1008
 *   2  principal = login uid or a live su grant             else retry EACCES principal (not persisted)
 *   3-5 vfsTxn: L0 op_log ON CONFLICT DO NOTHING (a duplicate returns the stored outcome),
 *      L1 users FOR UPDATE in uid order, L2 rename lock, L3/L4 inodes in ino order, re-check
 *      (permissions, leases and fences, base versions), body, one feed row per affected owner
 *   6  deterministic failure: recorded in op_log after the rollback, BEFORE the reply -> rejected
 *   7  transient failure: nothing persisted -> retry with retryAfterMs
 *   8  after COMMIT only: op.result, renew the OS session's leases, hand the entry to the broadcaster
 *
 * The op-specific statements come from `handlerFor(submit)` (content writes: ContentWriteHandler;
 * structural ops: the vfs/ops handlers wrapped in withBaseCheck). An op kind without a handler
 * gets `retry ENOSYS not-implemented` (60 s), so the client keeps it instead of losing it.
 */
import type { OpResult, OpSubmit, FeedCursor } from '@plotinium/protocol';

import type { CancelRegistry } from '../../vfs/cancel.ts';
import { vfsTxn, type OpHandler, type TxSteps } from '../../vfs/tx.ts';
import {
  VfsError,
  type ArmedFault,
  type OpContext,
  type TxOutcome,
  type VfsCall,
} from '../../vfs/types.ts';
import type { Effects } from './content-write.ts';
import { capturingSteps, type FeedSql } from './feed-steps.ts';
import {
  asVfsError,
  LamportClock,
  resultFromError,
  resultFromOutcome,
  retry,
  type StoredResult,
} from './outcome.ts';
import type { InvalidOp } from './router.ts';

/** Who submitted the op, as the server derived it from the cookie session (never from a frame). */
export interface OpOrigin {
  /** The connection the op arrived on; null for POST /api/ops/{opId}. */
  readonly connId: string | null;
  /** Login uid of the auth session. */
  readonly uid: number;
  /** deviceId from the connection's hello (null over HTTP). */
  readonly deviceId: string | null;
  /** True for the login uid and for a uid with a live `su` grant on this auth session (§3.8.6). */
  mayActAs(principal: number): boolean;
  /** Primary gid first, then supplementary groups of the principal (server-side lookup). */
  gidsOf(principal: number): readonly number[];
}

/** Step 1: the op's OS session must be registered to this uid (and device, when known). */
export interface OsSessionCheck {
  ownsOsSession(osSessionId: string, uid: number, deviceId: string | null): Promise<boolean>;
}

/** A committed op, handed to the broadcaster and the lease renewal after COMMIT. */
export interface CommittedOp {
  readonly opId: string;
  readonly originConnId: string | null;
  readonly osSessionId: string;
  readonly ownerSeqs: readonly FeedCursor[];
  readonly commitTime: string;
  readonly lamport: number;
  readonly effects: Effects;
}

/** Step 1 failed: a correct client never does this (close 1008, `bye policy`). */
export class ProtocolViolation extends Error {
  readonly closeCode = 1008;
  readonly byeReason = 'policy' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolViolation';
  }
}

export type HandlerFor<Tx> = (submit: OpSubmit) => OpHandler<Tx, StoredResult> | undefined;

export interface SyncEngineOptions<Tx> {
  readonly steps: TxSteps<Tx>;
  readonly cancel: CancelRegistry;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly feed: FeedSql<Tx>;
  readonly handlerFor: HandlerFor<Tx>;
  readonly sessions: OsSessionCheck;
  readonly lamport?: LamportClock;
  /** After COMMIT: broadcaster fan-out and renewal of the OS session's leases. */
  readonly onCommitted?: (c: CommittedOp) => void;
  /** Only under FAULT_INJECTION=1: the armed fault for this op, if any (database.md §3.14). */
  readonly faultFor?: (submit: OpSubmit) => ArmedFault | undefined;
  readonly onError?: (err: unknown, context: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly maxAttempts?: number;
}

/** The op_log `call` of an op kind; null for kinds vfsTxn's VfsCall does not list yet. */
export function callOf(op: OpSubmit['op']): VfsCall | null {
  switch (op.kind) {
    case 'create':
      return op.type === 'd' ? 'mkdir' : op.type === 'l' ? 'symlink' : 'create';
    case 'write':
    case 'unlink':
    case 'rename':
    case 'link':
    case 'copy':
    case 'chmod':
    case 'chown':
    case 'batch':
    case 'utimes':
    case 'audit.append':
    case 'session.layout':
      return op.kind;
  }
}

function toEffects(effects: unknown): Effects {
  if (typeof effects === 'object' && effects !== null) {
    const e = effects as Partial<Effects>;
    return {
      changes: Array.isArray(e.changes) ? e.changes : [],
      dirs: Array.isArray(e.dirs) ? e.dirs : [],
    };
  }
  return { changes: [], dirs: [] };
}

export class SyncEngine<Tx> {
  readonly lamport: LamportClock;
  readonly #o: SyncEngineOptions<Tx>;

  constructor(options: SyncEngineOptions<Tx>) {
    this.#o = options;
    this.lamport = options.lamport ?? new LamportClock();
  }

  /**
   * Applies one op (steps 1-8). Throws only ProtocolViolation; every other outcome is an op.result.
   * `signal` is the op's cancel signal (proc.signal on the control lane, AGT-09).
   */
  async applyOp(
    origin: OpOrigin,
    submit: OpSubmit,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<OpResult> {
    const o = this.#o;
    // Step 1: the OS session of the op belongs to the authenticated uid (and to this device).
    let owned: boolean;
    try {
      owned = await o.sessions.ownsOsSession(submit.osSessionId, origin.uid, origin.deviceId);
    } catch (err) {
      o.onError?.(err, 'os-session-check');
      return retry(submit.opId, 'EIO', 'server', this.lamport.value);
    }
    if (!owned)
      throw new ProtocolViolation(
        `osSessionId ${submit.osSessionId} is not a session of uid ${origin.uid}`,
      );

    // Step 2: the principal (§3.8.6). Held, never dropped: retry, not persisted.
    if (!origin.mayActAs(submit.principal)) {
      return retry(submit.opId, 'EACCES', 'principal', this.lamport.value);
    }

    const call = callOf(submit.op);
    const handler = call === null ? undefined : o.handlerFor(submit);
    if (call === null || handler === undefined) {
      return retry(submit.opId, 'ENOSYS', 'not-implemented', this.lamport.value);
    }

    const lamport = this.lamport.tick(submit.lamport);
    const fault = o.faultFor?.(submit);
    const ctx: OpContext = {
      opId: submit.opId,
      principal: {
        uid: submit.principal,
        realUid: origin.uid,
        gids: origin.gidsOf(submit.principal),
      },
      osSessionId: submit.osSessionId,
      cseq: submit.cseq,
      lamport: submit.lamport,
      call,
      args: submit.op,
      base:
        submit.base.kind === 'versions'
          ? { kind: 'versions', value: submit.base.entries }
          : { kind: 'digest', value: { rootIno: submit.base.rootIno, digest: submit.base.digest } },
      clientTs: submit.clientTime,
      signal,
      ...(fault === undefined ? {} : { fault }),
    };

    const cap = capturingSteps(o.steps, o.feed, lamport);
    let recordFailed = false;
    let outcome: TxOutcome<StoredResult>;
    try {
      outcome = await vfsTxn(
        {
          steps: cap.steps,
          cancel: o.cancel,
          lockTimeoutMs: o.lockTimeoutMs,
          statementTimeoutMs: o.statementTimeoutMs,
          ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
          ...(o.random === undefined ? {} : { random: o.random }),
          ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
        },
        ctx,
        handler,
        {
          publishAfterCommit: (_op, out) => {
            const c = cap.captured();
            if (out.kind === 'duplicate' || c === null) return;
            try {
              o.onCommitted?.({
                opId: submit.opId,
                originConnId: origin.connId,
                osSessionId: submit.osSessionId,
                ownerSeqs: c.cursors,
                commitTime: new Date(c.committedAt).toISOString(),
                lamport: c.lamport,
                effects: toEffects(out.effects),
              });
            } catch (err) {
              o.onError?.(err, 'publish');
            }
          },
          onRecordRejectionError: (_op, err) => {
            recordFailed = true;
            o.onError?.(err, 'record-rejection');
          },
        },
      );
    } catch (e) {
      if (!(e instanceof VfsError)) o.onError?.(e, 'apply');
      return resultFromError(submit.opId, asVfsError(e), this.lamport.value, {
        persisted: !recordFailed,
      });
    }
    if (outcome.kind !== 'duplicate') {
      // vfsTxn returns the body's result; the stored row also carries the feed numbers, the commit
      // time and the Lamport value (capturingSteps), and the first reply must say the same.
      const c = cap.captured();
      if (c !== null) {
        const extra = {
          ownerSeqs: c.cursors,
          commitTime: new Date(c.committedAt).toISOString(),
          lamport: c.lamport,
        };
        const body =
          typeof outcome.result === 'object' && outcome.result !== null ? outcome.result : {};
        return resultFromOutcome(
          submit.opId,
          { ...outcome, result: { ...body, ...extra } },
          lamport,
        );
      }
    }
    return resultFromOutcome(submit.opId, outcome, lamport);
  }

  /**
   * A queued op killed by proc.signal before it ran (§3.13.3): recorded as rejected ECANCELED
   * `killed` (persisted, so a resend never executes it), then answered.
   */
  rejectKilled(origin: OpOrigin, submit: OpSubmit): Promise<OpResult> {
    return this.#recordFinal(
      origin,
      {
        opId: submit.opId,
        osSessionId: submit.osSessionId,
        cseq: submit.cseq,
        lamport: submit.lamport,
        principal: submit.principal,
        clientTime: submit.clientTime,
        call: callOf(submit.op) ?? 'batch',
        args: submit.op,
      },
      new VfsError('ECANCELED', { reason: 'killed' }),
      false,
    );
  }

  /**
   * Step 0: a valid opId and slot with an invalid body is rejected EINVAL and persisted, so the
   * client reverts it instead of resending it forever (§3.10). Step 1 still applies.
   */
  rejectInvalid(origin: OpOrigin, op: InvalidOp): Promise<OpResult> {
    const known = op.kind === undefined ? null : KIND_CALLS.get(op.kind);
    return this.#recordFinal(
      origin,
      {
        opId: op.opId,
        osSessionId: op.osSessionId,
        cseq: op.cseq,
        lamport: op.lamport,
        principal: op.principal,
        clientTime: op.clientTime,
        call: known ?? 'batch',
        args: { kind: op.kind ?? null, invalid: true },
      },
      new VfsError('EINVAL', { reason: 'schema', issue: op.issue }),
      true,
    );
  }

  async #recordFinal(
    origin: OpOrigin,
    id: {
      opId: string;
      osSessionId: string;
      cseq: number;
      lamport: number;
      principal: number;
      clientTime: string | undefined;
      call: VfsCall;
      args: unknown;
    },
    err: VfsError,
    checkSession: boolean,
  ): Promise<OpResult> {
    const o = this.#o;
    if (checkSession) {
      let owned: boolean;
      try {
        owned = await o.sessions.ownsOsSession(id.osSessionId, origin.uid, origin.deviceId);
      } catch (e) {
        o.onError?.(e, 'os-session-check');
        return retry(id.opId, 'EIO', 'server', this.lamport.value);
      }
      if (!owned)
        throw new ProtocolViolation(
          `osSessionId ${id.osSessionId} is not a session of uid ${origin.uid}`,
        );
      if (!origin.mayActAs(id.principal))
        return retry(id.opId, 'EACCES', 'principal', this.lamport.value);
    }
    const ctx: OpContext = {
      opId: id.opId,
      principal: { uid: id.principal, realUid: origin.uid, gids: origin.gidsOf(id.principal) },
      osSessionId: id.osSessionId,
      cseq: id.cseq,
      lamport: id.lamport,
      call: id.call,
      args: id.args,
      ...(id.clientTime === undefined ? {} : { clientTs: id.clientTime }),
      signal: AbortSignal.abort(),
    };
    try {
      const existing = await o.steps.recordRejection(ctx, err);
      if (existing !== null) {
        if (existing.uid !== id.principal) {
          // An op id owned by another uid: never reveal its stored result (database.md §3.9.3).
          return resultFromError(
            id.opId,
            new VfsError('EINVAL', { reason: 'collision' }),
            this.lamport.value,
            { persisted: true },
          );
        }
        return resultFromOutcome(
          id.opId,
          {
            kind: 'duplicate',
            status: existing.status,
            errno: existing.errno,
            result: existing.result,
          },
          this.lamport.value,
        );
      }
    } catch (e) {
      o.onError?.(e, 'record-final');
      return retry(id.opId, 'EIO', 'server', this.lamport.value);
    }
    return resultFromError(id.opId, err, this.lamport.value);
  }
}

/** op kind -> op_log call for the kinds VfsCall lists (schema-invalid ops keep their kind). */
const KIND_CALLS: ReadonlyMap<string, VfsCall> = new Map<string, VfsCall>([
  ['create', 'create'],
  ['write', 'write'],
  ['unlink', 'unlink'],
  ['rename', 'rename'],
  ['link', 'link'],
  ['copy', 'copy'],
  ['chmod', 'chmod'],
  ['chown', 'chown'],
  ['utimes', 'utimes'],
  ['batch', 'batch'],
  ['audit.append', 'audit.append'],
  ['session.layout', 'session.layout'],
]);
