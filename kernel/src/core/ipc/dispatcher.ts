/**
 * The syscall dispatcher (syscall-abi.md §3.3 and §5.1; C3, ABI-03, ABI-12, INV-ABI-1..3).
 *
 * Stages, in contract order; a request failing several gets the errno of the FIRST:
 *   0 decode   an object with a uint32 `id`, a string `call` and `args`   EINVAL / drop
 *   1 resident the caller is the process dispatched on this port          ESRCH
 *   2 table    the call exists for this origin (and in this build)        ENOSYS
 *   3 schema   `v.safeParse(spec.args, args, {abortEarly: true})`         EINVAL / ENAMETOOLONG
 *   4 caps     required capabilities ⊆ the PCB's set; fs.scope prefixes  EPERM
 *   5 perm     the call's `authorize` (path resolution, rwx)              EACCES, EPERM, ENOENT, …
 *   6 audit    trace, security and agent records
 *   7 handler  F synchronously; T, B, X, R may resolve later
 *   8 reply    exactly once while the caller lives, never after
 * Stages 0–6 run synchronously and change nothing but audit and klog records. The dispatcher
 * never throws (ABI-12): every failure becomes a reply or a logged drop.
 */
import type { CallName, CallSpec, ErrDetail, Errno, SysRes } from '@plotinium/protocol';
import {
  ABI_VERSION,
  abiDigest,
  bitsToCaps,
  callTable,
  fail,
  ok,
  requiredCaps,
  SysReqFrame,
  ViewToKernel,
} from '@plotinium/protocol';

import { isKernelError, KernelError } from '../errors.ts';
import type { Klog } from '../klog/klog.ts';
import type { PCB } from '../proc/pcb.ts';
import type { Auditor, AuditToken } from './audit.ts';
import type { ErasedImpl, HandlerRegistry } from './handlers.ts';
import { NO_REPLY } from './handlers.ts';
import type { SchemaIssue } from './parse.ts';
import { safeParse } from './parse.ts';
import type { Caller, ExecPortRec, ViewPortRec } from './ports.ts';
import { scopeViolation } from './scope.ts';

export const VIEW_BACKLOG_MAX = 64;
const REQUEST_ID_MAX = 0xffff_ffff;

export interface DispatcherDeps {
  readonly procs: { get(pid: number): PCB | undefined };
  readonly handlers: HandlerRegistry;
  readonly audit: Auditor;
  readonly klog: Klog;
  readonly now: () => number;
  /** Whether the `ai.*` group exists in this build (C12 litmus: false answers ENOSYS). */
  readonly ai: boolean;
  /** Stage-0 drop: SIGKILL the executor process with reason `abi-violation`, or close the view. */
  readonly onAbiViolation?: (pid: number | null, port: ExecPortRec | ViewPortRec) => void;
  /** Second identity mismatch on an executor: terminate it through the watchdog path. */
  readonly onSuspectExecutor?: (port: ExecPortRec) => void;
}

/** A syscall frame from an executor: `{t:'syscall', pid, sliceSeq, req}` (other fields ignored). */
export interface SyscallFrame {
  readonly pid: unknown;
  readonly sliceSeq: unknown;
  readonly req: unknown;
}

type Decoded =
  | { readonly ok: true; readonly id: number; readonly call: string; readonly args: unknown }
  | { readonly ok: false; readonly id: number | null };

function readableId(frame: unknown): number | null {
  if (frame === null || typeof frame !== 'object') return null;
  const id = (frame as { id?: unknown }).id;
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= REQUEST_ID_MAX
    ? id
    : null;
}

/** Stage 0. */
function decode(req: unknown): Decoded {
  const parsed = safeParse<{ id: number; call: string; args: unknown }>(SysReqFrame, req);
  if (parsed.success)
    return { ok: true, id: parsed.output.id, call: parsed.output.call, args: parsed.output.args };
  return { ok: false, id: readableId(req) };
}

function issueField(issue: SchemaIssue): string | undefined {
  if (!issue.path || issue.path.length === 0) return undefined;
  const keys = issue.path.map((item) => {
    const key: unknown = item.key;
    return typeof key === 'string' || typeof key === 'number' ? String(key) : '?';
  });
  return keys.join('.').slice(0, 256);
}

/** Stage 3 errno: the tag `ENAMETOOLONG`, else EINVAL; `msg` names the field, never the value. */
function schemaError(issue: SchemaIssue | undefined): KernelError {
  const field = issue ? issueField(issue) : undefined;
  const errno: Errno = issue?.message === 'ENAMETOOLONG' ? 'ENAMETOOLONG' : 'EINVAL';
  const detail: ErrDetail = field === undefined ? {} : { field };
  return new KernelError(errno, detail, `invalid ${field ?? 'args'} (${issue?.type ?? 'schema'})`);
}

