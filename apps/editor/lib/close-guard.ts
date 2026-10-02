/**
 * The Editor's side of contract C4 (docs/design/bug-hunt/BUGS.md, UI-036 / UI-037): the system
 * call `window.setCloseGuard {wid, reason}` makes the desktop ask "Discard unsaved changes?"
 * (with `reason` as the explanation) before the window closes; `reason: null` removes the
 * question. The kernel side lands separately (UI-036), so the call is made by name: a kernel
 * without it answers ENOSYS (or refuses the unknown call), which means "no guard" and is never
 * shown to the user.
 */

/** A system-call client that can be asked for a call the protocol package may not list yet. */
interface CallByName {
  call(name: string, args: unknown): Promise<unknown>;
}

/** The syscall's name (contract C4). */
export const SET_CLOSE_GUARD = 'window.setCloseGuard';

/**
 * Sets (`reason`) or clears (`null`) the close guard of window `wid`. Resolves true when the
 * kernel accepted it, false when it could not (ENOSYS before UI-036, EPERM, EINVAL); never
 * rejects.
 */
export async function setCloseGuard(
  sys: object,
  wid: number,
  reason: string | null,
): Promise<boolean> {
  const client = sys as CallByName;
  try {
    await client.call(SET_CLOSE_GUARD, { wid, reason });
    return true;
  } catch {
    return false;
  }
}
