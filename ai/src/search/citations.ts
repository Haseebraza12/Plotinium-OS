/**
 * Citations and snippets (rag-semantic-search.md §3.5 step 8; RAG-06).
 *
 * A snippet is at most 240 characters, whitespace-collapsed, and never contains the chunk header.
 * Citations are rendered as plain text `path:lineStart-lineEnd  score  snippet`; control
 * characters (including ESC) are escaped so a file name or chunk text cannot inject terminal
 * escape sequences (ai-safety-and-evaluation.md §3.5 L10).
 */
export const SNIPPET_MAX = 240;

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Collapse whitespace and cut to 240 characters (the cut ends with an ellipsis). */
export function makeSnippet(text: string, max = SNIPPET_MAX): string {
  const flat = collapseWhitespace(text);
  const chars = [...flat];
  if (chars.length <= max) return flat;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** Code points escaped on TTY output: C0/C1 controls, DEL, bidi and zero-width format characters. */
export function isTtyUnsafe(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** Escape unsafe code points as `\u{XXXX}` so text cannot inject terminal sequences (L10). */
export function escapeForTty(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isTtyUnsafe(cp) ? `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}` : ch;
  }
  return out;
}

/** Snippet source in order of preference (§3.5 step 8). */
export function pickSnippet(sources: {
  preview?: string;
  localText?: string;
  serverSnippet?: string;
}): string {
  const text = sources.preview ?? sources.localText ?? sources.serverSnippet ?? '';
  return makeSnippet(text);
}

/** `~` for the caller's home directory, as the `semsearch` output shows it. */
export function displayPath(path: string, home?: string): string {
  if (home !== undefined && home !== '/' && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export interface Citation {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
}

/** One `semsearch` output line; a name-only match (lines 0) prints the path alone. */
export function formatCitation(c: Citation, home?: string): string {
  const where =
    c.lineStart > 0
      ? `${displayPath(c.path, home)}:${c.lineStart}-${c.lineEnd}`
      : displayPath(c.path, home);
  return escapeForTty(`${where}  ${c.score.toFixed(2)}  ${c.snippet}`);
}

/** `semsearch -l`: paths only, one per line (pipe-friendly, like `grep -l`). */
export function formatPathsOnly(results: readonly Citation[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(escapeForTty(r.path));
  }
  return out;
}
