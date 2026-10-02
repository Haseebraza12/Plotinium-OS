/**
 * The audit record (syscall-abi.md §3.7 and §4.7, ABI-08; supports AGT-08).
 *
 * Records never contain file contents, write data, passwords, secrets or tokens: arguments are
 * stored as a SHA-256 digest of their canonical JSON plus a redacted summary of at most 512
 * characters. The local `audit` store keys records by `auditId` with indexes on `uid` and
 * `promptId`; the server `audit_log` table mirrors these fields (INSERT and SELECT only for the
 * application role).
 */
import * as v from 'valibot';

import { Errno } from './errno.ts';
import { Count, Ino, PidOrZero, Sha256Hex, Uid } from './sys/common.ts';
import { CallName } from './sys/names.ts';

/** The agent's read-only tools; each is exactly one of these syscalls (C12, §4.4.2). */
export const READ_ONLY_TOOL_CALLS = ['readdir', 'stat', 'find', 'grep', 'du', 'wc'] as const;
export const ReadOnlyTool = v.picklist(READ_ONLY_TOOL_CALLS);
export type ReadOnlyTool = (typeof READ_ONLY_TOOL_CALLS)[number];

export const AuditLevel = v.picklist(['trace', 'security', 'agent']);
export const AuditActor = v.picklist(['user', 'agent', 'system']);
export const AuditOutcome = v.picklist([
  'ok',
  'error',
  'rejected',
  'declined',
  'confirmed',
  'killed_rolled_back',
  'attempt',
]);
export const AuditConfirmation = v.picklist([
  'not-required',
  'confirmed',
  'declined',
  'no-tty',
  'timeout',
]);

export const AuditRecord = v.strictObject({
  /** UUIDv7. */
  auditId: Ino,
  /** Epoch ms, kernel clock. */
  t: Count,
  level: AuditLevel,
  osSessionId: Ino,
  /** 0 = the kernel itself. */
  pid: PidOrZero,
  uid: Uid,
  /** Real login uid when running under `su`. */
  ruid: v.optional(Uid),
  actor: AuditActor,
  call: CallName,
  /** SHA-256 of the canonical JSON of the args; binary fields replaced by `{len, sha256}`. */
  argsDigest: Sha256Hex,
  /** At most 512 characters, redacted: no file data, secrets, passwords or tokens. */
  argsSummary: v.pipe(v.string(), v.maxLength(512)),
  outcome: AuditOutcome,
  errno: v.optional(Errno),
  errnoCode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  durationUs: v.pipe(v.number(), v.minValue(0)),
  // agent fields (AGT-08: prompt, plan, confirmation, result)
  /** = requestId. */
  promptId: v.optional(Ino),
  /** At most 2000 characters, only on the plan record of a request. */
  request: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  planHash: v.optional(Sha256Hex),
  dryRunHash: v.optional(Sha256Hex),
  confirmation: v.optional(AuditConfirmation),
  /** One entry per read-only observation call of a planning turn. */
  observations: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          call: ReadOnlyTool,
          argsDigest: Sha256Hex,
          ok: v.boolean(),
          errno: v.optional(Errno),
        }),
      ),
      v.maxLength(64),
    ),
  ),
  txnId: v.optional(Ino),
  opId: v.optional(Ino),
  undoId: v.optional(Ino),
  /** Blast radius. */
  inodes: v.optional(Count),
});

export type AuditRecord = v.InferOutput<typeof AuditRecord>;
export type AuditOutcome = v.InferOutput<typeof AuditOutcome>;
