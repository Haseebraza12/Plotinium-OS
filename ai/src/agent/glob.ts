/**
 * Basename glob matching for plan selectors (agentic-shell.md §3.6, §5.4): `*`, `?`, `[…]` with
 * ranges and `!`/`^` negation, and `**` (which matches like `*` inside one name). Never a regular
 * expression (INV-ABI-7).
 *
 * Iterative two-pointer matcher with ONE backtrack point (the last `*`): O(n·m) worst case for
 * name length n and pattern length m, no exponential backtracking.
 *
 * TODO(R2): the kernel's `find` uses the VFS matcher; ai/ may not import vfs/, so this copy serves
 * the plan overlay and the evaluation fixtures until the kernel exposes find through the AI seam.
 */

type Token =
  | { t: 'char'; c: string }
  | { t: 'any' }
  | { t: 'star' }
  | { t: 'class'; negate: boolean; items: Array<[string, string]> };

function parse(pattern: string): Token[] {
  const chars = [...pattern];
  const out: Token[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? '';
    if (c === '*') {
      if (out[out.length - 1]?.t !== 'star') out.push({ t: 'star' });
    } else if (c === '?') out.push({ t: 'any' });
    else if (c === '\\' && i + 1 < chars.length) out.push({ t: 'char', c: chars[++i] ?? '' });
    else if (c === '[') {
      let j = i + 1;
      let negate = false;
      if (chars[j] === '!' || chars[j] === '^') {
        negate = true;
        j++;
      }
      const items: Array<[string, string]> = [];
      let first = true;
      while (j < chars.length && (chars[j] !== ']' || first)) {
        const lo = chars[j] ?? '';
        if (chars[j + 1] === '-' && j + 2 < chars.length && chars[j + 2] !== ']') {
          items.push([lo, chars[j + 2] ?? lo]);
          j += 3;
        } else {
          items.push([lo, lo]);
          j++;
        }
        first = false;
      }
      if (j >= chars.length) out.push({ t: 'char', c: '[' });
      else {
        out.push({ t: 'class', negate, items });
        i = j;
      }
    } else out.push({ t: 'char', c });
  }
  return out;
}

function single(tok: Token, ch: string): boolean {
  switch (tok.t) {
    case 'char':
      return tok.c === ch;
    case 'any':
      return true;
    case 'class': {
      const hit = tok.items.some(([lo, hi]) => ch >= lo && ch <= hi);
      return hit !== tok.negate;
    }
    case 'star':
      return false;
  }
}

export function globMatch(pattern: string, name: string): boolean {
  const p = parse(pattern);
  const s = [...name];
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si < s.length) {
    const tok = p[pi];
    if (tok !== undefined && tok.t !== 'star' && single(tok, s[si] ?? '')) {
      pi++;
      si++;
    } else if (tok?.t === 'star') {
      starP = pi++;
      starS = si;
    } else if (starP >= 0) {
      pi = starP + 1;
      si = ++starS;
    } else return false;
  }
  while (p[pi]?.t === 'star') pi++;
  return pi === p.length;
}
