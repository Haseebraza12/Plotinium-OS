/**
 * Memory through the system calls on the process loopback host (memory-and-paging.md §3.2–§3.13):
 * real programs use `ctx.mem` (`mem.alloc`, page access with runtime faults, `mem.free`) and
 * `mem.stat`, and the memory manager pages their data out through the executor port to the swap
 * device and back, verified against the page checksums.
 *
 * MEM-01 budget and per-process accounting in `mem.stat`; MEM-02 the focused process is never
 * evicted while an unfocused one is; MEM-03 paged-out data comes back byte-identical, and a
 * corrupted swap copy is never used; MEM-06 a 2x-budget workload keeps accounted memory within the
 * budget (reservation-based admission: callers block on `mem` until reclaim made room).
 */
import type { MemStat } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import type { MmParams } from '../../core/mm/params.ts';
import type { ProcLoopback } from '../proc-loopback.ts';
import { attempt, defineScript, exited, loopback, recordOf, trace } from './proc-harness.ts';

const KiB = 1_024;
const MiB = 1_024 * KiB;
const CHUNK = 256 * KiB;

const PARAMS: Partial<MmParams> = {
  budget: 4 * MiB,
  softLimit: 4 * MiB,
  overheadProc: 16 * KiB,
  initialStateBytes: 16 * KiB,
  stateHeadroom: 32 * KiB,
  stateSoft: 64 * KiB,
  stateMax: 512 * KiB,
  heavyBytes: 64 * MiB,
};

/** The byte pattern of page `i` of a hog: distinct per page, checked at three offsets. */
const fillOf = (i: number): number => (i * 37 + 11) & 0xff;

function checkPage(buf: ArrayBuffer, i: number): boolean {
  const u8 = new Uint8Array(buf);
  const v = fillOf(i);
  return u8.length === CHUNK && u8[0] === v && u8[CHUNK >> 1] === v && u8[CHUNK - 1] === v;
}

/**
 * `hog <pages>`: allocate one 256 KiB chunk page at a time and fill it, then (after a pause
 * during which other processes may run) read every page back and verify it.
 */
defineScript('hog', function* (ctx, rec) {
  const n = Number(ctx.argv[2]);
  const mem = ctx.mem;
  if (mem === undefined) throw new Error('no ctx.mem');
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const { pageIds } = yield* mem.alloc({ kind: 'chunk', size: CHUNK, label: `hog-${String(i)}` });
    const id = pageIds[0] ?? -1;
    ids.push(id);
    const buf = yield* mem.get(id, 'rw');
    new Uint8Array(buf).fill(fillOf(i));
  }
  rec['allocated'] = ids.length;
  rec['statMid'] = yield* ctx.sys['mem.stat']({ pid: ctx.pid });
  yield* ctx.sleep(Number(ctx.argv[3] ?? '0'));
  let bad = 0;
  for (let i = 0; i < ids.length; i++) {
    const buf = yield* mem.get(ids[i] ?? -1, 'r');
    if (!checkPage(buf, i)) bad++;
  }
  rec['bad'] = bad;
  rec['stat'] = yield* ctx.sys['mem.stat']({ pid: ctx.pid });
  rec['global'] = yield* ctx.sys['mem.stat']({});
  const freed = yield* mem.free(ids);
  rec['freed'] = freed.bytes;
  rec['bigAlloc'] = yield* attempt(mem.alloc({ kind: 'chunk', size: 64 * MiB }));
  return bad === 0 ? 0 : 1;
});

function memLoopback(): ProcLoopback {
  return loopback({ memory: PARAMS, cores: 4 });
}

/** Run until `pred`, sampling the accounted memory; returns the longest over-budget stretch. */
async function runSampling(
  lb: ProcLoopback,
  pred: () => boolean,
  maxMs: number,
): Promise<{ ok: boolean; peak: number }> {
  const mm = lb.mm;
  if (mm === null) throw new Error('no memory manager');
  let peak = 0;
  const ok = await lb.until(() => {
    peak = Math.max(peak, mm.accounted);
    return pred();
  }, maxMs);
  return { ok, peak };
}

describe('MEM-01 budget and accounting (syscalls)', () => {
  it("MEM-01 mem.stat reports the configured budget and each process's accounted bytes, which grow with mem.alloc", async () => {
    const lb = memLoopback();
    const hog = await lb.spawn('script', { argv: ['script', 'hog', '4'] });
    await lb.until(() => exited(hog), 30_000);
    const rec = recordOf(hog.pid);
    expect(hog.exitCode).toBe(0);
    const mid = rec['statMid'] as MemStat;
    expect(mid.budget).toBe(4 * MiB);
    const row = (mid.procs ?? []).find((p) => p.pid === hog.pid);
    expect(row).toBeDefined();
    expect(row?.accounted ?? 0).toBeGreaterThanOrEqual(4 * CHUNK);
    expect(rec['freed']).toBe(4 * CHUNK);
    // An allocation larger than the whole budget can never be granted.
    expect(rec['bigAlloc']).toEqual({ errno: 'EINVAL' });
    lb.checkInvariants();
  });
});

