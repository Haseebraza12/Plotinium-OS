/**
 * Pure helpers of the Editor app (ui-design-system.md §3.8.12; VFS-09, VFS-10): launch
 * arguments, the lease view of the lock chip, and the exact banner strings.
 */
import type { LeaseInfo } from '@plotinium/protocol';

import { dirname, join, splitExtension } from '../../files/lib/path.ts';

/** One file to open, with an optional 1-based line (`editor notes.md +42`). */
export interface OpenRequest {
  readonly path: string;
  readonly line?: number;
}

/**
 * Parses the Editor's argv: paths, with `+N` or `--line N` (or `--line=N`) giving the line of
 * the path before it (or of the next path when it comes first, as in `vi +N file`). A leading
 * `editor` (the program name) is ignored.
 */
export function parseEditorArgs(argv: readonly string[]): OpenRequest[] {
  const out: { path: string; line?: number }[] = [];
  let pending: number | undefined;
  const args = argv[0] === 'editor' ? argv.slice(1) : argv;
  const setLine = (n: number): void => {
    const last = out.at(-1);
    if (last !== undefined && last.line === undefined) last.line = n;
    else pending = n;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const plus = /^\+(\d+)$/u.exec(arg);
    const eq = /^--line=(\d+)$/u.exec(arg);
    if (plus !== null) setLine(Number(plus[1]));
    else if (eq !== null) setLine(Number(eq[1]));
    else if (arg === '--line' && /^\d+$/u.test(args[i + 1] ?? '')) {
      setLine(Number(args[i + 1]));
      i += 1;
    } else if (arg !== '' && !arg.startsWith('--')) {
      out.push(pending === undefined ? { path: arg } : { path: arg, line: pending });
      pending = undefined;
    }
  }
  return out.map((r) => (r.line !== undefined && r.line >= 1 ? r : { path: r.path }));
}

/** The lock chip's state (ui `LockState`). */
export type LockView =
  | { kind: 'other'; holder: string; expiresAt: number; leaseMs: number; fence?: number }
  | { kind: 'mine' }
  | { kind: 'released'; holder: string };

/** Default lease length (C6: 30 s; the ring shows the share left). */
export const LEASE_MS = 30_000;

/** `alice` from `alice@lab-pc-3`. */
export function holderName(holder: string): string {
  const at = holder.indexOf('@');
  return at > 0 ? holder.slice(0, at) : holder;
}

/**
 * The chip for a file from its holders: another user's live X lease makes it read-only; this
 * window's own lease shows "Editing"; a lease that just ended shows "Editable" (released).
 */
export function lockViewOf(
  holders: readonly LeaseInfo[],
  opts: { user: string; mine: boolean; previous?: LockView; now: number },
): LockView | undefined {
  const other = holders.find(
    (h) =>
      h.mode === 'X' &&
      h.expiresAt > opts.now &&
      !(opts.mine && holderName(h.holder) === opts.user),
  );
  if (other !== undefined) {
    return {
      kind: 'other',
      holder: holderName(other.holder),
      expiresAt: other.expiresAt,
      leaseMs: LEASE_MS,
    };
  }
  if (opts.mine) return { kind: 'mine' };
  if (opts.previous?.kind === 'other') return { kind: 'released', holder: opts.previous.holder };
  return undefined;
}

/** Banners besides the sync conflict (exact strings of ui-design-system.md §3.8.12). */
export type BannerView =
  | { kind: 'changed'; name: string }
  | { kind: 'locked'; holder: string; seconds: number }
  | { kind: 'quota'; usedMb: string; totalMb: string }
  | { kind: 'permission' }
  | { kind: 'error'; text: string; errno: string };

export function bannerTitle(b: BannerView): string {
  switch (b.kind) {
    case 'changed':
      return `${b.name} was changed by another window.`;
    case 'locked':
      return `Locked by ${b.holder} — read-only. The lock expires in ${String(b.seconds)} s if ${b.holder}'s session stops.`;
    case 'quota':
      return `Not saved: your quota is full (${b.usedMb} of ${b.totalMb} MB). Nothing was written.`;
    case 'permission':
      return 'You can read this file but not write it.';
    case 'error':
      return `Not saved: ${b.text} (${b.errno})`;
  }
}

/** `99.8` MB with one decimal under 100, whole numbers above. */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_048_576;
  return mb < 100 ? (Math.round(mb * 10) / 10).toString() : Math.round(mb).toString();
}

/** A document's language as the Editor shows it (ui `EditorLanguage`). */
export type DocLanguage = 'markdown' | 'javascript' | 'typescript' | 'plain';

const LANGUAGE_EXTENSION: Readonly<Record<DocLanguage, string>> = {
  markdown: '.md',
  typescript: '.ts',
  javascript: '.js',
  plain: '.txt',
};

/**
 * The path Save As suggests (UI-102): a new document goes into the folder the sidebar shows
 * (its home folder when nothing is open) as `untitled` with the extension of its language; a
 * saved one as `<name> copy.<ext>` beside itself. Never a folder that may not exist.
 */
export function saveAsSuggestion(
  doc: { readonly path: string | undefined; readonly name: string },
  folder: string,
  language: DocLanguage,
): string {
  if (doc.path === undefined) return join(folder, `untitled${LANGUAGE_EXTENSION[language]}`);
  const { stem, ext } = splitExtension(doc.name);
  return join(dirname(doc.path), `${stem} copy${ext}`);
}

/**
 * The close guard's reason for a window's documents (UI-037, contract C4): null when nothing is
 * unsaved, else the sentence the desktop shows under "Discard unsaved changes?".
 */
export function closeGuardReason(
  docs: readonly { readonly name: string; readonly dirty: boolean }[],
): string | null {
  const dirty = docs.filter((d) => d.dirty);
  const first = dirty[0];
  if (first === undefined) return null;
  const text =
    dirty.length === 1
      ? `“${first.name}” has unsaved changes. They will be lost if you close this window.`
      : `${String(dirty.length)} documents have unsaved changes. They will be lost if you close this window.`;
  return text.slice(0, 256);
}
