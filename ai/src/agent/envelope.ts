/**
 * The envelope and observation blocks sent to the planner, with datamarking (agentic-shell.md
 * §3.4; AGT-06, ai-safety-and-evaluation.md §3.5 L3).
 *
 * 1. Every untrusted line starts with `^` + a per-request nonce of 4 base62 characters; the
 *    closing tag repeats the nonce. A nonce that occurs inside any rendered untrusted text is
 *    redrawn, so a name can neither guess nor forge the marker.
 * 2. Names are JSON-style string literals; control characters, `<`, `>`, bidi overrides and
 *    isolates, LRM/RLM, zero-width characters and Unicode tag characters become `\u{XXXX}`.
 * 3. Names longer than 120 characters are cut with `…(+N bytes)`.
 * 4. A listing holds at most 150 entries plus a count line: directories first, then newest first.
 * 5. Kernel-authored text (`<request>`, `<kernel_context>`) is never inside an untrusted block and
 *    untrusted text is never outside one. File contents never appear at all (I-B5).
 *
 * Pure: the nonce comes from an injected random source and the clock from the caller, so two
 * envelopes built with the same seed and frozen clock are byte-identical (cassette determinism).
 */
import { ENVELOPE_LISTING_MAX } from '@plotinium/protocol';

import { utf8Length } from '../util/bytes.ts';
import type { RandomSource } from '../util/rng.ts';

export const NAME_MAX_CHARS = 120;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const NONCE_LEN = 4;

function mustEscape(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x3c ||
    cp === 0x3e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

/** Escape untrusted text for the envelope (no quotes added). */
export function escapeUntrusted(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (mustEscape(cp) || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;
    } else out += ch;
  }
  return out;
}

/** Cut to 120 characters with `…(+N bytes)`, then quote and escape. */
export function renderName(name: string): string {
  const chars = [...name];
  if (chars.length <= NAME_MAX_CHARS) return `"${escapeUntrusted(name)}"`;
  const kept = chars.slice(0, NAME_MAX_CHARS).join('');
  const rest = utf8Length(chars.slice(NAME_MAX_CHARS).join(''));
  return `"${escapeUntrusted(kept)}…(+${rest} bytes)"`;
}

export function drawNonce(rng: RandomSource, untrusted: readonly string[]): string {
  for (;;) {
    let nonce = '';
    for (let i = 0; i < NONCE_LEN; i++) nonce += BASE62.charAt(rng() % 62);
    if (!untrusted.some((s) => s.includes(nonce))) return nonce;
  }
}

/** Wrap rendered untrusted lines in a datamarked block with a nonce that none of them contains. */
export function datamark(
  source: string,
  lines: readonly string[],
  rng: RandomSource,
): { nonce: string; text: string } {
  const src = escapeUntrusted(source);
  const nonce = drawNonce(rng, [...lines, src]);
  const body = lines.map((l) => `^${nonce} ${l}`).join('\n');
  const text = `<untrusted source="${src}" marker="${nonce}">\n${body}${body === '' ? '' : '\n'}</untrusted marker="${nonce}">`;
  return { nonce, text };
}

export interface ListingEntry {
  name: string;
  type: 'f' | 'd' | 'l';
  size: number;
  mtime: number;
}

/** `1.2MB`, `340KB`, `0B` (decimal units, one decimal below 10). */
export function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const text = u === 0 || v >= 10 ? Math.round(v).toString() : v.toFixed(1);
  return `${text}${units[u] ?? 'B'}`;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in an IANA time zone. */
export function localParts(ms: number, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const get = (type: string): number =>
    Number(fmt.formatToParts(new Date(ms)).find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');

/** `2026-11-15T18:40` in the user's time zone. */
export function localMinute(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset of `tz` from UTC at instant `ms`, in minutes. */
export function tzOffsetMinutes(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** ISO 8601 with the zone's numeric offset, e.g. `2026-11-16T10:12:00+05:00`. */
export function isoWithOffset(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  const off = tzOffsetMinutes(ms, tz);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Listing lines (§3.4 rule 4): directories first, then by mtime descending, then by name. */
export function listingLines(
  entries: readonly ListingEntry[],
  total: number,
  tz: string,
): string[] {
  const sorted = [...entries].sort((a, b) => {
    if ((a.type === 'd') !== (b.type === 'd')) return a.type === 'd' ? -1 : 1;
    return b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  const shown = sorted.slice(0, ENVELOPE_LISTING_MAX);
  const lines = shown.map(
    (e) =>
      `${e.type} ${renderName(e.name)} ${e.type === 'd' ? '-' : humanSize(e.size)} ${localMinute(e.mtime, tz)}`,
  );
  const more = Math.max(0, total - shown.length);
  if (more > 0) lines.push(`… ${more} more entries (cap ${ENVELOPE_LISTING_MAX})`);
  return lines;
}

export interface KernelContext {
  uid: number;
  user: string;
  groups: readonly string[];
  cwd: string;
  home: string;
  now: string;
  tz: string;
  scope: readonly string[];
}

/** Kernel JSON with `<` and `>` escaped, so it can never close or open a tag. */
export function kernelJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export interface FirstTurnInput {
  request: string;
  context: KernelContext;
  listing: readonly ListingEntry[];
  listingTotal: number;
  rng: RandomSource;
}

/** The exact first user turn (whitespace significant for caching and cassettes). */
export function renderFirstTurn(input: FirstTurnInput): { nonce: string; text: string } {
  const c = input.context;
  const ctx = kernelJson({
    uid: c.uid,
    user: c.user,
    groups: c.groups,
    cwd: c.cwd,
    home: c.home,
    now: c.now,
    tz: c.tz,
    scope: c.scope,
  });
  const block = datamark(
    `readdirPlus ${c.cwd}`,
    listingLines(input.listing, input.listingTotal, c.tz),
    input.rng,
  );
  const request = input.request.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return {
    nonce: block.nonce,
    text: `<request>${request}</request>\n<kernel_context>${ctx}</kernel_context>\n${block.text}`,
  };
}

/** A clarification answer as a new user turn (kernel-authored, never inside an untrusted block). */
export function renderClarification(answer: string): string {
  return `<clarification>${answer.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</clarification>`;
}
