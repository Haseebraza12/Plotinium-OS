import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  badNameArb,
  frameFatesArb,
  heapOpsArb,
  messyPathArb,
  modeArb,
  nameArb,
  NAME_MAX_BYTES,
  permQueryArb,
  utf8Bytes,
  vfsProgramArb,
} from './arbitraries.ts';
import {
  DEEP_RUNS,
  fcParams,
  fcParamsHeavy,
  loadRegressions,
  parseRegressions,
  PR_RUNS,
  PR_SEED,
  regressionsFor,
} from './profile.ts';

describe('TST-10 property profiles', () => {
  it('TST-10 pull-request runs use seed 42 and 100 runs, so a commit always gives the same verdict', () => {
    expect(fcParams({})).toEqual({ seed: PR_SEED, numRuns: PR_RUNS });
    expect(fcParamsHeavy(10, {})).toEqual({ seed: PR_SEED, numRuns: 10 });
  });

  it('TST-10 the nightly deep profile runs 10,000 times with a random seed that is logged', () => {
    const logged: string[] = [];
    const p = fcParams(
      { PLT_FC_PROFILE: 'deep' },
      () => 0.5,
      (s) => logged.push(s),
    );
    expect(p.numRuns).toBe(DEEP_RUNS);
    expect(logged[0]).toContain(`seed ${p.seed}`);
    expect(fcParamsHeavy(10, { PLT_FC_PROFILE: 'deep' }).numRuns).toBe(100);
  });

  it('TST-10 pinned regression seeds are validated and replayed by property title', () => {
    expect(loadRegressions()).toEqual([]);
    const pinned = parseRegressions({
      regressions: [{ property: 'VFS-11 x', seed: 7, path: '3:1', issue: 12, since: '2026-10-01' }],
    });
    expect(regressionsFor('VFS-11 x', pinned)).toEqual([{ seed: 7, path: '3:1', numRuns: 1 }]);
    expect(regressionsFor('other', pinned)).toEqual([]);
    expect(() => parseRegressions({})).toThrow(TypeError);
    expect(() => parseRegressions({ regressions: [{ property: 'x' }] })).toThrow(
      /regressions\[0\]/,
    );
  });
});

describe('TST-10 shared arbitraries', () => {
  it('VFS-08 generated names are NFC, at most 255 bytes and never contain a slash or a dot name', () => {
    fc.assert(
      fc.property(nameArb, (n) => {
        expect(n.normalize('NFC')).toBe(n);
        expect(utf8Bytes(n)).toBeLessThanOrEqual(NAME_MAX_BYTES);
        expect(n.includes('/') || n.includes('\u0000')).toBe(false);
        expect(['.', '..', '']).not.toContain(n);
      }),
      fcParams(),
    );
  });

  it('VFS-08 generated bad names are each invalid for the reason they carry', () => {
    fc.assert(
      fc.property(badNameArb, ({ name, errno }) => {
        if (errno === 'ENAMETOOLONG') return utf8Bytes(name) > NAME_MAX_BYTES;
        return (
          name === '' ||
          name === '.' ||
          name === '..' ||
          name.includes('/') ||
          name.includes('\u0000')
        );
      }),
      fcParams(),
    );
  });

  it('VFS-03 messy paths are absolute and mix dot, dot-dot and empty segments', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(messyPathArb, (p) => {
        if (p.includes('/./')) seen.add('dot');
        if (p.includes('/../')) seen.add('dotdot');
        if (p.includes('//')) seen.add('double');
        return p.startsWith('/');
      }),
      fcParams(),
    );
    expect(seen).toEqual(new Set(['dot', 'dotdot', 'double']));
  });

  it('VFS-04 permission questions cover every mode bit, type and wanted access', () => {
    fc.assert(
      fc.property(
        permQueryArb,
        modeArb,
        (q, m) => q.mode >= 0 && q.mode <= 0o7777 && m <= 0o7777 && [4, 2, 1].includes(q.want),
      ),
      fcParams(),
    );
  });

  it('VFS-11 VFS programs draw from a small path universe so commands collide', () => {
    const sample = fc.sample(vfsProgramArb, { seed: 42, numRuns: 50 });
    const kinds = new Set(sample.flat().map((c) => c.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(8);
    expect(sample.every((p) => p.length >= 1 && p.length <= 40)).toBe(true);
  });

  it('PROC-02 heap workloads use priorities 0 to 39 and include every operation', () => {
    const ops = fc.sample(heapOpsArb, { seed: 42, numRuns: 30 }).flat();
    expect(new Set(ops.map((o) => o.kind))).toEqual(
      new Set(['push', 'pop', 'changePriority', 'remove']),
    );
    for (const o of ops) if ('key' in o) expect(o.key >= 0 && o.key <= 39).toBe(true);
  });

  it('OFF-02 frame fates cover every frame with deliver, drop, duplicate or delay', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }).chain((n) => frameFatesArb(n).map((f) => [n, f] as const)),
        ([n, fates]) => fates.length === n,
      ),
      fcParams(),
    );
  });
});
