/** `echo [-n] [-e] [ARG...]` (shell-and-terminal.md §3.14.8). */
import { defineCommand } from '../lib/command.ts';
import { errnoText } from '../lib/errors.ts';
import { errnoOf } from '../lib/sys.ts';

export interface EchoOpts {
  readonly newline: boolean;
  readonly escapes: boolean;
  readonly words: readonly string[];
}

/** Leading words made only of `n` and `e` letters are options, as in the shell builtin. */
export function parseEcho(args: readonly string[]): EchoOpts {
  let i = 0;
  let newline = true;
  let escapes = false;
  while (i < args.length && /^-[ne]+$/.test(args[i] ?? '')) {
    const flag = args[i] ?? '';
    if (flag.includes('n')) newline = false;
    if (flag.includes('e')) escapes = true;
    i++;
  }
  return { newline, escapes, words: args.slice(i) };
}

const SIMPLE: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  '\\': '\\',
  a: '\x07',
  e: '\x1b',
};

/** `-e` escapes: `\n \t \\ \a \e` and `\0NNN` (octal); anything else stays as written. */
export function interpretEscapes(text: string): string {
  return text.replace(/\\(0[0-7]{0,3}|.)/gs, (all: string, seq: string) => {
    if (seq.startsWith('0')) return String.fromCharCode(parseInt(seq.slice(1) || '0', 8) & 0xff);
    return SIMPLE[seq] ?? all;
  });
}

export default defineCommand<EchoOpts>({
  name: 'echo',
  helpFlag: false,
  parse: parseEcho,
  *run(io, opts) {
    const joined = opts.words.join(' ');
    const text = (opts.escapes ? interpretEscapes(joined) : joined) + (opts.newline ? '\n' : '');
    try {
      yield* io.out(text);
      yield* io.flush();
      return 0;
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === undefined || errno === 'EPIPE') throw e;
      try {
        yield* io.write(2, `echo: write error: ${errnoText(errno)}\n`);
      } catch {
        // stderr is gone too; the status still reports the failure
      }
      return 1;
    }
  },
});
