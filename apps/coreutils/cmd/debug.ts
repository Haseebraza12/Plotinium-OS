/**
 * `debug inject OP N [--target client|server|both] | delay MS | status | clear`
 * (shell-and-terminal.md §3.14.50, DB-02, AGT-09): root only, audited, one-shot faults.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno, reasonOf } from '../lib/errors.ts';
import { extCall } from '../lib/sys.ts';

type Op = 'unlink' | 'rename' | 'copy' | 'chmod' | 'chown' | 'batch';
type Target = 'client' | 'server' | 'both';

export type DebugOpts =
  | {
      readonly sub: 'inject';
      readonly name: string;
      readonly op: Op;
      readonly after: number;
      readonly target: Target;
    }
  | { readonly sub: 'delay'; readonly ms: number }
  | { readonly sub: 'status' }
  | { readonly sub: 'clear' }
  | { readonly sub: 'unknown-op'; readonly name: string };

/** Command names to the fault hook's operations. */
export const OPS: Readonly<Record<string, Op>> = {
  rm: 'unlink',
  cp: 'copy',
  mv: 'rename',
  'rename-batch': 'batch',
  chmod: 'chmod',
  chown: 'chown',
};

export function parseDebug(args: readonly string[]): DebugOpts {
  const p = parseFor('debug', args);
  const [sub, a, b, extra] = p.operands;
  if (extra !== undefined) throw new UsageError(`extra operand '${extra}'`);
  if (sub === 'status' || sub === 'clear') return { sub };
  if (sub === 'delay') {
    const ms = Number(a);
    if (a === undefined || !Number.isInteger(ms) || ms < 1 || ms > 10_000)
      throw new UsageError(`invalid delay '${a ?? ''}' (1 to 10000 ms)`);
    return { sub: 'delay', ms };
  }
  if (sub !== 'inject')
    throw new UsageError(sub === undefined ? 'missing command' : `unknown command '${sub}'`);
  if (a === undefined) throw new UsageError('inject: missing operation');
  const op = OPS[a];
  if (op === undefined) return { sub: 'unknown-op', name: a };
  const after = Number(b);
  if (b === undefined || !Number.isInteger(after) || after < 1 || after > 100_000)
    throw new UsageError(`invalid node count '${b ?? ''}'`);
  const target = p.value('target') ?? 'both';
  if (target !== 'client' && target !== 'server' && target !== 'both')
    throw new UsageError(`invalid target '${target}'`);
  return { sub: 'inject', name: a, op, after, target };
}

export default defineCommand<DebugOpts>({
  name: 'debug',
  parse: parseDebug,
  *run(io, opts) {
    try {
      switch (opts.sub) {
        case 'unknown-op':
          yield* io.error(`unknown operation '${opts.name}'`);
          return 2;
        case 'inject':
          yield* io.sys.call('debug.inject', {
            target: opts.target,
            op: opts.op,
            after: opts.after,
          });
          yield* io.line(
            `debug: armed ${opts.name} fault at node ${opts.after} (target ${opts.target}, one-shot)`,
          );
          return 0;
        case 'delay':
          yield* io.sys.call('debug.delay', { op: 'batch', ms: opts.ms });
          yield* io.line(`debug: armed a ${opts.ms} ms delay for the next agent batch (one-shot)`);
          return 0;
        case 'status': {
          const res = yield* extCall(io.sys, 'debug.status', {});
          if (res.armed.length === 0) yield* io.line('debug: nothing armed');
          yield* io.lines(
            res.armed.map((f) => `armed: ${f.op} at node ${f.after} (target ${f.target})`),
          );
          return 0;
        }
        case 'clear': {
          const res = yield* extCall(io.sys, 'debug.clear', {});
          yield* io.line(`debug: cleared ${res.cleared}`);
          return 0;
        }
      }
    } catch (e) {
      const errno = mustErrno(e);
      const disabled = reasonOf(e) === 'disabled' || describe(e).includes('disabled');
      if (errno === 'EPERM' && disabled)
        yield* io.error('fault injection is disabled on this server');
      else yield* io.error(describe(e));
      return 1;
    }
  },
});
