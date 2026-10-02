/**
 * `ls [-a] [-l] [-h] [-d] [-R] [-1] [-i] [-t] [-r] [--color[=WHEN]] [PATH...]`
 * (shell-and-terminal.md §3.14.1): `lstat` for operands, `readdir {plus}` in pages of 1,000.
 */
import type { DirEntry, Stat } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { byCodePoint, dateTime, escapeName, humanSize, modeString } from '../lib/format.ts';
import { listDir, tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { join } from '../lib/path.ts';
import type { SysGen } from '../lib/sys.ts';
import type { UserDb } from '../lib/users.ts';
import { groupName, loadUsers, userName } from '../lib/users.ts';

export interface LsOpts {
  readonly all: boolean;
  readonly long: boolean;
  readonly human: boolean;
  readonly dirSelf: boolean;
  readonly recursive: boolean;
  readonly one: boolean;
  readonly inode: boolean;
  readonly byTime: boolean;
  readonly reverse: boolean;
  readonly color: 'auto' | 'never' | 'always';
  readonly paths: readonly string[];
}

export interface Item {
  readonly name: string;
  readonly stat: Stat;
}

/** How items are printed: decided once per run. */
export interface Style {
  readonly tty: boolean;
  readonly color: boolean;
  readonly cols: number;
  readonly tz: number;
  readonly users: UserDb;
}

const BLUE_BOLD = '\x1b[1;34m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export function sortItems(items: Item[], opts: LsOpts): Item[] {
  items.sort((a, b) => {
    if (opts.byTime && a.stat.mtime !== b.stat.mtime) return b.stat.mtime - a.stat.mtime;
    return byCodePoint(a.name, b.name);
  });
  if (opts.reverse) items.reverse();
  return items;
}

function painted(item: Item, style: Style, text: string): string {
  if (!style.color) return text;
  if (item.stat.type === 'd') return `${BLUE_BOLD}${text}${RESET}`;
  if (item.stat.type === 'l') return `${CYAN}${text}${RESET}`;
  return text;
}

function inodePrefix(item: Item, opts: LsOpts): string {
  return opts.inode ? `${item.stat.ino.replace(/-/g, '').slice(0, 8)} ` : '';
}

/** Short-format label: escaped name plus the TTY classification mark (`/`, `@`). */
function shortLabel(item: Item, opts: LsOpts, style: Style): { text: string; width: number } {
  const name = escapeName(item.name, style.tty);
  const mark = style.tty ? (item.stat.type === 'd' ? '/' : item.stat.type === 'l' ? '@' : '') : '';
  const plain = `${inodePrefix(item, opts)}${name}${mark}`;
  return {
    text: `${inodePrefix(item, opts)}${painted(item, style, name)}${mark}`,
    width: [...plain].length,
  };
}

/** Columns sized to the terminal width, filled top to bottom. */
export function columns(
  labels: readonly { text: string; width: number }[],
  cols: number,
): string[] {
  if (labels.length === 0) return [];
  const colWidth = Math.max(...labels.map((l) => l.width)) + 2;
  const ncols = Math.max(1, Math.floor((cols + 2) / colWidth));
  const nrows = Math.ceil(labels.length / ncols);
  const lines: string[] = [];
  for (let r = 0; r < nrows; r++) {
    let line = '';
    for (let c = 0; c < ncols; c++) {
      const label = labels[c * nrows + r];
      if (label === undefined) break;
      const last = labels[(c + 1) * nrows + r] === undefined;
      line += last ? label.text : label.text + ' '.repeat(colWidth - label.width);
    }
    lines.push(line);
  }
  return lines;
}

export function longLines(items: readonly Item[], opts: LsOpts, style: Style): string[] {
  const rows = items.map((item) => {
    const s = item.stat;
    const name = painted(item, style, escapeName(item.name, style.tty));
    const target =
      s.type === 'l' && s.target !== null ? ` -> ${escapeName(s.target, style.tty)}` : '';
    return {
      prefix: inodePrefix(item, opts),
      mode: modeString(s.type, s.mode),
      nlink: String(s.nlink),
      owner: userName(style.users, s.uid),
      group: groupName(style.users, s.gid),
      size: opts.human ? humanSize(s.size) : String(s.size),
      time: dateTime(s.mtime, style.tz),
      name: name + target,
    };
  });
  const w = (key: 'nlink' | 'owner' | 'group' | 'size'): number =>
    Math.max(0, ...rows.map((r) => r[key].length));
  const [wl, wo, wg, ws] = [w('nlink'), w('owner'), w('group'), w('size')];
  return rows.map(
    (r) =>
      `${r.prefix}${r.mode} ${r.nlink.padStart(wl)} ${r.owner.padEnd(wo)} ${r.group.padEnd(wg)} ${r.size.padStart(ws)} ${r.time} ${r.name}`,
  );
}

