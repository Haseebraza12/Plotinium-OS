/**
 * Word expansion (shell-and-terminal.md §3.6, SHL-05), in the order tilde, parameter, field
 * splitting of unquoted results, pathname expansion, quote removal. Quote removal is implicit:
 * word parts already carry their unquoted text and whether it was quoted.
 */
import type { SysGen } from '../src/_sys.ts';
import { errnoOf } from '../src/_sys.ts';
import type { Word, WordPart } from './ast.ts';
import { compareCodePoints, escapeGlob, hasGlobMeta, matchGlob, unescapeGlob } from './glob.ts';
import type { Sh } from './state.ts';
import { getVar } from './vars.ts';

/** A run of text inside one field; `glob` text keeps its pattern characters active. */
interface Seg {
  text: string;
  glob: boolean;
}

interface Field {
  segs: Seg[];
  /** A quoted part makes the field exist even when it is empty (`""`). */
  forced: boolean;
}

const IFS = /[ \t\n]+/;

/** The value of a parameter, or undefined when unset (`$@` is handled by the caller). */
export function paramValue(sh: Sh, name: string): string | undefined {
  const st = sh.st;
  switch (name) {
    case '?':
      return String(st.status);
    case '$':
      return String(st.pid);
    case '!':
      return st.lastBg === null ? '' : String(st.lastBg);
    case '#':
      return String(st.positional.length);
    case '0':
      return st.name;
    case '@':
      return st.positional.join(' ');
    default:
      if (/^[1-9]$/.test(name)) return st.positional[Number(name) - 1];
      return getVar(st.vars, name);
  }
}

class FieldBuilder {
  readonly fields: Field[] = [];
  private cur: Field = { segs: [], forced: false };

  add(text: string, glob: boolean, forced: boolean): void {
    if (text.length > 0) this.cur.segs.push({ text, glob });
    if (forced) this.cur.forced = true;
  }

  /** Ends the current field (an unquoted separator or a `"$@"` boundary). */
  cut(): void {
    if (this.cur.forced || this.cur.segs.length > 0) this.fields.push(this.cur);
    this.cur = { segs: [], forced: false };
  }

  finish(): Field[] {
    this.cut();
    return this.fields;
  }

  /** Adds unquoted expansion text, splitting it on IFS whitespace (step 3). */
  addSplit(text: string): void {
    const pieces = text.split(IFS);
    pieces.forEach((piece, i) => {
      if (i > 0) this.cut();
      this.add(piece, true, false);
    });
  }
}

function homeOf(sh: Sh, user: string | null, homes: ReadonlyMap<string, string>): string | null {
  if (user === null) return getVar(sh.st.vars, 'HOME') ?? null;
  return homes.get(user) ?? null;
}

function buildFields(sh: Sh, parts: WordPart[], homes: ReadonlyMap<string, string>): Field[] {
  const b = new FieldBuilder();
  for (const p of parts) {
    switch (p.t) {
      case 'lit':
        b.add(p.v, false, p.quoted);
        break;
      case 'glob':
        b.add(p.v, true, true);
        break;
      case 'tilde': {
        const home = homeOf(sh, p.user, homes);
        // An unknown user leaves the tilde prefix unchanged (§3.6 step 1).
        b.add(home ?? `~${p.user ?? ''}`, false, true);
        break;
      }
      case 'param':
        if (p.name === '@') addAt(sh, b, p.quoted);
        else if (p.quoted) b.add(paramValue(sh, p.name) ?? '', false, true);
        else b.addSplit(paramValue(sh, p.name) ?? '');
        break;
    }
  }
  return b.finish();
}

/** `"$@"` is one field per positional parameter; unquoted `$@` splits each of them. */
function addAt(sh: Sh, b: FieldBuilder, quoted: boolean): void {
  sh.st.positional.forEach((arg, i) => {
    if (i > 0) b.cut();
    if (quoted) b.add(arg, false, true);
    else b.addSplit(arg);
  });
}

function tildeUsers(words: readonly (Word | null)[]): string[] {
  const users = new Set<string>();
  for (const w of words) {
    for (const p of w?.parts ?? []) if (p.t === 'tilde' && p.user !== null) users.add(p.user);
  }
  return [...users];
}

