/**
 * The kernel program model as ai/ sees it (processes-and-scheduling.md §3.5; syscall-abi.md §3.2).
 *
 * A program is `init(argv) → state` plus a generator `run(ctx, state)` that yields system-call
 * requests (`{call, args}`, no id; the executor stamps it) or `ctx.tick` at voluntary yield points,
 * and receives the reply value or has a `SysError` thrown into it. ai/ may not import
 * `@plotinium/kernel/sys` (architecture.md §3.7), so these are STRUCTURAL copies of its types: the
 * executor's `ctx` is assignable to `AiProgramContext` and the executor accepts any module whose
 * default export has `init` and `run` (the same stand-in pattern as apps/src/_sys.ts).
 */
import type {
  ArgsIn,
  CallName,
  Errno,
  KEvent,
  RetOf,
  SignalName,
  Topic,
} from '@plotinium/protocol';
import { isErrno } from '@plotinium/protocol';

export interface SysRequest {
  readonly call: string;
  readonly args: unknown;
}

export type Yield = SysRequest | symbol;
export type SysGen<T> = Generator<Yield, T, unknown>;

export interface AiSys {
  call<C extends CallName>(name: C, args: ArgsIn<C>): SysGen<RetOf<C>>;
}

/** The fields of the executor's `ctx` the AI programs read. */
export interface AiProgramContext {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly argv: readonly string[];
  readonly env: ReadonlyMap<string, string>;
  readonly cwd: string;
  readonly tty: number | null;
  readonly sys: AiSys;
  readonly tick: symbol;
  now(): number;
  sleep(ms: number): SysGen<void>;
}

export interface AiProgram<St> {
  readonly checkpointable?: boolean;
  init(argv: readonly string[]): St;
  run(ctx: AiProgramContext, st: St): SysGen<number | undefined>;
  signal?(ctx: AiProgramContext, st: St, sig: SignalName): void;
}

/**
 * `sys.events` returns events typed from the Valibot variant, which TypeScript sees as one object
 * whose `topic` and `data` are independent unions. The kernel built every event with a matching
 * pair (the bus stamps `{topic, data}` from `EventData[topic]`), so this is the same value seen as
 * the protocol's discriminated `KEvent` union.
 */
export function asKEvents(
  events: ReadonlyArray<{
    readonly topic: Topic;
    readonly seq: number;
    readonly t: number;
    readonly data: unknown;
  }>,
): readonly KEvent[] {
  return events as readonly KEvent[];
}

/** The errno of a thrown system-call failure, or undefined. */
export function errnoOf(e: unknown): Errno | undefined {
  if (typeof e !== 'object' || e === null || !('errno' in e)) return undefined;
  const errno: unknown = e.errno;
  return isErrno(errno) ? errno : undefined;
}

/** The `detail.reason` of a thrown system-call failure, if any. */
export function reasonOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('detail' in e)) return undefined;
  const d: unknown = e.detail;
  if (typeof d !== 'object' || d === null || !('reason' in d)) return undefined;
  return typeof d.reason === 'string' ? d.reason : undefined;
}

/** A system call whose failure is returned instead of thrown. */
export function* attempt<C extends CallName>(
  sys: AiSys,
  name: C,
  args: ArgsIn<C>,
): SysGen<{ ok: true; value: RetOf<C> } | { ok: false; errno: Errno; reason?: string }> {
  try {
    return { ok: true, value: yield* sys.call(name, args) };
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    const reason = reasonOf(e);
    return reason === undefined ? { ok: false, errno } : { ok: false, errno, reason };
  }
}

const encoder = new TextEncoder();

function toBuffer(text: string): ArrayBuffer {
  const bytes = encoder.encode(text);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Write text to a descriptor (1 = stdout, 2 = stderr); a closed descriptor is ignored. */
export function* writeText(sys: AiSys, fd: number, text: string): SysGen<void> {
  if (text === '') return;
  yield* attempt(sys, 'write', { fd, data: toBuffer(text) });
}

/** Read one line from a descriptor; undefined at end of file or on error. */
export function* readLine(sys: AiSys, fd: number, max = 4_096): SysGen<string | undefined> {
  const decoder = new TextDecoder();
  let line = '';
  for (;;) {
    const r = yield* attempt(sys, 'read', { fd, len: 256 });
    if (!r.ok || r.value.byteLength === 0) return line === '' ? undefined : line;
    line += decoder.decode(new Uint8Array(r.value), { stream: true });
    const nl = line.indexOf('\n');
    if (nl >= 0) return line.slice(0, nl).replace(/\r$/, '');
    if (line.length >= max) return line.slice(0, max);
  }
}
