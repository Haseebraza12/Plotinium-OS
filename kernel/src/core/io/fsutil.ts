/**
 * Kernel-internal reads of the file system on behalf of kernel services (root credentials, never
 * a process): the completion index, the man index, session and seed helpers.
 */
import type { InodeType, Uuid } from '@plotinium/vfs';
import { INO } from '@plotinium/protocol';

import type { FsActor, KernelFs } from '../fs/kfs.ts';

export const ROOT_ACTOR: FsActor = Object.freeze({
  pid: 1,
  cred: Object.freeze({ uid: 0, gid: 0, groups: Object.freeze([0]) as number[] }),
  cls: 'system',
  cwdIno: INO.ROOT,
  cwdPath: '/',
  umask: 0o022,
});

const decoder = new TextDecoder();

/** The bytes of a regular file, or null when it does not exist or is not a file. */
export async function readFileAsRoot(fs: KernelFs, path: string): Promise<Uint8Array | null> {
  try {
    const r = await fs.resolvePath(ROOT_ACTOR, path, { follow: true });
    const node = r.node;
    if (node?.type !== 'f') return null;
    if (node.blob === null || node.size === 0) return new Uint8Array(0);
    const bytes = await fs.content.bytesOf(node.blob);
    return bytes.byteLength > node.size ? bytes.slice(0, node.size) : bytes;
  } catch {
    return null;
  }
}

export async function readTextAsRoot(fs: KernelFs, path: string): Promise<string | null> {
  const b = await readFileAsRoot(fs, path);
  return b === null ? null : decoder.decode(b);
}

export interface DirEntry {
  readonly name: string;
  readonly ino: Uuid;
  readonly type: InodeType;
}

/** The entries of a directory (loading it first), or null when it cannot be listed. */
export async function listDir(fs: KernelFs, dirIno: Uuid): Promise<DirEntry[] | null> {
  try {
    await fs.loader.ensureLoaded(dirIno);
  } catch {
    return null;
  }
  const entries = fs.tree.entries(dirIno);
  if (typeof entries === 'string') return null;
  return entries.map((d) => ({ name: d.name, ino: d.ino, type: d.dtype }));
}
