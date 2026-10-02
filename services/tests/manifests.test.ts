import { describe, expect, it } from 'vitest';

import { DAG_IMPLEMENTED } from '@plotinium/dsa';
import { DEFAULT_SERVICE_MANIFESTS, ServiceManifestSchema } from '@plotinium/protocol';

import {
  ancestorClosure,
  BUILTIN_MANIFEST_FILES,
  DependencyCycle,
  fallbackPlan,
  planLevels,
  validateManifests,
} from '../src/index.ts';
import type { ServiceManifest } from '../src/index.ts';
import { builtin, filesOf } from './helpers.ts';

const ALL = new Set(BUILTIN_MANIFEST_FILES.map((f) => (f.json as { name: string }).name));

function parsedBuiltin(): ServiceManifest[] {
  const r = validateManifests(BUILTIN_MANIFEST_FILES, ALL);
  if (!r.ok) throw new Error(r.error.text);
  return r.manifests;
}

describe('service manifests', () => {
  it('SVC-01 the shipped 18 manifests validate: 30 edges, acyclic, 7 levels, A weight 25', () => {
    const manifests = parsedBuiltin();
    expect(manifests).toHaveLength(18);
    const plan = planLevels(manifests, false);
    expect(plan.edges).toBe(30);
    expect(plan.levels).toHaveLength(7);
    expect(plan.levels[0]).toEqual(['kernel']);
    expect(plan.levels[1]).toEqual(['sched', 'storage', 'wm']);
    const a = ancestorClosure(manifests, 'desktop');
    expect([...a].sort()).toEqual([
      'desktop',
      'kernel',
      'login',
      'mm',
      'sched',
      'session',
      'storage',
      'vfs',
      'wm',
    ]);
    expect(manifests.filter((m) => a.has(m.name)).reduce((n, m) => n + m.weight, 0)).toBe(25);
  });

  it('SVC-01 the JSON manifests equal the protocol reference set with every default applied', () => {
    expect(parsedBuiltin()).toEqual(
      DEFAULT_SERVICE_MANIFESTS.map((m) => ({ ...m, description: expect.any(String) as unknown })),
    );
  });

  it("SVC-01 the spec's example ai.indexer manifest validates unchanged against ServiceManifestSchema", () => {
    const example = {
      name: 'ai.indexer',
      requires: ['ai.runtime', 'vfs', 'session'],
      critical: false,
      weight: 3,
      timeoutMs: 4000,
      priority: 32,
      safeMode: false,
    };
    const ds = ServiceManifestSchema['~run']({ value: example }, { abortEarly: true });
    expect(ds.issues).toBeUndefined();
  });

  it('BOOT-03 every edge is respected by the fallback order and levels are longest paths', () => {
    const manifests = parsedBuiltin();
    const plan = fallbackPlan(manifests);
    const pos = new Map(plan.order.map((n, i) => [n, i] as const));
    for (const m of manifests) {
      for (const dep of m.requires) {
        expect(pos.get(dep)).toBeLessThan(pos.get(m.name) ?? -1);
        expect(plan.levelOf.get(dep)).toBeLessThan(plan.levelOf.get(m.name) ?? -1);
      }
    }
    expect(plan.source).toBe('fallback');
    expect(plan.levelOf.get('desktop')).toBe(5);
    expect(plan.levelOf.get('lockd')).toBe(6);
  });

  it('BOOT-04 a cycle added to auth makes the fallback report the services on and behind the cycle', () => {
    const manifests = builtin().map((m) =>
      m.name === 'auth' ? { ...m, requires: [...m.requires, 'lockd'] } : m,
    );
    expect(() => fallbackPlan(manifests)).toThrow(DependencyCycle);
    try {
      fallbackPlan(manifests);
    } catch (e) {
      const cycle = (e as DependencyCycle).cycle;
      expect(cycle).toEqual(expect.arrayContaining(['auth', 'lockd', 'sync']));
      expect(cycle).not.toContain('kernel');
      expect((e as DependencyCycle).exact).toBe(false);
    }
  });

  it.runIf(DAG_IMPLEMENTED)(
    'BOOT-04 with the real dsa/dag the built-in set levels identically and a cycle is named exactly',
    () => {
      const manifests = parsedBuiltin();
      const dag = planLevels(manifests, true);
      const fb = fallbackPlan(manifests);
      expect(dag.source).toBe('dsa/dag');
      expect(dag.levels).toEqual(fb.levels);
      expect([...dag.levelOf]).toEqual(expect.arrayContaining([...fb.levelOf]));
      const cyclic = manifests.map((m) =>
        m.name === 'auth' ? { ...m, requires: [...m.requires, 'lockd'] } : m,
      );
      expect(() => planLevels(cyclic, true)).toThrow(
        'dependency cycle detected: auth → sync → lockd → auth',
      );
    },
  );

  it('BOOT-04 with dsa/dag the cycle path is reported exactly as the structure gives it', () => {
    const e = new DependencyCycle(['auth', 'sync', 'lockd', 'auth'], true);
    expect(e.message).toBe('dependency cycle detected: auth → sync → lockd → auth');
  });
});