describe('MEM-06 and MEM-03 a 2x-budget workload (syscalls)', () => {
  it('MEM-06 a hog of twice the budget stays within the budget (callers block on mem while reclaim pages out), and MEM-03 every page comes back byte-identical', async () => {
    const lb = memLoopback();
    const mm = lb.mm;
    const swap = lb.swap;
    if (mm === null || swap === null) throw new Error('no memory');
    const hog = await lb.spawn('script', { argv: ['script', 'hog', '32'] });
    const { ok, peak } = await runSampling(lb, () => exited(hog), 120_000);
    expect(ok).toBe(true);
    const rec = recordOf(hog.pid);
    expect(rec['allocated']).toBe(32);
    expect(rec['bad']).toBe(0);
    expect(hog.exitCode).toBe(0);
    console.info(
      `MEM-06 (kernel) 2x budget: peak accounted ${(peak / MiB).toFixed(2)} MiB of ${(mm.budget / MiB).toFixed(0)} MiB, ` +
        `max over budget ${String(mm.maxOverBudgetMs())} ms, swap writes ${String(swap.writes)}, reads ${String(swap.reads)}`,
    );
    // Accounted memory never stayed over the budget for more than 1 s (0 expected).
    expect(mm.maxOverBudgetMs()).toBeLessThanOrEqual(1_000);
    expect(peak).toBeLessThanOrEqual(mm.budget * 1.05);
    // Pages really went to swap and came back (faults), verified on the way in.
    expect(swap.writes).toBeGreaterThan(0);
    expect(swap.reads).toBeGreaterThan(0);
    const stat = rec['stat'] as MemStat;
    const row = (stat.procs ?? []).find((p) => p.pid === hog.pid);
    expect(row?.faults ?? 0).toBeGreaterThan(0);
    // The reservation made the hog wait on `mem` at least once (KMM-06), or fault on `page:*`.
    const t = lb.kernel.klog.read({ filter: (r) => r.kind === 'proc' && r.pid === hog.pid });
    expect(
      t.some(
        (r) =>
          r.kind === 'proc' && (r.waitingOn === 'mem' || String(r.waitingOn).startsWith('page:')),
      ),
    ).toBe(true);
    lb.checkInvariants();
  }, 120_000);

  it('MEM-03 a corrupted swap copy is never used: the page-in fails its checksum and the program gets an error, not wrong bytes', async () => {
    const lb = memLoopback();
    const mm = lb.mm;
    const swap = lb.swap;
    if (mm === null || swap === null) throw new Error('no memory');
    // Corrupt every stored body as soon as it is written: any page-in must fail verification.
    const write = swap.write.bind(swap);
    swap.write = async (key, gen, header, body, sha256) => {
      const r = await write(key, gen, header, body, sha256);
      swap.corruptStored(key, gen);
      return r;
    };
    const hog = await lb.spawn('script', { argv: ['script', 'hog', '32'] });
    await lb.until(() => exited(hog), 120_000);
    const rec = recordOf(hog.pid);
    // The program never saw wrong bytes: either it crashed on EIO or it completed with bad = 0.
    if (hog.exitCode === 0) expect(rec['bad']).toBe(0);
    else expect(rec['bad']).toBeUndefined();
    expect(
      trace(lb, hog.pid).some(
        (x) => x.endsWith('>TERMINATED:crash') || x.endsWith('>TERMINATED:exit'),
      ),
    ).toBe(true);
    lb.checkInvariants();
  }, 120_000);
});

describe('MEM-02 focus pinning (syscalls)', () => {
  it('MEM-02 the focused process is never evicted while an unfocused process pages out under the same pressure', async () => {
    const lb = memLoopback();
    const mm = lb.mm;
    if (mm === null) throw new Error('no memory');
    // The focused hog fills 5 pages and then waits; the second hog takes twice the budget.
    const focused = await lb.spawn('script', { argv: ['script', 'hog', '5', '2000'] });
    await lb.until(() => recordOf(focused.pid)['allocated'] === 5, 30_000);
    lb.kernel.proc.focus(focused.pid);
    const other = await lb.spawn('script', { argv: ['script', 'hog', '28'] });
    await runSampling(lb, () => exited(focused) && exited(other), 120_000);
    expect(focused.exitCode).toBe(0);
    expect(other.exitCode).toBe(0);
    const f = recordOf(focused.pid)['stat'] as MemStat;
    const o = recordOf(other.pid)['stat'] as MemStat;
    expect((f.procs ?? []).find((p) => p.pid === focused.pid)?.faults ?? -1).toBe(0);
    expect((o.procs ?? []).find((p) => p.pid === other.pid)?.faults ?? 0).toBeGreaterThan(0);
    expect(mm.maxOverBudgetMs()).toBeLessThanOrEqual(1_000);
    lb.checkInvariants();
  }, 120_000);
});
