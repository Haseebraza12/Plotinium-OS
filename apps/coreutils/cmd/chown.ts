/**
 * `chown [-R] [-v] [-c] OWNER[:GROUP] FILE...` and `chown [-R] :GROUP FILE...`
 * (shell-and-terminal.md §3.14.17). Root only; `-R` is one bulk transaction.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { bulkSuffix, describe } from '../lib/errors.ts';
import { tryStat } from '../lib/fs.ts';
import type { UserDb } from '../lib/users.ts';
import { findGid, findUid, findUser, groupName, loadUsers, userName } from '../lib/users.ts';

export interface ChownOpts {
  readonly recursive: boolean;
  readonly verbose: boolean;
  readonly changes: boolean;
  readonly owner: string | null;
  readonly group: string | null;
  /** `OWNER:` — the group becomes the owner's login group. */
  readonly loginGroup: boolean;
  readonly spec: string;
  readonly files: readonly string[];
}

export function parseOwner(spec: string): {
  owner: string | null;
  group: string | null;
  loginGroup: boolean;
} {
  const i = spec.indexOf(':');
  if (i === -1) return { owner: spec, group: null, loginGroup: false };
  const owner = spec.slice(0, i) || null;
  const group = spec.slice(i + 1) || null;
  return { owner, group, loginGroup: owner !== null && group === null };
}

type Resolved = { uid?: number; gid?: number } | string;

export function resolveOwner(db: UserDb, opts: ChownOpts): Resolved {
  const out: { uid?: number; gid?: number } = {};
  if (opts.owner !== null) {
    const uid = findUid(db, opts.owner);
    if (uid === undefined) return `invalid user: '${opts.spec}'`;
    out.uid = uid;
    if (opts.loginGroup) {
      const rec = findUser(db, opts.owner);
      if (rec === undefined) return `invalid user: '${opts.spec}'`;
      out.gid = rec.gid;
    }
  }
  if (opts.group !== null) {
    const gid = findGid(db, opts.group);
    if (gid === undefined) return `invalid group: '${opts.spec}'`;
    out.gid = gid;
  }
  return out;
}

export default defineCommand<ChownOpts>({
  name: 'chown',
  parse(args) {
    const p = parseFor('chown', args);
    const [spec, ...files] = p.operands;
    if (spec === undefined) throw new UsageError('missing operand');
    if (files.length === 0) throw new UsageError(`missing operand after '${spec}'`);
    return {
      recursive: p.has('R'),
      verbose: p.has('v'),
      changes: p.has('c'),
      ...parseOwner(spec),
      spec,
      files,
    };
  },
  *run(io, opts) {
    const db = yield* loadUsers(io.sys);
    const target = resolveOwner(db, opts);
    if (typeof target === 'string') {
      yield* io.error(target);
      return 1;
    }
    const pair = (uid: number, gid: number): string => `${userName(db, uid)}:${groupName(db, gid)}`;
    let status = 0;
    for (const path of opts.files) {
      const st = yield* tryStat(io.sys, path);
      if (!st.ok) {
        yield* io.error(`cannot access '${path}': ${describe(st.error)}`);
        status = 1;
        continue;
      }
      try {
        yield* io.sys.call('chown', { path, ...target, recursive: opts.recursive });
      } catch (e) {
        yield* io.error(`changing ownership of '${path}': ${describe(e)}${bulkSuffix(e)}`);
        status = 1;
        continue;
      }
      const before = pair(st.stat.uid, st.stat.gid);
      const after = pair(target.uid ?? st.stat.uid, target.gid ?? st.stat.gid);
      if (before !== after && (opts.verbose || opts.changes)) {
        yield* io.line(`changed ownership of '${path}' from ${before} to ${after}`);
      } else if (before === after && opts.verbose) {
        yield* io.line(`ownership of '${path}' retained as ${after}`);
      }
    }
    return status;
  },
});
