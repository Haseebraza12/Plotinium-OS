/**
 * The user's home and the server's home must be the SAME inode before sync may send the user's ops
 * (C5: homes are minted by the server; offline-and-sync.md §3.8.3; UI-006).
 *
 * A device formats its own tree and, when nobody on it has used an account yet, creates
 * `/home/<user>` at the first sign-in. Online, that home takes the id the server minted
 * (`ServerApi.homeIno`), so every op under it names a directory the server knows. A home made
 * before (offline, or by an older build) keeps its id if it holds anything; an empty one is moved to
 * the server's id (`relinkEmptyHome`). A home that cannot be linked leaves sync DEGRADED with a
 * reason that says so, instead of sending ops the server would reject and revert.
 */
import type { KernelFs } from '../fs/kfs.ts';
import type { RelinkRefusal } from '../fs/users.ts';
import { relinkEmptyHome } from '../fs/users.ts';
import type { Kernel } from '../kernel.ts';
import type { ServerApi } from './http.ts';

/** How long sign-in waits for the server's home id (the `login` service has 2 s in total). */
export const HOME_LOOKUP_LOGIN_MS = 1_000;
/** How long the `sync` service waits for it (4 s budget). */
export const HOME_LOOKUP_SYNC_MS = 2_500;

export type HomeLink =
  | { readonly linked: true; readonly ino: string }
  | {
      readonly linked: false;
      /** Why, for the service reason. */
      readonly reason: string;
      /** Retrying later can succeed (the server did not answer). */
      readonly selfHeals: boolean;
    };

const REFUSAL: Readonly<Record<RelinkRefusal, string>> = {
  'no-user': 'no home folder on this device',
  'not-empty': 'home folder made offline on this device (not linked to the server)',
  'pending-ops': 'home folder has unsynced changes made before it was linked',
  'in-use': 'home folder in use; sign in again to link it',
};

/** The processes that have `ino` as their working directory. */
export function cwdUsers(kernel: Kernel, ino: string): number {
  return kernel.procs.table.values().filter((p) => p.state !== 'TERMINATED' && p.cwdIno === ino)
    .length;
}

/**
 * Make the console user's local home the server's home when that is safe, and report whether it
 * is. `serverIno`: the id already looked up at sign-in, if any (`undefined` = look it up now).
 */
export async function linkHome(o: {
  readonly kernel: Kernel;
  readonly fs: KernelFs;
  readonly api: ServerApi;
  readonly uid: number;
  readonly username: string;
  readonly serverIno?: string | null;
  readonly timeoutMs: number;
}): Promise<HomeLink> {
  const ino =
    o.serverIno === undefined ? await o.api.homeIno(o.username, o.timeoutMs) : o.serverIno;
  if (ino === undefined)
    return { linked: false, reason: 'server did not answer; home not verified', selfHeals: true };
  if (ino === null)
    return { linked: false, reason: 'no home folder on the server', selfHeals: false };
  const local = o.fs.tree.user(o.uid)?.homeIno;
  if (local === ino) return { linked: true, ino };
  const r = await relinkEmptyHome(o.fs, o.uid, ino, (old) => cwdUsers(o.kernel, old) > 0);
  if (r.ok) {
    o.kernel.log(
      'sync',
      'info',
      `home of ${o.username} linked to the server's (${ino.slice(0, 8)}…)`,
    );
    return { linked: true, ino };
  }
  return { linked: false, reason: REFUSAL[r.why], selfHeals: false };
}
