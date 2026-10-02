/**
 * Shared fast-check arbitraries for the cross-package property suites (spec §3.7). Package owners
 * import them into their own `*.prop.test.ts` files; the generators only produce values, they
 * never implement a DSA structure (C16).
 */
import fc from 'fast-check';

import { faultPoints, MATRIX, nodeOps, type MatrixRow } from '../fault-injection/matrix.ts';
import type { FixtureNode, FixtureTree } from '../fixtures/trees.ts';

/** UTF-8 byte length. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export const NAME_MAX_BYTES = 255;
export const PATH_MAX_BYTES = 4096;
/** Every seeded uid of db/seed and tests/fixtures/users.ts, plus an unknown one. */
export const UIDS = [0, 1000, 1001, 1002, 65534, 4242] as const;

const SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._- ';
const UNICODE = ['é', 'ü', 'ß', 'ø', '日', '本', 'Ω', '😀'];

/** A valid name: NFC, 1-255 bytes, no `/` or NUL, never `.` or `..` (VFS-08, PVFS-12). */
export const nameArb: fc.Arbitrary<string> = fc
  .string({ unit: fc.constantFrom(...SAFE.split(''), ...UNICODE), minLength: 1, maxLength: 64 })
  .map((s) => s.normalize('NFC'))
  .filter((s) => s !== '.' && s !== '..' && utf8Bytes(s) <= NAME_MAX_BYTES && s.trim() === s);

/** Names a correct resolver must reject, each with the errno it must return. */
export const badNameArb: fc.Arbitrary<{ name: string; errno: 'EINVAL' | 'ENAMETOOLONG' }> =
  fc.oneof(
    fc.constantFrom('', '.', '..').map((name) => ({ name, errno: 'EINVAL' as const })),
    nameArb.map((n) => ({ name: `${n}/x`, errno: 'EINVAL' as const })),
    nameArb.map((n) => ({ name: `${n}\u0000`, errno: 'EINVAL' as const })),
    fc
      .integer({ min: NAME_MAX_BYTES + 1, max: 600 })
      .map((len) => ({ name: 'a'.repeat(len), errno: 'ENAMETOOLONG' as const })),
  );

/** Absolute paths mixing `.`, `..`, `//` and a trailing `/` (VFS-03 path resolver). */
export const messyPathArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 6, arbitrary: nameArb },
      { weight: 1, arbitrary: fc.constant('.') },
      { weight: 1, arbitrary: fc.constant('..') },
      { weight: 1, arbitrary: fc.constant('') },
    ),
    {
      maxLength: 12,
    },
  )
  .chain((parts) => fc.boolean().map((trailing) => `/${parts.join('/')}${trailing ? '/' : ''}`));

export const modeArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 0o7777 });
export const uidArb: fc.Arbitrary<number> = fc.constantFrom(...UIDS);

export type InodeKind = 'f' | 'd' | 'l';
export type Want = 4 | 2 | 1;

/** One access-check question for the VFS-04 permission matrix. */
export interface PermQuery {
  uid: number;
  gid: number;
  groups: number[];
  mode: number;
  ownerUid: number;
  ownerGid: number;
  type: InodeKind;
  want: Want;
}

export const permQueryArb: fc.Arbitrary<PermQuery> = fc.record({
  uid: uidArb,
  gid: fc.constantFrom(0, 100, 200, 65534),
  groups: fc.uniqueArray(fc.constantFrom(0, 100, 200, 300), { maxLength: 3 }),
  mode: modeArb,
  ownerUid: uidArb,
  ownerGid: fc.constantFrom(0, 100, 200),
  type: fc.constantFrom<InodeKind>('f', 'd', 'l'),
  want: fc.constantFrom<Want>(4, 2, 1),
});

/** The model-based VFS commands of spec §3.7 over a small path universe (so ops collide). */
export type VfsCommand =
  | { kind: 'mkdir' | 'unlink' | 'rm-r'; path: string; uid: number }
  | { kind: 'write'; path: string; bytes: number; uid: number }
  | { kind: 'rename' | 'link' | 'cp-r'; from: string; to: string; uid: number }
  | { kind: 'symlink'; target: string; path: string; uid: number }
  | { kind: 'chmod'; path: string; mode: number; uid: number }
  | { kind: 'chown'; path: string; owner: number; uid: number };

const UNIVERSE = [
  '/tmp/a',
  '/tmp/a/b',
  '/tmp/a/b/c',
  '/tmp/d',
  '/tmp/d/e',
  '/tmp/f.txt',
  '/tmp/a/g.txt',
];
const pathInUniverse = fc.constantFrom(...UNIVERSE);

