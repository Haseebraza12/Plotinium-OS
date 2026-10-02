/**
 * Eligibility and text extraction (rag-semantic-search.md §3.2.2, §3.2.3).
 *
 * Plain text and source code are used as decoded; Markdown is kept raw (the chunker uses its
 * headings); HTML tags are stripped by a tokenizer-level scan that keeps newlines, so line
 * numbers still point at the original file. No DOM parsing and no HTML sinks.
 */
export const INDEX_MAX_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;

export type TextKind = 'markdown' | 'code' | 'text';

const MARKDOWN_EXT = new Set(['md', 'markdown', 'rst']);
const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'py',
  'c',
  'h',
  'cpp',
  'hpp',
  'java',
  'go',
  'rs',
  'css',
  'json',
  'yaml',
  'yml',
  'toml',
  'sql',
  'sh',
]);
const TEXT_EXT = new Set(['txt']);
const HTML_EXT = new Set(['html']);

export type Eligibility =
  | { ok: true; kind: TextKind; html: boolean }
  | {
      ok: false;
      reason: 'location' | 'dot-dir' | 'type' | 'size' | 'binary' | 'encoding' | 'extension';
    };

function extensionOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/** Rule 1 and rule 4 of §3.2.2, from the path and inode type alone. */
export function pathEligibility(path: string, type: 'f' | 'd' | 'l'): Eligibility {
  if (type !== 'f') return { ok: false, reason: 'type' };
  if (!/^\/(home|mnt)\/./.test(path)) return { ok: false, reason: 'location' };
  const dirs = path.split('/').slice(1, -1);
  if (dirs.some((d) => d.startsWith('.'))) return { ok: false, reason: 'dot-dir' };
  const ext = extensionOf(path);
  if (ext === undefined) return { ok: true, kind: 'text', html: false };
  if (MARKDOWN_EXT.has(ext)) return { ok: true, kind: 'markdown', html: false };
  if (CODE_EXT.has(ext)) return { ok: true, kind: 'code', html: false };
  if (HTML_EXT.has(ext)) return { ok: true, kind: 'text', html: true };
  if (TEXT_EXT.has(ext)) return { ok: true, kind: 'text', html: false };
  return { ok: false, reason: 'extension' };
}

export type Extracted =
  { ok: true; kind: TextKind; text: string } | Extract<Eligibility, { ok: false }>;

/** Rules 2 and 3 (size, NUL sniff, strict UTF-8), then extraction. */
export function extractText(path: string, type: 'f' | 'd' | 'l', bytes: Uint8Array): Extracted {
  const elig = pathEligibility(path, type);
  if (!elig.ok) return elig;
  if (bytes.length > INDEX_MAX_BYTES) return { ok: false, reason: 'size' };
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return { ok: false, reason: 'binary' };
  let text: string;
  try {
    // fatal: lossy decoding is not allowed (§3.2.2 rule 3).
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: 'encoding' };
  }
  return { ok: true, kind: elig.kind, text: elig.html ? stripHtml(text) : text };
}

/**
 * Remove tags, comments and the bodies of script/style elements; keep every newline so line
 * numbers are unchanged. Entities are left as written (they are harmless as plain text).
 */
export function stripHtml(html: string): string {
  const keepNewlines = (s: string): string => s.replace(/[^\n]/g, '');
  return html
    .replace(/<!--[\s\S]*?-->/g, keepNewlines)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, keepNewlines)
    .replace(/<[^>]*>/g, (tag) => (tag.includes('\n') ? keepNewlines(tag) : ' '));
}
