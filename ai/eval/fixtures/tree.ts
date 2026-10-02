/**
 * Fixture file-system trees for the AI evaluation sets and unit tests.
 *
 * `buildTree` turns a flat entry list into both views the AI code consumes: the plan validator's
 * `FsSnapshot` and the search's `LiveTree` (with parent links for the readable set). Well-known
 * directories keep their protocol ids; every other inode gets a valid, deterministic UUIDv7-shaped
 * id, so SubmitResult and audit records built from fixtures pass the protocol schemas.
 */
import { INO, wellKnownIno } from '@plotinium/protocol';

import type { FsSnapshot, SnapNode } from '../../src/agent/fsview.ts';
import type { LiveNode, LiveTree } from '../../src/search/readable.ts';

export interface FixtureEntry {
  path: string;
  type: 'f' | 'd' | 'l';
  uid: number;
  gid: number;
  mode: number;
  size?: number;
  mtime?: number;
  target?: string;
  /** Additional hard-link paths for a regular file. */
  links?: string[];
}

export interface FixtureTree {
  snapshot: FsSnapshot;
  live: LiveTree;
  inoOf(path: string): string | undefined;
  nodeAt(path: string): SnapNode | undefined;
  paths(): string[];
}

const WELL_KNOWN: Record<string, string> = {
  '/': INO.ROOT,
  '/bin': INO.BIN,
  '/system': INO.SYSTEM,
  '/home': INO.HOME,
  '/tmp': INO.TMP,
  '/mnt': INO.MNT,
};

const FIXTURE_BASE = 0x10_0000;

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

interface MutableNode {
  ino: string;
  type: 'f' | 'd' | 'l';
  uid: number;
  gid: number;
  mode: number;
  version: number;
  size: number;
  mtime: number;
  target?: string;
  children?: Map<string, string>;
  parents: string[];
}

export function buildTree(entries: readonly FixtureEntry[], defaultMtime = 0): FixtureTree {
  const byPath = new Map<string, MutableNode>();
  const byIno = new Map<string, MutableNode>();
  let next = 0;
  const add = (path: string, e: Omit<FixtureEntry, 'path'>): MutableNode => {
    const ino = WELL_KNOWN[path] ?? wellKnownIno(FIXTURE_BASE + next++);
    const n: MutableNode = {
      ino,
      type: e.type,
      uid: e.uid,
      gid: e.gid,
      mode: e.mode,
      version: 1,
      size: e.size ?? 0,
      mtime: e.mtime ?? defaultMtime,
      parents: [],
    };
    if (e.type === 'd') n.children = new Map();
    if (e.target !== undefined) n.target = e.target;
    byPath.set(path, n);
    byIno.set(ino, n);
    return n;
  };
  add('/', { type: 'd', uid: 0, gid: 0, mode: 0o755 });
  const sorted = [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const e of sorted) {
    if (byPath.has(e.path)) continue;
    // Missing ancestors are created as root-owned 755 directories.
    const chain: string[] = [];
    for (let p = parentOf(e.path); !byPath.has(p); p = parentOf(p)) chain.unshift(p);
    for (const p of chain) {
      const d = add(p, { type: 'd', uid: 0, gid: 0, mode: 0o755 });
      const parent = byPath.get(parentOf(p));
      parent?.children?.set(p.slice(p.lastIndexOf('/') + 1), d.ino);
      if (parent !== undefined) d.parents.push(parent.ino);
    }
    const n = add(e.path, e);
    for (const linkPath of [e.path, ...(e.links ?? [])]) {
      const parent = byPath.get(parentOf(linkPath));
      if (parent === undefined) throw new Error(`fixture: no parent for ${linkPath}`);
      parent.children?.set(linkPath.slice(linkPath.lastIndexOf('/') + 1), n.ino);
      n.parents.push(parent.ino);
      if (linkPath !== e.path) byPath.set(linkPath, n);
    }
  }
  const snapNode = (n: MutableNode): SnapNode => {
    const s: { -readonly [K in keyof SnapNode]: SnapNode[K] } = {
      ino: n.ino,
      type: n.type,
      uid: n.uid,
      gid: n.gid,
      mode: n.mode,
      version: n.version,
      size: n.size,
      mtime: n.mtime,
    };
    if (n.target !== undefined) s.target = n.target;
    if (n.children !== undefined) s.children = n.children;
    return s;
  };
  const liveNode = (n: MutableNode): LiveNode => ({
    ino: n.ino,
    type: n.type,
    uid: n.uid,
    gid: n.gid,
    mode: n.mode,
    version: n.version,
    parents: n.parents,
  });
  return {
    snapshot: {
      rootIno: INO.ROOT,
      generation: 1,
      node: (ino) => {
        const n = byIno.get(ino);
        return n === undefined ? undefined : snapNode(n);
      },
    },
    live: {
      rootIno: INO.ROOT,
      node: (ino) => {
        const n = byIno.get(ino);
        return n === undefined ? undefined : liveNode(n);
      },
    },
    inoOf: (path) => byPath.get(path)?.ino,
    nodeAt: (path) => {
      const n = byPath.get(path);
      return n === undefined ? undefined : snapNode(n);
    },
    paths: () => [...byPath.keys()].sort(),
  };
}
