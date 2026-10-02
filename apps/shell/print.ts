/**
 * AST → source text (shell-and-terminal.md §8.1: "parse then print then parse is the identity").
 * Quoted text is printed in single quotes, parameters inside double quotes when quoted.
 */
import type { AndOr, List, Pipeline, Redir, SimpleCommand, Word, WordPart } from './ast.ts';

function part(p: WordPart): string {
  switch (p.t) {
    case 'lit':
      return p.quoted ? `'${p.v.replace(/'/g, `'\\''`)}'` : p.v;
    case 'param': {
      const text = p.braced ? `\${${p.name}}` : `$${p.name}`;
      return p.quoted ? `"${text}"` : text;
    }
    case 'tilde':
      return `~${p.user ?? ''}`;
    case 'glob':
      return p.v;
  }
}

export function printWord(w: Word): string {
  return w.parts.map(part).join('');
}

function printRedir(r: Redir): string {
  const target = typeof r.target === 'number' ? String(r.target) : printWord(r.target);
  const defaultFd = r.op === '<' ? 0 : 1;
  return `${r.fd === defaultFd ? '' : r.fd}${r.op} ${target}`;
}

function printCommand(c: SimpleCommand): string {
  const assigns = c.assigns.map((a) => `${a.name}=${a.value === null ? '' : printWord(a.value)}`);
  return [...assigns, ...c.words.map(printWord), ...c.redirs.map(printRedir)].join(' ');
}

function printPipeline(p: Pipeline): string {
  return (p.negate ? '! ' : '') + p.cmds.map(printCommand).join(' | ');
}

function printAndOr(a: AndOr): string {
  return [printPipeline(a.first), ...a.rest.map((r) => `${r.op} ${printPipeline(r.right)}`)].join(
    ' ',
  );
}

export function printList(l: List): string {
  return l.items.map((i) => `${printAndOr(i.node)}${i.background ? ' &' : ';'}`).join(' ');
}
