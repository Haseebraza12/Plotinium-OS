/**
 * The kernel's confirmation predicate and the kernel-owned TTY prompt (agentic-shell.md §3.13;
 * syscall-abi.md §5.4 rule 2; AGT-03).
 *
 * `needsConfirmation` is the ONLY decision point (I-B4): the model has no input to it except
 * through flags the kernel computed (`suspicious_content_seen` can only add confirmation). The
 * categories of the ABI are delete, overwrite, chmod, chown, more than 20 touched inodes and
 * system paths; agentic-shell.md adds unlicensed, ungrounded, suspicious, edited and elevated
 * plans. Only the ABI categories fit `SubmitResult.confirm.reasons` (protocol's picklist).
 *
 * The answer is read ONLY from kernel-owned TTY input after type-ahead is flushed; the default is
 * N. Without a controlling TTY in the foreground, a plan that needs confirmation is refused with
 * ENOTTY, so `yes | ai …` can never confirm.
 */
import {
  type BatchOp,
  CONFIRM_INODE_THRESHOLD,
  type ConfirmReason,
  type Errno,
} from '@plotinium/protocol';

import type { ResolvedOp } from './apply.ts';
import type { DryRunFlags } from './validator.ts';

export type ExtraReason = 'unlicensed' | 'ungrounded' | 'suspicious' | 'edited' | 'elevation';
export type Reason = ConfirmReason | ExtraReason;

const ABI_REASONS: ReadonlySet<string> = new Set([
  'delete',
  'overwrite',
  'chmod',
  'chown',
  'over-20-inodes',
  'system-path',
]);

export interface PredicateInput {
  ops: ReadonlyArray<Pick<ResolvedOp, 'call' | 'kind' | 'overwrites'>>;
  affectedInodes: number;
  systemPath: boolean;
  flags: DryRunFlags;
}

export function needsConfirmation(dr: PredicateInput): { required: boolean; reasons: Reason[] } {
  const r: Reason[] = [];
  if (dr.ops.some((o) => o.kind === 'delete')) r.push('delete');
  if (dr.ops.some((o) => o.overwrites !== undefined)) r.push('overwrite');
  if (dr.ops.some((o) => o.call === 'chmod')) r.push('chmod');
  if (dr.ops.some((o) => o.call === 'chown')) r.push('chown');
  // Spec: "more than 20 inodes" — exactly 20 does not need confirmation.
  if (dr.affectedInodes > CONFIRM_INODE_THRESHOLD) r.push('over-20-inodes');
  if (dr.systemPath) r.push('system-path');
  if (dr.flags.unlicensed) r.push('unlicensed');
  if (dr.flags.ungrounded) r.push('ungrounded');
  if (dr.flags.suspicious) r.push('suspicious');
  if (dr.flags.edited) r.push('edited');
  if (dr.flags.elevation) r.push('elevation');
  return { required: r.length > 0, reasons: r };
}

/** The reasons that `SubmitResult.confirm.reasons` can carry. */
export function abiReasons(reasons: readonly Reason[]): ConfirmReason[] {
  return reasons.filter((r): r is ConfirmReason => ABI_REASONS.has(r));
}

/** One secure read from the kernel TTY. */
export type TtyRead = { kind: 'line'; text: string } | { kind: 'eof' } | { kind: 'timeout' };

/** What the kernel's TTY line discipline offers the confirmation (shell-and-terminal.md). */
export interface ConfirmTty {
  /** The agent's session has a controlling TTY and its group is the foreground group. */
  interactive(): boolean;
  /** Suspend input to the foreground group and discard type-ahead. */
  flushTypeAhead(): void;
  write(text: string): void;
  /** One canonical-mode line from the kernel-owned TTY; never the agent's stdin. */
  secureReadLine(timeoutMs: number): Promise<TtyRead>;
}

export type ConfirmOutcome =
  | { granted: true; answer: 'y' }
  | { granted: false; answer: 'edit' }
  | {
      granted: false;
      answer: 'n' | 'timeout' | 'no-tty';
      errno: Errno;
      outcome: 'declined' | 'confirm_timeout' | 'no_tty';
    };

export const CONFIRM_TIMEOUT_MS = 120_000;
export const PROMPT = 'Proceed? [y/N/e=edit] ';

/** Interpret one answer: only `y`/`yes` (any case) confirms; empty, anything else or EOF is N. */
export function interpretAnswer(read: TtyRead): ConfirmOutcome {
  if (read.kind === 'timeout')
    return { granted: false, answer: 'timeout', errno: 'ECANCELED', outcome: 'confirm_timeout' };
  if (read.kind === 'eof')
    return { granted: false, answer: 'n', errno: 'ECANCELED', outcome: 'declined' };
  const a = read.text.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return { granted: true, answer: 'y' };
  if (a === 'e') return { granted: false, answer: 'edit' };
  return { granted: false, answer: 'n', errno: 'ECANCELED', outcome: 'declined' };
}

/** The kernel side of `ai.agent.confirm`: render, flush type-ahead, read one secure line. */
export async function confirmOnTty(tty: ConfirmTty, rendered: string): Promise<ConfirmOutcome> {
  if (!tty.interactive())
    return { granted: false, answer: 'no-tty', errno: 'ENOTTY', outcome: 'no_tty' };
  tty.flushTypeAhead();
  tty.write(`${rendered}\n${PROMPT}`);
  return interpretAnswer(await tty.secureReadLine(CONFIRM_TIMEOUT_MS));
}

/**
 * Defence in depth (§3.13): `batch` recomputes the predicate over the ops it actually received,
 * whatever path the call came from. A rename into `$HOME/.trash/` is a delete; `exists` tells
 * whether a write, rename, copy or symlink target already exists (an overwrite).
 */
export function opsRequireConfirmation(
  ops: readonly BatchOp[],
  ctx: { home: string; affectedInodes: number; exists(path: string): boolean },
): boolean {
  const trash = `${ctx.home}/.trash/`;
  const system = (p: string): boolean =>
    ['/system', '/bin'].some((r) => p === r || p.startsWith(`${r}/`));
  if (ctx.affectedInodes > CONFIRM_INODE_THRESHOLD) return true;
  return ops.some((op) => {
    switch (op.op) {
      case 'unlink':
      case 'chmod':
      case 'chown':
        return true;
      case 'rename':
        return op.to.startsWith(trash) || ctx.exists(op.to) || system(op.from) || system(op.to);
      case 'copy':
        return ctx.exists(op.to) || system(op.to);
      case 'write':
      case 'symlink':
        return ctx.exists(op.path) || system(op.path);
      case 'mkdir':
      case 'utimes':
        return system(op.path);
    }
  });
}
