/**
 * Agent audit records (syscall-abi.md §3.7, §4.7; agentic-shell.md §3.17; AGT-08).
 *
 * One plan record per request carries the prompt, the plan hash, the dry-run hash, the
 * confirmation and the outcome; one syscall record per executed op travels in the same
 * transaction as the batch. Records never contain file contents, write data, secrets or tokens:
 * arguments are a SHA-256 of their canonical JSON (binary fields as `{len, sha256}`) plus a
 * redacted summary of at most 512 characters. The detailed agent outcome of agentic-shell.md is
 * mapped onto the ABI's outcome set and kept in the summary.
 */
import {
  type AuditOutcome,
  type AuditRecord,
  type Errno,
  type ReadOnlyTool,
  errnoCode,
  sha256Hex,
  toHex,
  sha256,
} from '@plotinium/protocol';

import { canonicalHash } from '../util/canonical.ts';

export type AgentOutcome =
  | 'committed'
  | 'dry_run_only'
  | 'rejected_invalid'
  | 'declined'
  | 'confirm_timeout'
  | 'no_tty'
  | 'needs_clarification'
  | 'cannot_comply'
  | 'refused_model'
  | 'unavailable'
  | 'stale_plan'
  | 'killed_before_execute'
  | 'killed_rolled_back'
  | 'rejected_on_sync'
  | 'failed_rolled_back'
  | 'undone';

const OUTCOME_MAP: Record<AgentOutcome, AuditOutcome> = {
  committed: 'ok',
  dry_run_only: 'ok',
  rejected_invalid: 'rejected',
  declined: 'declined',
  confirm_timeout: 'declined',
  no_tty: 'rejected',
  needs_clarification: 'attempt',
  cannot_comply: 'attempt',
  refused_model: 'error',
  unavailable: 'error',
  stale_plan: 'rejected',
  killed_before_execute: 'attempt',
  killed_rolled_back: 'killed_rolled_back',
  rejected_on_sync: 'rejected',
  failed_rolled_back: 'error',
  undone: 'ok',
};

export function abiOutcome(o: AgentOutcome): AuditOutcome {
  return OUTCOME_MAP[o];
}

/** Keys whose values are secret or content and never reach an audit summary. */
const REDACTED_KEYS = new Set([
  'text',
  'data',
  'token',
  'password',
  'secret',
  'content',
  'confirmToken',
]);

/** Replace binary fields by `{len, sha256}` before hashing (§4.7). */
function digestable(value: unknown): unknown {
  if (value instanceof ArrayBuffer)
    return { len: value.byteLength, sha256: toHex(sha256(new Uint8Array(value))) };
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { len: bytes.length, sha256: toHex(sha256(bytes)) };
  }
  if (Array.isArray(value)) return value.map(digestable);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = digestable(v);
    return out;
  }
  return value;
}

export function argsDigest(args: unknown): string {
  return canonicalHash(digestable(args));
}

/** A short, redacted, single-line summary: keys and short scalar values only. */
export function argsSummary(args: unknown, max = 512): string {
  const walk = (v: unknown, depth: number): string => {
    if (typeof v === 'string') return JSON.stringify(v.length > 80 ? `${v.slice(0, 79)}…` : v);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    if (Array.isArray(v))
      return depth > 2
        ? `[${v.length}]`
        : `[${v
            .slice(0, 5)
            .map((x) => walk(x, depth + 1))
            .join(',')}${v.length > 5 ? ',…' : ''}]`;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return '<binary>';
    if (typeof v === 'object') {
      if (depth > 2) return '{…}';
      const parts = Object.entries(v as Record<string, unknown>).map(([k, x]) =>
        REDACTED_KEYS.has(k) ? `${k}:<redacted>` : `${k}:${walk(x, depth + 1)}`,
      );
      return `{${parts.join(',')}}`;
    }
    return '';
  };
  const s = [...walk(args, 0)]
    .map((c) => ((c.codePointAt(0) ?? 0) < 0x20 || c === '\u007f' ? ' ' : c))
    .join('');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface PlanRecordInput {
  auditId: string;
  t: number;
  osSessionId: string;
  pid: number;
  uid: number;
  ruid?: number;
  requestId: string;
  request: string;
  call: 'ai.agent.plan' | 'ai.agent.submit' | 'ai.agent.confirm' | 'ai.undo' | 'batch';
  args: unknown;
  outcome: AgentOutcome;
  errno?: Errno;
  durationUs: number;
  planHash?: string;
  dryRunHash?: string;
  confirmation?: AuditRecord['confirmation'];
  observations?: ReadonlyArray<{ call: ReadOnlyTool; args: unknown; ok: boolean; errno?: Errno }>;
  txnId?: string;
  undoId?: string;
  inodes?: number;
}

/** The plan record of one request (level `agent`, actor `agent`). */
export function planRecord(i: PlanRecordInput): AuditRecord {
  const rec: AuditRecord = {
    auditId: i.auditId,
    t: i.t,
    level: 'agent',
    osSessionId: i.osSessionId,
    pid: i.pid,
    uid: i.uid,
    actor: 'agent',
    call: i.call,
    argsDigest: argsDigest(i.args),
    argsSummary: argsSummary({ outcome: i.outcome, args: i.args }),
    outcome: abiOutcome(i.outcome),
    durationUs: Math.max(0, i.durationUs),
    promptId: i.requestId,
    request: i.request.slice(0, 2000),
  };
  if (i.ruid !== undefined) rec.ruid = i.ruid;
  if (i.errno !== undefined) {
    rec.errno = i.errno;
    rec.errnoCode = errnoCode(i.errno);
  }
  if (i.planHash !== undefined) rec.planHash = i.planHash;
  if (i.dryRunHash !== undefined) rec.dryRunHash = i.dryRunHash;
  if (i.confirmation !== undefined) rec.confirmation = i.confirmation;
  if (i.observations !== undefined) {
    rec.observations = i.observations.slice(0, 64).map((o) => {
      const obs: NonNullable<AuditRecord['observations']>[number] = {
        call: o.call,
        argsDigest: argsDigest(o.args),
        ok: o.ok,
      };
      if (o.errno !== undefined) obs.errno = o.errno;
      return obs;
    });
  }
  if (i.txnId !== undefined) rec.txnId = i.txnId;
  if (i.undoId !== undefined) rec.undoId = i.undoId;
  if (i.inodes !== undefined) rec.inodes = i.inodes;
  return rec;
}

/** One record per executed batch op, written in the batch's own transaction (I-B8). */
export function syscallRecords(base: {
  auditIds: readonly string[];
  t: number;
  osSessionId: string;
  pid: number;
  uid: number;
  requestId: string;
  txnId: string;
  ops: readonly unknown[];
}): AuditRecord[] {
  return base.ops.map((op, i) => ({
    auditId: base.auditIds[i] ?? base.auditIds[0] ?? '',
    t: base.t,
    level: 'agent',
    osSessionId: base.osSessionId,
    pid: base.pid,
    uid: base.uid,
    actor: 'agent',
    call: 'batch',
    argsDigest: argsDigest(op),
    argsSummary: argsSummary(op),
    outcome: 'ok',
    durationUs: 0,
    promptId: base.requestId,
    txnId: base.txnId,
  }));
}

/** Stable id of a request's audit chain, for cross-checks in tests. */
export function recordFingerprint(r: AuditRecord): string {
  return sha256Hex(`${r.auditId}|${r.call}|${r.argsDigest}|${r.outcome}`);
}
