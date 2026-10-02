/**
 * Property tests (virtual-file-system.md §8.4, 200 runs per PR; the seed is printed on failure for
 * replay). Random op sequences, as random users, over the planners and the in-memory commit:
 *   - every op either commits or changes nothing (all or nothing, §3.11);
 *   - after every step fsck is clean (I1–I13), in server and client semantics;
 *   - every committed synced op's undo record restores the exact tree checksum (OFF-02, §3.14).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { checksumOf, fsck } from '../src/fsck/fsck.ts';
import type { FsckInput } from '../src/fsck/state.ts';
import { planChmod, planChown, planUtimes } from '../src/ops/attr.ts';
import { planCopy } from '../src/ops/copy.ts';
import { planMkdir, planSymlink } from '../src/ops/create.ts';
import { planLink } from '../src/ops/link.ts';
import type { PlanBuilder } from '../src/ops/plan.ts';
import { planRename } from '../src/ops/rename.ts';
import { planRmdir, planUnlink } from '../src/ops/unlink.ts';
import { planWriteFile } from '../src/ops/write.ts';
import type { Cred } from '../src/perm.ts';
import type { DentryRec, InodeRec, OpKind, UndoRec } from '../src/store/records.ts';
import { ALICE, BOB, CAROL, ROOT, World } from './doubles/world.ts';

/** bob is in alice's `team` group here, so /home/shared is writable by both. */
const BOB_TEAM: Cred = { ...BOB, groups: [...BOB.groups, 200] };
const USERS: readonly Cred[] = [ROOT, ALICE, BOB_TEAM, CAROL];
const DIRS = ['/home/alice', '/home/alice/x', '/home/shared', '/home/shared/y', '/tmp', '/tmp/z'];
const NAMES = ['a', 'b', 'x', 'y', 'f.txt'];
const MODES = [0o755, 0o700, 0o777, 0o644, 0o1777, 0o555, 0o775];

const pathArb = fc
  .tuple(fc.constantFrom(...DIRS), fc.constantFrom(...NAMES), fc.integer({ min: 0, max: 4 }))
  .map(([d, n, deep]) => (deep === 0 ? `${d}/${n}/${n}` : `${d}/${n}`));

