import { describe, expect, it } from 'vitest';

import type { Program } from '@plotinium/kernel/sys';
import { SysError } from '@plotinium/kernel/sys';

import type { ChildWork, MemhogOpts, MemhogWork } from '../cmd/memhog.ts';
import memhog, {
  childArgv,
  EXIT_MISMATCH,
  MEMHOG_MANIFEST,
  parseMemhog,
  shareOf,
  statusLine,
} from '../cmd/memhog.ts';
import type { DemoState } from '../lib/cli.ts';
import { PAGE_CHUNK } from '../lib/pages.ts';
import { pageBytes } from '../lib/pattern.ts';
import type { FakeProc } from './fakesys.ts';
import { FakeKernel } from './fakesys.ts';

const program = memhog as unknown as Program<unknown>;
const MiB = 1_048_576;

function work(p: FakeProc): ChildWork {
  const w = (p.st as DemoState<MemhogOpts, MemhogWork>).w;
  if (w?.kind !== 'child') throw new Error('not a memhog child');
  return w;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A kernel whose memory budget is `budget` bytes, with memhog installed at /bin/memhog.json. */
function kernel(budget: number): FakeKernel {
  const k = new FakeKernel({ budget });
  k.programs.set(MEMHOG_MANIFEST, program);
  return k;
}

describe('memhog options (memory-and-paging.md §3.17.5)', () => {
  it('KMM-14 memhog --total 512M --procs 8 parses to eight 64 MiB shares', () => {
    const o = parseMemhog(['--total', '512M', '--procs', '8']);
    expect(o).toMatchObject({
      total: 512 * MiB,
      procs: 8,
      touch: 'random',
      rate: 50,
      writeRatio: 0.25,
      hold: null,
      seed: 42,
      report: 5,
      child: null,
    });
    const shares = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => shareOf(o.total, o.procs, i));
    expect(new Set(shares)).toEqual(new Set([64 * MiB]));
    expect(shareOf(10, 3, 0) + shareOf(10, 3, 1) + shareOf(10, 3, 2)).toBe(10);
  });

  it('KMM-14 a child gets its share and every touch option on its command line', () => {
    const o = parseMemhog([
      '--total',
      '1G',
      '--procs',
      '3',
      '--touch',
      'seq',
      '--rate',
      '0',
      '--write-ratio',
      '0.5',
      '--compressible',
      '--hold',
      '9',
      '--seed',
      '7',
    ]);
    const child = parseMemhog(childArgv(o, 2).slice(1));
    expect(child).toEqual({
      ...o,
      total: shareOf(1024 * MiB, 3, 2),
      procs: 1,
      report: 5,
      child: 2,
    });
  });

  it('SYS-02 memhog without --total, or with a bad option, prints the usage and exits 2', () => {
    const k = kernel(64 * MiB);
    for (const argv of [
      ['memhog'],
      ['memhog', '--total', '12Q'],
      ['memhog', '--total', '1M', '--touch', 'zigzag'],
      ['memhog', '--total', '1M', '--write-ratio', '2'],
      ['memhog', '--total', '3', '--procs', '4'],
    ]) {
      const r = k.run(program, argv);
      expect(r.status).toBe(2);
      expect(r.err).toContain('Usage: memhog --total SIZE');
    }
  });
});

