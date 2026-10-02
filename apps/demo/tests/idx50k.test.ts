import { describe, expect, it } from 'vitest';

import type { Program } from '@plotinium/kernel/sys';
import { SysError } from '@plotinium/kernel/sys';

import idx50k, { DEFAULT_SIZE, parseIdx, verdict } from '../cmd/idx50k.ts';
import { idxText, markerOf } from '../lib/prose.ts';
import { FakeKernel } from './fakesys.ts';

const program = idx50k as unknown as Program<unknown>;
const INO = '0190a5c2-7d1e-7abc-8def-0123456789ab';

interface Written {
  readonly path: string;
  readonly text: string;
  /** Virtual epoch time of the write. */
  readonly at: number;
}

/** Records every writeFile and answers it with the demo inode. */
function withWrites(k: FakeKernel): Written[] {
  const written: Written[] = [];
  k.on('writeFile', (a) => {
    written.push({
      path: a.path,
      text: new TextDecoder().decode(new Uint8Array(a.data)),
      at: k.epochNow,
    });
    return { ino: INO, version: written.length, bytes: a.data.byteLength } as never;
  });
  return written;
}

interface Hit {
  readonly path: string;
  readonly ino: string;
  readonly score: number;
}

/** semsearch finds the written file once `afterMs` have passed since the first write. */
function withSearch(
  k: FakeKernel,
  written: readonly Written[],
  afterMs: number,
  mode: 'semantic' | 'hybrid' | 'keyword' = 'semantic',
): string[] {
  const queries: string[] = [];
  k.on('ai.semsearch', (a) => {
    queries.push(a.q);
    const first = written[0];
    const hits: Hit[] = [{ path: '/home/alice/other.md', ino: 'other', score: 0.41 }];
    if (first !== undefined && k.epochNow - first.at >= afterMs)
      hits.unshift({ path: first.path, ino: INO, score: 0.83 });
    return {
      mode,
      model: {
        key: 'mdbr-leaf-ir-q8@4262131b-384',
        state: mode === 'keyword' ? 'unavailable' : 'ready',
      },
      results: hits.map((h) => ({
        ...h,
        lineStart: 1,
        lineEnd: 3,
        snippet: 'x',
        verified: 'own' as const,
      })),
      notices: [],
      timings: { embedMs: 1, filterMs: 1, scanMs: 1, verifyMs: 1, totalMs: 4 },
    };
  });
  return queries;
}

describe('the idx50k text', () => {
  it('RAG-02 the text is exactly SIZE bytes of ASCII with the marker in its first and last paragraphs', () => {
    for (const [size, seed] of [
      [DEFAULT_SIZE, 1],
      [1024, 2],
      [100 * 1024, 3],
      [51_201, 4],
    ] as const) {
      const text = idxText(size, seed);
      const bytes = new TextEncoder().encode(text);
      expect(bytes.byteLength).toBe(size);
      expect(bytes.every((b) => b === 10 || (b >= 32 && b < 127))).toBe(true);
      const marker = markerOf(seed);
      expect(text.split(marker)).toHaveLength(3);
      expect(text.startsWith('# Field notes: Arctic tern migration')).toBe(true);
      expect(text.endsWith(`Reference marker: ${marker}.\n`)).toBe(true);
    }
  });

  it('RAG-02 one seed always gives the same bytes; another seed modifies the text and the marker', () => {
    expect(idxText(DEFAULT_SIZE, 1)).toBe(idxText(DEFAULT_SIZE, 1));
    expect(idxText(DEFAULT_SIZE, 2)).not.toBe(idxText(DEFAULT_SIZE, 1));
    expect(markerOf(1)).toMatch(/^[a-z]+-[0-9a-f]{4}$/);
    expect(new Set([1, 2, 3, 4, 5].map(markerOf)).size).toBe(5);
    expect(() => idxText(100, 1)).toThrow(RangeError);
  });
});

