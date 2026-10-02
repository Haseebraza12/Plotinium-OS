/**
 * Root drop (agentic-shell.md §3.19; AGT-04, I-B6).
 *
 * The agent process always runs as the session's REAL login uid, even when `ai` is started from a
 * shell that ran `su`; it never holds uid 0. A direct root login cannot start the agent at all.
 * Root effects happen only through a per-plan elevation grant (the `batch` ops run as uid 0 while
 * the agent process keeps its own uid).
 */
import type { Cred } from '../util/cred.ts';
import { type Result, fail, ok } from '../util/errors.ts';

export const ROOT_REFUSAL =
  'ai: the agent never runs as root (§3.4); log in as a regular user and use su for elevation';

export interface Invoker {
  /** Effective credentials of the invoking shell (uid 0 after `su`). */
  effective: Cred;
  /** The session's real login credentials. */
  login: Cred;
}

/** The credentials the `ai.agent` process is spawned with. */
export function agentCredentials(inv: Invoker): Result<Cred> {
  if (inv.login.uid === 0) return fail('EPERM', 'root-only', undefined, ROOT_REFUSAL);
  return ok({ uid: inv.login.uid, gid: inv.login.gid, groups: [...inv.login.groups] });
}

/** Elevation needs a live `su` grant AND the secure-prompt password for this plan. */
export function elevationAllowed(args: {
  liveSuGrant: boolean;
  securePromptOk: boolean;
}): Result<undefined> {
  if (!args.liveSuGrant || !args.securePromptOk) return fail('EPERM', 'system-path');
  return ok(undefined);
}
