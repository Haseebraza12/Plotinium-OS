/**
 * The errno vocabulary of the server and the SRV-04 error body.
 *
 * Spec: specs/01-architecture/syscall-abi.md §4.3 (C3 errno master table and registered
 * detail.reason values); specs/11-server/backend-api.md §3.5 (SRV-04 error model and status codes).
 * The closed errno set itself lives in @plotinium/protocol (C3); this module adds the server's
 * error class, the SRV-04 body and the default HTTP status per errno.
 */
import { ERRNO_NAMES, isErrno, type Errno } from '@plotinium/protocol';

export { isErrno, type Errno };

/** The twelve spec errnos (§9.3) plus the thirteen Plotinium extras (C3). Nothing else is allowed. */
export const ERRNOS: readonly Errno[] = ERRNO_NAMES;

/** An error that carries one C3 errno and a detail object (detail.reason is a registered reason). */
export class ErrnoError extends Error {
  readonly errno: Errno;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(errno: Errno, detail: Record<string, unknown> = {}, message?: string) {
    super(message ?? errno);
    this.name = 'ErrnoError';
    this.errno = errno;
    this.detail = detail;
  }

  get reason(): string | undefined {
    const reason = this.detail['reason'];
    return typeof reason === 'string' ? reason : undefined;
  }
}

/** SRV-04: the body of every error response (backend-api.md §3.5). */
export interface ApiError {
  errno: Errno;
  reason?: string;
  msg: string;
  reqId: string;
  retryAfterMs?: number;
  detail?: Record<string, unknown>;
}

/**
 * The HTTP status used for an errno when the route does not choose one explicitly. It agrees with
 * the fallback mapping clients use when a response has no JSON body (syscall-abi.md §4.9); the
 * body's errno is always authoritative.
 */
export function defaultStatusFor(errno: Errno): number {
  switch (errno) {
    case 'EINVAL':
    case 'ENAMETOOLONG':
    case 'ELOOP':
      return 400;
    case 'EACCES':
    case 'EPERM':
      return 403;
    case 'ENOENT':
    case 'ENOSYS':
    case 'ESRCH':
      return 404;
    case 'EEXIST':
    case 'EBUSY':
    case 'ENOTEMPTY':
    case 'ENOTDIR':
    case 'EISDIR':
    case 'EXDEV':
      return 409;
    case 'EDQUOT':
      return 413;
    case 'EAIREFUSED':
      return 422;
    case 'EAGAIN':
      return 429;
    case 'EAIUNAVAIL':
      return 503;
    case 'ETIMEDOUT':
      return 504;
    case 'ECANCELED':
    case 'EIO':
    case 'EBADF':
    case 'EMFILE':
    case 'ENOTTY':
    case 'EPIPE':
      return 500;
  }
}
