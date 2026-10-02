/**
 * Names (virtual-file-system.md §3.15.3, §5.5, §3.21): conflicted-copy names and lost+found names.
 * Isomorphic (PVFS-16): pure TypeScript, so the server computes the same names.
 */
import { NAME_MAX, utf8Length } from './path.ts';

/** Drop the last code point of `s`. */
function dropLastCodePoint(s: string): string {
  const cps = Array.from(s);
  cps.pop();
  return cps.join('');
}

/** Split at the last '.' that is not the first character (a dotfile has no extension). */
export function splitExtension(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  return i > 0 ? { stem: name.slice(0, i), ext: name.slice(i) } : { stem: name, ext: '' };
}

/**
 * `conflictName` (§5.5): `<stem> (conflict from <user>, <YYYY-MM-DD>)[ n]<ext>`, the first candidate
 * `taken` rejects, with the stem shortened at a code-point boundary to stay within 255 bytes.
 */
export function conflictName(
  name: string,
  user: string,
  date: string,
  taken: (candidate: string) => boolean,
): string {
  const { stem, ext } = splitExtension(name);
  for (let n = 1; ; n++) {
    const suffix = ` (conflict from ${user}, ${date})${n > 1 ? ` ${n}` : ''}`;
    let s = stem;
    let e = ext;
    while (utf8Length(s + suffix + e) > NAME_MAX) {
      if (s !== '') s = dropLastCodePoint(s);
      else {
        // An absurdly long extension becomes the stem.
        s = e;
        e = '';
      }
    }
    const candidate = s + suffix + e;
    if (!taken(candidate)) return candidate;
  }
}

/** `YYYY-MM-DD` of `ms` in `timeZone` (the configured OS time zone; UTC by default). */
export function isoDate(ms: number, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `#<first 12 hex digits of ino>`, then `-2`, `-3`… if taken (fsck, §3.21). */
export function lostFoundName(ino: string, taken: (candidate: string) => boolean): string {
  const base = `#${ino.replaceAll('-', '').slice(0, 12)}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Code-point order (= UTF-8 byte order = the server's pg_c_utf8 order), not UTF-16 order (§3.4). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx - cy;
  }
}
