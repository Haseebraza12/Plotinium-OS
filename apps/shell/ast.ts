/**
 * Shell AST (shell-and-terminal.md §4.3, SHL-04). Every node is plain data so it can live in the
 * shell's serialisable state. Words keep their parts and quoting so expansion applies the rules of
 * §3.6 without re-lexing.
 */
export interface Span {
  start: number;
  end: number;
}

export type WordPart =
  | { t: 'lit'; v: string; quoted: boolean }
  | { t: 'param'; name: string; braced: boolean; quoted: boolean }
  | { t: 'tilde'; user: string | null }
  | { t: 'glob'; v: string };

export interface Word {
  parts: WordPart[];
  span: Span;
}

export type RedirOp = '>' | '>>' | '<' | '>&';

export interface Redir {
  fd: number;
  op: RedirOp;
  target: Word | number;
  span: Span;
}

export interface Assign {
  name: string;
  value: Word | null;
}

export interface SimpleCommand {
  kind: 'cmd';
  assigns: Assign[];
  words: Word[];
  redirs: Redir[];
  span: Span;
}

export interface Pipeline {
  kind: 'pipeline';
  negate: boolean;
  cmds: SimpleCommand[];
  span: Span;
}

export interface AndOr {
  kind: 'andor';
  first: Pipeline;
  rest: { op: '&&' | '||'; right: Pipeline }[];
  span: Span;
}

export interface List {
  kind: 'list';
  items: { node: AndOr; background: boolean }[];
}

export type ParseResult =
  | { ok: true; list: List }
  | { ok: false; kind: 'incomplete'; unclosed?: string }
  | { ok: false; kind: 'error'; message: string; column: number };
