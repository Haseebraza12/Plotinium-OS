/**
 * `nice [-n N] [COMMAND [ARG...]]` (processes-and-scheduling.md §3.18.5): with no COMMAND prints
 * the caller's niceness; otherwise runs COMMAND at nice + N (default 10), clamped to −20…19. A
 * negative N without root prints a warning and runs COMMAND unchanged (GNU behaviour).
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { lookupCommand, spawnAndWait } from '../lib/exec.ts';

export interface NiceOpts {
  readonly adjust: number;
  readonly command: readonly string[];
}

export function clampNice(n: number): number {
  return Math.min(19, Math.max(-20, n));
}

export default defineCommand<NiceOpts>({
  name: 'nice',
  parse(args) {
    const p = parseFor('nice', args, { stopAtFirstOperand: true });
    const text = p.value('n') ?? '10';
    const adjust = Number(text);
    if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`invalid adjustment '${text}'`);
    return { adjust, command: p.operands };
  },
  *run(io, opts) {
    const current = (yield* io.sys.call('getpriority', { pid: io.ctx.pid })).nice;
    const [name, ...rest] = opts.command;
    if (name === undefined) {
      yield* io.line(String(current));
      return 0;
    }
    const path = yield* lookupCommand(io, name);
    if (path === null) {
      yield* io.error(`'${name}': No such file or directory`);
      return 127;
    }
    const inc = clampNice(current + opts.adjust) - current;
    const argv = [name, ...rest];
    try {
      return yield* spawnAndWait(io, path, argv, inc === 0 ? {} : { nice: inc });
    } catch (e) {
      const errno = mustErrno(e);
      if (errno !== 'EPERM' && errno !== 'EACCES') {
        yield* io.error(`${name}: ${describe(e)}`);
        return 126;
      }
    }
    yield* io.error('cannot set niceness: Permission denied');
    return yield* spawnAndWait(io, path, argv);
  },
});
