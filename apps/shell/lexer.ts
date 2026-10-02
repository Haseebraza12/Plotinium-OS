/**
 * Shell lexer (shell-and-terminal.md §3.5, SHL-04): a hand-written single-pass state machine,
 * O(n) in the input length. Produces WORD (with ASSIGNMENT_WORD candidates), IO_NUMBER, NEWLINE
 * and operator tokens with source spans. Unsupported constructs fail with the exact messages of
 * the §3.5 table, and unfinished input reports `incomplete` so the editor can prompt with PS2.
 */
import type { Assign, Span, Word, WordPart } from './ast.ts';

export type Op = '|' | '||' | '&' | '&&' | ';' | '>' | '>>' | '<' | '>&';

export type Token =
  | {
      k: 'word';
      word: Word;
      /** The raw text when the whole word is unquoted plain text (used for `!`, `{`, digits). */
      bare: string | null;
      /** Set when the word has the ASSIGNMENT_WORD shape; the parser decides by position. */
      assign: Assign | null;
      span: Span;
    }
  | { k: 'io'; n: number; span: Span }
  | { k: 'nl'; span: Span }
  | { k: 'op'; op: Op; span: Span };

export type LexResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; kind: 'incomplete'; unclosed?: string }
  | { ok: false; kind: 'error'; message: string; column: number };

export const MSG_CMD_SUBST = 'sh: command substitution is not supported';
export const MSG_BACKQUOTE = 'sh: backquote substitution is not supported';
export const MSG_GROUPS = 'sh: syntax error: subshells and groups are not supported';
export const MSG_HEREDOC = 'sh: here-documents are not supported';

const META = new Set([' ', '\t', '\n', '|', '&', ';', '<', '>', '(', ')']);
const SPECIAL_PARAMS = new Set(['?', '$', '!', '#', '@', '0']);
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const TILDE_USER = /[A-Za-z0-9._-]/;
const ASSIGN_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Thrown inside the lexer to unwind to `lex`, which turns it back into a result. */
class LexFail extends Error {
  readonly result: Exclude<LexResult, { ok: true }>;
  constructor(result: Exclude<LexResult, { ok: true }>) {
    super(result.kind);
    this.result = result;
  }
}

function fail(message: string, index: number): never {
  throw new LexFail({ ok: false, kind: 'error', message, column: index + 1 });
}

function incomplete(unclosed?: string): never {
  throw new LexFail(
    unclosed === undefined
      ? { ok: false, kind: 'incomplete' }
      : { ok: false, kind: 'incomplete', unclosed },
  );
}

/**
 * Appends a literal, merging with the previous literal of the same quoting, so that equal words
 * always have equal parts. An empty quoted literal is kept only when nothing quoted precedes it:
 * it is what makes `""` a field of its own.
 */
function pushLit(parts: WordPart[], v: string, quoted: boolean): void {
  const last = parts.at(-1);
  if (last?.t === 'lit' && last.quoted === quoted) last.v += v;
  else if (v.length > 0 || quoted) parts.push({ t: 'lit', v, quoted });
}

class Lexer {
  private readonly s: string;
  private i = 0;
  private readonly tokens: Token[] = [];

  constructor(source: string) {
    this.s = source;
  }

