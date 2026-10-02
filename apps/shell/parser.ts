/**
 * Recursive-descent parser over the tokens of lexer.ts, exactly the EBNF of shell-and-terminal.md
 * §3.5 (SHL-04). O(n) tokens, no backtracking. Precedence: `|` binds tightest, then `&&`/`||`
 * (left-associative), then `;`, `&` and newlines; `&` applies to the whole and_or before it.
 * A line that fails to parse runs nothing (I-SH1): the caller only executes an `ok` result.
 */
import type {
  AndOr,
  Assign,
  List,
  ParseResult,
  Pipeline,
  Redir,
  SimpleCommand,
  Word,
} from './ast.ts';
import { lex, MSG_GROUPS } from './lexer.ts';
import type { Token } from './lexer.ts';

/** Thrown inside the parser to unwind to `parse`, which turns it back into a result. */
class ParseFail extends Error {
  readonly result: Exclude<ParseResult, { ok: true }>;
  constructor(result: Exclude<ParseResult, { ok: true }>) {
    super(result.kind);
    this.result = result;
  }
}

function tokenText(t: Token | undefined, source: string): string {
  if (t === undefined || t.k === 'nl') return 'newline';
  return source.slice(t.span.start, t.span.end);
}

/** A tilde after `=` only counts in assignment position; elsewhere it is literal text. */
function asPlainWord(word: Word): Word {
  if (!word.parts.some((p, i) => i > 0 && p.t === 'tilde')) return word;
  return {
    span: word.span,
    parts: word.parts.map((p, i) =>
      i > 0 && p.t === 'tilde' ? { t: 'lit', v: `~${p.user ?? ''}`, quoted: false } : p,
    ),
  };
}

class Parser {
  private i = 0;
  private readonly toks: Token[];
  private readonly source: string;

  constructor(toks: Token[], source: string) {
    this.toks = toks;
    this.source = source;
  }

  private peek(): Token | undefined {
    return this.toks[this.i];
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t?.k === 'op' && t.op === op;
  }

  private unexpected(): never {
    const t = this.peek();
    const column = (t?.span.start ?? this.source.length) + 1;
    throw new ParseFail({
      ok: false,
      kind: 'error',
      message: `sh: syntax error near unexpected token '${tokenText(t, this.source)}' (column ${column})`,
      column,
    });
  }

  private linebreak(): void {
    while (this.peek()?.k === 'nl') this.i++;
  }

  /** After `|`, `&&` or `||` the input may continue on the next line. */
  private continuation(): void {
    this.linebreak();
    if (this.peek() === undefined) throw new ParseFail({ ok: false, kind: 'incomplete' });
  }

  program(): List {
    const list: List = { kind: 'list', items: [] };
    this.linebreak();
    while (this.peek() !== undefined) {
      const node = this.andOr();
      const t = this.peek();
      let background = false;
      if (t?.k === 'op' && (t.op === ';' || t.op === '&')) {
        background = t.op === '&';
        this.i++;
        this.linebreak();
      } else if (t?.k === 'nl') {
        this.linebreak();
      } else if (t !== undefined) {
        this.unexpected();
      }
      list.items.push({ node, background });
    }
    return list;
  }

  private andOr(): AndOr {
    const first = this.pipeline();
    const rest: AndOr['rest'] = [];
    let end = first.span.end;
    for (;;) {
      const t = this.peek();
      if (t?.k !== 'op' || (t.op !== '&&' && t.op !== '||')) break;
      this.i++;
      this.continuation();
      const right = this.pipeline();
      rest.push({ op: t.op, right });
      end = right.span.end;
    }
    return { kind: 'andor', first, rest, span: { start: first.span.start, end } };
  }

  private pipeline(): Pipeline {
    let negate = false;
    const t = this.peek();
    const start = t?.span.start ?? this.source.length;
    if (t?.k === 'word' && t.bare === '!') {
      negate = true;
      this.i++;
    }
    const cmds = [this.simple()];
    while (this.isOp('|')) {
      this.i++;
      this.continuation();
      cmds.push(this.simple());
    }
    const end = cmds.at(-1)?.span.end ?? start;
    return { kind: 'pipeline', negate, cmds, span: { start, end } };
  }

  private simple(): SimpleCommand {
    const assigns: Assign[] = [];
    const words: Word[] = [];
    const redirs: Redir[] = [];
    const first = this.peek();
    const start = first?.span.start ?? this.source.length;
    let end = start;
    for (;;) {
      const t = this.peek();
      if (t === undefined) break;
      if (t.k === 'word') {
        if (words.length === 0 && t.assign !== null) {
          assigns.push(t.assign);
        } else {
          if (words.length === 0 && (t.bare === '{' || t.bare === '}')) {
            throw new ParseFail({
              ok: false,
              kind: 'error',
              message: MSG_GROUPS,
              column: t.span.start + 1,
            });
          }
          words.push(asPlainWord(t.word));
        }
        end = t.span.end;
        this.i++;
      } else if (
        t.k === 'io' ||
        (t.k === 'op' && (t.op === '>' || t.op === '>>' || t.op === '<' || t.op === '>&'))
      ) {
        const r = this.redirect();
        redirs.push(r);
        end = r.span.end;
      } else {
        break;
      }
    }
    if (assigns.length === 0 && words.length === 0 && redirs.length === 0) this.unexpected();
    return { kind: 'cmd', assigns, words, redirs, span: { start, end } };
  }

  private redirect(): Redir {
    let t = this.peek();
    const start = t?.span.start ?? 0;
    let fd: number | null = null;
    if (t?.k === 'io') {
      fd = t.n;
      this.i++;
      t = this.peek();
    }
    if (t?.k !== 'op' || (t.op !== '>' && t.op !== '>>' && t.op !== '<' && t.op !== '>&'))
      return this.unexpected();
    const op = t.op;
    this.i++;
    const target = this.peek();
    if (target?.k !== 'word') return this.unexpected();
    this.i++;
    const span = { start, end: target.span.end };
    if (op === '>&') {
      if (target.bare === null || !/^[0-9]$/.test(target.bare)) {
        this.i--;
        return this.unexpected();
      }
      return { fd: fd ?? 1, op, target: Number(target.bare), span };
    }
    return { fd: fd ?? (op === '<' ? 0 : 1), op, target: target.word, span };
  }
}

export function parse(source: string): ParseResult {
  const lexed = lex(source);
  if (!lexed.ok) return lexed;
  try {
    return { ok: true, list: new Parser(lexed.tokens, source).program() };
  } catch (e) {
    if (e instanceof ParseFail) return e.result;
    throw e;
  }
}

/** The message a non-interactive shell prints for input that ended too early. */
export function incompleteMessage(unclosed: string | undefined): string {
  return unclosed !== undefined && unclosed !== '\\'
    ? `sh: syntax error: unexpected end of input (unclosed ${unclosed})`
    : 'sh: syntax error: unexpected end of input';
}
