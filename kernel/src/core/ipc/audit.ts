/**
 * Audit (syscall-abi.md §3.7 and §4.7, ABI-08; dispatcher stage 6).
 *
 * - trace: every call that returns an error, every T, B, X and R call, and 1 in 64 successful F
 *   calls, as `{t, pid, uid, call, errno, µs}` in the klog ring (volatile by design);
 * - security: calls whose registry level is `security` (or `conditional` when the handler says
 *   so), identity mismatches and any stage 0–5 rejection of a security-level call;
 * - agent: every call made by an agent-class process.
 *
 * Durable records go to an `AuditSink`. TODO(R2): the durable sink is one strict IndexedDB
 * transaction into the local `audit` store plus an `audit.append` outbox op; until the storage
 * service lands the kernel keeps them in memory and mirrors a line into klog.
 *
 * Records never contain file data, passwords, secrets or tokens: args become a SHA-256 digest of
 * their canonical JSON (binary fields replaced by `{len, sha256}`) plus a redacted summary.
 */
import type { AuditOutcome, AuditRecord, CallName, CallSpec, Errno } from '@plotinium/protocol';
import { errnoCode, sha256, sha256Hex, toHex, uuidv7 } from '@plotinium/protocol';

import type { Klog } from '../klog/klog.ts';
import type { PCB } from '../proc/pcb.ts';

export const TRACE_SAMPLE_EVERY = 64;
const SUMMARY_MAX = 512;
const SECRET_KEYS = /secret|password|passwd|token|data|text|request|clarification/i;

export interface AuditSink {
  write(rec: AuditRecord): void;
}

/** In-memory sink (see the module TODO). */
export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  write(rec: AuditRecord): void {
    this.records.push(rec);
  }
}

type Canon = null | boolean | number | string | Canon[] | { [k: string]: Canon };

function canonValue(x: unknown): Canon {
  if (x === null || x === undefined) return null;
  if (typeof x === 'boolean' || typeof x === 'string') return x;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (x instanceof ArrayBuffer)
    return { len: x.byteLength, sha256: toHex(sha256(new Uint8Array(x))) };
  if (ArrayBuffer.isView(x)) {
    const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return { len: x.byteLength, sha256: toHex(sha256(bytes)) };
  }
  if (Array.isArray(x)) return x.map(canonValue);
  if (typeof x === 'object') {
    const out: { [k: string]: Canon } = {};
    for (const k of Object.keys(x).sort()) out[k] = canonValue((x as Record<string, unknown>)[k]);
    return out;
  }
  return null;
}

function canonString(c: Canon): string {
  if (Array.isArray(c)) return `[${c.map(canonString).join(',')}]`;
  if (c !== null && typeof c === 'object') {
    return `{${Object.keys(c)
      .map((k) => `${JSON.stringify(k)}:${canonString(c[k] ?? null)}`)
      .join(',')}}`;
  }
  return JSON.stringify(c);
}

/** SHA-256 hex of the canonical JSON of `args`. */
export function argsDigest(args: unknown): string {
  return sha256Hex(canonString(canonValue(args)));
}

