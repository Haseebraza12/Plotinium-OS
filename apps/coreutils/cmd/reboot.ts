/**
 * `reboot [--menu] [--safe] [--verbose]` (shell-and-terminal.md §3.14.42): `shutdown -r now` with
 * flags for the next boot.
 * TODO(R5): protocol `reboot` has `menu` and `safe` but no `verbose` flag (boot-and-services.md
 * §4.7 `next: 'verbose'`); `--verbose` warns and restarts without it until it lands.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';

export interface RebootOpts {
  readonly menu: boolean;
  readonly safe: boolean;
  readonly verbose: boolean;
}

export default defineCommand<RebootOpts>({
  name: 'reboot',
  parse(args) {
    const p = parseFor('reboot', args);
    if (p.operands.length > 0) throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    return { menu: p.has('menu'), safe: p.has('safe'), verbose: p.has('verbose') };
  },
  *run(io, opts) {
    if (opts.verbose)
      yield* io.error('--verbose is not available yet; restarting without the verbose log');
    try {
      yield* io.flush();
      yield* io.sys.call('reboot', {
        ...(opts.menu ? { menu: true } : {}),
        ...(opts.safe ? { safe: true } : {}),
      });
      return 0;
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    }
  },
});