/** A starting tree, so most random paths name something (each run starts from it). */
function seeded(): World {
  const w = new World({ quotaBytes: 400, quotaInodes: 40 });
  const must = (cred: Cred, call: OpKind, fn: (b: PlanBuilder) => unknown): void => {
    const r = w.run(cred, call, fn);
    if (r.ok !== true) throw new Error(`seed failed: ${JSON.stringify(r)}`);
  };
  must(ALICE, 'create', (b) => planMkdir(b, '/home/alice/x/a', 0o755, true));
  must(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/a', contentOfText('alice', 0)));
  must(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/x/f.txt', contentOfText('fx', 0)));
  must(ALICE, 'create', (b) => planMkdir(b, '/home/shared/y/b', 0o775, true));
  must(ALICE, 'chmod', (b) => planChmod(b, '/home/shared/y', { kind: 'octal', bits: 0o775 }));
  must(BOB_TEAM, 'write', (b) => planWriteFile(b, '/home/shared/y/f.txt', contentOfText('bob', 0)));
  must(ROOT, 'create', (b) => planMkdir(b, '/tmp/z/x', 0o777, true));
  must(ROOT, 'chmod', (b) => planChmod(b, '/tmp/z', { kind: 'octal', bits: 0o1777 }));
  must(ALICE, 'write', (b) => planWriteFile(b, '/tmp/z/a', contentOfText('t', 0)));
  must(BOB_TEAM, 'write', (b) => planWriteFile(b, '/tmp/b', contentOfText('tb', 0)));
  return w;
}

type Cmd = { user: number; kind: string; a: string; b: string; mode: number; text: string };

const cmdArb: fc.Arbitrary<Cmd> = fc.record({
  user: fc.oneof(
    { arbitrary: fc.constant(1), weight: 5 },
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.constant(2), weight: 2 },
    { arbitrary: fc.constant(3), weight: 1 },
  ),
  kind: fc.constantFrom(
    'mkdir',
    'mkdirp',
    'write',
    'rename',
    'unlink',
    'rmr',
    'rmdir',
    'cp',
    'cpr',
    'chmod',
    'chmodR',
    'chown',
    'chownR',
    'symlink',
    'link',
    'utimes',
  ),
  a: pathArb,
  b: pathArb,
  mode: fc.constantFrom(...MODES),
  text: fc.string({ maxLength: 12 }),
});

function op(c: Cmd): { call: OpKind; fn: (b: PlanBuilder) => unknown } {
  const octal = { kind: 'octal', bits: c.mode } as const;
  switch (c.kind) {
    case 'mkdir':
      return { call: 'create', fn: (b) => planMkdir(b, c.a, c.mode) };
    case 'mkdirp':
      return { call: 'create', fn: (b) => planMkdir(b, c.a, c.mode, true) };
    case 'write':
      return { call: 'write', fn: (b) => planWriteFile(b, c.a, contentOfText(c.text, 0)) };
    case 'rename':
      return { call: 'rename', fn: (b) => planRename(b, c.a, c.b) };
    case 'unlink':
      return { call: 'unlink', fn: (b) => planUnlink(b, c.a) };
    case 'rmr':
      return { call: 'unlink', fn: (b) => planUnlink(b, c.a, true) };
    case 'rmdir':
      return { call: 'unlink', fn: (b) => planRmdir(b, c.a) };
    case 'cp':
      return { call: 'copy', fn: (b) => planCopy(b, c.a, c.b) };
    case 'cpr':
      return { call: 'copy', fn: (b) => planCopy(b, c.a, c.b, { recursive: true }) };
    case 'chmod':
      return { call: 'chmod', fn: (b) => planChmod(b, c.a, octal) };
    case 'chmodR':
      return { call: 'chmod', fn: (b) => planChmod(b, c.a, octal, true) };
    case 'chown':
      return {
        call: 'chown',
        fn: (b) => planChown(b, c.a, { uid: USERS[(c.user + 1) % USERS.length]?.uid ?? 0 }),
      };
    case 'chownR':
      return {
        call: 'chown',
        fn: (b) =>
          planChown(b, c.a, { uid: USERS[(c.user + 2) % USERS.length]?.uid ?? 0, recursive: true }),
      };
    case 'symlink':
      return { call: 'create', fn: (b) => planSymlink(b, c.b, c.a) };
    case 'link':
      return { call: 'link', fn: (b) => planLink(b, c.a, c.b) };
    default:
      return { call: 'utimes', fn: (b) => planUtimes(b, c.a, { mtime: 'now' }) };
  }
}

/** Apply an undo record to rows: delete what the op created, restore the pre-images (§3.14.4). */
function revert(
  rows: { inodes: InodeRec[]; dentries: DentryRec[] },
  u: UndoRec,
): { inodes: InodeRec[]; dentries: DentryRec[] } {
  const inodes = new Map(rows.inodes.map((n) => [n.ino, n]));
  const dentries = new Map(rows.dentries.map((d) => [`${d.parent}\u0000${d.name}`, d]));
  for (const ino of u.created.inodes) inodes.delete(ino);
  for (const [p, n] of u.created.dentries) dentries.delete(`${p}\u0000${n}`);
  for (const n of u.pre.inodes) inodes.set(n.ino, n);
  for (const d of u.pre.dentries) dentries.set(`${d.parent}\u0000${d.name}`, d);
  return { inodes: [...inodes.values()], dentries: [...dentries.values()] };
}

function failing(input: FsckInput, complete: boolean): string[] {
  return fsck(input, { complete })
    .report.invariants.filter((i) => !i.ok)
    .map((i) => `${i.id}: ${i.examples.join('; ')}`);
}

describe('VFS invariants under random operations (VFS-11, OFF-02, DB-02)', () => {
  it('VFS-11 property: random op sequences keep fsck clean and failed ops change nothing', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 5, maxLength: 30 }), (cmds) => {
        const w = seeded();
        for (const c of cmds) {
          const before = w.fsckInput();
          const sumBefore = checksumOf(before);
          const undoCount = w.undo.length;
          const { call, fn } = op(c);
          const r = w.run(USERS[c.user] ?? ROOT, call, fn);
          const after = w.fsckInput();
          if (r.ok !== true) {
            expect(r.ok).toBe(false);
            expect(after.inodes).toEqual(before.inodes);
            expect(after.dentries).toEqual(before.dentries);
            expect(after.users).toEqual(before.users);
            continue;
          }
          expect(failing(after, true), JSON.stringify(c)).toEqual([]);
          expect(failing(after, false), JSON.stringify(c)).toEqual([]);
          const u = w.undo[w.undo.length - 1];
          if (w.undo.length > undoCount && u !== undefined) {
            expect(
              checksumOf(revert({ inodes: [...after.inodes], dentries: [...after.dentries] }, u)),
              JSON.stringify(c),
            ).toBe(sumBefore);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
