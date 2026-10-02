/**
 * Pathname-pattern matching for one path component (shell-and-terminal.md §3.6 step 4, SHL-05).
 *
 * Patterns use `*`, `?` and `[…]` (with `!`/`^` negation and ranges); a backslash escapes the
 * next character (expansion escapes every quoted character this way). Matching is the two-pointer
 * wildcard algorithm: O(len(name) × len(pattern)) worst case, never exponential.
 */

type GlobTok =
  | { k: 'lit'; c: string }
  | { k: 'one' }
  | { k: 'any' }
  | { k: 'set'; negate: boolean; items: { lo: string; hi: string }[] };

/** Escapes a literal so `matchGlob` treats it verbatim. */
export function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

/** Removes the escapes that `escapeGlob` added. */
export function unescapeGlob(pattern: string): string {
  return pattern.replace(/\\(.)/gsu, '$1');
}

/** True when the pattern has an unescaped `*`, `?` or `[`. */
export function hasGlobMeta(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') i++;
    else if (c === '*' || c === '?' || c === '[') return true;
  }
  return false;
}

function parseSet(chars: string[], open: number): { tok: GlobTok; next: number } | null {
  let j = open + 1;
  let negate = false;
  if (chars[j] === '!' || chars[j] === '^') {
    negate = true;
    j++;
  }
  const items: { lo: string; hi: string }[] = [];
  let first = true;
  while (j < chars.length && (chars[j] !== ']' || first)) {
    let lo = chars[j] ?? '';
    if (lo === '\\' && j + 1 < chars.length) lo = chars[++j] ?? '';
    let hi = lo;
    if (chars[j + 1] === '-' && j + 2 < chars.length && chars[j + 2] !== ']') {
      hi = chars[j + 2] ?? lo;
      j += 2;
    }
    items.push({ lo, hi });
    j++;
    first = false;
  }
  if (j >= chars.length) return null;
  return { tok: { k: 'set', negate, items }, next: j + 1 };
}

function tokenize(pattern: string): GlobTok[] {
  const chars = Array.from(pattern);
  const toks: GlobTok[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? '';
    if (c === '\\' && i + 1 < chars.length) {
      toks.push({ k: 'lit', c: chars[++i] ?? '' });
    } else if (c === '*') {
      if (toks.at(-1)?.k !== 'any') toks.push({ k: 'any' });
    } else if (c === '?') {
      toks.push({ k: 'one' });
    } else if (c === '[') {
      const set = parseSet(chars, i);
      if (set === null) toks.push({ k: 'lit', c });
      else {
        toks.push(set.tok);
        i = set.next - 1;
      }
    } else {
      toks.push({ k: 'lit', c });
    }
  }
  return toks;
}

function matchOne(tok: GlobTok, ch: string): boolean {
  switch (tok.k) {
    case 'lit':
      return tok.c === ch;
    case 'one':
      return true;
    case 'any':
      return false;
    case 'set': {
      const cp = ch.codePointAt(0) ?? 0;
      const hit = tok.items.some(
        (r) => cp >= (r.lo.codePointAt(0) ?? 0) && cp <= (r.hi.codePointAt(0) ?? 0),
      );
      return hit !== tok.negate;
    }
  }
}

/**
 * Whether `name` matches the component `pattern`. A name beginning with `.` matches only a
 * pattern that begins with a literal `.` (§3.6).
 */
export function matchGlob(pattern: string, name: string): boolean {
  const toks = tokenize(pattern);
  const s = Array.from(name);
  if (s[0] === '.') {
    const first = toks[0];
    if (first?.k !== 'lit' || first.c !== '.') return false;
  }
  let p = 0;
  let i = 0;
  let starP = -1;
  let starI = 0;
  while (i < s.length) {
    const tok = toks[p];
    if (tok !== undefined && tok.k !== 'any' && matchOne(tok, s[i] ?? '')) {
      p++;
      i++;
    } else if (tok?.k === 'any') {
      starP = p++;
      starI = i;
    } else if (starP >= 0) {
      p = starP + 1;
      i = ++starI;
    } else {
      return false;
    }
  }
  while (toks[p]?.k === 'any') p++;
  return p === toks.length;
}

/** Code-point order, as §3.6 requires for sorted matches (JS `<` compares UTF-16 units). */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
