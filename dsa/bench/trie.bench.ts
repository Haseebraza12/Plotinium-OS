/**
 * S2 radix trie benchmarks (specs/08-dsa/data-structures.md §7, §8.3). Gated on IMPLEMENTED.
 *
 * Workloads (§7.1, seed 42): `path:` basenames in one directory (the SYS-03 "10,000-entry
 * directory"); `cmd:` synthetic command names; `flag:` commands × flags; `hist:` shell lines from a
 * small grammar. Queries are prefixes of length 1–10 of existing keys plus 10% misses, and each
 * returns at most 20 completions.
 *
 * Hard limits (fail on any runner, §7.2): complete p95 ≤ 1 ms at 10^4 and 10^5 entries in every
 * namespace (SYS-03); ≤ 32 MB per namespace at 10^5 entries (reversal trigger 6). Shape: complete
 * p95 grows at most 3× from 10^3 to 10^5 while the linear-scan baseline grows about 100×;
 * insert/remove at most 3×.
 */
import { describe, it } from 'vitest';

import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32 } from '../src/_shared/prng.ts';
import { IMPLEMENTED, NamespacedRadixTrie, RadixTrie } from '../src/trie/index.ts';
import type { Namespace } from '../src/trie/index.ts';
import { measureCurve, record, recordMemory, SEED, SIZES, shapeRatio } from './harness.ts';

const LIMIT = 20;
const QUERIES = 1_024;
const DIR = '00000000-0000-7000-8000-00000000abcd';
const SYLLABLES = [
  'ka',
  'lo',
  'mi',
  'ne',
  'ra',
  'to',
  'su',
  'vi',
  'da',
  'pe',
  'qu',
  'zo',
  'report',
  'data',
  'img',
  'notes',
];
const EXTENSIONS = ['.txt', '.md', '.png', '.json', '.ts', ''];
const COMMANDS = [
  'ls',
  'cat',
  'grep',
  'find',
  'cd',
  'mv',
  'cp',
  'rm',
  'echo',
  'less',
  'head',
  'tail',
  'ai',
  'ps',
  'kill',
  'top',
];

const pick = <T>(rand: () => number, xs: readonly T[]): T =>
  xs[Math.floor(rand() * xs.length)] as T;

