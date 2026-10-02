/**
 * Tab completion (shell-and-terminal.md §3.10; SYS-03, SHL-10, SHL-17).
 *
 * The trie is team-owned and lives in the `complete` service, so the shell only talks to it over
 * the `Completer` interface (`complete.query`). When the service is not running the shell falls
 * back to a directory scan and says so once. Which namespace applies is decided here, from the
 * line up to the cursor, lexed tolerantly.
 */
import type {
  CompleteItem,
  CompleteNamespace,
  CompleteQuery,
  CompleteResult,
  SysGen,
} from '../src/_sys.ts';
import { errnoOf } from '../src/_sys.ts';
import { BUILTIN_NAMES } from './builtins/names.ts';
import { compareCodePoints } from './glob.ts';
import { prefixMatches } from './history.ts';
import type { Sh } from './state.ts';
import { err, varOr } from './state.ts';
import { varNames } from './vars.ts';
import { stringWidth } from './wcwidth.ts';

export const COMPLETE_LIMIT = 100;
export const DEGRADED_NOTICE = 'complete: service unavailable — using a directory scan\n';

/** The completion backend: the `complete` service, or anything with its query shape. */
export interface Completer {
  query(q: CompleteQuery): SysGen<CompleteResult>;
}

export function serviceCompleter(sh: Sh): Completer {
  return { query: (q) => sh.sys.call('complete.query', q) };
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

export type Where = { ns: 'cmd' } | { ns: 'flag'; cmd: string } | { ns: 'var' } | { ns: 'path' };

export interface Context {
  where: Where;
  /** Index in the line where the current word starts. */
  start: number;
  /** The current word with quotes and escapes removed. */
  value: string;
  /** An open quote the insertion continues inside, or null. */
  quote: "'" | '"' | null;
}

interface Tok {
  kind: 'word' | 'sep' | 'redir';
  text: string;
  value: string;
  start: number;
}

const SEP_CHARS = new Set(['|', '&', ';']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Tolerant lexing of the text before the cursor: words, separators and redirections. */
function scan(line: string): { toks: Tok[]; quote: "'" | '"' | null; openWord: boolean } {
  const toks: Tok[] = [];
  let i = 0;
  let quote: "'" | '"' | null = null;
  let cur: Tok | null = null;
  const endWord = (): void => {
    if (cur !== null) toks.push(cur);
    cur = null;
  };
  while (i < line.length) {
    const c = line[i] ?? '';
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\' && i + 1 < line.length) {
        i++;
        if (cur) cur.value += line[i] ?? '';
      } else if (cur) cur.value += c;
      if (cur) cur.text = line.slice(cur.start, i + 1);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      endWord();
      i++;
      continue;
    }
    if (SEP_CHARS.has(c) || c === '<' || c === '>' || c === '(' || c === ')') {
      endWord();
      let j = i + 1;
      while (j < line.length && (line[j] === c || line[j] === '&') && j - i < 2) j++;
      toks.push({
        kind: c === '<' || c === '>' ? 'redir' : 'sep',
        text: line.slice(i, j),
        value: '',
        start: i,
      });
      i = j;
      continue;
    }
    cur ??= { kind: 'word', text: '', value: '', start: i };
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\' && i + 1 < line.length) {
      i++;
      cur.value += line[i] ?? '';
    } else cur.value += c;
    i++;
    cur.text = line.slice(cur.start, i);
  }
  const openWord = cur !== null;
  endWord();
  return { toks, quote, openWord };
}

export function completionContext(line: string, cursor: number): Context {
  const before = line.slice(0, cursor);
  const { toks, quote, openWord } = scan(before);
  const current = openWord ? toks.pop() : undefined;
  const word = current ?? { kind: 'word' as const, text: '', value: '', start: before.length };
  // Words since the last separator, skipping leading assignments.
  let cmd: string | null = null;
  let afterRedir = false;
  for (const t of toks) {
    if (t.kind === 'sep') {
      cmd = null;
      afterRedir = false;
    } else if (t.kind === 'redir') {
      afterRedir = true;
    } else if (afterRedir) {
      afterRedir = false;
    } else if (cmd === null && !ASSIGN.test(t.text)) {
      cmd = t.value;
    }
  }
  const value = word.value;
  let where: Where;
  if (afterRedir) where = { ns: 'path' };
  else if (value.startsWith('$') && quote !== "'") where = { ns: 'var' };
  else if (cmd === null && !ASSIGN.test(word.text) && !value.includes('/')) where = { ns: 'cmd' };
  else if (cmd !== null && value.startsWith('-')) where = { ns: 'flag', cmd };
  else where = { ns: 'path' };
  return { where, start: word.start, value, quote };
}

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

