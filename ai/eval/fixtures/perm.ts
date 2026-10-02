/**
 * Reference POSIX permission oracle for fixtures and tests: the semantics of `vfs/perm.ts`
 * (owner, then group, then other; root bypasses r and w, and x on a file needs some x bit).
 * The kernel injects the real `vfs/perm.ts`; ai/ never imports it.
 */
import type { Cred, PermBit, PermOracle, PermSubject } from '../../src/util/cred.ts';

export const posixOracle: PermOracle = {
  may(cred: Cred, node: PermSubject, bit: PermBit): boolean {
    const mask = bit === 'r' ? 4 : bit === 'w' ? 2 : 1;
    if (cred.uid === 0) return bit !== 'x' || node.type === 'd' || (node.mode & 0o111) !== 0;
    if (node.uid === cred.uid) return ((node.mode >> 6) & mask) !== 0;
    if (node.gid === cred.gid || cred.groups.includes(node.gid))
      return ((node.mode >> 3) & mask) !== 0;
    return (node.mode & mask) !== 0;
  },
};
