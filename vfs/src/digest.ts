/**
 * Subtree digest and tree checksum (virtual-file-system.md §5.6). Isomorphic: the server computes
 * the same lines with the same formula, so equal output means identical metadata (DB-02 proof).
 */
import { sha256Hex } from '@plotinium/protocol';

import { compareCodePoints } from './names.ts';
import type { DentryRec, InodeRec } from './store/records.ts';

export { sha256Hex };

const ascii = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Base of subtree ops: SHA-256 over `"<ino>:<version>\n"` sorted by ino, each inode once, `tmp`
 * inodes excluded (synthesised inodes are never stored, so callers never pass them).
 */
export function subtreeDigest(inodes: Iterable<Pick<InodeRec, 'ino' | 'version' | 'fs'>>): string {
  const seen = new Map<string, number>();
  for (const n of inodes) if (n.fs !== 'tmp') seen.set(n.ino, n.version);
  const lines = [...seen.entries()]
    .sort((a, b) => ascii(a[0], b[0]))
    .map(([ino, v]) => `${ino}:${v}\n`);
  return sha256Hex(lines.join(''));
}

/** One checksum line: `<parent>|<name>|<ino>|<type>|<mode>|<uid>|<gid>|<size>|<nlink>|<version>|<blob or ->`. */
export function checksumLine(parent: string, name: string, n: InodeRec): string {
  return `${parent}|${name}|${n.ino}|${n.type}|${n.mode}|${n.uid}|${n.gid}|${n.size}|${n.nlink}|${n.version}|${n.blob ?? '-'}\n`;
}

/**
 * Tree checksum (`fsck --checksum`): one line per dentry of the subtree plus the root's own line
 * (for '/', parent and name are empty), sorted by (parent ASCII, name code point).
 */
export function treeChecksum(
  root: { parent: string; name: string; inode: InodeRec },
  entries: Iterable<{ dentry: DentryRec; inode: InodeRec }>,
): string {
  const rows: { parent: string; name: string; line: string }[] = [
    {
      parent: root.parent,
      name: root.name,
      line: checksumLine(root.parent, root.name, root.inode),
    },
  ];
  for (const { dentry, inode } of entries) {
    rows.push({
      parent: dentry.parent,
      name: dentry.name,
      line: checksumLine(dentry.parent, dentry.name, inode),
    });
  }
  rows.sort((a, b) => ascii(a.parent, b.parent) || compareCodePoints(a.name, b.name));
  return sha256Hex(rows.map((r) => r.line).join(''));
}
