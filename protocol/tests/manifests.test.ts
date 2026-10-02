import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { AppManifestSchema, parseDepRef } from '../src/apps.ts';
import {
  BOOT_TARGET,
  DEFAULT_SERVICE_MANIFEST_INPUTS,
  DEFAULT_SERVICE_MANIFESTS,
  ServiceManifestSchema,
} from '../src/services.ts';
import type { ServiceManifest } from '../src/services.ts';
import { codeSpans, readSpec, section, tables } from './spec-tables.ts';

const boot = readSpec('02-boot/boot-and-services.md');

/** Test oracle: longest-path levels by repeated relaxation (not a product structure). */
function levels(ms: readonly ServiceManifest[]): Map<string, number> {
  const level = new Map<string, number>(ms.map((m) => [m.name, 0]));
  for (let round = 0; round < ms.length; round++) {
    for (const m of ms)
      for (const r of m.requires)
        level.set(m.name, Math.max(level.get(m.name) ?? 0, (level.get(r) ?? 0) + 1));
  }
  return level;
}
function ancestors(ms: readonly ServiceManifest[], target: string): Set<string> {
  const byName = new Map(ms.map((m) => [m.name, m]));
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    stack.push(...(byName.get(name)?.requires ?? []));
  }
  return seen;
}