export const vfsCommandArb: fc.Arbitrary<VfsCommand> = fc.oneof(
  fc.record({
    kind: fc.constantFrom('mkdir' as const, 'unlink' as const, 'rm-r' as const),
    path: pathInUniverse,
    uid: uidArb,
  }),
  fc.record({
    kind: fc.constant('write' as const),
    path: pathInUniverse,
    bytes: fc.integer({ min: 0, max: 4096 }),
    uid: uidArb,
  }),
  fc.record({
    kind: fc.constantFrom('rename' as const, 'link' as const, 'cp-r' as const),
    from: pathInUniverse,
    to: pathInUniverse,
    uid: uidArb,
  }),
  fc.record({
    kind: fc.constant('symlink' as const),
    target: fc.oneof(pathInUniverse, messyPathArb),
    path: pathInUniverse,
    uid: uidArb,
  }),
  fc.record({
    kind: fc.constant('chmod' as const),
    path: pathInUniverse,
    mode: modeArb,
    uid: uidArb,
  }),
  fc.record({
    kind: fc.constant('chown' as const),
    path: pathInUniverse,
    owner: uidArb,
    uid: uidArb,
  }),
);

export const vfsProgramArb: fc.Arbitrary<VfsCommand[]> = fc.array(vfsCommandArb, {
  minLength: 1,
  maxLength: 40,
});

/** One cell of the §3.6.6 matrix with a fault point anywhere in [1, M] (spec §3.6.6 last line). */
export const faultCaseArb: fc.Arbitrary<{ row: MatrixRow; failAt: number }> = fc
  .constantFrom(...MATRIX)
  .chain((row) => fc.integer({ min: 1, max: nodeOps(row) }).map((failAt) => ({ row, failAt })));

/** The matrix's named points only, for suites where every run is expensive. */
export const namedFaultCaseArb: fc.Arbitrary<{ row: MatrixRow; failAt: number }> = fc
  .constantFrom(...MATRIX)
  .chain((row) => fc.constantFrom(...faultPoints(row)).map((failAt) => ({ row, failAt })));

/** A small random fixture tree: unique paths, every parent before its children. */
export const fixtureTreeArb: fc.Arbitrary<FixtureTree> = fc
  .array(
    fc.record({ parent: fc.nat(), dir: fc.boolean(), size: fc.integer({ min: 0, max: 2048 }) }),
    { minLength: 0, maxLength: 60 },
  )
  .map((spec) => {
    const nodes: FixtureNode[] = [{ path: 'tree1000', type: 'd', mode: 0o755, size: 0 }];
    const dirs = ['tree1000'];
    spec.forEach((s, i) => {
      const parent = dirs[s.parent % dirs.length] ?? 'tree1000';
      if (s.dir) {
        const path = `${parent}/d${i}`;
        nodes.push({ path, type: 'd', mode: 0o755, size: 0 });
        dirs.push(path);
      } else {
        nodes.push({ path: `${parent}/f${i}.txt`, type: 'f', mode: 0o644, size: s.size });
      }
    });
    return { id: 'tree1000' as const, nodes };
  });

/** Scheduler and heap workloads for PROC-02 (priorities 0-39, ties allowed). */
export type HeapOp =
  | { kind: 'push'; handle: number; key: number }
  | { kind: 'pop' }
  | { kind: 'changePriority'; handle: number; key: number }
  | { kind: 'remove'; handle: number };

export const heapOpsArb: fc.Arbitrary<HeapOp[]> = fc.array(
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('push' as const),
        handle: fc.nat({ max: 63 }),
        key: fc.integer({ min: 0, max: 39 }),
      }),
    },
    { weight: 2, arbitrary: fc.constant({ kind: 'pop' as const }) },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('changePriority' as const),
        handle: fc.nat({ max: 63 }),
        key: fc.integer({ min: 0, max: 39 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('remove' as const), handle: fc.nat({ max: 63 }) }),
    },
  ),
  { maxLength: 200 },
);

/** What the seeded WebSocket fault injector does to each frame (OFF-02 exactly-once property). */
export type FrameFate = 'deliver' | 'drop' | 'duplicate' | 'delay';
export const frameFatesArb = (frames: number): fc.Arbitrary<FrameFate[]> =>
  fc.array(
    fc.constantFrom<FrameFate>('deliver', 'deliver', 'deliver', 'drop', 'duplicate', 'delay'),
    { minLength: frames, maxLength: frames },
  );