/** At most 512 characters; secret-looking and binary fields are replaced by placeholders. */
export function argsSummary(args: unknown): string {
  if (args === null || typeof args !== 'object') return String(args).slice(0, SUMMARY_MAX);
  const parts: string[] = [];
  for (const k of Object.keys(args).sort()) {
    const val: unknown = (args as Record<string, unknown>)[k];
    let shown: string;
    if (SECRET_KEYS.test(k)) shown = '<redacted>';
    else if (val instanceof ArrayBuffer || ArrayBuffer.isView(val))
      shown = `<${String(val.byteLength)} bytes>`;
    else if (typeof val === 'string') shown = JSON.stringify(val.slice(0, 64));
    else if (typeof val === 'number' || typeof val === 'boolean' || val === null)
      shown = String(val);
    else shown = Array.isArray(val) ? `[${String(val.length)}]` : '{…}';
    parts.push(`${k}=${shown}`);
  }
  const text = parts.join(' ');
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

export interface AuditDeps {
  readonly klog: Klog;
  readonly sink: AuditSink;
  /** Kernel monotonic clock. */
  readonly now: () => number;
  /** Wall-clock epoch ms. */
  readonly epochMs: () => number;
  readonly osSessionId: () => string;
}

export interface AuditToken {
  readonly pcb: PCB;
  readonly call: CallName;
  readonly spec: CallSpec;
  readonly args: unknown;
  readonly t0: number;
}

export class Auditor {
  private readonly deps: AuditDeps;
  private fastCalls = 0;

  constructor(deps: AuditDeps) {
    this.deps = deps;
  }

  /** Stage 6: note the start of an accepted call. */
  begin(pcb: PCB, call: CallName, spec: CallSpec, args: unknown): AuditToken {
    return { pcb, call, spec, args, t0: this.deps.now() };
  }

  /** After the handler: the trace record, and the durable record when the level asks for one. */
  end(token: AuditToken, errno: Errno | null, securityRelevant = false): void {
    const us = Math.max(0, (this.deps.now() - token.t0) * 1_000);
    const sampled =
      token.spec.cls === 'F' && errno === null ? ++this.fastCalls % TRACE_SAMPLE_EVERY === 0 : true;
    if (sampled) this.trace(token.pcb, token.call, errno, us);
    const outcome: AuditOutcome = errno === null ? 'ok' : 'error';
    if (token.pcb.cls === 'agent')
      this.durable('agent', token.pcb, token.call, token.args, outcome, errno, us);
    if (token.spec.audit === 'security' || securityRelevant) {
      this.durable('security', token.pcb, token.call, token.args, outcome, errno, us);
    }
  }

  /** A stage 1–5 rejection: always traced; durable for security-level calls and agents. */
  rejected(
    pcb: PCB | null,
    call: string,
    spec: CallSpec | undefined,
    args: unknown,
    errno: Errno,
  ): void {
    this.trace(pcb, call, errno, 0);
    if (pcb === null || spec === undefined) return;
    const name = call as CallName;
    if (spec.audit === 'security') this.durable('security', pcb, name, args, 'rejected', errno, 0);
    if (pcb.cls === 'agent') this.durable('agent', pcb, name, args, 'rejected', errno, 0);
  }

  /** A security event that is not a call (identity mismatch, ABI violation, stage-0 drop). */
  securityEvent(pid: number, what: string): void {
    this.deps.klog.line(
      this.deps.now(),
      'audit',
      'warn',
      `security: ${what}`,
      pid > 0 ? pid : undefined,
    );
  }

  private trace(pcb: PCB | null, call: string, errno: Errno | null, us: number): void {
    this.deps.klog.append({
      kind: 'trace',
      t: this.deps.now(),
      pid: pcb?.pid ?? 0,
      uid: pcb?.cred.uid ?? 0,
      call: call.slice(0, 64),
      errno,
      us,
    });
  }

  private durable(
    level: 'security' | 'agent',
    pcb: PCB,
    call: CallName,
    args: unknown,
    outcome: AuditOutcome,
    errno: Errno | null,
    us: number,
  ): void {
    const rec: AuditRecord = {
      auditId: uuidv7(),
      t: Math.max(0, Math.floor(this.deps.epochMs())),
      level,
      osSessionId: this.deps.osSessionId(),
      pid: pcb.pid,
      uid: pcb.cred.uid,
      actor: pcb.cls,
      call,
      argsDigest: argsDigest(args),
      argsSummary: argsSummary(args),
      outcome,
      durationUs: us,
    };
    if (pcb.cred.ruid !== pcb.cred.uid) rec.ruid = pcb.cred.ruid;
    if (errno !== null) {
      rec.errno = errno;
      rec.errnoCode = errnoCode(errno);
    }
    this.deps.sink.write(rec);
    this.deps.klog.line(
      this.deps.now(),
      'audit',
      'info',
      `${level} ${call} pid ${String(pcb.pid)} → ${errno ?? outcome}`,
      pcb.pid,
    );
  }
}
