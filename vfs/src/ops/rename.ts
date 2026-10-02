/**
 * `rename` / `mv` (virtual-file-system.md §3.12.4): the POSIX matrix, `noReplace`, EINVAL for a
 * directory moved into its own subtree (O(depth) walk up from the destination parent), EXDEV across
 * `root` and `tmp`, EBUSY for well-known directories, and the sticky rules. Only the two parents'
 * versions change: the moved inode gets a new ctime, never a new version (§3.2).
 */
import { fail } from '../errors.ts';
import { checkRename } from '../perm.ts';
import type { Uuid } from '../store/records.ts';
import { entryPath, isWithin } from '../view.ts';
import {
  checkNotBusy,
  checkNotSynth,
  checkNotWellKnown,
  checkWritable,
  entriesOf,
  forRemove,
  forTarget,
  fsOfChild,
  orFail,
} from './common.ts';
import type { PlanBuilder } from './plan.ts';
import { dropDir, dropLink } from './unlink.ts';

export interface RenameResult {
  readonly ino: Uuid;
  readonly replaced?: Uuid;
}

export function planRename(
  b: PlanBuilder,
  from: string,
  to: string,
  noReplace = false,
): RenameResult {
  checkWritable(b);
  const s = forRemove(b, from);
  const d = forTarget(b, to);
  const moved = s.node;
  const target = d.node;
  checkNotSynth(moved);
  if (target !== null) checkNotSynth(target);
  // The same entry, or two links of one inode: a successful no-op (POSIX).
  if ((s.parent.ino === d.parent.ino && s.name === d.name) || target?.ino === moved.ino)
    return { ino: moved.ino };
  if (moved.type === 'd') checkNotWellKnown(moved);
  if (target?.type === 'd') checkNotWellKnown(target);
  if (fsOfChild(s.parent) !== fsOfChild(d.parent)) fail('EXDEV');
  if (moved.type === 'd' && isWithin(b.view, d.parent.ino, moved.ino)) fail('EINVAL');
  if (target !== null) {
    if (noReplace) fail('EEXIST');
    if (moved.type !== 'd' && target.type === 'd') fail('EISDIR');
    if (moved.type === 'd' && target.type !== 'd') fail('ENOTDIR');
    if (target.type === 'd' && entriesOf(b, target.ino).length > 0) fail('ENOTEMPTY');
  }
  const sameParent = s.parent.ino === d.parent.ino;
  orFail(checkRename(b.ctx.cred, s.parent, moved, d.parent, target, sameParent));
  checkNotBusy(b, moved);
  if (target !== null) checkNotBusy(b, target);

  const movedDir = moved.type === 'd';
  let freedTarget = false;
  b.delDentry({ parent: s.parent.ino, name: s.name, ino: moved.ino, dtype: moved.type });
  if (target !== null) {
    if (target.type === 'd') {
      dropDir(b, d.parent.ino, d.name, target);
      freedTarget = true;
    } else {
      freedTarget = dropLink(b, d.parent.ino, d.name, target);
    }
  }
  b.addDentry({ parent: d.parent.ino, name: d.name, ino: moved.ino, dtype: moved.type });
  const cur = b.view.inode(moved.ino) ?? moved;
  b.putInode({ ...cur, ctime: b.ctx.now });
  const replacedDir = target?.type === 'd' ? -1 : 0;
  if (sameParent) {
    b.dirChanged(s.parent.ino, replacedDir);
  } else {
    b.dirChanged(s.parent.ino, movedDir ? -1 : 0);
    b.dirChanged(d.parent.ino, (movedDir ? 1 : 0) + replacedDir);
  }

  const fromPath = entryPath(b.base, s.parent.ino, s.name);
  const toPath = entryPath(b.base, d.parent.ino, d.name);
  b.notes.moves.push({ from: fromPath, to: toPath });
  if (target !== null) b.notes.overwrites.push(toPath);
  b.emit({
    topic: 'vfs.rename',
    data: {
      items: [
        {
          ino: moved.ino,
          type: moved.type,
          from: { parent: s.parent.ino, name: s.name },
          to: { parent: d.parent.ino, name: d.name },
          ...(target === null ? {} : { replaced: target.ino }),
        },
      ],
    },
  });
  if (target !== null) {
    b.emit({
      topic: 'vfs.unlink',
      data: {
        items: [
          {
            parent: d.parent.ino,
            name: d.name,
            ino: target.ino,
            type: target.type,
            inos: freedTarget ? [target.ino] : [],
            count: freedTarget ? 1 : 0,
          },
        ],
      },
    });
  }
  b.wire(
    {
      kind: 'rename',
      ino: moved.ino,
      fromParentIno: s.parent.ino,
      fromName: s.name,
      toParentIno: d.parent.ino,
      toName: d.name,
      ...(target === null ? {} : { replace: { ino: target.ino, version: target.version } }),
    },
    moved.fs,
  );
  b.setBase({ kind: 'versions', entries: [] });
  return target === null ? { ino: moved.ino } : { ino: moved.ino, replaced: target.ino };
}
