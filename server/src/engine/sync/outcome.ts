/**
 * The `op.result` shape and the persisted-outcome rule (offline-and-sync.md §3.10, §4.4; SYN-04;
 * INV-S2, INV-S11; database.md §3.9.3, §3.15).
 *
 * The rule: every outcome after which the client reverts or finishes is persisted; every outcome
 * after which the client sends the same op again is not.
 *
 *   applied / conflict            persisted in the op transaction      (vfsTxn body + feed + op_log)
 *   rejected                      persisted after the rollback, BEFORE the reply (vfsTxn recordRejection)
 *   retry                         never persisted; carries retryAfterMs
 *
 * `op_log.result` (kept forever, the tombstone) stores `StoredResult`: reason, versions, keptAs,
 * ownerSeqs, lamport and commitTime, so a very late resend gets its original outcome back with
 * `duplicate: true` (and `pruned: true` once the retention job has nulled the payload columns).
 */
import * as v from 'valibot';

import {
  FeedCursor,
  Ms,
  Seq,
  Timestamp,
  Version,
  WsErrno,
  WsIno,
  WsName,
  WsReason,
  WsUid,
  type Errno,
  type OpResult,
} from '@plotinium/protocol';

import { isDeterministic } from '../../db/errors.ts';
import type { TxOutcome } from '../../vfs/types.ts';
import { VfsError } from '../../vfs/types.ts';

/** What the op transaction stores in op_log.result (and what a duplicate reads back). */
export const StoredResult = v.object({
  reason: v.optional(WsReason),
  versions: v.optional(
    v.array(
      v.strictObject({
        ino: WsIno,
        version: Version,
        mtime: v.optional(Ms),
        ctime: v.optional(Ms),
      }),
    ),
  ),
  keptAs: v.optional(v.strictObject({ ino: WsIno, parentIno: WsIno, name: WsName })),
  ownerSeqs: v.optional(v.array(FeedCursor)),
  commitTime: v.optional(Timestamp),
  lamport: v.optional(Seq),
  quota: v.optional(
    v.strictObject({
      uid: WsUid,
      usedBytes: Seq,
      usedInodes: Seq,
      quotaBytes: Seq,
      quotaInodes: Seq,
    }),
  ),
  /** Set by the retention job's tombstone reader (payload purged, §3.10). */
  pruned: v.optional(v.boolean()),
  errno: v.optional(WsErrno),
});
export type StoredResult = v.InferOutput<typeof StoredResult>;

const REASON = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_RETRY_AFTER_MS = 600_000;

/** The server's Lamport counter: L_s := max(L_s, op.lamport) + 1 per applied op (§3.5). */
export class LamportClock {
  #value: number;

  constructor(start = 0) {
    this.#value = start;
  }

  get value(): number {
    return this.#value;
  }

