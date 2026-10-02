/**
 * Local advisory locks through the Web Locks API (virtual-file-system.md §3.16.1 "Degraded";
 * PVFS-13). Names are `plotinium:vfs:<ino>` in `shared` or `exclusive` mode, requested by the kernel
 * on behalf of its processes, so they are released automatically if the kernel worker dies.
 *
 * The Web Locks API rejects `ifAvailable` together with `signal` (NotSupportedError), so `signal`
 * is passed only for a waiting request.
 */
import type { LeaseMode, LockManagerLike } from './types.ts';

export const advisoryName = (ino: string): string => `plotinium:vfs:${ino}`;

export interface AdvisoryHandle {
  readonly mode: LeaseMode;
  release(): void;
}

/**
 * Take the advisory lock of `ino`. Resolves with a handle, or null when it is not available
 * (`wait` false) or the request failed (for example aborted).
 */
export function requestAdvisory(
  locks: LockManagerLike,
  ino: string,
  mode: LeaseMode,
  wait: boolean,
  signal?: AbortSignal,
): Promise<AdvisoryHandle | null> {
  return new Promise((resolve) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const options = {
      mode: mode === 'X' ? ('exclusive' as const) : ('shared' as const),
      ...(wait ? (signal === undefined ? {} : { signal }) : { ifAvailable: true }),
    };
    locks
      .request(advisoryName(ino), options, (lock) => {
        if (lock === null) {
          resolve(null);
          return undefined;
        }
        resolve({ mode, release });
        return held;
      })
      .catch(() => resolve(null));
  });
}

/** `navigator.locks` of the kernel worker, when the runtime has it. */
export function platformLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks;
}
