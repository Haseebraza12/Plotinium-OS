/** `id [-u | -g | -G] [-n] [USER]` (shell-and-terminal.md §3.14.35). */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import type { UserDb } from '../lib/users.ts';
import { findUser, groupName, loadUsers } from '../lib/users.ts';

export interface IdOpts {
  readonly only: 'u' | 'g' | 'G' | null;
  readonly names: boolean;
  readonly user: string | null;
}

interface Ident {
  readonly uid: number;
  readonly user: string;
  readonly gid: number;
  readonly groups: readonly number[];
}

export function formatId(id: Ident, db: UserDb, opts: IdOpts): string {
  const gname = (gid: number): string => groupName(db, gid);
  if (opts.only === 'u') return opts.names ? id.user : String(id.uid);
  if (opts.only === 'g') return opts.names ? gname(id.gid) : String(id.gid);
  if (opts.only === 'G') return id.groups.map((g) => (opts.names ? gname(g) : String(g))).join(' ');
  const groups = id.groups.map((g) => `${g}(${gname(g)})`).join(',');
  return `uid=${id.uid}(${id.user}) gid=${id.gid}(${gname(id.gid)}) groups=${groups}`;
}

export default defineCommand<IdOpts>({
  name: 'id',
  parse(args) {
    const p = parseFor('id', args);
    const chosen = (['u', 'g', 'G'] as const).filter((k) => p.has(k));
    if (chosen.length > 1) throw new UsageError('cannot print "only" of more than one choice');
    const only = chosen[0] ?? null;
    if (p.has('n') && only === null)
      throw new UsageError('cannot print only names in default format');
    if (p.operands.length > 1) throw new UsageError(`extra operand '${p.operands[1] ?? ''}'`);
    return { only, names: p.has('n'), user: p.operands[0] ?? null };
  },
  *run(io, opts) {
    const db = yield* loadUsers(io.sys);
    let ident: Ident;
    if (opts.user === null) {
      try {
        const cred = yield* io.sys.call('proc.cred', {});
        ident = { uid: cred.uid, user: cred.user, gid: cred.gid, groups: cred.groups };
      } catch (e) {
        yield* io.error(describe(e));
        return 1;
      }
    } else {
      const rec = findUser(db, opts.user);
      if (rec === undefined) {
        yield* io.error(`'${opts.user}': no such user`);
        return 1;
      }
      ident = { uid: rec.uid, user: rec.name, gid: rec.gid, groups: rec.groups };
    }
    yield* io.line(formatId(ident, db, opts));
    return 0;
  },
});
