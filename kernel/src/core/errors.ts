/**
 * Errors raised inside the kernel. Handlers throw `KernelError`; the dispatcher turns it into a
 * `SysErr` reply. Every errno comes from the closed protocol set (INV-ABI-8).
 */
import type { ErrDetail, Errno } from '@plotinium/protocol';
import { strerror } from '@plotinium/protocol';

export class KernelError extends Error {
  readonly errno: Errno;
  readonly detail: ErrDetail | undefined;

  constructor(errno: Errno, detail?: ErrDetail, message?: string) {
    super(message ?? strerror(errno));
    this.name = 'KernelError';
    this.errno = errno;
    this.detail = detail;
  }
}

export function isKernelError(e: unknown): e is KernelError {
  return e instanceof KernelError;
}

/** A broken kernel invariant (for example an illegal lifecycle edge). Never reaches the wire. */
export class KernelBug extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelBug';
  }
}
