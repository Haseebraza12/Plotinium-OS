/** `touch [-c] [-a] [-m] [-d DATE] FILE...` (shell-and-terminal.md §3.14.6). */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { tryStat } from '../lib/fs.ts';

export interface TouchOpts {
  readonly noCreate: boolean;
  readonly atime: boolean;
  readonly mtime: boolean;
  readonly date: string | null;
  readonly files: readonly string[];
}

/** `YYYY-MM-DD[THH:MM[:SS]]` in local time → epoch ms, or null when malformed. */
export function parseDate(text: string, tzOffsetMin: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0));
  if (mo === undefined || mo < 1 || mo > 12 || d === undefined || d < 1 || d > 31) return null;
  if ((h ?? 0) > 23 || (mi ?? 0) > 59 || (s ?? 0) > 59) return null;
  const utc = Date.UTC(y ?? 0, mo - 1, d, h, mi, s);
  if (new Date(utc).getUTCDate() !== d) return null;
  return utc - tzOffsetMin * 60_000;
}

export default defineCommand<TouchOpts>({
  name: 'touch',
  parse(args) {
    const p = parseFor('touch', args);
    if (p.operands.length === 0) throw new UsageError('missing file operand');
    const onlyA = p.has('a') && !p.has('m');
    const onlyM = p.has('m') && !p.has('a');
    return {
      noCreate: p.has('c'),
      atime: !onlyM,
      mtime: !onlyA,
      date: p.value('d') ?? null,
      files: p.operands,
    };
  },
  *run(io, opts) {
    let when: number | 'now' = 'now';
    if (opts.date !== null) {
      const parsed = parseDate(opts.date, yield* io.tzOffset());
      if (parsed === null) {
        yield* io.error(`invalid date format '${opts.date}'`);
        return 1;
      }
      when = parsed;
    }
    const times = {
      ...(opts.atime ? { atime: when } : {}),
      ...(opts.mtime ? { mtime: when } : {}),
    };
    const explicit = opts.date !== null || !opts.atime || !opts.mtime;
    let status = 0;
    for (const path of opts.files) {
      try {
        const st = yield* tryStat(io.sys, path, true);
        if (st.ok) {
          yield* io.sys.call('utimes', { path, ...times });
          continue;
        }
        if (st.errno !== 'ENOENT') throw st.error;
        if (opts.noCreate) continue;
        const { fd } = yield* io.sys.call('open', { path, flags: 'w', create: true });
        yield* io.sys.call('close', { fd });
        if (explicit) yield* io.sys.call('utimes', { path, ...times });
      } catch (e) {
        yield* io.error(`cannot touch '${path}': ${describe(e)}`);
        status = 1;
      }
    }
    return status;
  },
});