describe('protocol/services (boot-and-services.md §3.3 and §4.1, C17)', () => {
  it('SVC-01 the shipped 18 manifests equal the table of boot-and-services.md section 3.3', () => {
    const rows =
      tables(section(boot, '### 3.3 Service manifests')).find((t) => t.header[0] === 'name')
        ?.rows ?? [];
    expect(rows).toHaveLength(18);
    const fromSpec = rows.map((r) => ({
      name: codeSpans(r[0] ?? '')[0],
      requires: (r[1] ?? '') === '–' ? [] : (r[1] ?? '').split(',').map((s) => s.trim()),
      critical: r[2] === 'true',
      weight: Number(r[3]),
      timeoutMs: Number.parseInt(r[4] ?? '', 10),
      priority: Number(r[5]),
      safeMode: (r[6] ?? '').startsWith('true'),
    }));
    expect(
      DEFAULT_SERVICE_MANIFESTS.map(
        ({ name, requires, critical, weight, timeoutMs, priority, safeMode }) => ({
          name,
          requires,
          critical,
          weight,
          timeoutMs,
          priority,
          safeMode,
        }),
      ),
    ).toEqual(fromSpec);
  });

  it('SVC-01 the extension fields equal the shipped-manifest extension table of section 3.3', () => {
    const get = (name: string) =>
      DEFAULT_SERVICE_MANIFESTS.find((m) => m.name === name) as ServiceManifest;
    expect(DEFAULT_SERVICE_MANIFESTS.filter((m) => m.userWait).map((m) => m.name)).toEqual([
      'login',
    ]);
    expect(
      DEFAULT_SERVICE_MANIFESTS.filter((m) => m.onDegradedDependency === 'start-degraded').map(
        (m) => m.name,
      ),
    ).toEqual(['lockd', 'ai.agent']);
    expect(get('sync').stopTimeoutMs).toBe(4000);
    expect(
      DEFAULT_SERVICE_MANIFESTS.filter((m) => m.stopTimeoutMs !== 2000).map((m) => m.name),
    ).toEqual(['sync']);
    expect(DEFAULT_SERVICE_MANIFESTS.filter((m) => m.recovery).map((m) => m.name)).toEqual([
      'kernel',
      'sched',
      'storage',
      'wm',
      'vfs',
    ]);
  });

  it('SVC-01 the shipped manifests validate: 30 edges, acyclic, 7 levels, A weight 25', () => {
    const ms = DEFAULT_SERVICE_MANIFEST_INPUTS.map((m) => v.parse(ServiceManifestSchema, m));
    expect(ms.reduce((n, m) => n + m.requires.length, 0)).toBe(30);
    const lv = levels(ms);
    for (const m of ms)
      for (const r of m.requires)
        expect(lv.get(m.name) ?? 0, `${r} -> ${m.name}`).toBeGreaterThan(lv.get(r) ?? 0);
    expect(Math.max(...lv.values()) + 1).toBe(7);
    const a = ancestors(ms, BOOT_TARGET);
    expect(a.size).toBe(9);
    expect([...a].reduce((w, name) => w + (ms.find((m) => m.name === name)?.weight ?? 0), 0)).toBe(
      25,
    );
  });

  it('SVC-01 the validation rules V2 to V8 hold for the shipped set', () => {
    const names = DEFAULT_SERVICE_MANIFESTS.map((m) => m.name);
    expect(new Set(names).size).toBe(18); // V3
    const byName = new Map(DEFAULT_SERVICE_MANIFESTS.map((m) => [m.name, m]));
    for (const m of DEFAULT_SERVICE_MANIFESTS) {
      for (const r of m.requires) expect(byName.has(r), `${m.name} requires ${r}`).toBe(true); // V4
      expect(m.requires).not.toContain(m.name); // V5
      expect(new Set(m.requires).size).toBe(m.requires.length); // V5
      if (m.critical)
        for (const r of m.requires) expect(byName.get(r)?.critical, `${m.name} -> ${r}`).toBe(true); // V6
    }
    const roots = DEFAULT_SERVICE_MANIFESTS.filter((m) => m.requires.length === 0);
    expect(roots.map((m) => m.name)).toEqual(['kernel']); // V7
    expect(byName.get(BOOT_TARGET)?.critical).toBe(true); // V8
  });

  it("SVC-01 the spec's example ai.indexer manifest validates unchanged against ServiceManifestSchema", () => {
    const example = {
      name: 'ai.indexer',
      requires: ['ai.runtime', 'vfs'],
      critical: false,
      weight: 3,
      timeoutMs: 4000,
      priority: 32,
      safeMode: false,
    };
    const r = v.safeParse(ServiceManifestSchema, example);
    expect(r.success).toBe(true);
    if (r.success) expect(r.output).toMatchObject(example);
  });

  it('SVC-01 rule V1 rejects unknown keys and out-of-range weight, priority and timeoutMs', () => {
    const ok = {
      name: 'x',
      requires: [],
      critical: false,
      weight: 1,
      timeoutMs: 100,
      priority: 0,
      safeMode: true,
    };
    expect(v.safeParse(ServiceManifestSchema, ok).success).toBe(true);
    for (const bad of [
      { ...ok, extra: true },
      { ...ok, weight: 0 },
      { ...ok, weight: 11 },
      { ...ok, priority: 40 },
      { ...ok, timeoutMs: 99 },
      { ...ok, timeoutMs: 60_001 },
      { ...ok, name: 'Bad' },
      { ...ok, name: 'a..b' },
      { ...ok, requires: Array.from({ length: 17 }, (_, i) => `s${i}`) },
      { ...ok, caps: ['net.sync2'] },
      { ...ok, class: 'user' },
    ]) {
      expect(v.safeParse(ServiceManifestSchema, bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('protocol/apps (boot-and-services.md §3.12 and §4.4)', () => {
  it('SVC-12 the example editor and codemirror manifests of boot-and-services.md section 3.12 validate', () => {
    const block =
      /```json\n([\s\S]*?)```/.exec(section(boot, '### 3.12 Application start-up DAG'))?.[1] ?? '';
    const docs = block
      .split(/^\/\/.*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as unknown);
    expect(docs).toHaveLength(2);
    for (const doc of docs)
      expect(v.safeParse(AppManifestSchema, doc).success, JSON.stringify(doc)).toBe(true);
  });

  it('ABI-06 an app manifest defaults to class user, no capabilities, priority 10 and not checkpointable', () => {
    const m = v.parse(AppManifestSchema, {
      name: 'ls',
      kind: 'command',
      entry: 'apps/coreutils/ls',
      requires: ['svc:vfs'],
    });
    expect(m).toMatchObject({ class: 'user', caps: [], priority: 10, checkpointable: false });
    expect(
      v.safeParse(AppManifestSchema, { name: 'ls', kind: 'command', requires: [], class: 'root' })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(AppManifestSchema, { name: 'ls', kind: 'command', requires: ['vfs'] }).success,
    ).toBe(false);
  });

  it('SVC-12 dependency references name a service or a library and may be optional', () => {
    expect(parseDepRef('svc:lockd?')).toEqual({ kind: 'svc', name: 'lockd', optional: true });
    expect(parseDepRef('lib:codemirror')).toEqual({
      kind: 'lib',
      name: 'codemirror',
      optional: false,
    });
    expect(parseDepRef('proc:x')).toBeUndefined();
    expect(parseDepRef('svc:')).toBeUndefined();
  });
});