describe('validation rules V1–V9', () => {
  const base = () =>
    builtin().map((m) => ({ ...m, requires: [...m.requires] })) as (ServiceManifest &
      Record<string, unknown>)[];
  const cases: [
    string,
    (ms: (ServiceManifest & Record<string, unknown>)[]) => unknown[],
    string,
    RegExp,
  ][] = [
    [
      'V1',
      (ms) => ms.map((m) => (m.name === 'sync' ? { ...m, weight: 11 } : m)),
      'sync.json',
      /^invalid manifest sync\.json: weight/,
    ],
    [
      'V1',
      (ms) => ms.map((m) => (m.name === 'sync' ? { ...m, colour: 'red' } : m)),
      'sync.json',
      /^invalid manifest sync\.json/,
    ],
    [
      'V3',
      (ms) => [...ms, ms.find((m) => m.name === 'sync')],
      'sync.json',
      /^duplicate service "sync"$/,
    ],
    [
      'V4',
      (ms) => ms.map((m) => (m.name === 'vfs' ? { ...m, requires: ['storge'] } : m)),
      'vfs.json',
      /requires unknown service "storge"/,
    ],
    [
      'V5',
      (ms) => ms.map((m) => (m.name === 'sync' ? { ...m, requires: ['sync'] } : m)),
      'sync.json',
      /sync\.json requires itself/,
    ],
    [
      'V5',
      (ms) => ms.map((m) => (m.name === 'sync' ? { ...m, requires: ['auth', 'auth'] } : m)),
      'sync.json',
      /twice/,
    ],
    [
      'V6',
      (ms) => ms.map((m) => (m.name === 'vfs' ? { ...m, requires: ['storage', 'sync'] } : m)),
      'vfs.json',
      /critical service vfs requires non-critical sync/,
    ],
    [
      'V7',
      (ms) => ms.map((m) => (m.name === 'kernel' ? { ...m, requires: ['sched'] } : m)),
      'kernel.json',
      /kernel\.json must have no requirements/,
    ],
    [
      'V7',
      (ms) => ms.map((m) => (m.name === 'update' ? { ...m, requires: [] } : m)),
      'update.json',
      /only kernel may be a root/,
    ],
    [
      'V7',
      (ms) =>
        ms
          .filter((m) => m.name !== 'kernel')
          .map((m) => ({ ...m, requires: m.requires.filter((r) => r !== 'kernel') })),
      'kernel.json',
      /no root service/,
    ],
    [
      'V8',
      (ms) =>
        ms
          .map((m) => (m.name === 'desktop' ? { ...m, critical: false } : m))
          .map((m) => (m.name === 'complete' || m.name === 'update' ? m : m)),
      'desktop.json',
      /boot target desktop/,
    ],
  ];
  for (const [rule, mutate, file, text] of cases) {
    it(`SVC-01 rule ${rule} panics with the file name and rule text (${file})`, () => {
      const r = validateManifests(filesOf(mutate(base()) as object[]), ALL);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.rule).toBe(rule);
      expect(r.error.file).toBe(file);
      expect(r.error.text).toMatch(text);
    });
  }

  it('SVC-01 rule V2 panics when a file declares another name', () => {
    const files = filesOf(builtin()).map((f) =>
      f.file === 'sync.json'
        ? { file: 'sync.json', json: { ...(f.json as object), name: 'syncd' } }
        : f,
    );
    const r = validateManifests(files, ALL);
    expect(r).toMatchObject({
      ok: false,
      error: { rule: 'V2', text: 'manifest sync.json declares name "syncd"' },
    });
  });

  it('SVC-01 rule V9 panics when a manifest has no implementation in this build', () => {
    const r = validateManifests(
      BUILTIN_MANIFEST_FILES,
      new Set([...ALL].filter((n) => n !== 'complete')),
    );
    expect(r).toMatchObject({
      ok: false,
      error: { rule: 'V9', text: 'no implementation for service "complete"' },
    });
  });
});