describe('memhog child on ctx.mem pages', () => {
  it('MEM-06 a child allocates its share in 256 KiB pages and accounted memory never exceeds the budget', () => {
    const k = kernel(2 * MiB);
    const r = k.run(
      program,
      ['memhog', '--child', '0', '--total', String(3 * MiB + 1000), '--hold', '3', '--rate', '200'],
      { ctxMem: true },
    );
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    const w = work(r.proc);
    expect(w.handles).toHaveLength(13);
    expect(k.callsOf('ctxmem.alloc').map((a) => (a as { size: number }).size)).toEqual([
      ...Array<number>(12).fill(PAGE_CHUNK),
      1000,
    ]);
    expect(k.mem.maxCommitted).toBeLessThanOrEqual(2 * MiB);
    expect(k.mem.pageOuts).toBeGreaterThan(0);
    expect(k.mem.faults).toBeGreaterThan(0);
    // Every page was given back at exit.
    expect(k.mem.pages.size).toBe(0);
    expect(k.mem.committed).toBe(0);
  });

  it('MEM-03 pages that were paged out come back byte-identical and every read touch verifies them', () => {
    const k = kernel(1 * MiB);
    const p = k.start(
      program,
      ['memhog', '--child', '1', '--total', String(2 * MiB), '--rate', '0', '--write-ratio', '0.3'],
      { ctxMem: true },
    );
    k.runUntil(() => work(p).touches >= 300);
    const w = work(p);
    expect(w.mismatches).toBe(0);
    expect(w.verified).toBeGreaterThan(150);
    expect(w.writes).toBeGreaterThan(50);
    expect(k.mem.faults).toBeGreaterThan(50);
    // The bytes the kernel holds (resident or in swap) are exactly the pattern of each page's generation.
    for (const [i, handle] of w.handles.entries()) {
      const page = k.mem.pages.get(handle);
      const bytes = page?.body ?? page?.swap ?? new Uint8Array();
      const want = pageBytes(PAGE_CHUNK, {
        seed: 42,
        child: 1,
        page: i,
        gen: w.gens[i] ?? 0,
        compressible: false,
      });
      expect(sameBytes(bytes, want)).toBe(true);
    }
    k.signal(p, 'SIGTERM');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(143);
    expect(k.mem.pages.size).toBe(0);
  });

  it('MEM-03 a page that changed in swap is caught at page-in and the child exits 3', () => {
    const k = kernel(1 * MiB);
    let damaged = 0;
    k.mem.onPageIn = (page, bytes) => {
      if (damaged === 0 && page.size === PAGE_CHUNK) {
        bytes[12_345] = (bytes[12_345] ?? 0) ^ 0x10;
        damaged = page.id;
      }
    };
    const r = k.run(
      program,
      [
        'memhog',
        '--child',
        '0',
        '--total',
        String(2 * MiB),
        '--rate',
        '200',
        '--write-ratio',
        '0',
        '--hold',
        '1',
      ],
      { ctxMem: true },
    );
    expect(damaged).toBeGreaterThan(0);
    expect(r.status).toBe(EXIT_MISMATCH);
    expect(r.err).toMatch(
      /^memhog: child 0 \(pid \d+\): page \d+ changed after page-in: checksum [0-9a-f]{16}, expected [0-9a-f]{16}\n/,
    );
    expect(work(r.proc).mismatches).toBeGreaterThanOrEqual(1);
  });

  it('MEM-03 a child restored after a whole-process page-out verifies every page before it continues', () => {
    const k = kernel(8 * MiB);
    const p = k.start(
      program,
      ['memhog', '--child', '2', '--total', String(3 * MiB), '--rate', '100'],
      { ctxMem: true },
    );
    k.runUntil(() => work(p).touches >= 5);
    k.mem.pageOutAll(p.pid);
    k.restore(p, 'page-in');
    k.runUntil(() => p.out.includes('restored'));
    expect(p.out).toMatch(
      new RegExp(
        `^memhog: child 2 \\(pid ${String(p.pid)}\\) restored after page-in: 12/12 pages verified byte-identical\\n$`,
      ),
    );
    expect(k.mem.faults).toBeGreaterThanOrEqual(12);
    k.signal(p, 'SIGINT');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(130);
  });

  it('MEM-06 a page that can never fit the budget is reported once and the child exits 1', () => {
    const k = kernel(100_000);
    const r = k.run(program, ['memhog', '--child', '0', '--total', '1M'], { ctxMem: true });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(
      /^memhog: child 0 \(pid \d+\): cannot allocate 256\.0K: Invalid argument \(exceeds-budget\)\n$/,
    );
  });

  it('MEM-07 SIGUSR1 prints the child status line', () => {
    const k = kernel(8 * MiB);
    const p = k.start(program, ['memhog', '--child', '3', '--total', '1M', '--rate', '0'], {
      ctxMem: true,
    });
    k.runUntil(() => work(p).touches >= 10);
    k.signal(p, 'SIGUSR1');
    k.runUntil(() => p.out.length > 0);
    expect(p.out).toMatch(
      /^memhog: child 3 \(pid \d+\): 1\.0M in 4\/4 pages, \d+ touches \(\d+ writes\), \d+ verified, 0 changed, max blocked \d+ ms\n$/,
    );
    k.signal(p, 'SIGTERM');
    k.runUntil(() => p.state !== 'run');
  });

  it('MEM-06 --touch seq visits every page in order and --compressible fills a text pattern', () => {
    const k = kernel(8 * MiB);
    const p = k.start(
      program,
      [
        'memhog',
        '--child',
        '0',
        '--total',
        '1M',
        '--touch',
        'seq',
        '--rate',
        '0',
        '--write-ratio',
        '0',
        '--compressible',
      ],
      { ctxMem: true },
    );
    k.runUntil(() => work(p).touches >= 8);
    const w = work(p);
    expect(w.cursor).toBe(w.touches % 4);
    const first = k.mem.pages.get(w.handles[0] ?? 0)?.body;
    expect(new TextDecoder().decode(first?.subarray(0, 36))).toBe(
      'memhog seed 42 child 0 page 0 gen 0\n',
    );
    k.signal(p, 'SIGTERM');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(143);
  });
});