export function render(items: readonly Item[], opts: LsOpts, style: Style): string[] {
  if (opts.long) return longLines(items, opts, style);
  const labels = items.map((item) => shortLabel(item, opts, style));
  if (opts.one || !style.tty) return labels.map((l) => l.text);
  return columns(labels, style.cols);
}

function toItems(entries: readonly DirEntry[], opts: LsOpts): Item[] {
  const items: Item[] = [];
  for (const e of entries) {
    if (!opts.all && e.name.startsWith('.')) continue;
    if (e.stat !== undefined) items.push({ name: e.name, stat: e.stat });
  }
  return items;
}

/** The entries of one directory as items, `.` and `..` included with `-a`. */
function* readItems(io: Io, path: string, opts: LsOpts): SysGen<Item[]> {
  const items = toItems(yield* listDir(io.sys, path, true), opts);
  if (opts.all) {
    const self = yield* tryStat(io.sys, path, true);
    const parent = yield* tryStat(io.sys, join(path, '..'), true);
    if (self.ok) items.push({ name: '.', stat: self.stat });
    if (parent.ok) items.push({ name: '..', stat: parent.stat });
  }
  return sortItems(items, opts);
}

function* listOne(
  io: Io,
  path: string,
  opts: LsOpts,
  style: Style,
  header: boolean,
  first: boolean,
): SysGen<boolean> {
  let items: Item[];
  try {
    items = yield* readItems(io, path, opts);
  } catch (e) {
    const errno = mustErrno(e);
    const what = errno === 'EACCES' ? 'cannot open directory' : 'cannot access';
    yield* io.error(`${what} '${path}': ${describe(e)}`);
    return false;
  }
  if (header) yield* io.line(`${first ? '' : '\n'}${escapeName(path, style.tty)}:`);
  yield* io.lines(render(items, opts, style));
  if (!opts.recursive) return true;
  let ok = true;
  for (const item of items) {
    if (item.stat.type !== 'd' || item.name === '.' || item.name === '..') continue;
    ok = (yield* listOne(io, join(path, item.name), opts, style, true, false)) && ok;
  }
  return ok;
}

export default defineCommand<LsOpts>({
  name: 'ls',
  parse(args) {
    const p = parseFor('ls', args);
    const when = p.value('color') ?? 'auto';
    const color = when === '' ? 'auto' : when;
    if (color !== 'auto' && color !== 'never' && color !== 'always') {
      throw new UsageError(`invalid argument '${color}' for '--color'`);
    }
    return {
      all: p.has('a'),
      long: p.has('l'),
      human: p.has('h'),
      dirSelf: p.has('d'),
      recursive: p.has('R'),
      one: p.has('1'),
      inode: p.has('i'),
      byTime: p.has('t'),
      reverse: p.has('r'),
      color,
      paths: p.operands.length === 0 ? ['.'] : p.operands,
    };
  },
  *run(io, opts) {
    const tty = yield* io.isTty(1);
    const style: Style = {
      tty,
      color: opts.color === 'always' || (opts.color === 'auto' && tty),
      cols: yield* io.columns(),
      tz: yield* io.tzOffset(),
      users: opts.long ? yield* loadUsers(io.sys) : { users: [], groups: [] },
    };
    let status = 0;
    const files: Item[] = [];
    const dirs: string[] = [];
    for (const path of opts.paths) {
      const st = yield* tryStat(io.sys, path, false);
      if (!st.ok) {
        yield* io.error(`cannot access '${path}': ${describe(st.error)}`);
        status = 1;
        continue;
      }
      let isDir = st.stat.type === 'd';
      if (st.stat.type === 'l' && !opts.long && !opts.dirSelf) {
        const target = yield* tryStat(io.sys, path, true);
        isDir = target.ok && target.stat.type === 'd';
      }
      if (isDir && !opts.dirSelf) dirs.push(path);
      else files.push({ name: path, stat: st.stat });
    }
    yield* io.lines(render(sortItems(files, opts), opts, style));
    const header = opts.paths.length > 1 || opts.recursive;
    dirs.sort(byCodePoint);
    if (opts.reverse) dirs.reverse();
    for (const [i, dir] of dirs.entries()) {
      const ok = yield* listOne(io, dir, opts, style, header, i === 0 && files.length === 0);
      if (!ok) status = 1;
    }
    return status;
  },
});
