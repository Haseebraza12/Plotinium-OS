/**
 * The fault-injection matrix (spec §3.6.6; database.md §3.14; DB-02, §11.3 box).
 *
 * Every bulk operation is failed at nodes 1, 500, 999 and 1,000 (where it has that many node
 * operations), at the spec's own points (for example 250 and 499 for the 500-file batch rename)
 * and at its last node M; once more at M + 1, where the fault is armed beyond the last node op,
 * so the op must commit and report `fault_not_fired` (the hook is proven inert when not reached).
 *
 * A node operation is one row write on the counted table: `inodes` for rm -r, cp -r, chmod -R
 * and chown -R, `dentries` for mv and batch rename (database.md §3.14). The parent-directory
 * update is the last node op of rm -r and cp -r.
 */
import { TREE_SIZES, type TreeId } from '../fixtures/trees.ts';

export type BulkOp =
  'rm-r' | 'cp-r' | 'mv-batch' | 'mv-dir' | 'rename-batch' | 'chmod-r' | 'chown-r';
/** The `debug.inject` op names of protocol/src/sys/sys.ts (DebugInjectArgs.op). */
export type FaultOp = 'unlink' | 'rename' | 'copy' | 'chmod' | 'chown' | 'batch';
export type CountedTable = 'inodes' | 'dentries';

export interface MatrixRow {
  op: BulkOp;
  /** Title fragment, as the examiner would type the command. */
  label: string;
  faultOp: FaultOp;
  tree: TreeId;
  on: CountedTable;
  /** Fault points named by spec §3.6.6 for this op. */
  specPoints: readonly number[];
}

/** The points the §11.3 box names for the reference `rm -r` on 1,000 nodes. */
export const REFERENCE_POINTS = [1, 500, 999, 1000] as const;

export const MATRIX: readonly MatrixRow[] = [
  {
    op: 'rm-r',
    label: 'rm -r',
    faultOp: 'unlink',
    tree: 'tree1000',
    on: 'inodes',
    specPoints: [1, 500, 999, 1000],
  },
  {
    op: 'cp-r',
    label: 'cp -r',
    faultOp: 'copy',
    tree: 'tree1000',
    on: 'inodes',
    specPoints: [1, 500, 999, 1000],
  },
  {
    op: 'mv-batch',
    label: 'mv of 1,000 files',
    faultOp: 'rename',
    tree: 'flat1000',
    on: 'dentries',
    specPoints: [1, 500, 999],
  },
  {
    op: 'mv-dir',
    label: 'mv of a directory',
    faultOp: 'rename',
    tree: 'tree1000',
    on: 'dentries',
    specPoints: [1],
  },
  {
    op: 'rename-batch',
    label: 'batch rename of 500 files',
    faultOp: 'batch',
    tree: 'flat500',
    on: 'dentries',
    specPoints: [1, 250, 499],
  },
  {
    op: 'chmod-r',
    label: 'chmod -R',
    faultOp: 'chmod',
    tree: 'tree1000',
    on: 'inodes',
    specPoints: [1, 500, 999],
  },
  {
    op: 'chown-r',
    label: 'chown -R',
    faultOp: 'chown',
    tree: 'tree1000',
    on: 'inodes',
    specPoints: [1, 500, 999],
  },
];

/** Files and directories of a fixture, excluding its top directory. */
function childCount(tree: TreeId): number {
  return TREE_SIZES[tree] - 1;
}

/** M: node operations the op performs on its fixture (the counted-table row writes). */
export function nodeOps(row: Pick<MatrixRow, 'op' | 'tree'>): number {
  const n = TREE_SIZES[row.tree];
  switch (row.op) {
    case 'rm-r':
    case 'cp-r':
      return n + 1; // every inode of the subtree, then the parent directory
    case 'chmod-r':
    case 'chown-r':
      return n; // every inode of the subtree, no parent update
    case 'mv-batch':
    case 'rename-batch':
      return childCount(row.tree); // one dentry per moved file
    case 'mv-dir':
      return 1; // one dentry
  }
}

/** Sorted fault points for a row: spec points, the reference points, and M, all within [1, M]. */
export function faultPoints(row: MatrixRow): number[] {
  const m = nodeOps(row);
  const all = new Set<number>([...row.specPoints, ...REFERENCE_POINTS, m]);
  return [...all].filter((k) => k >= 1 && k <= m).sort((a, b) => a - b);
}

/** "Fail at node k" arms the trigger with `plotinium.fault_after = k − 1` (database.md §3.14). */
export function faultAfter(failAtNode: number): number {
  if (!Number.isInteger(failAtNode) || failAtNode < 1)
    throw new RangeError(`fault point must be >= 1, got ${failAtNode}`);
  return failAtNode - 1;
}

export interface MatrixCase {
  row: MatrixRow;
  failAt: number;
  expect: 'rolled-back' | 'committed';
}

export function matrixCases(rows: readonly MatrixRow[] = MATRIX): MatrixCase[] {
  return rows.flatMap((row) => [
    ...faultPoints(row).map((failAt): MatrixCase => ({ row, failAt, expect: 'rolled-back' })),
    { row, failAt: nodeOps(row) + 1, expect: 'committed' },
  ]);
}

/** The trigger's message for the fault at node k of `table` (plt_fault_hook). */
export function faultMessage(failAt: number, table: CountedTable): string {
  return `injected fault at node op ${failAt} on ${table}`;
}
