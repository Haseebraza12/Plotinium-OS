/** `whoami` (shell-and-terminal.md §3.14.34): the effective user name. */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';

export default defineCommand<Record<string, never>>({
  name: 'whoami',
  parse(args) {
    const p = parseFor('whoami', args);
    if (p.operands.length > 0) throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    return {};
  },
  *run(io) {
    try {
      const cred = yield* io.sys.call('proc.cred', {});
      yield* io.line(cred.user);
      return 0;
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    }
  },
});