describe('idx50k', () => {
  it('RAG-02 idx50k writes 51,200 bytes to ~/idx50k.md in one writeFile and prints the write time and marker', () => {
    const k = new FakeKernel();
    const written = withWrites(k);
    const r = k.run(program, ['idx50k']);
    expect(r.status).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe('/home/alice/idx50k.md');
    expect(written[0]?.text).toBe(idxText(DEFAULT_SIZE, 1));
    expect(k.callsOf('writeFile')[0]).toMatchObject({ create: true, mode: 0o644 });
    expect(r.out).toMatch(
      new RegExp(
        `^idx50k: wrote 51,200 bytes to /home/alice/idx50k\\.md \\(version 1\\) at \\d\\d:\\d\\d:\\d\\d\\.\\d{3}; marker ${markerOf(1)}\\n$`,
      ),
    );
  });

  it('RAG-02 --wait searches once a second until semsearch returns the file and times it against 30 s', () => {
    const k = new FakeKernel();
    const queries = withSearch(k, withWrites(k), 12_000);
    const r = k.run(program, ['idx50k', '--seed', '2', '--wait', 'notes.md']);
    expect(r.status).toBe(0);
    expect(queries.length).toBeGreaterThanOrEqual(12);
    expect(new Set(queries)).toEqual(new Set([markerOf(2)]));
    expect(r.out.trimEnd().split('\n').at(-1)).toMatch(
      /^idx50k: found by semsearch after 1[23]\.\d s \(mode semantic, score 0\.83; RAG-02 budget 30 s: met\)$/,
    );
  });

  it('RAG-02 --wait gives up after --timeout and says the budget was missed', () => {
    const k = new FakeKernel();
    withSearch(k, withWrites(k), 3_600_000);
    const r = k.run(program, ['idx50k', '--wait', '--timeout', '40']);
    expect(r.status).toBe(1);
    expect(r.err).toBe('idx50k: not found by semsearch after 40 s (RAG-02 budget 30 s: missed)\n');
  });

  it('RAG-06 --wait reports the keyword fallback mode that semsearch used', () => {
    const k = new FakeKernel();
    const queries = withSearch(k, withWrites(k), 2_000, 'keyword');
    const r = k.run(program, ['idx50k', '-w', '-q', 'arctic tern flyway']);
    expect(r.status).toBe(0);
    expect(queries[0]).toBe('arctic tern flyway');
    expect(r.out).toMatch(
      /found by semsearch after \d+\.\d s \(mode keyword, score 0\.83; RAG-02 budget 30 s: met\)\n$/,
    );
  });

  it('RAG-06 an unavailable semsearch is reported and idx50k exits 1', () => {
    const k = new FakeKernel();
    withWrites(k);
    k.fail('ai.semsearch', 'EAIUNAVAIL', 'offline');
    const r = k.run(program, ['idx50k', '--wait']);
    expect(r.status).toBe(1);
    expect(r.err).toBe('idx50k: semsearch unavailable: AI service unavailable (offline)\n');
  });

  it('RAG-02 a failed write is reported with the path and errno text', () => {
    const k = new FakeKernel();
    k.on('writeFile', () => {
      throw new SysError('EDQUOT');
    });
    const r = k.run(program, ['idx50k', '-s', '50K', '/home/alice/x.md']);
    expect(r.status).toBe(1);
    expect(r.err).toBe("idx50k: cannot write '/home/alice/x.md': Disk quota exceeded\n");
  });

  it('SYS-02 idx50k checks its options', () => {
    const k = new FakeKernel();
    for (const argv of [
      ['idx50k', '-s', '10'],
      ['idx50k', '--timeout', '5'],
      ['idx50k', '-q', 'x'],
      ['idx50k', 'a', 'b'],
      ['idx50k', '--wait', '-q', ' '],
    ]) {
      const r = k.run(program, argv);
      expect(r.status).toBe(2);
      expect(r.err).toContain('Usage: idx50k [-s SIZE]');
    }
    expect(parseIdx(['-s', '100K', '--seed', '9', '-w', '-t', '90'])).toEqual({
      path: null,
      size: 102_400,
      seed: 9,
      wait: true,
      timeout: 90,
      query: null,
    });
    expect(verdict(30_000)).toBe('RAG-02 budget 30 s: met');
    expect(verdict(30_001)).toBe('RAG-02 budget 30 s: missed');
  });
});
