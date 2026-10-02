/**
 * Fake permission graphs for the RAG-03 tests: a builder for hand-written trees and a fast-check
 * arbitrary for random ones (random modes, owners, groups, hard links, depth), plus the
 * brute-force definition of readability the two algorithms are checked against.
 */
import fc from 'fast-check';

import { may, R, X, type Cred } from '@plotinium/vfs/perm';

import type { GraphDentry, GraphInode, PermGraph } from '../reference.ts';

export const ROOT = '00000000-0000-7000-8000-000000000001';

/** Deterministic UUIDv7-shaped ids for test inodes. */
export function testIno(n: number): string {
  return `0192f2a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

export class GraphBuilder {
  readonly inodes = new Map<string, GraphInode>();
  readonly dentries: GraphDentry[] = [];
  #next = 1;

  constructor(rootMode = 0o755) {
    this.inodes.set(ROOT, { ino: ROOT, type: 'd', mode: rootMode, uid: 0, gid: 0 });
  }

  dir(parent: string, name: string, mode: number, uid: number, gid: number): string {
    const ino = testIno(this.#next++);
    this.inodes.set(ino, { ino, type: 'd', mode, uid, gid });
    this.dentries.push({ parentIno: parent, name, ino });
    return ino;
  }

  file(parent: string, name: string, mode: number, uid: number, gid: number): string {
    const ino = testIno(this.#next++);
    this.inodes.set(ino, { ino, type: 'f', mode, uid, gid });
    this.dentries.push({ parentIno: parent, name, ino });
    return ino;
  }

  link(parent: string, name: string, ino: string): void {
    this.dentries.push({ parentIno: parent, name, ino });
  }

  chmod(ino: string, mode: number): void {
    const n = this.inodes.get(ino);
    if (n !== undefined) this.inodes.set(ino, { ...n, mode });
  }

  graph(): PermGraph {
    return { rootIno: ROOT, inodes: this.inodes, dentries: this.dentries };
  }
}

/** Brute force: enumerate every path from / (no pruning) and apply the definition directly. */
export function bruteForceReadable(g: PermGraph, cred: Cred): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string, chainOk: boolean, depth: number): void => {
    if (depth > 64) return;
    const d = g.inodes.get(dir);
    const ok = chainOk && d !== undefined && may(cred, d, X);
    for (const e of g.dentries) {
      if (e.parentIno !== dir) continue;
      const n = g.inodes.get(e.ino);
      if (n === undefined) continue;
      if (n.type === 'd') walk(e.ino, ok, depth + 1);
      else if (n.type === 'f' && ok && may(cred, n, R)) out.add(e.ino);
    }
  };
  walk(g.rootIno, true, 0);
  return out;
}

export const USERS = [0, 1001, 1002, 1003] as const;
export const GROUPS = [0, 100, 500] as const;
/** Group membership used by the random tests: 1001 and 1002 are in team 500. */
export const GIDS: Readonly<Record<number, readonly number[]>> = {
  0: [0],
  1001: [100, 500],
  1002: [100, 500],
  1003: [100],
};

const MODES = [
  0o700, 0o711, 0o750, 0o755, 0o770, 0o705, 0o100, 0o000, 0o644, 0o640, 0o600, 0o604, 0o444, 0o055,
  0o001,
];

export interface RandomTree {
  readonly dirs: { parent: number; mode: number; uid: number; gid: number }[];
  readonly files: { parent: number; mode: number; uid: number; gid: number }[];
  readonly links: { file: number; parent: number }[];
  readonly rootMode: number;
}

/** Random trees: indices refer to directories created earlier (0 = /), so the tree is acyclic. */
export const randomTree: fc.Arbitrary<RandomTree> = fc
  .record({
    rootMode: fc.constantFrom(0o755, 0o711, 0o700),
    dirs: fc.array(
      fc.record({
        parentPick: fc.nat(),
        mode: fc.constantFrom(...MODES),
        uid: fc.constantFrom(...USERS),
        gid: fc.constantFrom(...GROUPS),
      }),
      { maxLength: 12 },
    ),
    files: fc.array(
      fc.record({
        parentPick: fc.nat(),
        mode: fc.constantFrom(...MODES),
        uid: fc.constantFrom(...USERS),
        gid: fc.constantFrom(...GROUPS),
      }),
      { minLength: 1, maxLength: 16 },
    ),
    links: fc.array(fc.record({ filePick: fc.nat(), parentPick: fc.nat() }), { maxLength: 6 }),
  })
  .map((r) => ({
    rootMode: r.rootMode,
    dirs: r.dirs.map((d, i) => ({
      parent: d.parentPick % (i + 1),
      mode: d.mode,
      uid: d.uid,
      gid: d.gid,
    })),
    files: r.files.map((f) => ({
      parent: f.parentPick % (r.dirs.length + 1),
      mode: f.mode,
      uid: f.uid,
      gid: f.gid,
    })),
    links: r.links.map((l) => ({
      file: l.filePick % r.files.length,
      parent: l.parentPick % (r.dirs.length + 1),
    })),
  }));

/** Materialises a RandomTree; returns the builder plus the inos of its dirs and files. */
export function buildTree(t: RandomTree): { g: GraphBuilder; dirs: string[]; files: string[] } {
  const g = new GraphBuilder(t.rootMode);
  const dirs: string[] = [ROOT];
  t.dirs.forEach((d, i) => dirs.push(g.dir(dirs[d.parent] ?? ROOT, `d${i}`, d.mode, d.uid, d.gid)));
  const files = t.files.map((f, i) =>
    g.file(dirs[f.parent] ?? ROOT, `f${i}`, f.mode, f.uid, f.gid),
  );
  t.links.forEach((l, i) => {
    const file = files[l.file];
    if (file !== undefined) g.link(dirs[l.parent] ?? ROOT, `h${i}`, file);
  });
  return { g, dirs, files };
}