export interface Candidates {
  /** What the candidates complete: the prefix typed so far in their namespace. */
  prefix: string;
  items: CompleteItem[];
  truncated: boolean;
}

function splitPath(value: string): { dirPart: string; base: string } {
  const slash = value.lastIndexOf('/');
  return slash < 0
    ? { dirPart: '', base: value }
    : { dirPart: value.slice(0, slash + 1), base: value.slice(slash + 1) };
}

/** The directory to list for a path word: `~` expanded, relative to `$PWD`. */
export function dirFor(sh: Sh, dirPart: string): string {
  const pwd = varOr(sh.st, 'PWD', '.');
  const home = varOr(sh.st, 'HOME', '');
  let dir = dirPart;
  if (dir === '~/' || dir.startsWith('~/')) dir = `${home}/${dir.slice(2)}`;
  if (dir === '') return pwd;
  if (!dir.startsWith('/')) dir = `${pwd === '/' ? '' : pwd}/${dir}`;
  return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;
}

const UNAVAILABLE = new Set(['ENOSYS', 'EAGAIN', 'ETIMEDOUT', 'ESRCH', 'EIO', 'EBUSY']);

type Answer = { ok: true; result: CompleteResult } | { ok: false; degraded: boolean };

function* ask(completer: Completer, q: CompleteQuery): SysGen<Answer> {
  try {
    return { ok: true, result: yield* completer.query(q) };
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    // EACCES and friends mean "nothing to complete here" (SHL-10), not a broken service.
    return { ok: false, degraded: UNAVAILABLE.has(errno) };
  }
}

function* listNames(sh: Sh, dir: string): SysGen<{ name: string; kind: 'd' | 'f' | 'l' }[]> {
  const out: { name: string; kind: 'd' | 'f' | 'l' }[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = yield* sh.sys.call(
        'readdir',
        cursor === undefined ? { path: dir } : { path: dir, cursor },
      );
      out.push(...page.entries.map((e) => ({ name: e.name, kind: e.type })));
      cursor = page.next;
    } while (cursor !== undefined);
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
  return out;
}

function prefixed<T extends { name: string }>(entries: readonly T[], prefix: string): T[] {
  return entries.filter(
    (e) => e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')),
  );
}

/** The degraded mode of SHL-17: one directory scan and a linear prefix filter. */
function* scanFallback(
  sh: Sh,
  ns: CompleteNamespace,
  prefix: string,
  dir: string,
): SysGen<CompleteItem[]> {
  if (ns === 'path') {
    return prefixed(yield* listNames(sh, dir), prefix).map((e) => ({ text: e.name, kind: e.kind }));
  }
  if (ns === 'hist')
    return prefixMatches(sh.st.hist, prefix).map((text) => ({ text, kind: 'hist' as const }));
  if (ns === 'flag') return [];
  const items: CompleteItem[] = BUILTIN_NAMES.filter((n) => n.startsWith(prefix)).map((text) => ({
    text,
    kind: 'builtin' as const,
  }));
  for (const d of varOr(sh.st, 'PATH', '').split(':')) {
    if (d === '') continue;
    const names = (yield* listNames(sh, d))
      .filter((e) => e.name.endsWith('.json'))
      .map((e) => ({ name: e.name.slice(0, -5) }));
    items.push(...prefixed(names, prefix).map((e) => ({ text: e.name, kind: 'program' as const })));
  }
  return items;
}

function dedupe(items: readonly CompleteItem[]): CompleteItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.text) ? false : (seen.add(i.text), true)));
}