  run(): Token[] {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i] ?? '';
      const start = this.i;
      if (c === ' ' || c === '\t') {
        this.i++;
      } else if (c === '\\' && s[this.i + 1] === '\n') {
        this.i += 2;
      } else if (c === '\n') {
        this.i++;
        this.tokens.push({ k: 'nl', span: { start, end: this.i } });
      } else if (c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (c === '|' || c === '&') {
        const doubled = s[this.i + 1] === c;
        this.i += doubled ? 2 : 1;
        const op: Op = c === '|' ? (doubled ? '||' : '|') : doubled ? '&&' : '&';
        this.tokens.push({ k: 'op', op, span: { start, end: this.i } });
      } else if (c === ';') {
        this.i++;
        this.tokens.push({ k: 'op', op: ';', span: { start, end: this.i } });
      } else if (c === '<' || c === '>') {
        this.redirOp(c, start);
      } else if (c === '(' || c === ')') {
        fail(MSG_GROUPS, start);
      } else if (DIGIT.test(c) && (s[this.i + 1] === '<' || s[this.i + 1] === '>')) {
        this.i++;
        this.tokens.push({ k: 'io', n: Number(c), span: { start, end: this.i } });
      } else {
        this.word();
      }
    }
    return this.tokens;
  }

  private redirOp(c: '<' | '>', start: number): void {
    const next = this.s[this.i + 1];
    let op: Op;
    if (c === '<') {
      if (next === '<') fail(MSG_HEREDOC, start);
      op = '<';
    } else if (next === '>') op = '>>';
    else if (next === '&') op = '>&';
    else op = '>';
    this.i += op.length;
    this.tokens.push({ k: 'op', op, span: { start, end: this.i } });
  }

  private word(): void {
    const s = this.s;
    const start = this.i;
    const parts: WordPart[] = [];
    // Plain unquoted text seen so far, or null once anything quoted/expanded appears.
    let plain: string | null = '';
    while (this.i < s.length && !META.has(s[this.i] ?? '')) {
      const c = s[this.i] ?? '';
      if (c === '\\') {
        const next = s[this.i + 1];
        if (next === undefined) incomplete('\\');
        this.i += 2;
        if (next === '\n') continue;
        pushLit(parts, next, true);
        plain = null;
      } else if (c === "'") {
        const close = s.indexOf("'", this.i + 1);
        if (close < 0) incomplete("'");
        pushLit(parts, s.slice(this.i + 1, close), true);
        this.i = close + 1;
        plain = null;
      } else if (c === '"') {
        this.doubleQuoted(parts);
        plain = null;
      } else if (c === '$') {
        this.parameter(parts, false);
        plain = null;
      } else if (c === '`') {
        fail(MSG_BACKQUOTE, this.i);
      } else if (c === '*' || c === '?') {
        parts.push({ t: 'glob', v: c });
        this.i++;
        plain = null;
      } else if (c === '[') {
        const end = this.bracketEnd(this.i);
        if (end < 0) {
          pushLit(parts, '[', false);
          if (plain !== null) plain += '[';
          this.i++;
        } else {
          parts.push({ t: 'glob', v: s.slice(this.i, end + 1) });
          this.i = end + 1;
          plain = null;
        }
      } else if (
        c === '~' &&
        (this.i === start || (plain !== null && ASSIGN_PREFIX.test(plain) && plain.endsWith('=')))
      ) {
        this.tilde(parts);
        plain = null;
      } else {
        pushLit(parts, c, false);
        if (plain !== null) plain += c;
        this.i++;
      }
    }
    const span = { start, end: this.i };
    const word: Word = { parts, span };
    this.tokens.push({ k: 'word', word, bare: plain, assign: assignOf(word), span });
  }

  private tilde(parts: WordPart[]): void {
    const s = this.s;
    let j = this.i + 1;
    while (j < s.length && TILDE_USER.test(s[j] ?? '')) j++;
    const after = s[j];
    if (after !== undefined && after !== '/' && !META.has(after) && after !== ':') {
      pushLit(parts, '~', false);
      this.i++;
      return;
    }
    const user = s.slice(this.i + 1, j);
    parts.push({ t: 'tilde', user: user.length > 0 ? user : null });
    this.i = j;
  }

  /** Index of the `]` closing a bracket expression at `open`, or -1 when it is a literal `[`. */
  private bracketEnd(open: number): number {
    const s = this.s;
    let j = open + 1;
    if (s[j] === '!' || s[j] === '^') j++;
    if (s[j] === ']') j++;
    while (j < s.length && s[j] !== ']') {
      if (META.has(s[j] ?? '') || s[j] === '/') return -1;
      j++;
    }
    return j < s.length ? j : -1;
  }

  private doubleQuoted(parts: WordPart[]): void {
    const s = this.s;
    this.i++;
    let sawAny = false;
    const before = parts.length;
    for (;;) {
      if (this.i >= s.length) incomplete('"');
      const c = s[this.i] ?? '';
      if (c === '"') {
        this.i++;
        break;
      }
      sawAny = true;
      if (c === '\\') {
        const next = s[this.i + 1];
        if (next === undefined) incomplete('"');
        if (next === '\n') {
          this.i += 2;
        } else if (next === '"' || next === '\\' || next === '$' || next === '`') {
          pushLit(parts, next, true);
          this.i += 2;
        } else {
          pushLit(parts, `\\${next}`, true);
          this.i += 2;
        }
      } else if (c === '$') {
        this.parameter(parts, true);
      } else if (c === '`') {
        fail(MSG_BACKQUOTE, this.i);
      } else {
        pushLit(parts, c, true);
        this.i++;
      }
    }
    if (!sawAny || parts.length === before) pushLit(parts, '', true);
  }

  private parameter(parts: WordPart[], quoted: boolean): void {
    const s = this.s;
    const at = this.i;
    const next = s[at + 1] ?? '';
    if (next === '(') fail(MSG_CMD_SUBST, at);
    if (next === '{') {
      const close = s.indexOf('}', at + 2);
      if (close < 0) incomplete('}');
      const inner = s.slice(at + 2, close);
      if (!isParamName(inner)) fail(`sh: \${${inner}}: bad substitution`, at);
      parts.push({ t: 'param', name: inner, braced: true, quoted });
      this.i = close + 1;
      return;
    }
    if (NAME_START.test(next)) {
      let j = at + 1;
      while (j < s.length && NAME_CHAR.test(s[j] ?? '')) j++;
      parts.push({ t: 'param', name: s.slice(at + 1, j), braced: false, quoted });
      this.i = j;
      return;
    }
    if (DIGIT.test(next) || SPECIAL_PARAMS.has(next)) {
      parts.push({ t: 'param', name: next, braced: false, quoted });
      this.i = at + 2;
      return;
    }
    pushLit(parts, '$', quoted);
    this.i++;
  }
}

function isParamName(inner: string): boolean {
  return /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[?$!#@])$/.test(inner);
}

/** The ASSIGNMENT_WORD reading of a word: `name=` in its leading unquoted literal. */
function assignOf(word: Word): Assign | null {
  const first = word.parts[0];
  if (first?.t !== 'lit' || first.quoted) return null;
  const m = ASSIGN_PREFIX.exec(first.v);
  if (!m) return null;
  const name = m[1] ?? '';
  const restText = first.v.slice(m[0].length);
  const valueParts: WordPart[] = [];
  if (restText.length > 0) valueParts.push({ t: 'lit', v: restText, quoted: false });
  valueParts.push(...word.parts.slice(1));
  const valueStart = word.span.start + m[0].length;
  return {
    name,
    value:
      valueParts.length === 0
        ? null
        : { parts: valueParts, span: { start: valueStart, end: word.span.end } },
  };
}

export function lex(source: string): LexResult {
  try {
    return { ok: true, tokens: new Lexer(source).run() };
  } catch (e) {
    if (e instanceof LexFail) return e.result;
    throw e;
  }
}
