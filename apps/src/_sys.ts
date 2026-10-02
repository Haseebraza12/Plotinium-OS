/**
 * Minimal program model and system-call client shared by apps/* programs (shell, coreutils, demo).
 *
 * Implements the shapes of specs/03-kernel/processes-and-scheduling.md §3.5 (program model:
 * `init(argv) -> state` plus `*run(ctx, state)`) and specs/01-architecture/syscall-abi.md §3.2
 * (a syscall stub yields a request without an id and returns the reply or throws an errno).
 *
 * TODO(R1): switch every importer to @plotinium/kernel/sys (and the protocol `Program`/`Ctx`
 * types) when they land; this file is the stand-in until then and must stay type-compatible.
 * TODO(R1): the `complete.*` calls below are "requested" in shell-and-terminal.md §4.5/§4.8 and are
 * not in protocol/src/sys/names.ts yet; move them there and delete `ExtraCalls`.
 *
 * Owner: R3 (shell); coreutils import it. Only protocol is imported (SYS-01).
 */
import type { ArgsIn, CallName, Errno, RetOf, SignalName } from '@plotinium/protocol';
import { isErrno, strerror } from '@plotinium/protocol';

/** What a program yields: a system-call request, or `ctx.tick` at a voluntary yield point. */
export interface SysRequest {
  readonly call: string;
  readonly args: unknown;
}
export type Yield = SysRequest | symbol;
/** A system-call stub or any program code that performs system calls. */
export type SysGen<T> = Generator<Yield, T, unknown>;

// -----------------------------------------------------------------------------------------------
// Requested calls not yet in protocol (shell-and-terminal.md §4.5)
// -----------------------------------------------------------------------------------------------

export type CompleteNamespace = 'cmd' | 'path' | 'flag' | 'hist';
export interface CompleteQuery {
  ns: CompleteNamespace;
  prefix: string;
  /** 1..100, default 100. */
  limit?: number;
  dir?: string;
  cmd?: string;
}
export interface CompleteItem {
  text: string;
  kind: 'builtin' | 'program' | 'd' | 'f' | 'l' | 'flag' | 'hist';
  desc?: string;
  seq?: number;
}
export interface CompleteResult {
  items: CompleteItem[];
  truncated: boolean;
  indexed: boolean;
}
type Empty = Record<string, never>;
export interface ExtraCalls {
  'complete.query': { args: CompleteQuery; ret: CompleteResult };
  'complete.hist.load': { args: { lines: string[] }; ret: Empty };
  'complete.hist.add': { args: { line: string }; ret: Empty };
  'complete.hist.clear': { args: Empty; ret: Empty };
}

export type AnyCallName = CallName | keyof ExtraCalls;
export type CallArgs<C extends AnyCallName> = C extends CallName
  ? ArgsIn<C>
  : C extends keyof ExtraCalls
    ? ExtraCalls[C]['args']
    : never;
export type CallRet<C extends AnyCallName> = C extends CallName
  ? RetOf<C>
  : C extends keyof ExtraCalls
    ? ExtraCalls[C]['ret']
    : never;

/** The port-bound system-call client (`ctx.sys`). */
export interface Sys {
  call<C extends AnyCallName>(name: C, args: CallArgs<C>): SysGen<CallRet<C>>;
}

/**
 * The generic stub: yields `{call, args}` and returns whatever the executor runtime resumes the
 * generator with (the runtime throws a `SysError` into it on failure).
 */
export function createSysStub(): Sys {
  return {
    *call<C extends AnyCallName>(name: C, args: CallArgs<C>): SysGen<CallRet<C>> {
      const reply = yield { call: name, args };
      return reply as CallRet<C>;
    },
  };
}

// -----------------------------------------------------------------------------------------------
// Program model (processes-and-scheduling.md §3.5.1, §3.5.2)
// -----------------------------------------------------------------------------------------------

export interface ProgramContext {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly uid: number;
  readonly gid: number;
  readonly argv: readonly string[];
  readonly env: ReadonlyMap<string, string>;
  /** Path at the last dispatch. */
  readonly cwd: string;
  /** Controlling TTY number, or null. */
  readonly tty: number | null;
  readonly restored: 'no' | 'page-in' | 'migration' | 'session';
  readonly sys: Sys;
  /** `yield ctx.tick` is a voluntary pre-emption point. */
  readonly tick: symbol;
  now(): number;
}

export interface Program<St> {
  readonly checkpointable?: boolean;
  init(argv: readonly string[]): St;
  run(ctx: ProgramContext, st: St): SysGen<number>;
  /** Synchronous signal hook: may only change `st`. */
  signal?(ctx: ProgramContext, st: St, sig: SignalName): void;
}

// -----------------------------------------------------------------------------------------------
// Errors and text helpers
// -----------------------------------------------------------------------------------------------

/** A failed system call. The runtime may throw its own class; use `errnoOf` to read any of them. */
export class SysError extends Error {
  readonly errno: Errno;
  constructor(errno: Errno, message?: string) {
    super(message ?? strerror(errno));
    this.name = 'SysError';
    this.errno = errno;
  }
}

/** The errno carried by a thrown value, or undefined when it is not a system-call failure. */
export function errnoOf(e: unknown): Errno | undefined {
  if (typeof e !== 'object' || e === null || !('errno' in e)) return undefined;
  const errno: unknown = e.errno;
  return isErrno(errno) ? errno : undefined;
}

/**
 * Terminal texts of shell-and-terminal.md §3.13. They differ from protocol's `strerror` for EBUSY
 * and ETIMEDOUT; the shell spec is normative for what a terminal shows.
 */
const TERMINAL_TEXT: Partial<Record<Errno, string>> = {
  EBUSY: 'Resource busy',
  ETIMEDOUT: 'Timed out',
};

export function errnoText(errno: Errno): string {
  return TERMINAL_TEXT[errno] ?? strerror(errno);
}

/** Terminal text for a thrown value; rethrows anything that is not a system-call failure. */
export function errText(e: unknown): string {
  const errno = errnoOf(e);
  if (errno === undefined) throw e;
  return errnoText(errno);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeText(text: string): ArrayBuffer {
  const bytes = encoder.encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function decodeText(buf: ArrayBuffer): string {
  return decoder.decode(new Uint8Array(buf));
}

/** Writes a whole string to `fd`. */
export function* writeText(sys: Sys, fd: number, text: string): SysGen<void> {
  if (text.length === 0) return;
  yield* sys.call('write', { fd, data: encodeText(text) });
}

/** Reads `fd` to end of file (chunked; yields at each read). */
export function* readAllText(sys: Sys, fd: number, chunk = 65_536): SysGen<string> {
  const parts: string[] = [];
  for (;;) {
    const buf = yield* sys.call('read', { fd, len: chunk });
    if (buf.byteLength === 0) break;
    parts.push(decodeText(buf));
  }
  return parts.join('');
}