/** Candidates for the word at the cursor, from the service or the fallback. */
export function* candidates(sh: Sh, ctx: Context, completer: Completer): SysGen<Candidates> {
  const w = ctx.where;
  if (w.ns === 'var') {
    const prefix = ctx.value.replace(/^\$\{?/, '');
    const names = varNames(sh.st.vars).filter((n) => n.startsWith(prefix));
    return { prefix, items: names.map((n) => ({ text: n, kind: 'f' as const })), truncated: false };
  }
  const { dirPart, base } = splitPath(ctx.value);
  const q: CompleteQuery =
    w.ns === 'path'
      ? { ns: 'path', prefix: base, dir: dirFor(sh, dirPart), limit: COMPLETE_LIMIT }
      : w.ns === 'flag'
        ? { ns: 'flag', prefix: ctx.value, cmd: w.cmd, limit: COMPLETE_LIMIT }
        : { ns: 'cmd', prefix: ctx.value, limit: COMPLETE_LIMIT };
  const prefix = q.prefix;
  const answer = yield* ask(completer, q);
  if (answer.ok)
    return { prefix, items: dedupe(answer.result.items), truncated: answer.result.truncated };
  if (!answer.degraded) return { prefix, items: [], truncated: false };
  if (!sh.st.completeNotice) {
    sh.st.completeNotice = true;
    yield* err(sh, `\r\n${DEGRADED_NOTICE}`);
  }
  const items = yield* scanFallback(sh, q.ns, prefix, q.dir ?? '.');
  return { prefix, items: dedupe(items), truncated: false };
}

/** Entries of the `hist` namespace for ↑ with a typed prefix, most recent first (§3.9). */
export function* historyMatches(sh: Sh, prefix: string, completer: Completer): SysGen<string[]> {
  if (prefix.length === 0)
    return [...sh.st.hist.lines].reverse().filter((l, i, a) => a.indexOf(l) === i);
  const answer = yield* ask(completer, { ns: 'hist', prefix, limit: COMPLETE_LIMIT });
  if (!answer.ok) return prefixMatches(sh.st.hist, prefix);
  return answer.result.items
    .slice()
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    .map((i) => i.text)
    .filter((t) => t !== prefix);
}

// ---------------------------------------------------------------------------------------------
// Applying candidates
// ---------------------------------------------------------------------------------------------

const SPECIAL = /[\s\\'"$`|&;<>()*?[\]#~=!{}]/g;

/** Inserted text escapes spaces and shell-special characters with `\` (§3.10). */
export function escapeWord(text: string, quote: Context['quote']): string {
  if (quote === "'") return text;
  if (quote === '"') return text.replace(/["\\$`]/g, (c) => `\\${c}`);
  return text.replace(SPECIAL, (c) => `\\${c}`);
}

function commonPrefix(texts: readonly string[]): string {
  let p = texts[0] ?? '';
  for (const t of texts) {
    let i = 0;
    while (i < p.length && i < t.length && p[i] === t[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

export type Outcome =
  { k: 'insert'; text: string } | { k: 'list'; items: CompleteItem[] } | { k: 'bell' };

/**
 * One candidate: the rest of it, then `/` for a directory or a space. Several: their longest
 * common prefix; when that adds nothing, the second Tab lists them (§3.10).
 */
export function outcome(c: Candidates, ctx: Context, again: boolean): Outcome {
  const items = c.items;
  if (items.length === 0) return { k: 'bell' };
  const only = items.length === 1 ? items[0] : undefined;
  if (only !== undefined) {
    const rest = escapeWord(only.text.slice(c.prefix.length), ctx.quote);
    if (only.kind === 'd') return { k: 'insert', text: `${rest}/` };
    return { k: 'insert', text: `${rest}${ctx.quote ?? ''} ` };
  }
  const lcp = commonPrefix(items.map((i) => i.text));
  const rest = lcp.slice(c.prefix.length);
  if (rest.length > 0) return { k: 'insert', text: escapeWord(rest, ctx.quote) };
  return again ? { k: 'list', items } : { k: 'bell' };
}

/** Candidates in columns sorted in code-point order; flags one per line with their text. */
export function formatListing(items: readonly CompleteItem[], cols: number): string {
  const sorted = [...items].sort((a, b) => compareCodePoints(a.text, b.text));
  if (sorted.some((i) => i.kind === 'flag')) {
    return sorted.map((i) => `${i.text}${i.desc === undefined ? '' : `  ${i.desc}`}\r\n`).join('');
  }
  const names = sorted.map((i) => (i.kind === 'd' ? `${i.text}/` : i.text));
  const width = Math.max(...names.map(stringWidth)) + 2;
  const per = Math.max(1, Math.floor(cols / width));
  const rows = Math.ceil(names.length / per);
  let out = '';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < per; c++) {
      const name = names[c * rows + r];
      if (name !== undefined) line += name + ' '.repeat(Math.max(0, width - stringWidth(name)));
    }
    out += `${line.trimEnd()}\r\n`;
  }
  return out;
}
