/**
 * The readable set, executable in TypeScript (RAG-03; backend-api.md §3.12; rag-semantic-search.md
 * §4.5, §5.1 I-A1, I-A9, §5.2).
 *
 * A file is READABLE by a requester when the requester has r on the file (its CURRENT inode row)
 * and at least one of its links (hard links exist) hangs under a chain of directories, from / down
 * to the link's parent, on every one of which the requester has x. Permissions are always read
 * from the current inodes and dentries, never from a copy, so a chmod is effective on the next
 * query and a deleted file is never readable.
 *
 * Two algorithms compute it, exactly as the two SQL statements of readable.sql.ts do:
 *   readableTopDown  walk down from / and prune every directory without x (the search and pull CTE);
 *   verifyUpward     walk up from each candidate, once per link (the verify statement).
 * This module is the executable specification: the unit tests check both against a brute-force
 * definition on random permission graphs, and the database-gated test checks the SQL against it.
 * Permission bits come from @plotinium/vfs/perm, the same `may` the kernel uses (VFS-04).
 */
import { INO } from '@plotinium/protocol';
import { may, R, X, type Cred } from '@plotinium/vfs/perm';

import type { Requester } from './types.ts';

export interface GraphInode {
  readonly ino: string;
  readonly type: 'f' | 'd' | 'l';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export interface GraphDentry {
  readonly parentIno: string;
  readonly name: string;
  readonly ino: string;
}

export interface PermGraph {
  readonly rootIno: string;
  readonly inodes: ReadonlyMap<string, GraphInode>;
  readonly dentries: readonly GraphDentry[];
}

/** Paths are at most 4,096 bytes, so no chain is deeper than 2,048 directories. */
export const MAX_DEPTH = 2048;
export const ROOT_INO = INO.ROOT;

/** Byte order of UTF-8 (= code point order), the order of COLLATE "C" in the SQL. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function credOf(req: Requester): Cred {
  return { uid: req.uid, gid: req.gids[0] ?? -1, groups: req.gids };
}

function childrenOf(g: PermGraph): Map<string, GraphDentry[]> {
  const m = new Map<string, GraphDentry[]>();
  for (const d of g.dentries) {
    const list = m.get(d.parentIno);
    if (list === undefined) m.set(d.parentIno, [d]);
    else list.push(d);
  }
  return m;
}

/**
 * Top-down (the CTE): file ino -> the smallest readable path. With `scopeIno`, only files under
 * that directory count, but the directory must still be reached from / with x on every ancestor.
 */
export function readableTopDown(
  g: PermGraph,
  req: Requester,
  scopeIno: string | null = null,
): Map<string, string> {
  const cred = credOf(req);
  const out = new Map<string, string>();
  const root = g.inodes.get(g.rootIno);
  if (root === undefined || root.type !== 'd' || !may(cred, root, X)) return out;
  const children = childrenOf(g);
  const seen = new Set<string>([g.rootIno]);
  const queue: { ino: string; path: string; under: boolean; depth: number }[] = [
    { ino: g.rootIno, path: '', under: scopeIno === null || scopeIno === g.rootIno, depth: 0 },
  ];
  for (let i = 0; i < queue.length; i++) {
    const w = queue[i];
    if (w === undefined) break;
    for (const d of children.get(w.ino) ?? []) {
      const n = g.inodes.get(d.ino);
      if (n === undefined) continue;
      const path = `${w.path}/${d.name}`;
      if (n.type === 'd') {
        if (!seen.has(d.ino) && w.depth + 1 < MAX_DEPTH && may(cred, n, X)) {
          seen.add(d.ino);
          queue.push({
            ino: d.ino,
            path,
            under: w.under || d.ino === scopeIno,
            depth: w.depth + 1,
          });
        }
      } else if (n.type === 'f' && w.under && may(cred, n, R)) {
        const prev = out.get(d.ino);
        if (prev === undefined || comparePaths(path, prev) < 0) out.set(d.ino, path);
      }
    }
  }
  return out;
}

export interface UpwardResult {
  readonly readable: boolean;
  readonly path?: string;
}

/** Upward, once per link (the verify statement). Missing inodes and non-files are not readable. */
export function verifyUpward(
  g: PermGraph,
  req: Requester,
  inos: readonly string[],
): Map<string, UpwardResult> {
  const cred = credOf(req);
  const parentLink = new Map<string, GraphDentry>();
  for (const d of g.dentries) {
    const n = g.inodes.get(d.ino);
    if (n?.type === 'd') parentLink.set(d.ino, d); // a directory has exactly one entry
  }
  const out = new Map<string, UpwardResult>();
  for (const ino of inos) {
    const n = g.inodes.get(ino);
    if (n === undefined || n.type !== 'f') {
      out.set(ino, { readable: false });
      continue;
    }
    const paths: string[] = [];
    for (const link of g.dentries) {
      if (link.ino !== ino) continue;
      const segs = [link.name];
      let dir = link.parentIno;
      let open = true;
      let reached = false;
      for (let depth = 1; depth <= MAX_DEPTH; depth++) {
        const dn = g.inodes.get(dir);
        if (dn === undefined || !may(cred, dn, X)) {
          open = false;
          break;
        }
        if (dir === g.rootIno) {
          reached = true;
          break;
        }
        const up = parentLink.get(dir);
        if (up === undefined) break; // not connected to /
        segs.unshift(up.name);
        dir = up.parentIno;
      }
      if (open && reached) paths.push(`/${segs.join('/')}`);
    }
    paths.sort(comparePaths);
    const readable = may(cred, n, R) && paths.length > 0;
    out.set(ino, readable ? { readable, path: paths[0] ?? '' } : { readable: false });
  }
  return out;
}
