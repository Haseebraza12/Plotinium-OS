/**
 * `chmod [-R] [-v] [-c] MODE FILE...` (shell-and-terminal.md §3.14.16, virtual-file-system.md
 * §5.4). `-R` is one bulk transaction; a mode with `X` depends on each inode, so it becomes one
 * `batch` of exact modes computed from a walk of the tree.
 */
import type { BatchOp, ModeChange } from '@plotinium/protocol';
import { BATCH_MAX_OPS } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { bulkSuffix, describe } from '../lib/errors.ts';
import { octal, permString } from '../lib/format.ts';
import type { FindHit } from '../lib/fs.ts';
import { findAll, tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import type { ModeSpec } from '../lib/mode.ts';
import { applyMode, parseMode, toModeChange } from '../lib/mode.ts';
import type { SysGen } from '../lib/sys.ts';
import { uuidv7 } from '../lib/uuid.ts';

export interface ChmodOpts {
  readonly recursive: boolean;
  readonly verbose: boolean;
  readonly changes: boolean;
  readonly mode: string;
  readonly files: readonly string[];
}

const MODE_LIKE = /^[-+=][rwxXt]*([,][ugoa]*[-+=][rwxXt]*)*$/;

/** `chmod -w f`: a leading-dash MODE is taken out before option parsing (GNU behaviour). */
export function splitModeArg(args: readonly string[]): { args: string[]; mode: string | null } {
  const rest = [...args];
  const end = rest.indexOf('--');
  const limit = end === -1 ? rest.length : end;
  for (let i = 0; i < limit; i++) {
    const a = rest[i] ?? '';
    if (a.startsWith('-') && MODE_LIKE.test(a) && !/^-[Rvc]+$/.test(a)) {
      rest.splice(i, 1);
      return { args: rest, mode: a };
    }
  }
  return { args: rest, mode: null };
}

interface Change {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

export function changeLine(c: Change, verbose: boolean): string | null {
  const show = (m: number): string => `${octal(m)} (${permString(m)})`;
  if (c.from !== c.to) return `mode of '${c.path}' changed from ${show(c.from)} to ${show(c.to)}`;
  return verbose ? `mode of '${c.path}' retained as ${show(c.from)}` : null;
}

/** The planned change of every non-symlink node of a walk. */
export function planWalk(hits: readonly FindHit[], spec: ModeSpec, umask: number): Change[] {
  const changes: Change[] = [];
  for (const hit of hits) {
    const st = hit.entry?.stat;
    if (st === undefined || st.type === 'l') continue;
    changes.push({
      path: hit.path,
      from: st.mode,
      to: applyMode(spec, st.mode, st.type === 'd', umask),
    });
  }
  return changes;
}

/** Every non-symlink node under `path` with its current and new mode. */
function* plan(
  io: Io,
  path: string,
  spec: ModeSpec,
  umask: number,
  recursive: boolean,
): SysGen<Change[]> {
  const root = yield* io.sys.call('stat', { path });
  const first: Change = {
    path,
    from: root.mode,
    to: applyMode(spec, root.mode, root.type === 'd', umask),
  };
  if (!recursive || root.type !== 'd') return [first];
  const walk = yield* findAll(io.sys, { path, plus: true });
  return [first, ...planWalk(walk.hits, spec, umask)];
}

function* apply(
  io: Io,
  path: string,
  change: ModeChange | null,
  planned: readonly Change[],
  recursive: boolean,
): SysGen<void> {
  if (change !== null) {
    yield* io.sys.call('chmod', { path, mode: change, recursive });
    return;
  }
  if (!recursive) {
    yield* io.sys.call('chmod', { path, mode: { op: 'set', bits: planned[0]?.to ?? 0 } });
    return;
  }
  if (planned.length > BATCH_MAX_OPS)
    throw new UsageError(
      `'${path}': too many files for one transaction with X (${planned.length})`,
    );
  const ops: BatchOp[] = planned.map((c) => ({
    op: 'chmod',
    path: c.path,
    mode: { op: 'set', bits: c.to },
  }));
  yield* io.sys.call('batch', { txnId: uuidv7(yield* io.wallClock()), ops, expectedVersions: [] });
}

export default defineCommand<ChmodOpts>({
  name: 'chmod',
  parse(args) {
    const split = splitModeArg(args);
    const p = parseFor('chmod', split.args);
    const operands = [...p.operands];
    const mode = split.mode ?? operands.shift();
    if (mode === undefined) throw new UsageError('missing operand');
    if (operands.length === 0) throw new UsageError(`missing operand after '${mode}'`);
    return {
      recursive: p.has('R'),
      verbose: p.has('v'),
      changes: p.has('c'),
      mode,
      files: operands,
    };
  },
  *run(io, opts) {
    const spec = parseMode(opts.mode);
    if (spec === null) {
      yield* io.error(`invalid mode: '${opts.mode}'`);
      return 1;
    }
    const umask = spec.kind === 'symbolic' ? (yield* io.sys.call('umask', {})).old : 0;
    const change = toModeChange(spec, umask);
    const report = opts.verbose || opts.changes;
    let status = 0;
    for (const path of opts.files) {
      const st = yield* tryStat(io.sys, path, true);
      if (!st.ok) {
        yield* io.error(`cannot access '${path}': ${describe(st.error)}`);
        status = 1;
        continue;
      }
      try {
        const planned =
          report || change === null ? yield* plan(io, path, spec, umask, opts.recursive) : [];
        yield* apply(io, path, change, planned, opts.recursive);
        if (report) {
          for (const c of planned) {
            const line = changeLine(c, opts.verbose);
            if (line !== null) yield* io.line(line);
          }
        }
      } catch (e) {
        if (e instanceof UsageError) {
          yield* io.error(e.message);
        } else {
          yield* io.error(`changing permissions of '${path}': ${describe(e)}${bulkSuffix(e)}`);
        }
        status = 1;
      }
    }
    return status;
  },
});