  /** Merge a received value without ticking (hello, ack). */
  observe(received: number): number {
    if (received > this.#value) this.#value = received;
    return this.#value;
  }

  /** One applied op carrying the client's `lamport`. */
  tick(received: number): number {
    this.#value = Math.max(this.#value, received) + 1;
    return this.#value;
  }
}

const RETRY_AFTER_BY_REASON: Readonly<Record<string, number>> = {
  'blob-missing': 0, // re-upload first; the upload itself is the wait
  principal: 1_000, // the op is held until a grant exists (§3.8.6)
  'lock-timeout': 500,
  'retry-exhausted': 500,
  'not-implemented': 60_000,
};
const RETRY_AFTER_BY_ERRNO: Partial<Readonly<Record<Errno, number>>> = {
  ETIMEDOUT: 1_000,
  EIO: 2_000,
};

/** Default back-off per transient outcome (the client uses max(retryAfterMs, full jitter)). */
export function retryAfterFor(errno: Errno, reason: string | undefined): number {
  const byReason = reason === undefined ? undefined : RETRY_AFTER_BY_REASON[reason];
  return byReason ?? RETRY_AFTER_BY_ERRNO[errno] ?? 500;
}

function cleanReason(reason: unknown): string | undefined {
  return typeof reason === 'string' && REASON.test(reason) ? reason : undefined;
}

/**
 * Field by field, so one malformed field (for example a SQLSTATE detail recorded with a rejection)
 * never hides the others.
 */
function parseStored(result: unknown): StoredResult {
  if (typeof result !== 'object' || result === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(StoredResult.entries)) {
    const value: unknown = (result as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const r = v.safeParse(schema, value);
    if (r.success) out[key] = r.output;
  }
  return out;
}

/** Copies the optional reply fields of a stored result into an op.result body. */
function fromStored(
  s: StoredResult,
  lamport: number,
): Omit<OpResult, 'opId' | 'status' | 'duplicate'> {
  return {
    lamport: s.lamport ?? lamport,
    ...(s.reason === undefined ? {} : { reason: s.reason }),
    ...(s.versions === undefined ? {} : { versions: s.versions.slice(0, 256) }),
    ...(s.keptAs === undefined ? {} : { keptAs: s.keptAs }),
    ...(s.ownerSeqs === undefined ? {} : { ownerSeqs: s.ownerSeqs.slice(0, 64) }),
    ...(s.commitTime === undefined ? {} : { commitTime: s.commitTime }),
    ...(s.quota === undefined ? {} : { quota: s.quota }),
  };
}

/** op.result for a committed op or a duplicate (stored outcome, `duplicate: true`). */
export function resultFromOutcome(
  opId: string,
  outcome: TxOutcome<unknown>,
  lamport: number,
): OpResult {
  const stored = parseStored(outcome.result);
  if (outcome.kind === 'duplicate') {
    const errno = outcome.errno ?? stored.errno;
    const base = {
      opId,
      status: outcome.status,
      duplicate: true,
      ...fromStored(stored, lamport),
      ...(errno === undefined || errno === null ? {} : { errno }),
      ...(stored.pruned === true ? { pruned: true } : {}),
    };
    // A pruned conflict tombstone may have lost keptAs: the client re-reads by snapshot (§3.10).
    if (base.status === 'conflict' && base.keptAs === undefined)
      return { ...base, status: 'applied', pruned: true };
    return base;
  }
  return {
    opId,
    status: outcome.kind,
    duplicate: false,
    ...fromStored(stored, lamport),
    ...(outcome.errno === undefined ? {} : { errno: outcome.errno }),
  };
}

/** op.result for a failed op: `rejected` when the rule persists it, `retry` otherwise. */
export function resultFromError(
  opId: string,
  err: VfsError,
  lamport: number,
  opts: { persisted: boolean } = { persisted: true },
): OpResult {
  const reason = cleanReason(err.detail['reason']);
  if (isDeterministic(err) && opts.persisted) {
    const keptAs = v.safeParse(StoredResult, { keptAs: err.detail['keptAs'] });
    return {
      opId,
      status: 'rejected',
      duplicate: false,
      errno: err.errno,
      lamport,
      ...(reason === undefined ? {} : { reason }),
      ...(keptAs.success && keptAs.output.keptAs !== undefined
        ? { keptAs: keptAs.output.keptAs }
        : {}),
    };
  }
  if (isDeterministic(err)) {
    // INV-S11: a rejection that could not be recorded must not be sent; the resend decides.
    return retry(opId, 'EIO', 'server', lamport);
  }
  return retry(opId, err.errno, reason, lamport);
}

export function retry(
  opId: string,
  errno: Errno,
  reason: string | undefined,
  lamport: number,
  retryAfterMs?: number,
): OpResult {
  const clean = cleanReason(reason);
  const after = Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(0, Math.round(retryAfterMs ?? retryAfterFor(errno, clean))),
  );
  return {
    opId,
    status: 'retry',
    duplicate: false,
    errno,
    retryAfterMs: after,
    lamport,
    ...(clean === undefined ? {} : { reason: clean }),
  };
}

/** Maps anything thrown by the pipeline to a VfsError (unexpected throws are transient EIO). */
export function asVfsError(e: unknown): VfsError {
  if (e instanceof VfsError) return e;
  return new VfsError('EIO', { reason: 'server' });
}