describe('memhog child on the mem.alloc fallback', () => {
  it('MEM-06 without ctx.mem every page is reserved with mem.alloc and freed at exit', () => {
    const k = kernel(64 * MiB);
    const r = k.run(program, ['memhog', '--child', '4', '--total', '1M', '--hold', '1']);
    expect(r.status).toBe(0);
    expect(k.callsOf('mem.alloc')).toEqual(
      [0, 1, 2, 3].map((i) => ({
        bytes: PAGE_CHUNK,
        key: `memhog.4.${String(i)}`,
        kind: 'buffer',
      })),
    );
    expect(k.callsOf('mem.free')).toHaveLength(4);
    expect(k.segments.size).toBe(0);
    expect(work(r.proc).mismatches).toBe(0);
  });

  it('MEM-06 a fallback child waits while the budget is full instead of going over it', () => {
    const k = kernel(3 * PAGE_CHUNK);
    const a = k.start(program, [
      'memhog',
      '--child',
      '0',
      '--total',
      String(2 * PAGE_CHUNK),
      '--hold',
      '2',
    ]);
    const b = k.start(program, [
      'memhog',
      '--child',
      '1',
      '--total',
      String(2 * PAGE_CHUNK),
      '--hold',
      '2',
    ]);
    k.runUntil(() => a.state !== 'run' && b.state !== 'run');
    expect(k.statusOf(a)).toBe(0);
    expect(k.statusOf(b)).toBe(0);
    expect(k.mem.maxCommitted).toBeLessThanOrEqual(3 * PAGE_CHUNK);
  });

  it('MEM-03 after a restore the fallback re-creates the lost bodies from their seeds and verifies them', () => {
    const k = kernel(64 * MiB);
    const p = k.start(program, ['memhog', '--child', '0', '--total', '1M', '--rate', '0']);
    k.runUntil(() => work(p).writes >= 3);
    k.restore(p, 'migration');
    k.runUntil(() => p.out.includes('restored'));
    expect(p.out).toMatch(
      /restored after migration: 4\/4 pages re-created from their seeds and verified \(no ctx\.mem\)\n$/,
    );
    k.signal(p, 'SIGHUP');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(129);
    expect(work(p).mismatches).toBe(0);
  });
});