/** n distinct keys of one namespace, as stored in its trie. */
function corpus(ns: Namespace, n: number): string[] {
  const rand = mulberry32(SEED);
  const keys = new Set<string>();
  while (keys.size < n) {
    const i = keys.size;
    switch (ns) {
      case 'path':
        keys.add(
          `${DIR}/${pick(rand, SYLLABLES)}${pick(rand, SYLLABLES)}_${i.toString(36)}${pick(rand, EXTENSIONS)}`,
        );
        break;
      case 'cmd': {
        const length = 2 + Math.floor(rand() * 11);
        keys.add(
          Array.from({ length }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join(''),
        );
        break;
      }
      case 'flag':
        keys.add(
          `${pick(rand, COMMANDS)}${Math.floor(i / 20)}\u0000--${pick(rand, SYLLABLES)}-${i % 20}`,
        );
        break;
      case 'hist':
        keys.add(
          `1000\u0000${pick(rand, COMMANDS)} ${pick(rand, SYLLABLES)}${pick(rand, EXTENSIONS)} ${i}`,
        );
        break;
    }
  }
  return [...keys];
}

/** Prefixes of length 1–10 (after the namespace's fixed part) of existing keys, plus 10% misses. */
function queries(ns: Namespace, keys: readonly string[]): string[] {
  const rand = mulberry32(SEED + 1);
  const fixed = ns === 'path' ? DIR.length + 1 : ns === 'hist' ? 5 : 0;
  return Array.from({ length: QUERIES }, () => {
    const key = pick(rand, keys);
    const prefix = key.slice(0, fixed + 1 + Math.floor(rand() * 10));
    return rand() < 0.1 ? `${prefix}\u{FFFF}` : prefix;
  });
}

function build(keys: readonly string[]): RadixTrie {
  const trie = new RadixTrie();
  for (const k of keys) trie.insert(k);
  return trie;
}

const NAMESPACES: readonly Namespace[] = ['path', 'cmd', 'flag', 'hist'];
const MB32 = 32 * 1_048_576;

describe.runIf(IMPLEMENTED)('dsa/trie benchmarks (S2)', () => {
  it('SYS-03 complete p95 is at most 1 ms at 10^4 and 10^5 entries in every namespace', async ({
    bench,
    expect,
  }) => {
    for (const ns of NAMESPACES) {
      const curve = await measureCurve(bench, {
        structure: 'trie',
        op: `complete(prefix, ${LIMIT})`,
        variant: ns,
        batch: 1,
        setup: (n) => {
          const keys = corpus(ns, n);
          const trie = build(keys);
          const qs = queries(ns, keys);
          let q = 0;
          return () => {
            trie.complete(qs[q++ % QUERIES] ?? '', LIMIT);
          };
        },
      });
      for (const t of curve.timings.filter((x) => x.n >= 10_000)) {
        record({
          structure: 'trie',
          variant: ns,
          op: 'complete p95 budget',
          timing: t,
          budget: {
            metric: 'p95 ns',
            limit: 1e6,
            value: t.p95Ns,
            pass: t.p95Ns <= 1e6,
            hard: true,
          },
        });
        expect(t.p95Ns).toBeLessThanOrEqual(1e6);
      }
    }
  });

  it('DSA-TRIE-01 complete p95 grows at most 3x from 10^3 to 10^5 while the linear-scan baseline grows about 100x', async ({
    bench,
    expect,
  }) => {
    const trie = await measureCurve(bench, {
      structure: 'trie',
      op: `complete(prefix, ${LIMIT})`,
      variant: 'path shape',
      batch: 1,
      shape: { expected: 'O(P+k)', limit: 3 },
      setup: (n) => {
        const keys = corpus('path', n);
        const t = build(keys);
        const qs = queries('path', keys);
        let q = 0;
        return () => {
          t.complete(qs[q++ % QUERIES] ?? '', LIMIT);
        };
      },
    });
    const baseline = await measureCurve(bench, {
      structure: 'trie',
      op: `complete(prefix, ${LIMIT})`,
      variant: 'baseline:linear-scan',
      batch: 1,
      setup: (n) => {
        const keys = corpus('path', n);
        const qs = queries('path', keys);
        let q = 0;
        return () => {
          const prefix = qs[q++ % QUERIES] ?? '';
          keys
            .filter((k) => k.startsWith(prefix))
            .sort()
            .slice(0, LIMIT);
        };
      },
    });
    const p95Ratio = shapeRatio(trie.timings, (t) => t.p95Ns);
    expect(p95Ratio).toBeLessThanOrEqual(3);
    if (SIZES.length > 1)
      expect(shapeRatio(baseline.timings, (t) => t.p95Ns)).toBeGreaterThan(p95Ratio);
  });

  it('DSA-TRIE-01 insert and remove (L ≤ 64) grow at most 3x from 10^3 to 10^5', async ({
    bench,
    expect,
  }) => {
    const churn = await measureCurve(bench, {
      structure: 'trie',
      op: 'insert+remove',
      variant: 'path',
      batch: 100,
      shape: { expected: 'O(P+k)', limit: 3 },
      setup: (n) => {
        const keys = corpus('path', n + 100);
        const trie = build(keys.slice(0, n));
        const extra = keys.slice(n);
        return () => {
          for (const k of extra) trie.insert(k);
          for (const k of extra) trie.remove(k);
        };
      },
    });
    expect(churn.ratio).toBeLessThanOrEqual(3);
  });

  it('DSA-TRIE-03 memory at 10^5 entries is at most 32 MB per namespace and bytes per entry are reported', ({
    expect,
  }) => {
    for (const ns of NAMESPACES) {
      for (const n of SIZES) {
        const keys = corpus(ns, n);
        // Template-literal keys are V8 cons strings. insert's first charCodeAt flattens each one,
        // and the freed cons cells would be subtracted from the trie's growth (negative bytes per
        // entry for path and hist). Flatten them before the first snapshot so only the trie counts.
        for (const k of keys) k.charCodeAt(0);
        const { value: trie, bytesPerEntryMeasured } = measureBytesPerEntry(n, () => build(keys));
        const stats = trie.stats();
        recordMemory('trie', n, bytesPerEntryMeasured, stats, ns);
        expect(stats.bytesAllocated).toBeLessThanOrEqual(MB32);
        if (bytesPerEntryMeasured !== null)
          expect(bytesPerEntryMeasured * n).toBeLessThanOrEqual(MB32);
      }
    }
    // The namespaced wrapper holds all four instances; each stays within its own budget.
    const all = new NamespacedRadixTrie();
    for (const key of corpus('path', 1_000)) all.addPath(DIR, key.slice(DIR.length + 1), 'file');
    expect(all.path.stats().bytesAllocated).toBeLessThanOrEqual(MB32);
  });
});
