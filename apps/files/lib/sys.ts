/**
 * One way to write file logic for both halves of an app (window-manager.md §3.1, §3.13):
 *
 * - the operations in ops.ts are generator functions over `GenSys`, the `call(name, args)` shape
 *   of `@plotinium/kernel/sys`: `const st = yield* sys.call('stat', {path})`;
 * - in the app's process (proc.ts, on an executor) they run on `ctx.sys` unchanged;
 * - in the view they run through `drive()`, which answers each yielded request with the view's
 *   promise client (`AppViewContext.sys`; the host routes executor-only calls through the app's
 *   own process, so the kernel always sees the app's pid and credentials).
 *
 * Imports: @plotinium/protocol types and @plotinium/kernel/sys only (SYS-01).
 */
import type { ArgsIn, CallName, Errno, RetOf } from '@plotinium/protocol';
import { strerror } from '@plotinium/protocol';
import type { SysGen } from '@plotinium/kernel/sys';
import { createSys, errnoOf } from '@plotinium/kernel/sys';

export type { SysGen };

/** The generator system-call surface the operations need (`ctx.sys` satisfies it). */
export interface GenSys {
  call<C extends CallName>(name: C, args: ArgsIn<C>): SysGen<RetOf<C>>;
}

/** The promise client of a view (`AppSys` in apps/src/descriptor.ts satisfies it). */
export interface PromiseSys {
  call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>>;
}

/** Generator stubs that only yield `{call, args}`; `drive()` answers them. */
export const STUBS: GenSys = createSys();

/**
 * Runs an operation in the view: every yielded request becomes one promise call, a rejection is
 * thrown back into the generator (so its try/catch and finally blocks work as on an executor),
 * and a voluntary yield (`ctx.tick`) just continues.
 */
export async function drive<T>(gen: SysGen<T>, sys: PromiseSys): Promise<T> {
  let step = gen.next();
  for (;;) {
    if (step.done === true) return step.value;
    const req = step.value;
    if (typeof req === 'symbol') {
      step = gen.next();
      continue;
    }
    let value: unknown;
    try {
      value = await sys.call(req.call as CallName, req.args as never);
    } catch (e) {
      step = gen.throw(e);
      continue;
    }
    step = gen.next(value);
  }
}

/** A failed operation, with the errno the views show beside the message. */
export interface Failure {
  readonly errno: string;
  readonly message: string;
}

/** `EACCES`, or `EIO` for a thrown value that is not a system-call failure. */
export function errnoText(e: unknown): string {
  return errnoOf(e) ?? (hasErrnoString(e) ? e.errno : 'EIO');
}

function hasErrnoString(e: unknown): e is { errno: string } {
  return typeof e === 'object' && e !== null && 'errno' in e && typeof e.errno === 'string';
}

/** Words for the errnos a file manager meets; the protocol text otherwise. */
const FRIENDLY: Partial<Record<Errno, string>> = {
  EACCES: 'You do not have permission to do that',
  EPERM: 'Only the owner can do that',
  ENOENT: 'That item no longer exists',
  EEXIST: 'An item with that name already exists',
  ENOTEMPTY: 'The folder is not empty',
  EDQUOT: 'Your quota is full',
  EBUSY: 'The item is in use or locked by someone else',
  EXDEV: 'That move crosses file systems',
  EISDIR: 'That is a folder',
  ENOTDIR: 'That is not a folder',
  ENOSYS: 'This action is not available in this build',
  EINVAL: 'The request was not valid',
  ENAMETOOLONG: 'That name is too long',
  ELOOP: 'Too many symbolic links',
  ETIMEDOUT: 'The request timed out',
  EAGAIN: 'Busy right now, try again',
};

/** A refusal decided by the app itself (before any system call), with its own sentence. */
export class AppError extends Error {
  readonly errno: Errno;
  constructor(errno: Errno, message: string) {
    super(message);
    this.name = 'AppError';
    this.errno = errno;
  }
}

/** `{errno, message}` for a thrown value, with a friendly sentence when there is one. */
export function failureOf(e: unknown): Failure {
  if (e instanceof AppError) return { errno: e.errno, message: e.message };
  const errno = errnoOf(e);
  if (errno !== undefined) return { errno, message: FRIENDLY[errno] ?? strerror(errno) };
  if (hasErrnoString(e))
    return { errno: e.errno, message: e instanceof Error ? e.message : e.errno };
  return { errno: 'EIO', message: e instanceof Error ? e.message : String(e) };
}

/** Whether a thrown value carries this errno. */
export function isErrno(e: unknown, errno: string): boolean {
  return errnoText(e) === errno;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of `text` as a standalone ArrayBuffer (transferable). */
export function encodeUtf8(text: string): ArrayBuffer {
  const bytes = encoder.encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
