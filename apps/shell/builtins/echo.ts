/**
 * `echo [-n] [-e] [ARG...]` (§3.14.8). Leading words made only of `n` and `e` flags are options;
 * any other word starts the operands, as in other shells.
 */
import type { SysGen } from '../../src/_sys.ts';
import { errText, writeText } from '../../src/_sys.ts';
import type { Sh } from '../state.ts';
import { err } from '../state.ts';

const SIMPLE: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  '\\': '\\',
  a: '\x07',
  e: '\x1b',
  r: '\r',
};

/** `-e` escapes: `\n \t \\ \a \e \r` and `\0NNN` (octal); others stay as written. */
export function interpretEscapes(s: string): string {
  return s.replace(/\\(0[0-7]{0,3}|.)/gsu, (m, c: string) => {
    if (c.startsWith('0')) return String.fromCharCode(parseInt(c.length > 1 ? c.slice(1) : '0', 8));
    return SIMPLE[c] ?? m;
  });
}

export function echoText(args: readonly string[]): string {
  let i = 0;
  let newline = true;
  let escapes = false;
  while (i < args.length && /^-[ne]+$/.test(args[i] ?? '')) {
    const a = args[i] ?? '';
    if (a.includes('n')) newline = false;
    if (a.includes('e')) escapes = true;
    i++;
  }
  const body = args.slice(i).join(' ');
  return (escapes ? interpretEscapes(body) : body) + (newline ? '\n' : '');
}

export function* echo(sh: Sh, argv: readonly string[]): SysGen<number> {
  try {
    yield* writeText(sh.sys, 1, echoText(argv.slice(1)));
    return 0;
  } catch (e) {
    yield* err(sh, `echo: write error: ${errText(e)}\n`);
    return 1;
  }
}
