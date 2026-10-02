/**
 * Memory-manager errors. The syscall dispatcher maps an `MmError` to the wire errno with
 * `detail.reason` (syscall-abi.md §4.3); errno names come from @plotinium/protocol.
 *
 * Reasons used here (memory-and-paging.md §6): EINVAL `exceeds-budget` (a request that can never
 * fit; ENOMEM is only requested, protocol/src/sys/mem.ts), EAGAIN `mem-pressure` (blocked longer
 * than MEM_WAIT_MAX_MS), EAGAIN `thrashing`, EAGAIN `no-free-memory`, EIO `checksum`, EIO
 * `storage`, EBUSY for a page-out while a non-restartable call is in flight.
 */
import type { Errno } from '@plotinium/protocol';

export class MmError extends Error {
  readonly errno: Errno;
  readonly reason: string | undefined;

  constructor(errno: Errno, reason?: string, message?: string) {
    super(message ?? (reason ? `${errno} (${reason})` : errno));
    this.name = 'MmError';
    this.errno = errno;
    this.reason = reason;
  }
}

export function isMmError(e: unknown): e is MmError {
  return e instanceof MmError;
}
