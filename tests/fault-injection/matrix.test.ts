import { describe, expect, it } from 'vitest';

import {
  faultAfter,
  faultMessage,
  faultPoints,
  MATRIX,
  matrixCases,
  nodeOps,
  REFERENCE_POINTS,
  type BulkOp,
} from './matrix.ts';

const row = (op: BulkOp) => {
  const r = MATRIX.find((x) => x.op === op);
  if (r === undefined) throw new Error(`no matrix row ${op}`);
  return r;
};

describe('DB-02 fault-injection matrix', () => {
  it('DB-02 the matrix covers rm -r, cp -r, mv, batch rename, chmod -R and chown -R', () => {
    expect(MATRIX.map((r) => r.op)).toEqual([
      'rm-r',
      'cp-r',
      'mv-batch',
      'mv-dir',
      'rename-batch',
      'chmod-r',
      'chown-r',
    ]);
  });

  it('DB-02 every bulk op on a 1,000-node fixture is failed at nodes 1, 500, 999 and 1000', () => {
    for (const r of MATRIX.filter((x) => nodeOps(x) >= 1000)) {
      for (const k of REFERENCE_POINTS) expect(faultPoints(r), r.op).toContain(k);
    }
  });

  it('DB-02 node counts follow the node-op definition: parent last for rm -r and cp -r, one dentry per rename', () => {
    expect(nodeOps(row('rm-r'))).toBe(1001);
    expect(nodeOps(row('cp-r'))).toBe(1001);
    expect(nodeOps(row('chmod-r'))).toBe(1000);
    expect(nodeOps(row('chown-r'))).toBe(1000);
    expect(nodeOps(row('mv-batch'))).toBe(1000);
    expect(nodeOps(row('rename-batch'))).toBe(500);
    expect(nodeOps(row('mv-dir'))).toBe(1);
  });

  it('DB-02 the batch rename of 500 is failed at its spec points 1, 250, 499 and its last node 500', () => {
    expect(faultPoints(row('rename-batch'))).toEqual([1, 250, 499, 500]);
    expect(faultPoints(row('rm-r'))).toEqual([1, 500, 999, 1000, 1001]);
    expect(faultPoints(row('mv-dir'))).toEqual([1]);
  });

  it('DB-02 every op also runs once armed beyond its last node op and must commit', () => {
    const cases = matrixCases();
    for (const r of MATRIX) {
      const committed = cases.filter((c) => c.row === r && c.expect === 'committed');
      expect(committed.map((c) => c.failAt)).toEqual([nodeOps(r) + 1]);
    }
    expect(cases.filter((c) => c.expect === 'rolled-back')).toHaveLength(
      MATRIX.reduce((n, r) => n + faultPoints(r).length, 0),
    );
  });

  it('DB-02 fail at node k arms fault_after k - 1 and the trigger names node k', () => {
    expect(faultAfter(500)).toBe(499);
    expect(faultAfter(1)).toBe(0);
    expect(() => faultAfter(0)).toThrow(RangeError);
    expect(faultMessage(500, 'inodes')).toBe('injected fault at node op 500 on inodes');
  });
});