function toReply(id: number, e: KernelError): SysRes {
  return fail(id, e.errno, e.message.slice(0, 256), e.detail);
}

export class Dispatcher {
  private readonly deps: DispatcherDeps;
  private readonly tables: {
    readonly E: ReadonlyMap<CallName, CallSpec>;
    readonly V: ReadonlyMap<CallName, CallSpec>;
  };

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.tables = { E: callTable('E', { ai: deps.ai }), V: callTable('V', { ai: deps.ai }) };
  }

  // -------------------------------------------------------------------------------------------
  // Executor ports
  // -------------------------------------------------------------------------------------------

  /** A `{t:'syscall'}` frame on executor port `port`. */
  execFrame(port: ExecPortRec, frame: SyscallFrame): void {
    try {
      const d = decode(frame.req);
      if (!d.ok) {
        this.stage0(port, d.id, typeof frame.pid === 'number' ? frame.pid : null, (res) => {
          const s = port.slice;
          if (s) port.reply(s.pid, res);
        });
        return;
      }
      const pcb = this.residentCaller(port, frame);
      if (!pcb) {
        const claimed = typeof frame.pid === 'number' ? frame.pid : 0;
        this.deps.audit.rejected(null, d.call, undefined, d.args, 'ESRCH');
        port.reply(claimed, fail(d.id, 'ESRCH', 'caller not resident on this port'));
        return;
      }
      const caller: Caller = { pcb, origin: 'E', wid: null };
      this.run(caller, this.tables.E, d, (res) => {
        if (pcb.state !== 'TERMINATED') port.reply(pcb.pid, res);
      });
    } catch (e) {
      this.internal(e);
    }
  }

  /** Stage 1 on an executor port (§5.2). O(1). */
  private residentCaller(port: ExecPortRec, frame: SyscallFrame): PCB | null {
    const s = port.slice;
    if (!s) return null;
    if (s.pid !== frame.pid || s.sliceSeq !== frame.sliceSeq) {
      const claimed = typeof frame.pid === 'number' ? String(frame.pid) : '?';
      this.deps.audit.securityEvent(
        s.pid,
        `identity-mismatch exec ${String(port.index)} claimed ${claimed} dispatched ${String(s.pid)}`,
      );
      port.suspect++;
      if (port.suspect >= 2) this.deps.onSuspectExecutor?.(port);
      return null;
    }
    port.slice = null;
    const pcb = this.deps.procs.get(s.pid);
    return pcb && pcb.state !== 'TERMINATED' && pcb.worker === port.index ? pcb : null;
  }

  // -------------------------------------------------------------------------------------------
  // View ports
  // -------------------------------------------------------------------------------------------

  /** Any message on a view port: `hello` (ABI-10) or `req`. */
  viewMessage(port: ViewPortRec, msg: unknown): void {
    try {
      if (!port.open) return;
      const parsed = safeParse<ViewToKernel>(ViewToKernel, msg);
      if (!parsed.success) {
        const req =
          msg !== null && typeof msg === 'object' ? (msg as { req?: unknown }).req : undefined;
        this.stage0(port, readableId(req), port.pid, (res) => {
          port.reply(res);
        });
        return;
      }
      if (parsed.output.t === 'hello') {
        if (parsed.output.abi !== ABI_VERSION || parsed.output.digest !== abiDigest()) {
          this.deps.klog.line(
            this.deps.now(),
            'ipc',
            'warn',
            `view ${String(port.wid)}: ABI mismatch, restart to update`,
            port.pid,
          );
          port.close('abi-mismatch');
          return;
        }
        port.greeted = true;
        return;
      }
      this.viewRequest(port, parsed.output.req);
    } catch (e) {
      this.internal(e);
    }
  }

  private viewRequest(port: ViewPortRec, req: unknown): void {
    const d = decode(req);
    if (!d.ok) {
      this.stage0(port, d.id, port.pid, (res) => {
        port.reply(res);
      });
      return;
    }
    if (port.outstanding >= VIEW_BACKLOG_MAX) {
      port.reply(fail(d.id, 'EAGAIN', 'too many outstanding calls', { reason: 'view-backlog' }));
      return;
    }
    const pcb = this.deps.procs.get(port.pid);
    if (!pcb || pcb.state === 'TERMINATED' || !pcb.windows.has(port.wid)) {
      this.deps.audit.rejected(null, d.call, undefined, d.args, 'ESRCH');
      port.reply(fail(d.id, 'ESRCH', 'window or process is gone'));
      return;
    }
    port.outstanding++;
    const caller: Caller = { pcb, origin: 'V', wid: port.wid };
    this.run(caller, this.tables.V, d, (res) => {
      port.outstanding--;
      if (port.open && pcb.state !== 'TERMINATED') port.reply(res);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Shared stages
  // -------------------------------------------------------------------------------------------

  /** Stage 0 failure: EINVAL when the id is readable, else drop + security audit + kill/close. */
  private stage0(
    port: ExecPortRec | ViewPortRec,
    id: number | null,
    pid: number | null,
    reply: (res: SysRes) => void,
  ): void {
    if (id !== null) {
      this.deps.audit.rejected(
        pid === null ? null : (this.deps.procs.get(pid) ?? null),
        '?',
        undefined,
        undefined,
        'EINVAL',
      );
      reply(fail(id, 'EINVAL', 'malformed request frame'));
      return;
    }
    this.deps.audit.securityEvent(
      pid ?? 0,
      `abi-violation: undecodable frame on ${port.kind} port`,
    );
    this.deps.onAbiViolation?.(pid, port);
    if (port.kind === 'view') port.close('abi-mismatch');
  }

  /** Stages 2–8 for a decoded request from a resident caller. */
  private run(
    caller: Caller,
    table: ReadonlyMap<CallName, CallSpec>,
    d: Extract<Decoded, { ok: true }>,
    reply: (res: SysRes) => void,
  ): void {
    const { pcb } = caller;
    const name = d.call as CallName;
    const spec = table.get(name);
    const impl = spec === undefined ? undefined : this.deps.handlers.get(name);
    if (spec === undefined || impl === undefined) {
      this.deps.audit.rejected(pcb, d.call, spec, d.args, 'ENOSYS');
      reply(fail(d.id, 'ENOSYS', `${d.call.slice(0, 64)}: not available here`));
      return;
    }
    const rejection = this.check(caller, name, spec, impl, d.args);
    if (rejection.error) {
      this.deps.audit.rejected(pcb, name, spec, d.args, rejection.error.errno);
      reply(toReply(d.id, rejection.error));
      return;
    }
    const args = rejection.args;
    const token = this.deps.audit.begin(pcb, name, spec, args);
    const security = impl.securityRelevant?.(caller, args) ?? false;
    let result: unknown;
    try {
      result = impl.handle(caller, args);
    } catch (e) {
      this.finish(token, d.id, e, security, reply);
      return;
    }
    if (result instanceof Promise) {
      result.then(
        (value: unknown) => {
          this.complete(token, d.id, value, security, reply);
        },
        (e: unknown) => {
          this.finish(token, d.id, e, security, reply);
        },
      );
      return;
    }
    this.complete(token, d.id, result, security, reply);
  }

  /** Stages 3–5. */
  private check(
    caller: Caller,
    name: CallName,
    spec: CallSpec,
    impl: ErasedImpl,
    rawArgs: unknown,
  ): { error: KernelError; args?: undefined } | { error: null; args: unknown } {
    const parsed = safeParse(spec.args, rawArgs);
    if (!parsed.success) return { error: schemaError(parsed.issue) };
    const args: unknown = parsed.output;
    const { pcb } = caller;
    const held = new Set(bitsToCaps(pcb.caps));
    for (const cap of requiredCaps(spec, args, pcb.cls)) {
      if (!held.has(cap))
        return {
          error: new KernelError('EPERM', { reason: 'capability' }, `${name} needs ${cap}`),
        };
    }
    if (pcb.fsScope !== null && held.has('fs.scope')) {
      const outside = scopeViolation(args, pcb.cwdPath, pcb.fsScope);
      if (outside !== null)
        return {
          error: new KernelError(
            'EPERM',
            { reason: 'scope', path: outside },
            'outside the allowed scope',
          ),
        };
    }
    const denied = impl.authorize?.(caller, args) ?? null;
    if (denied) return { error: denied };
    return { error: null, args };
  }

  private complete(
    token: AuditToken,
    id: number,
    value: unknown,
    security: boolean,
    reply: (res: SysRes) => void,
  ): void {
    this.deps.audit.end(token, null, security);
    if (value === NO_REPLY) return;
    reply(ok(id, value));
  }

  private finish(
    token: AuditToken,
    id: number,
    e: unknown,
    security: boolean,
    reply: (res: SysRes) => void,
  ): void {
    const err = isKernelError(e) ? e : this.internal(e);
    this.deps.audit.end(token, err.errno, security);
    reply(toReply(id, err));
  }

  /** A handler bug: logged with its message and stack head, answered EIO (never thrown). */
  private internal(e: unknown): KernelError {
    const msg =
      e instanceof Error
        ? `${e.name}: ${e.message}${e.stack ? ` · ${e.stack.slice(0, 2_048)}` : ''}`
        : String(e);
    try {
      this.deps.klog.line(this.deps.now(), 'ipc', 'fail', `internal error: ${msg}`);
    } catch {
      // Logging must never make the dispatcher throw.
    }
    return new KernelError('EIO', undefined, 'internal kernel error');
  }
}
