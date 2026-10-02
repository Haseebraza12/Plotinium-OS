/**
 * Conflicted-copy names on the server (Spec: MUST, §9.3; offline-and-sync.md §3.12.2; SYN-08;
 * database.md §3.13): `<stem> (conflict from <username>, <YYYY-MM-DD>)[ n]<ext>`, where `<ext>` is
 * the part from the last '.' if that dot is not the first character, the date is the server
 * COMMIT date in PLOTINIUM_TZ (default Asia/Karachi), ` 2`, ` 3`, ... is appended inside the
 * suffix when the name is taken, the stem is shortened at a code-point boundary so the name stays
 * within 255 UTF-8 bytes, and the result is NFC.
 *
 * TODO(boundary): the spec builds this name with the isomorphic `vfs/names.ts` on both sides
 * (PVFS-16). The server may import only `@plotinium/vfs/path` and `@plotinium/vfs/perm` today
 * (tools/eslint-rules/boundaries.js, vfs/package.json exports), so this is a line-for-line mirror of
 * vfs/src/names.ts `conflictName`/`isoDate`; names.test.ts pins the two to the same outputs. Replace
 * it with `import { conflictName, isoDate } from '@plotinium/vfs/names'` once vfs exports `./names`
 * and the server boundary allows it (integration note).
 */
import { NAME_MAX, utf8Length } from '@plotinium/vfs/path';

export function splitExtension(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  return i > 0 ? { stem: name.slice(0, i), ext: name.slice(i) } : { stem: name, ext: '' };
}

function dropLastCodePoint(s: string): string {
  const cps = Array.from(s);
  cps.pop();
  return cps.join('');
}

/** The first candidate that `taken` does not reject (n = 1 has no number). */
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
        s = e;
        e = '';
      }
    }
    const candidate = (s + suffix + e).normalize('NFC');
    if (!taken(candidate)) return candidate;
  }
}

/** `YYYY-MM-DD` of `ms` in `timeZone`. */
export function isoDate(ms: number, timeZone = 'Asia/Karachi'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
