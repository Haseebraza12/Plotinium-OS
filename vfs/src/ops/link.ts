/**
 * `link(existing, path)`: hard links (virtual-file-system.md §3.7.2). Regular files only (EPERM),
 * same file system only (EXDEV), protected hard links (a non-root caller must own the file or have
 * both r and w on it). `nlink` + 1 and ctime; no version bump and no new quota charge (an inode is
 * charged once, whatever its link count).
 */
import { fail } from '../errors.ts';
import { checkLink } from '../perm.ts';
import type { Uuid } from '../store/records.ts';
import { entryPath } from '../view.ts';
import { checkNotSynth, checkWritable, forCreate, fsOfChild, locate, orFail } from './common.ts';
import type { PlanBuilder } from './plan.ts';

export function planLink(
  b: PlanBuilder,
  existing: string,
  path: string,
): { ino: Uuid; nlink: number } {
  checkWritable(b);
  const src = locate(b, existing, { follow: false }).node ?? fail('ENOENT');
  const t = forCreate(b, path);
  if (t.node !== null) fail('EEXIST');
  checkNotSynth(src);
  orFail(checkLink(b.ctx.cred, src, t.parent));
  if (src.fs !== fsOfChild(t.parent)) fail('EXDEV');
  b.addDentry({ parent: t.parent.ino, name: t.name, ino: src.ino, dtype: src.type });
  const cur = b.view.inode(src.ino) ?? src;
  const nlink = cur.nlink + 1;
  b.putInode({ ...cur, nlink, ctime: b.ctx.now });
  b.dirChanged(t.parent.ino, 0);
  b.notes.creates.push(entryPath(b.view, t.parent.ino, t.name));
  b.emit({
    topic: 'vfs.link',
    data: { items: [{ ino: src.ino, parent: t.parent.ino, name: t.name, nlink }] },
  });
  b.wire({ kind: 'link', ino: src.ino, parentIno: t.parent.ino, name: t.name }, src.fs);
  b.setBase({ kind: 'versions', entries: [] });
  return { ino: src.ino, nlink };
}
