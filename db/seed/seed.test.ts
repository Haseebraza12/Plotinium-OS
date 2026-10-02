import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  fixtureUsersFor,
  generateBench,
  HOME_INO,
  SYSTEM_INODES,
  type BenchData,
} from './lib/generate.ts';
import { mulberry32, zipfSampler } from './lib/rng.ts';
import { lit, renderBenchSql } from './lib/sql.ts';
import { seededUuidv7 } from './lib/uuid.ts';

const bench10k = generateBench('bench10k', 42);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function subtreeSize(data: BenchData, root: string): number {
  const children = new Map<string, string[]>();
  for (const d of data.dentries) {
    const list = children.get(d.parent) ?? [];
    list.push(d.ino);
    children.set(d.parent, list);
  }
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const ino = stack.pop() as string;
    n++;
    stack.push(...(children.get(ino) ?? []));
  }
  return n;
}

function inoOf(data: BenchData, path: string): string {
  let cur = '00000000-0000-7000-8000-000000000001';
  for (const part of path.split('/').filter((p) => p !== '')) {
    const d =
      part === 'home' && cur === '00000000-0000-7000-8000-000000000001'
        ? { ino: HOME_INO }
        : data.dentries.find((e) => e.parent === cur && e.name === part);
    if (d === undefined) throw new Error(`no ${part} in ${path}`);
    cur = d.ino;
  }
  return cur;
}

describe('DB-05 the bench seed (database.md §3.27)', () => {
  it('DB-05 mulberry32 with seed 42 is deterministic and uniform in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it('DB-05 the Zipf sampler favours low ranks and stays in range', () => {
    const rng = mulberry32(7);
    const draw = zipfSampler(59, 1.1);
    const counts = new Array<number>(59).fill(0);
    for (let i = 0; i < 20_000; i++) {
      const k = draw(rng);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts[0] ?? 0).toBeGreaterThan(counts[58] ?? 0);
    expect(counts.every((c) => c >= 0)).toBe(true);
  });

  it('DB-05 two bench-seed runs produce the same SQL and the same manifest checksum', () => {
    const again = generateBench('bench10k', 42);
    expect(sha(renderBenchSql(again))).toBe(sha(renderBenchSql(bench10k)));
    expect(again.manifest).toEqual(bench10k.manifest);
    expect(sha(renderBenchSql(generateBench('bench10k', 43)))).not.toBe(
      sha(renderBenchSql(bench10k)),
    );
  });

  it('DB-05 the bench seed has at least 50 users and writes its depth histogram to the manifest', () => {
    const m = bench10k.manifest;
    expect(m.users).toBeGreaterThanOrEqual(50);
    const histogramTotal = Object.values(m.depthHistogram).reduce((s, n) => s + n, 0);
    expect(histogramTotal).toBe(m.newInodes);
    expect(m.maxDepth).toBeGreaterThanOrEqual(33); // deep32 below /home/<user>
    expect(Object.keys(m.depthHistogram).length).toBeGreaterThan(10);
  });

  it('DB-05 bench10k and bench100k bring the tree to exactly 10,000 and 100,000 inodes', () => {
    expect(bench10k.inodes).toHaveLength(10_000 - SYSTEM_INODES);
    expect(bench10k.manifest.totalInodes).toBe(10_000);
    const big = generateBench('bench100k', 42);
    expect(big.inodes).toHaveLength(100_000 - SYSTEM_INODES);
    expect(big.manifest.fixtureUsers).toHaveLength(20);
  });

  it('DB-05 the fixtures have their exact sizes: q1 path of 8 components, big500, tree1000, flat1000, deep32 and 300 Ärger files', () => {
    const m = bench10k.manifest;
    expect(m.fixtureUsers).toHaveLength(fixtureUsersFor('bench10k'));
    for (const p of m.fixtures.q1) expect(p.split('/').filter(Boolean)).toHaveLength(8);
    for (const p of m.fixtures.big500) {
      const ino = inoOf(bench10k, p);
      expect(bench10k.dentries.filter((d) => d.parent === ino)).toHaveLength(500);
    }
    for (const p of m.fixtures.tree1000) {
      const ino = inoOf(bench10k, p);
      expect(subtreeSize(bench10k, ino)).toBe(1000);
      const dirs = bench10k.inodes.filter((n) => n.type === 'd').map((n) => n.ino);
      const inTree = new Set<string>();
      const walk = (x: string): void => {
        inTree.add(x);
        for (const d of bench10k.dentries.filter((e) => e.parent === x)) walk(d.ino);
      };
      walk(ino);
      expect(dirs.filter((d) => inTree.has(d))).toHaveLength(100); // 1 root + 99 directories
    }
    for (const p of m.fixtures.flat1000) {
      expect(bench10k.dentries.filter((d) => d.parent === inoOf(bench10k, p))).toHaveLength(1000);
    }
    for (const p of m.fixtures.deep32) expect(p.split('/').filter(Boolean).length).toBe(2 + 32);
    const aerger = bench10k.dentries.filter((d) => d.name.startsWith('Ärger_'));
    expect(aerger).toHaveLength(300);
  });

  it('VFS-08 every generated name is NFC, 1 to 255 bytes, free of / and unique in its directory', () => {
    const seen = new Set<string>();
    let nonAscii = 0;
    for (const d of bench10k.dentries) {
      expect(d.name.normalize('NFC')).toBe(d.name);
      const bytes = Buffer.byteLength(d.name, 'utf8');
      expect(bytes).toBeGreaterThanOrEqual(1);
      expect(bytes).toBeLessThanOrEqual(255);
      expect(d.name.includes('/') || d.name === '.' || d.name === '..').toBe(false);
      const key = `${d.parent}\u0000${d.name}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      if (Buffer.byteLength(d.name, 'utf8') !== d.name.length) nonAscii++;
    }
    expect(nonAscii).toBeGreaterThan(300); // the 300 Ärger files plus about 2 % of random names
  });

  it('DB-05 every file has a blob of its size, 10 % of files share content, and ids are UUIDv7', () => {
    const blobSize = new Map(bench10k.blobs.map((b) => [b.sha, b.size]));
    for (const n of bench10k.inodes) {
      expect(n.ino).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      if (n.type === 'f') expect(blobSize.get(n.blobSha ?? '')).toBe(n.size);
      else expect(n.blobSha).toBeNull();
    }
    const files = bench10k.inodes.filter((n) => n.type === 'f').length;
    expect(bench10k.manifest.sharedContentFiles / files).toBeGreaterThan(0.05);
    expect(bench10k.manifest.sharedContentFiles / files).toBeLessThan(0.15);
    expect(new Set(bench10k.inodes.map((n) => n.ino)).size).toBe(bench10k.inodes.length);
  });

  it('DB-05 seeded UUIDv7 ids sort in creation order', () => {
    const rng = mulberry32(1);
    const ids = Array.from({ length: 100 }, (_, i) => seededUuidv7(i, rng));
    expect([...ids].sort()).toEqual(ids);
  });

  it('DB-05 the SQL escapes quotes and loads in one transaction with the fix-ups before COMMIT', () => {
    expect(lit("it's")).toBe("'it''s'");
    expect(() => lit('a\u0000b')).toThrow();
    const sql = renderBenchSql(bench10k);
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('INSERT INTO inodes'));
    expect(sql.indexOf('UPDATE users u SET used_bytes')).toBeLessThan(sql.indexOf('COMMIT;'));
    expect(sql.trimEnd().endsWith('VACUUM (ANALYZE);')).toBe(true);
    expect(renderBenchSql(bench10k, { vacuum: false })).not.toContain('VACUUM');
  });
});
