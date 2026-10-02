/**
 * The system-call envelope and the port frames that carry it (syscall-abi.md §3.1, §3.2, §4.1).
 *
 * Spec: MUST, §9.6. Calls travel as `{id, call, args}`; replies come back as
 * `{id, ok, value | errno}`. Plotinium design (C3): caller identity comes from the PORT the frame
 * arrived on and the kernel's dispatch state, never from message fields (ABI-02). The executor
 * control port and the view port are the only channels that carry system calls.
 *
 * `SysReqFrame` is the stage-0 decode schema: `call` is any well-formed call name, so that an
 * unknown call can be answered ENOSYS at stage 2 rather than EINVAL.
 *
 * The executor frames follow §4.1. processes-and-scheduling.md §4.3 adds watchdog telemetry to the
 * slice-ending frames (`steps`, `maxStepUs`, `touched`, `dirtied`); they are accepted here as
 * OPTIONAL fields, while field names (`res`, `quantumMs`, `pendingSigs`) follow §4.1.
 */
import * as v from 'valibot';

import { Errno, Reason } from '../errno.ts';
import { KEvent } from '../events.ts';
import { Count, Path, Pid, RequestId, Sha256Hex } from './common.ts';
import type { CallName } from './names.ts';

/** Well-formed call names: lower-camel segments separated by dots, at most 64 characters. */
export const CallNameSyntax = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/),
);

/** Stage 0 of the dispatcher: an object with a uint32 `id`, a string `call` and an `args` field. */
export const SysReqFrame = v.strictObject({
  id: RequestId,
  call: CallNameSyntax,
  args: v.unknown(),
});

export type SysReq<C extends CallName = CallName> = { id: number; call: C; args: unknown };

export const ErrDetail = v.strictObject({
  /** One of the registered reasons of §4.3.1 (see REGISTERED_REASONS). */
  reason: v.optional(Reason),
  /** Schema issue path (stage 3); never the value. */
  field: v.optional(v.pipe(v.string(), v.maxLength(256))),
  /** The path that failed (stage 5). */
  path: v.optional(Path),
  /** Agent plan validation (AGT-02). */
  step: v.optional(Count),
  check: v.optional(v.pipe(v.string(), v.maxLength(64))),
  /** EBUSY on a lease, for example `alice@lab-pc-3`. */
  holder: v.optional(v.pipe(v.string(), v.maxLength(128))),
  /** EAGAIN, EAIUNAVAIL. */
  retryAfterMs: v.optional(Count),
  /** `sync.flush` timeout. */
  remaining: v.optional(Count),
  /** `spawn`: application dependency cycle path. */
  cycle: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(64))), v.maxLength(64))),
});

export const SysOk = v.strictObject({ id: RequestId, ok: v.literal(true), value: v.unknown() });
export const SysErr = v.strictObject({
  id: RequestId,
  ok: v.literal(false),
  errno: Errno,
  msg: v.optional(v.pipe(v.string(), v.maxLength(256))),
  detail: v.optional(ErrDetail),
});
export const SysRes = v.variant('ok', [SysOk, SysErr]);

export type ErrDetail = v.InferOutput<typeof ErrDetail>;
export type SysOk<T = unknown> = { id: number; ok: true; value: T };
export type SysErr = v.InferOutput<typeof SysErr>;
export type SysRes<T = unknown> = SysOk<T> | SysErr;

/** The `hello` both executors and views send first (ABI-10). */
const Hello = v.strictObject({
  t: v.literal('hello'),
  abi: v.pipe(v.number(), v.integer(), v.minValue(1)),
  digest: Sha256Hex,
});

const SliceSeq = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const CpuMs = v.pipe(v.number(), v.minValue(0));
const PendingSigs = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xffff_ffff));
const QuantumMs = v.pipe(v.number(), v.minValue(0));
/** Watchdog telemetry of processes-and-scheduling.md §4.3 (optional here). */
const SliceTelemetry = {
  steps: v.optional(Count),
  maxStepUs: v.optional(v.pipe(v.number(), v.minValue(0))),
  touched: v.optional(v.instance(Uint32Array)),
  dirtied: v.optional(v.instance(Uint32Array)),
} as const;

/** Executor control port, executor → kernel: only the frames that carry or end a syscall slice. */
export const ExecToKernel = v.variant('t', [
  Hello,
  /** Also ends the slice (the syscall frame is the slice-end report). */
  v.strictObject({
    t: v.literal('syscall'),
    pid: Pid,
    sliceSeq: SliceSeq,
    cpuMs: CpuMs,
    req: SysReqFrame,
    ...SliceTelemetry,
  }),
  v.strictObject({
    t: v.literal('yield'),
    pid: Pid,
    sliceSeq: SliceSeq,
    cpuMs: CpuMs,
    ...SliceTelemetry,
  }),
  v.strictObject({
    t: v.literal('exit'),
    pid: Pid,
    sliceSeq: SliceSeq,
    cpuMs: CpuMs,
    code: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255))),
  }),
]);

/** Executor control port, kernel → executor. */
export const KernelToExec = v.variant('t', [
  v.strictObject({
    t: v.literal('dispatch'),
    pid: Pid,
    sliceSeq: SliceSeq,
    quantumMs: QuantumMs,
    pendingSigs: PendingSigs,
    res: v.optional(SysRes),
  }),
  /** The fast path of class F calls: continue on the same executor with the remaining quantum. */
  v.strictObject({
    t: v.literal('resume'),
    pid: Pid,
    sliceSeq: SliceSeq,
    quantumMs: QuantumMs,
    pendingSigs: PendingSigs,
    res: SysRes,
  }),
]);

/** View port, view → kernel. */
export const ViewToKernel = v.variant('t', [
  Hello,
  v.strictObject({ t: v.literal('req'), req: SysReqFrame }),
]);

/** View port, kernel → view. */
export const KernelToView = v.variant('t', [
  v.strictObject({ t: v.literal('res'), res: SysRes }),
  /** At most one batch per animation frame. */
  v.strictObject({ t: v.literal('events'), batch: v.array(KEvent) }),
  /** Terminal views only. */
  v.strictObject({ t: v.literal('tty.out'), data: v.instance(ArrayBuffer) }),
  v.strictObject({
    t: v.literal('close'),
    reason: v.picklist(['window-closed', 'process-exit', 'abi-mismatch']),
  }),
]);

export type ExecToKernel = v.InferOutput<typeof ExecToKernel>;
export type KernelToExec = v.InferOutput<typeof KernelToExec>;
export type ViewToKernel = v.InferOutput<typeof ViewToKernel>;
export type KernelToView = v.InferOutput<typeof KernelToView>;

/** Build a success reply. */
export function ok<T>(id: number, value: T): SysOk<T> {
  return { id, ok: true, value };
}

/** Build an error reply; `detail` is omitted when empty. */
export function fail(id: number, errno: Errno, msg?: string, detail?: ErrDetail): SysErr {
  const res: SysErr = { id, ok: false, errno };
  if (msg !== undefined) res.msg = msg;
  if (detail !== undefined && Object.keys(detail).length > 0) res.detail = detail;
  return res;
}