/** Homes of the users named by `~user` prefixes (one `users.list` call when there are any). */
function* resolveHomes(sh: Sh, words: readonly (Word | null)[]): SysGen<Map<string, string>> {
  const homes = new Map<string, string>();
  const wanted = tildeUsers(words);
  if (wanted.length === 0) return homes;
  try {
    const { users } = yield* sh.sys.call('users.list', {});
    users.filter((u) => wanted.includes(u.name)).forEach((u) => homes.set(u.name, u.home));
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
  return homes;
}

function literalOf(f: Field): string {
  return f.segs.map((s) => s.text).join('');
}

function patternOf(f: Field): string {
  return f.segs.map((s) => (s.glob ? s.text : escapeGlob(s.text))).join('');
}

function joinPath(base: string, name: string): string {
  if (base === '') return name;
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

/** One directory's names and types, all pages, or [] when it cannot be listed. */
function* listDir(sh: Sh, dir: string): SysGen<{ name: string; dir: boolean }[]> {
  const out: { name: string; dir: boolean }[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = yield* sh.sys.call(
        'readdir',
        cursor === undefined ? { path: dir } : { path: dir, cursor },
      );
      out.push(...page.entries.map((e) => ({ name: e.name, dir: e.type !== 'f' })));
      cursor = page.next;
    } while (cursor !== undefined);
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return [];
  }
  return out;
}

function matching(
  entries: readonly { name: string; dir: boolean }[],
  comp: string,
  last: boolean,
  base: string,
): string[] {
  return entries
    .filter((e) => (last || e.dir) && matchGlob(comp, e.name))
    .map((e) => joinPath(base, e.name));
}

function* exists(sh: Sh, path: string): SysGen<boolean> {
  try {
    yield* sh.sys.call('lstat', { path });
    return true;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return false;
  }
}

/**
 * Pathname expansion of one pattern, matched per component against directory listings as the
 * caller (§3.6 step 4). Returns the sorted matches, or [] when nothing matches.
 */
export function* globPaths(sh: Sh, pattern: string): SysGen<string[]> {
  const comps = pattern.split('/');
  const absolute = pattern.startsWith('/');
  let bases = [absolute ? '/' : ''];
  let globbed = false;
  let literalTail = false;
  for (let i = absolute ? 1 : 0; i < comps.length && bases.length > 0; i++) {
    const comp = comps[i] ?? '';
    const last = i === comps.length - 1;
    if (!hasGlobMeta(comp)) {
      const lit = unescapeGlob(comp);
      bases = bases.map((b) => (lit === '' && last ? `${b}/` : joinPath(b, lit)));
      literalTail = globbed;
      continue;
    }
    globbed = true;
    literalTail = false;
    const next: string[] = [];
    for (const base of bases) {
      next.push(...matching(yield* listDir(sh, base === '' ? '.' : base), comp, last, base));
    }
    bases = next;
  }
  if (literalTail) {
    // Literal components after a glob were appended unchecked: keep the paths that exist.
    const kept: string[] = [];
    for (const b of bases) if (yield* exists(sh, b)) kept.push(b);
    bases = kept;
  }
  return bases.sort(compareCodePoints);
}

/** Full expansion of the words of a command: the resulting fields (§3.6 steps 1–5). */
export function* expandWords(sh: Sh, words: readonly Word[]): SysGen<string[]> {
  const homes = yield* resolveHomes(sh, words);
  const out: string[] = [];
  for (const w of words) {
    for (const f of buildFields(sh, w.parts, homes)) {
      const globbing = f.segs.some((s) => s.glob && hasGlobMeta(s.text));
      const matches = globbing ? yield* globPaths(sh, patternOf(f)) : [];
      if (matches.length > 0) out.push(...matches);
      else out.push(literalOf(f));
    }
  }
  return out;
}

function valueText(sh: Sh, word: Word, homes: ReadonlyMap<string, string>): string {
  return word.parts
    .map((p) => {
      if (p.t === 'lit' || p.t === 'glob') return p.v;
      if (p.t === 'tilde') return homeOf(sh, p.user, homes) ?? `~${p.user ?? ''}`;
      if (p.name === '@') return sh.st.positional.join(' ');
      return paramValue(sh, p.name) ?? '';
    })
    .join('');
}

/** An assignment value: tilde and parameter expansion only, no splitting or globbing. */
export function* expandValue(sh: Sh, word: Word | null): SysGen<string> {
  if (word === null) return '';
  return valueText(sh, word, yield* resolveHomes(sh, [word]));
}

/** A redirection target must expand to exactly one field (§3.6); null otherwise. */
export function* expandTarget(sh: Sh, word: Word): SysGen<string | null> {
  const fields = yield* expandWords(sh, [word]);
  return fields.length === 1 ? (fields[0] ?? null) : null;
}
