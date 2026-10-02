/**
 * AI error texts shared by `ai`, `semsearch` and `predict` (agentic-shell.md §3.20; nothing runs in
 * any of these cases and the shell stays usable).
 */
import { describe, mustErrno, reasonOf } from './errors.ts';

/** `detail.retryAfterMs` of a rate-limited call, in whole seconds. */
function retryAfter(e: unknown): number | null {
  if (typeof e !== 'object' || e === null || !('detail' in e)) return null;
  const detail: unknown = e.detail;
  if (typeof detail !== 'object' || detail === null || !('retryAfterMs' in detail)) return null;
  return typeof detail.retryAfterMs === 'number' ? Math.ceil(detail.retryAfterMs / 1000) : null;
}

/** The message after `ai: ` for an unavailable or refused agent; null for other errnos. */
export function aiUnavailable(e: unknown): string | null {
  const errno = mustErrno(e);
  if (errno === 'EAIREFUSED') return 'the model declined this request — nothing was run';
  if (errno !== 'EAIUNAVAIL' && errno !== 'ENOSYS') return null;
  const reason = reasonOf(e);
  const secs = retryAfter(e);
  const texts: Readonly<Record<string, string>> = {
    offline: 'agent unavailable (offline) — nothing was run; find, mv and chmod still work',
    rate: `agent busy (rate limit) — nothing was run${secs === null ? '' : `; retry in ${secs} s`}`,
    budget: "today's AI budget is used up — nothing was run",
    expired: 'conversation expired — nothing was run; please retry',
    'safe-mode': 'AI services are disabled in safe mode',
  };
  const known = reason === undefined ? undefined : texts[reason];
  if (known !== undefined) return known;
  return errno === 'ENOSYS'
    ? 'agent unavailable (not installed) — nothing was run'
    : 'agent unavailable (model service) — nothing was run';
}

/** Any AI call failure as one line (without the command prefix). */
export function aiError(e: unknown): string {
  return aiUnavailable(e) ?? describe(e);
}
