/**
 * Errors of ai/ are errno values from protocol (C3), optionally with a registered or proposed
 * `detail.reason` and the offending plan step. Functions return `Result`s instead of throwing, so a
 * rejected plan can never be half-applied by an exception path.
 */
import type { Errno } from '@plotinium/protocol';

export interface AiError {
  readonly errno: Errno;
  readonly reason?: string;
  readonly step?: string;
  readonly message?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AiError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(
  errno: Errno,
  reason?: string,
  step?: string,
  message?: string,
): Result<T> {
  const error: { errno: Errno; reason?: string; step?: string; message?: string } = { errno };
  if (reason !== undefined) error.reason = reason;
  if (step !== undefined) error.step = step;
  if (message !== undefined) error.message = message;
  return { ok: false, error };
}