describe('memhog parent', () => {
  it('KMM-14 memhog --procs 4 spawns four children, reports the status line and ends with the summary', () => {
    const k = kernel(1 * MiB);
    const r = k.run(
      program,
      ['memhog', '--total', '2M', '--procs', '4', '--hold', '4', '--report', '1', '--rate', '20'],
      { ctxMem: true },
    );
    expect(k.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    const spawns = k.callsOf('spawn') as { argv: string[] }[];
    expect(spawns.map((s) => s.argv.slice(0, 5))).toEqual(
      [0, 1, 2, 3].map((i) => ['memhog', '--child', String(i), '--total', String(512 * 1024)]),
    );
    const lines = r.out.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines.slice(0, -1)) {
      expect(line).toMatch(
        /^memhog: \d procs, [\d.]+[BKM] allocated, budget 1\.0M, committed [\d.]+[BKM], faults \d+( \(\d+\/s\))?, max blocked -, max over budget -$/,
      );
    }
    expect(lines.some((l) => /faults [1-9]\d* \(\d+\/s\)/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(
      /^memhog: done: 4 of 4 procs, peak [\d.]+[KM] allocated, budget 1\.0M, faults \d+, max blocked -, max over budget -; pages changed in 0 procs$/,
    );
    expect(k.mem.maxCommitted).toBeLessThanOrEqual(1 * MiB);
    expect(k.mem.pages.size).toBe(0);
  });

  it('MEM-06 SIGINT to the parent stops every child, which give their pages back, and the parent exits 130', () => {
    const k = kernel(4 * MiB);
    const parent = k.start(program, ['memhog', '--total', '2M', '--procs', '2'], { ctxMem: true });
    k.runUntil(
      () =>
        [...k.procs.values()].filter((c) => c.ppid === parent.pid && work(c).phase === 'touch')
          .length === 2,
    );
    k.signal(parent, 'SIGINT');
    k.runUntil(() => parent.state !== 'run');
    expect(k.statusOf(parent)).toBe(130);
    const children = [...k.procs.values()].filter((c) => c.ppid === parent.pid);
    expect(children.map((c) => k.statusOf(c))).toEqual([143, 143]);
    expect(parent.out.trimEnd().split('\n').at(-1)).toMatch(
      /; pages changed in 0 procs \(stopped by SIGINT\)$/,
    );
    expect(k.mem.pages.size).toBe(0);
  });

  it('MEM-03 the parent exits 3 when a child found a changed page', () => {
    const k = kernel(1 * MiB);
    let hit = false;
    k.mem.onPageIn = (_page, bytes) => {
      if (!hit) {
        bytes[7] = (bytes[7] ?? 0) ^ 1;
        hit = true;
      }
    };
    const r = k.run(
      program,
      [
        'memhog',
        '--total',
        '2M',
        '--procs',
        '2',
        '--hold',
        '2',
        '--rate',
        '200',
        '--write-ratio',
        '0',
      ],
      { ctxMem: true },
    );
    expect(hit).toBe(true);
    expect(r.status).toBe(EXIT_MISMATCH);
    expect(r.out.trimEnd().split('\n').at(-1)).toMatch(/pages changed in 1 procs$/);
  });

  it('MEM-07 statusLine prints dashes for the values the kernel does not report yet', () => {
    expect(
      statusLine({
        procs: 8,
        allocated: 512 * MiB,
        faults: 1832,
        faultsPerSec: 41,
        budget: 256 * MiB,
        committed: 254.9 * MiB,
        maxBlockedMs: 380,
        maxOverBudgetMs: 0,
      }),
    ).toBe(
      'memhog: 8 procs, 512.0M allocated, budget 256.0M, committed 254.9M, faults 1832 (41/s), max blocked 380 ms, max over budget 0 ms',
    );
    expect(
      statusLine({
        procs: 1,
        allocated: 0,
        faults: 0,
        faultsPerSec: null,
        budget: null,
        committed: null,
        maxBlockedMs: null,
        maxOverBudgetMs: null,
      }),
    ).toBe(
      'memhog: 1 procs, 0B allocated, budget -, committed -, faults 0, max blocked -, max over budget -',
    );
  });

  it('MEM-07 the kernel fields committed, oldestBlockedMs and maxOverBudgetMs are shown when present', () => {
    const k = kernel(1 * MiB);
    k.on('mem.stat', () => ({
      budget: MiB,
      accounted: 0,
      reservedWaiting: 0,
      committed: 900 * 1024,
      oldestBlockedMs: 380,
      maxOverBudgetMs: 0,
      resident: 0,
      swappedLocal: 0,
      swappedRemote: 0,
      speculative: 0,
      embed: { bytes: 0, state: 'absent' as const },
      kernel: 0,
      faults: 0,
      faultsPerSec: 0,
      hitRatio: 1,
      bytesIn: 0,
      bytesOut: 0,
    }));
    const r = k.run(program, ['memhog', '--total', '1M', '--hold', '2', '--report', '1'], {
      ctxMem: true,
    });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(
      /committed 900\.0K, faults \d+( \(\d+\/s\))?, max blocked 380 ms, max over budget 0 ms\n/,
    );
  });

  it('KMM-14 a child that cannot be spawned is reported, the others are stopped and memhog exits 1', () => {
    const k = kernel(8 * MiB);
    let n = 0;
    k.on('spawn', (a, p, kk) => {
      n++;
      if (n === 2) throw new SysError('ENOENT');
      return kk.spawnDefault(a, p);
    });
    const r = k.run(program, ['memhog', '--total', '1M', '--procs', '3'], { ctxMem: true });
    expect(r.status).toBe(1);
    expect(r.err).toBe('memhog: cannot spawn child 1: No such file or directory\n');
    expect(r.out).toMatch(/^memhog: done: 1 of 3 procs, /);
    const children = [...k.procs.values()].filter((c) => c.ppid === r.proc.pid);
    expect(children.map((c) => k.statusOf(c))).toEqual([143]);
  });

  it('MEM-06 a refused spawn (EAGAIN, thrashing) is retried every second', () => {
    const k = kernel(8 * MiB);
    let n = 0;
    k.on('spawn', (a, p, kk) => {
      n++;
      if (n <= 2) throw new SysError('EAGAIN', undefined, { reason: 'thrashing' });
      return kk.spawnDefault(a, p);
    });
    const r = k.run(program, ['memhog', '--total', '512K', '--hold', '1'], { ctxMem: true });
    expect(r.status).toBe(0);
    expect(r.err).toBe(
      'memhog: spawn of child 0 refused (Resource temporarily unavailable (thrashing)); retrying\n',
    );
    expect(k.callsOf('sleep').slice(0, 2)).toEqual([{ ms: 1000 }, { ms: 1000 }]);
  });
});
