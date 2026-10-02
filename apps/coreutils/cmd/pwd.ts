/** `pwd [-L | -P]` (shell-and-terminal.md §3.14.3). */
import { defineCommand, parseFor } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';

export interface PwdOpts {
  readonly logical: boolean;
}

export default defineCommand<PwdOpts>({
  name: 'pwd',
  parse(args) {
    const p = parseFor('pwd', args);
    // The last of -L and -P wins, as in POSIX.
    const last = args.filter((a) => a === '-L' || a === '-P').at(-1);
    return { logical: p.has('L') && last !== '-P' };
  },
  *run(io, opts) {
    let cwd: { path: string; ino: string };
    try {
      cwd = yield* io.sys.call('getcwd', {});
    } catch (e) {
      yield* io.error(`cannot determine current directory: ${describe(e)}`);
      return 1;
    }
    const pwd = io.env('PWD');
    if (
      opts.logical &&
      pwd !== undefined &&
      pwd.startsWith('/') &&
      !/(^|\/)\.\.?(\/|$)/.test(pwd)
    ) {
      try {
        const st = yield* io.sys.call('stat', { path: pwd });
        if (st.ino === cwd.ino) {
          yield* io.line(pwd);
          return 0;
        }
      } catch {
        // $PWD no longer names a directory: fall back to the kernel's path
      }
    }
    yield* io.line(cwd.path);
    return 0;
  },
});
