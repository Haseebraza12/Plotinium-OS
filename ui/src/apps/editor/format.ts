/**
 * Pure helpers for the Editor views: conflicted-copy names (SYN-08), the Markdown outline,
 * lease countdowns (VFS-09) and status-bar labels.
 */
import type { EditorLanguage } from './CodeEditor.tsx';

function isoDay(date: Date | string): string {
  if (typeof date === 'string') return date.slice(0, 10);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * `name (conflict from <user>, <YYYY-MM-DD>).ext` (offline-and-sync.md SYN-08), dated by the
 * server's commit time. A leading dot is part of the name, not an extension.
 */
export function conflictedCopyName(fileName: string, user: string, date: Date | string): string {
  const dot = fileName.lastIndexOf('.');
  const hasExt = dot > 0 && dot < fileName.length - 1;
  const base = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : '';
  return `${base} (conflict from ${user}, ${isoDay(date)})${ext}`;
}

export interface OutlineHeading {
  /** 1–6. */
  level: number;
  text: string;
  /** 1-based line of the heading. */
  line: number;
}

/** ATX headings of a Markdown document, skipping fenced code blocks. */
export function markdownOutline(doc: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  let fence: string | undefined;
  doc.split('\n').forEach((raw, index) => {
    const text = raw.replace(/\r$/u, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(text);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '';
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(text);
    if (heading !== null) {
      out.push({ level: (heading[1] ?? '#').length, text: heading[2] ?? '', line: index + 1 });
    }
  });
  return out;
}

/** The heading whose section contains `line` (the last heading at or above it). */
export function activeHeading(
  outline: readonly OutlineHeading[],
  line: number,
): OutlineHeading | undefined {
  let found: OutlineHeading | undefined;
  for (const heading of outline) {
    if (heading.line > line) break;
    found = heading;
  }
  return found;
}

/** Whole seconds left on a lease, never negative (the chip shows "lease 12 s"). */
export function leaseSecondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function languageLabel(language: EditorLanguage | undefined): string {
  switch (language) {
    case 'markdown':
      return 'Markdown';
    case 'javascript':
      return 'JavaScript';
    case 'typescript':
      return 'TypeScript';
    case 'plain':
    case undefined:
      return 'Plain Text';
  }
}

/** Language from a file name, for tabs and the status bar. */
export function languageOf(fileName: string): EditorLanguage {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs' || ext === 'json')
    return 'javascript';
  return 'plain';
}

/** Short tab badge: MD, TS, JS or TXT. */
export function languageBadge(language: EditorLanguage): string {
  switch (language) {
    case 'markdown':
      return 'MD';
    case 'typescript':
      return 'TS';
    case 'javascript':
      return 'JS';
    case 'plain':
      return 'TXT';
  }
}
