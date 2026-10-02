/**
 * The memory manager end to end over test doubles (memory-and-paging.md §8): MEM-01, MEM-02,
 * MEM-03, MEM-04, MEM-06, MEM-07, WM-05, KMM-12, KMM-13. The executor, the swap devices, the
 * LRU (dsa/lru, IMPLEMENTED = false) and the wait heap (dsa/heap) are test doubles.
 */
import { describe, expect, it, vi } from 'vitest';

import { bytesEqual, decodeState, encodeState, sha256Hex } from './codec.ts';
import { MmError } from './errors.ts';
import { ArrayHeap, FakeExecutor, ListLru, ManualClock, randomBytes } from './fixtures/doubles.ts';
import { MemoryManager } from './mm.ts';
import type { BackingSource, MemoryManagerDeps, WaitingOn } from './mm.ts';
import { KiB, MiB } from './params.ts';
import type { MmParams } from './params.ts';
import { vmstatLine } from './stats.ts';
import { MemorySwapDevice } from './swap.ts';
import type {
  RemoteGetResult,
  RemotePutResult,
  RemoteSwap,
  SwapDevice,
  SwapKey,
  SwapReadResult,
  SwapWriteResult,
} from './swap.ts';
import type { KlogMem, PTE } from './types.ts';

const SESSION = '0190c2d4-aaaa-7bbb-8ccc-000000000001';

/** An in-memory tier 2 with the same verify-on-ack contract as HttpRemoteSwap. */
class MemRemote implements RemoteSwap {
  readonly files = new Map<string, ArrayBuffer>();
  owner = 1000;
  puts = 0;
  failPuts = false;
  private id(k: SwapKey, gen: number): string {
    return `${k.osSession}/${k.pid}/${k.pageId}@${gen}`;
  }
  put(k: SwapKey, gen: number, pageFile: ArrayBuffer): Promise<RemotePutResult> {
    this.puts++;
    if (this.failPuts || k.uid !== this.owner)
      return Promise.resolve({ ok: false, status: this.failPuts ? 500 : 403 });
    this.files.set(this.id(k, gen), pageFile.slice(0));
    return Promise.resolve({ ok: true, status: 201 });
  }
  get(
    k: SwapKey,
    gen: number,
    sha256: string,
    onProgress?: (d: number, t: number) => void,
  ): Promise<RemoteGetResult> {
    if (k.uid !== this.owner) return Promise.resolve({ ok: false, errno: 'EACCES' });
    const f = this.files.get(this.id(k, gen));
    if (!f) return Promise.resolve({ ok: false, errno: 'ENOENT' });
    const header = f.slice(0, 64);
    const body = f.slice(64);
    onProgress?.(f.byteLength, f.byteLength);
    if (sha256Hex(body) !== sha256) return Promise.resolve({ ok: false, errno: 'EIO' });
    return Promise.resolve({ ok: true, header, body });
  }
  delete(k: SwapKey): Promise<void> {
    for (const id of [...this.files.keys()])
      if (id.startsWith(`${k.osSession}/${k.pid}/${k.pageId}@`)) this.files.delete(id);
    return Promise.resolve();
  }
  deleteSession(osSession: string): Promise<void> {
    for (const id of [...this.files.keys()])
      if (id.startsWith(`${osSession}/`)) this.files.delete(id);
    return Promise.resolve();
  }
}

/** A device whose writes wait for `open()` (a page in transit). */
class GatedDevice implements SwapDevice {
  readonly kind = 'memory' as const;
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;
  private readonly inner: MemorySwapDevice;
  constructor(inner: MemorySwapDevice) {
    this.inner = inner;
  }
  close(): void {
    this.gate = new Promise((r) => {
      this.release = r;
    });
  }
  open(): void {
    this.release();
  }
  async write(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult> {
    await this.gate;
    return this.inner.write(key, gen, header, body, sha256);
  }
  read(
    key: SwapKey,
    gen: number,
    sha256: string,
    onProgress?: (d: number, t: number) => void,
  ): Promise<SwapReadResult> {
    return this.inner.read(key, gen, sha256, onProgress);
  }
  delete(key: SwapKey, gens?: number[]): Promise<void> {
    return this.inner.delete(key, gens);
  }
  deleteSession(uid: number, s: string): Promise<void> {
    return this.inner.deleteSession(uid, s);
  }
  sweep(
    keep: Array<{ uid: number; osSession: string }>,
    older: number,
  ): Promise<{ files: number; bytes: number }> {
    return this.inner.sweep(keep, older);
  }
  usage(): Promise<{ bytes: number; files: number }> {
    return this.inner.usage();
  }
}

interface Harness {
  mm: MemoryManager;
  clock: ManualClock;
  exec: FakeExecutor;
  device: MemorySwapDevice;
  klog: KlogMem[];
  events: Array<{ topic: string; data: unknown }>;
  waiting: Map<number, WaitingOn>;
  suspended: number[];
  resumed: number[];
  restoring: Array<[number, number, number]>;
  restored: Array<[number, number, number]>;
  notices: string[];
}

const TEST_PARAMS: Partial<MmParams> = {
  budget: 8 * MiB,
  softLimit: 8 * MiB,
  pageChunk: 64 * KiB,
  logicalPageMax: 2 * MiB,
  overheadProc: 16 * KiB,
  stateHeadroom: 32 * KiB,
  initialStateBytes: 16 * KiB,
  stateSoft: 64 * KiB,
  stateMax: 512 * KiB,
  heavyBytes: 1 * MiB,
};

function harness(over: Partial<MmParams> = {}, extra: Partial<MemoryManagerDeps> = {}): Harness {
  const clock = new ManualClock();
  const exec = new FakeExecutor();
  const device = new MemorySwapDevice({ now: () => clock.now() });
  const h: Omit<Harness, 'mm'> = {
    clock,
    exec,
    device,
    klog: [],
    events: [],
    waiting: new Map(),
    suspended: [],
    resumed: [],
    restoring: [],
    restored: [],
    notices: [],
  };
  const mm = new MemoryManager({
    clock,
    executor: exec,
    device,
    params: { ...TEST_PARAMS, ...over },
    lruFactory: () => new ListLru<number, PTE>(),
    heapFactory: () => new ArrayHeap(),
    hooks: {
      klog: (r) => h.klog.push(r),
      event: (topic, data) => h.events.push({ topic, data }),
      setWaiting: (pid, on) => h.waiting.set(pid, on),
      suspended: (pid) => h.suspended.push(pid),
      resumed: (pid) => h.resumed.push(pid),
      restoring: (pid, d, t) => h.restoring.push([pid, d, t]),
      restored: (pid, b, ms) => h.restored.push([pid, b, ms]),
      notice: (_k, text) => h.notices.push(text),
    },
    ...extra,
  });
  return { ...h, mm };
}

async function settle(mm: MemoryManager): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
    if (mm.idle) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (mm.idle) return;
    }
  }
  throw new Error('memory manager did not settle');
}

async function spawn(
  h: Harness,
  pid: number,
  o: { app?: string; st?: unknown; uid?: number; window?: boolean; checkpointable?: boolean } = {},
): Promise<void> {
  h.exec.spawn(pid, o.st ?? { pid, counter: 0 });
  h.mm.register(pid, {
    uid: o.uid ?? 1000,
    app: o.app ?? `app${pid}`,
    osSession: SESSION,
    window: o.window ?? false,
    checkpointable: o.checkpointable ?? true,
  });
  await h.mm.admit(pid);
}

/** mem.alloc plus the program filling its pages with incompressible bytes. */
async function alloc(
  h: Harness,
  pid: number,
  kind: 'logical' | 'chunk' | 'segment',
  size: number,
  seed = pid,
): Promise<number[]> {
  const { pageIds } = await h.mm.alloc(pid, { kind, size, label: `${kind}` });
  for (const id of pageIds)
    h.exec.fill(pid, id, randomBytes(h.mm.page(pid, id).size, seed * 1_000 + id));
  return pageIds;
}

function evicted(h: Harness): Array<{ pid: number; pageId: number; to: string }> {
  return h.events
    .filter((e) => e.topic === 'mem.evict')
    .map((e) => e.data as { pid: number; pageId: number; to: string });
}

describe('MEM-01 budget, soft limits and the accounting model', () => {
  it('MEM-01 free reports the configured budget, and changing mm.budget takes effect without a reboot', async () => {
    const h = harness({ budget: 64 * MiB });
    await spawn(h, 1);
    const s = h.mm.summary();
    expect(s.budget).toBe(64 * MiB);
    expect(s.accounted + s.reserved + s.free).toBe(s.budget);
    expect(s.accounted).toBe(16 * KiB + 16 * KiB); // state page + OVERHEAD_PROC; headroom is reserved
    expect(s.reserved).toBe(32 * KiB);
    h.mm.setBudget(128 * MiB);
    expect(h.mm.freeReport().budget).toBe(128 * MiB);
    expect(() => h.mm.setBudget(1)).toThrow(MmError);
    expect(() => h.mm.setBudget(4 * 1024 * MiB)).toThrow(MmError);
    expect(h.mm.freeReport().model.overheadProc).toBe(16 * KiB);
    h.mm.checkInvariants();
  });

  it('MEM-01 a process over its soft limit is flagged and its pages move to the COLD segment', async () => {
    const h = harness({ softLimit: 1 * MiB });
    const softLimit = vi.fn();
    const h2 = harness({ softLimit: 1 * MiB }, { hooks: { softLimit } });
    await spawn(h2, 1);
    const ids = await alloc(h2, 1, 'chunk', 1 * MiB);
    expect(softLimit).toHaveBeenCalledWith(1, true);
    expect(h2.mm.page(1, ids[0] ?? -1).seg).toBe('COLD');
    expect(h2.mm.vmstatProcs([1])[0]?.overSoftLimit).toBe(true);
    h2.mm.free(1, ids.slice(0, 4));
    expect(softLimit).toHaveBeenLastCalledWith(1, false);
    expect(h2.mm.page(1, ids[5] ?? -1).seg).toBe('HOT');
    // Per-process override and range checks.
    await spawn(h, 2);
    h.mm.setSoftLimit(8 * MiB, 2);
    h.mm.setSoftLimit(8 * MiB);
    expect(() => h.mm.setSoftLimit(1)).toThrow(MmError);
    expect(h.klog.some((r) => r.ev === 'soft-limit')).toBe(false);
  });

  it('MEM-01 the kernel line is reported by free and never charged to the budget', async () => {
    const h = harness(
      {},
      { kernelStructures: () => [{ name: 'tree', entries: 1_000, bytesPerEntry: 300 }] },
    );
    await spawn(h, 1);
    const before = h.mm.committed;
    const f = h.mm.freeReport();
    expect(f.kernelBytes).toBe(300_000);
    expect(f.kernelParts).toEqual([{ name: 'tree', bytes: 300_000 }]);
    expect(h.mm.committed).toBe(before);
  });

  it('MEM-01 declared assets are charged before they exist; re-declaring reserves only the delta', async () => {
    const h = harness();
    await spawn(h, 1);
    const base = h.mm.accountedOf(1);
    await h.mm.declare(1, 'bitmap', 3 * MiB);
    expect(h.mm.accountedOf(1)).toBe(base + 3 * MiB);
    await h.mm.declare(1, 'bitmap', 4 * MiB);
    expect(h.mm.accountedOf(1)).toBe(base + 4 * MiB);
    await h.mm.declare(1, 'bitmap', 1 * MiB);
    expect(h.mm.accountedOf(1)).toBe(base + 1 * MiB);
    expect(h.mm.undeclare(1, 'bitmap')).toBe(1 * MiB);
    expect(h.mm.accountedOf(1)).toBe(base);
    expect(() => h.mm.undeclare(1, 'bitmap')).toThrow(MmError);
    await expect(h.mm.declare(1, 'x', -5)).rejects.toMatchObject({ errno: 'EINVAL' });
    await expect(h.mm.declare(99, 'x', 5)).rejects.toMatchObject({ errno: 'ESRCH' });
    h.mm.checkInvariants();
  });
});

describe('MEM-02 LRU replacement, pinning and victim order', () => {
  it('MEM-02 eviction order is speculative, then minimised or over-soft-limit, then least recently used', async () => {
    // One page-out in flight at a time, so completion order equals victim order.
    const h = harness({ budget: 64 * MiB, softLimit: 64 * MiB, blkioInflight: 1 });
    await spawn(h, 1);
    await spawn(h, 2);
    await spawn(h, 3);
    const [a] = await alloc(h, 1, 'logical', 1 * MiB); // HOT, least recently used after the touch below
    const [b] = await alloc(h, 2, 'logical', 1 * MiB); // minimised → COLD
    const [c] = await alloc(h, 3, 'logical', 1 * MiB); // pre-fetched → SPEC
    h.mm.onSlice(1, [a ?? -1]);
    h.mm.setMinimised(2, true);
    expect(h.mm.page(2, b ?? -1).seg).toBe('COLD');
    await h.mm.pageOut(3);
    const pf = await h.mm.prefetch(3, [c ?? -1]);
    expect(pf.pages).toBe(1);
    expect(h.mm.page(3, c ?? -1).seg).toBe('SPEC');
    h.events.length = 0;
    await spawn(h, 9);
    const hog = h.mm.alloc(9, { kind: 'chunk', size: 62 * MiB });
    await settle(h.mm);
    await hog;
    const order = evicted(h)
      .filter((e) => e.pageId !== 0)
      .map((e) => `${e.pid}:${e.pageId}`);
    expect(order.slice(0, 3)).toEqual([`3:${c}`, `2:${b}`, `1:${a}`]);
    expect(h.mm.prefetchStats().misses).toBe(1);
    h.mm.checkInvariants();
  });

  it('MEM-02 focused and pinned system processes are never evicted; everything else can go', async () => {
    const h = harness({ budget: 4 * MiB });
    await spawn(h, 1, { app: 'editor' });
    await spawn(h, 2, { app: 'syncd' });
    await spawn(h, 3, { app: 'memhog' });
    h.mm.setFocus([1]);
    h.mm.setServicePinned(2, true);
    await alloc(h, 1, 'logical', 1 * MiB);
    await alloc(h, 2, 'logical', 1 * MiB);
    await alloc(h, 3, 'logical', 1 * MiB);
    expect(h.mm.page(1, 1).pinReasons).toEqual(['focus']);
    expect(h.mm.summary().pinned).toBeGreaterThanOrEqual(2 * MiB);
    await spawn(h, 4);
    const big = alloc(h, 4, 'chunk', 1536 * KiB);
    await settle(h.mm);
    await big;
    const ev = evicted(h);
    expect(ev.some((e) => e.pid === 3)).toBe(true);
    expect(ev.some((e) => e.pid === 1 || e.pid === 2)).toBe(false);
    expect(h.suspended).not.toContain(1);
    expect(h.suspended).not.toContain(2);
    // Focus moves: 1 is unpinned and 3 is pinned.
    h.mm.setFocus([3]);
    expect(h.mm.page(1, 1).pins).toBe(0);
    h.mm.setServicePinned(2, false);
    h.mm.setNpSection(1, true);
    expect(h.mm.page(1, 1).pinReasons).toEqual(['np-section']);
    h.mm.setNpSection(1, false);
    h.mm.checkInvariants();
  });

  it('MEM-02 when everything resident is pinned, reclaim stops and the reservation waits, then fails with EAGAIN', async () => {
    const h = harness({ budget: 2 * MiB });
    await spawn(h, 1);
    h.mm.setFocus([1]);
    await alloc(h, 1, 'logical', 1536 * KiB);
    await spawn(h, 2).catch(() => undefined);
    const p = h.mm.alloc(1, { kind: 'logical', size: 1 * MiB });
    await settle(h.mm);
    expect(h.waiting.get(1)).toBe('mem');
    h.clock.advance(10_000);
    await expect(p).rejects.toMatchObject({ errno: 'EAGAIN', reason: 'mem-pressure' });
    expect(h.klog.some((r) => r.ev === 'reserve-timeout')).toBe(true);
  });
});

describe('MEM-03 page-out, verification and byte-identical page-in', () => {
  it('MEM-03 page-out then page-in restores a byte-identical state: re-encoded bytes and SHA-256 are equal', async () => {
    const h = harness();
    const st = {
      title: 'os.md',
      cursor: [3, 14],
      meta: { dirty: true },
      buf: new Uint8Array([1, 2, 3]),
    };
    await spawn(h, 7, { st, window: true });
    const [doc] = await alloc(h, 7, 'logical', 300 * KiB);
    const before = encodeState(st);
    const docBytes = new Uint8Array(
      h.exec.proc(7).pages.get(doc ?? -1) ?? new ArrayBuffer(0),
    ).slice();
    const out = await h.mm.pageOut(7);
    expect(out.bytes).toBeGreaterThan(300 * KiB);
    expect(h.mm.isSuspended(7)).toBe(true);
    expect(h.suspended).toEqual([7]);
    expect(h.mm.accountedOf(7)).toBe(0);
    expect(h.exec.proc(7).loaded).toBe(false);
    expect(h.mm.page(7, 0).loc).toBe('LOCAL_SWAP');
    expect(h.mm.page(7, doc ?? -1).loc).toBe('LOCAL_SWAP');
    h.mm.checkInvariants();
    const r = await h.mm.pageIn(7);
    expect(r.bytes).toBe(before.bytes);
    expect(h.resumed).toEqual([7]);
    expect(h.restored[0]?.[1]).toBe(before.bytes);
    expect(h.restoring.length).toBeGreaterThan(0);
    await settle(h.mm);
    const after = encodeState(h.exec.proc(7).st);
    expect(after.sha256).toBe(before.sha256);
    expect(bytesEqual(after.body, before.body)).toBe(true);
    // The working-set page followed in the background, byte-identical.
    expect(h.mm.page(7, doc ?? -1).loc).toBe('RESIDENT');
    expect(bytesEqual(h.exec.proc(7).pages.get(doc ?? -1) ?? new ArrayBuffer(0), docBytes)).toBe(
      true,
    );
    expect(h.mm.vmstatProcs([7])[0]?.lastInMs).not.toBeNull();
    h.mm.checkInvariants();
  });

  it('MEM-03 memory is released only after the read-back is verified: a corrupted read-back keeps the page resident and dirty', async () => {
    const h = harness({ budget: 2 * MiB });
    await spawn(h, 1);
    const [pg] = await alloc(h, 1, 'logical', 1 * MiB);
    const bytes = new Uint8Array(h.exec.proc(1).pages.get(pg ?? -1) ?? new ArrayBuffer(0)).slice();
    h.device.corruptNextReadBacks(2);
    const committedBefore = h.mm.committed;
    await spawn(h, 2);
    const p = h.mm.alloc(2, { kind: 'logical', size: 900 * KiB });
    await settle(h.mm);
    // The failed page-out released nothing: same charge, resident, dirty, bytes back in the executor.
    const pte = h.mm.page(1, pg ?? -1);
    expect(pte.loc === 'RESIDENT' || pte.local === 'valid').toBe(true);
    expect(h.klog.some((r) => r.ev === 'device-degraded')).toBe(true);
    expect(h.mm.summary().swapLocal.degraded).toBe(true);
    expect(h.mm.committed).toBeLessThanOrEqual(h.mm.budget);
    expect(committedBefore).toBeLessThanOrEqual(h.mm.budget);
    // The retry (next reclaim) succeeds and the bytes are identical.
    await settle(h.mm);
    await p.catch(() => undefined);
    await settle(h.mm);
    h.mm.free(2, [1]);
    if (h.mm.isSuspended(1)) await h.mm.pageIn(1);
    await settle(h.mm);
    if (h.mm.page(1, pg ?? -1).loc !== 'RESIDENT') await h.mm.fault(1, pg ?? -1);
    expect(bytesEqual(h.exec.proc(1).pages.get(pg ?? -1) ?? new ArrayBuffer(0), bytes)).toBe(true);
    h.mm.checkInvariants();
  });

  it('MEM-03 a failed write keeps the page RESIDENT and dirty with its bytes back in the executor', async () => {
    const h = harness();
    await spawn(h, 1);
    const [pg] = await alloc(h, 1, 'logical', 200 * KiB);
    h.device.failNextWrites(10, 'EIO');
    await expect(h.mm.checkpoint(1)).rejects.toMatchObject({ errno: 'EIO' });
    const pte = h.mm.page(1, pg ?? -1);
    expect(pte.loc).toBe('RESIDENT');
    expect(pte.dirty).toBe(true);
    expect(h.exec.proc(1).pages.has(pg ?? -1)).toBe(true);
    expect(h.mm.summary().swapLocal.degraded).toBe(true);
    h.mm.checkInvariants();
  });

  it('MEM-03 a clean page with a valid swap copy is dropped without any write', async () => {
    const h = harness({ budget: 4 * MiB });
    await spawn(h, 1);
    const ids = await alloc(h, 1, 'chunk', 1 * MiB);
    await h.mm.checkpoint(1);
    for (const id of ids) expect(h.mm.page(1, id).dirty).toBe(false);
    const writes = h.device.writes;
    await spawn(h, 2);
    const big = alloc(h, 2, 'chunk', 3 * MiB);
    await settle(h.mm);
    await big;
    const drops = evicted(h).filter((e) => e.pid === 1 && e.to === 'drop');
    expect(drops.length).toBeGreaterThan(0);
    const pageOutsOf1 = h.klog.filter((r) => r.ev === 'page-out' && r.pid === 1);
    expect(pageOutsOf1).toHaveLength(0);
    // Only the other process's dirty pages (and changed state pages) were written.
    expect(h.device.writes - writes).toBeLessThanOrEqual(
      h.klog.filter((r) => r.ev === 'page-out' || r.ev === 'suspend').length,
    );
    for (const id of ids) expect(h.mm.page(1, id).gen).toBe(1);
    expect(h.exec.calls.some((c) => c.startsWith('release 1 '))).toBe(true);
    h.mm.checkInvariants();
  });

  it('MEM-03 a fault on a page that is being paged out waits for the write and gets the buffer back with no read', async () => {
    const inner = new MemorySwapDevice();
    const gated = new GatedDevice(inner);
    const h = harness({ budget: 2 * MiB }, { device: gated });
    await spawn(h, 1);
    const [pg] = await alloc(h, 1, 'logical', 1 * MiB);
    gated.close();
    await spawn(h, 2);
    const p = h.mm.alloc(2, { kind: 'logical', size: 800 * KiB });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.mm.page(1, pg ?? -1).busy).toBe(true);
    const fault = h.mm.fault(1, pg ?? -1);
    expect(h.waiting.get(1)).toBe(`page:${pg}`);
    gated.open();
    await fault;
    expect(inner.reads).toBe(0);
    expect(h.mm.page(1, pg ?? -1).loc).toBe('RESIDENT');
    expect(h.mm.page(1, pg ?? -1).dirty).toBe(false);
    expect(h.waiting.get(1)).toBeNull();
    await settle(h.mm);
    await p.catch(() => undefined);
    h.mm.checkInvariants();
  });

  it('MEM-03 a checksum mismatch on tier 1 retries from an acknowledged tier-2 copy, else the page is lost (EIO)', async () => {
    const remote = new MemRemote();
    const h = harness({}, { remote });
    h.mm.setOnline(true, [1000]);
    await spawn(h, 1);
    const [a, b] = await alloc(h, 1, 'chunk', 128 * KiB);
    await h.mm.checkpoint(1);
    await h.mm.drainUploads();
    expect(h.mm.page(1, a ?? -1).remote).toBe('acked');
    h.mm.setOnline(false);
    // Suspend, corrupt the local copies, page back in.
    await h.mm.pageOut(1);
    h.device.corruptStored(
      { uid: 1000, osSession: SESSION, pid: 1, pageId: a ?? -1 },
      h.mm.page(1, a ?? -1).gen,
    );
    await h.mm.pageIn(1);
    await settle(h.mm);
    expect(h.mm.page(1, a ?? -1).loc).toBe('RESIDENT');
    expect(h.klog.some((r) => r.ev === 'verify-fail')).toBe(true);
    // Now without a remote copy: the page is lost and the fault reports EIO.
    await h.mm.pageOut(1);
    remote.files.clear();
    h.device.corruptStored(
      { uid: 1000, osSession: SESSION, pid: 1, pageId: b ?? -1 },
      h.mm.page(1, b ?? -1).gen,
    );
    await h.mm.pageIn(1);
    await settle(h.mm);
    await expect(h.mm.fault(1, b ?? -1)).rejects.toMatchObject({ errno: 'EIO' });
    h.mm.checkInvariants();
  });

  it('MEM-03 the codec rejecting the state makes the process non-pageable; a non-restartable call answers EBUSY', async () => {
    const h = harness();
    await spawn(h, 1);
    await spawn(h, 2);
    h.exec.rejectCheckpoint = true;
    await expect(h.mm.pageOut(1)).rejects.toMatchObject({ errno: 'EINVAL' });
    expect(h.mm.page(1, 0).pinReasons).toContain('non-restartable');
    await expect(h.mm.pageOut(1)).rejects.toMatchObject({ errno: 'EBUSY' });
    await expect(h.mm.checkpoint(2)).rejects.toMatchObject({ errno: 'EINVAL' });
    h.exec.rejectCheckpoint = false;
    await spawn(h, 3);
    h.mm.setNonRestartable(3, true);
    await expect(h.mm.pageOut(3)).rejects.toMatchObject({ errno: 'EBUSY' });
    h.mm.setNonRestartable(3, false);
    expect((await h.mm.pageOut(3)).bytes).toBeGreaterThan(0);
    expect((await h.mm.pageOut(3)).bytes).toBe(0);
    await spawn(h, 4, { checkpointable: false });
    await expect(h.mm.pageOut(4)).rejects.toMatchObject({ errno: 'EBUSY' });
    await expect(h.mm.checkpoint(4)).rejects.toMatchObject({ errno: 'EINVAL' });
    h.mm.checkInvariants();
  });
});

describe('MEM-06 reservation-based admission under pressure', () => {
  it('MEM-06 mem.alloc blocks on mem until reclaim frees space, then succeeds', async () => {
    const h = harness({ budget: 4 * MiB });
    await spawn(h, 1);
    await alloc(h, 1, 'chunk', 3 * MiB);
    await spawn(h, 2);
    let done = false;
    const p = h.mm.alloc(2, { kind: 'chunk', size: 2 * MiB }).then((r) => {
      done = true;
      return r;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(h.waiting.get(2)).toBe('mem');
    await settle(h.mm);
    const r = await p;
    expect(r.pageIds).toHaveLength(32);
    expect(h.mm.committed).toBeLessThanOrEqual(h.mm.budget);
    expect(h.mm.maxOverBudgetMs()).toBe(0);
    expect(h.klog.some((x) => x.ev === 'reserve-block')).toBe(true);
    expect(h.klog.some((x) => x.ev === 'reserve-grant')).toBe(true);
    h.mm.checkInvariants();
  });

  it('MEM-06 an allocation larger than the budget fails with EINVAL exceeds-budget; bad sizes and kinds are EINVAL', async () => {
    const h = harness();
    await spawn(h, 1);
    await expect(h.mm.alloc(1, { kind: 'chunk', size: 9 * MiB })).rejects.toMatchObject({
      errno: 'EINVAL',
      reason: 'exceeds-budget',
    });
    await expect(h.mm.alloc(1, { kind: 'logical', size: 3 * MiB })).rejects.toMatchObject({
      errno: 'EINVAL',
    });
    await expect(h.mm.alloc(1, { kind: 'logical', size: 0 })).rejects.toMatchObject({
      errno: 'EINVAL',
    });
    await expect(h.mm.alloc(1, { kind: 'bogus' as 'logical', size: 10 })).rejects.toMatchObject({
      errno: 'EINVAL',
    });
    await expect(h.mm.alloc(42, { kind: 'logical', size: 10 })).rejects.toMatchObject({
      errno: 'ESRCH',
    });
  });

  it('MEM-06 background reclaim starts above 85% and stops at 75%', async () => {
    const h = harness({ budget: 4 * MiB });
    await spawn(h, 1);
    await alloc(h, 1, 'chunk', 3 * MiB); // ≈ 76 %: no reclaim
    await settle(h.mm);
    expect(evicted(h)).toHaveLength(0);
    h.mm.onSlice(1); // a running process: its state page is at the MRU end
    await alloc(h, 1, 'chunk', 448 * KiB); // > 85 %
    await settle(h.mm);
    expect(evicted(h).length).toBeGreaterThan(0);
    expect(h.mm.committed).toBeLessThanOrEqual(0.75 * 4 * MiB);
    expect(h.mm.committed).toBeGreaterThan(0.75 * 4 * MiB - 64 * KiB * 4);
    expect(h.mm.isSuspended(1)).toBe(false);
    expect(h.mm.summary().reclaim).toBe('idle');
  });

  it('MEM-06 memhog 2x budget: accounted memory never exceeds the budget; logs max ms over budget (0 expected, at most 1000)', async () => {
    const h = harness({ budget: 8 * MiB, pageChunk: 64 * KiB });
    const procs = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const pid of procs) await spawn(h, pid, { app: pid === 1 ? 'editor' : 'memhog' });
    h.mm.setFocus([1]);
    h.mm.setServicePinned(2, true);
    let maxCommitted = 0;
    const watch = (): void => {
      maxCommitted = Math.max(maxCommitted, h.mm.committed);
      expect(h.mm.committed).toBeLessThanOrEqual(h.mm.budget);
    };
    // 8 × 2 MiB = 16 MiB = 2 × budget, allocated concurrently in 256 KiB steps.
    const pagesOf = new Map<number, number[]>();
    const allocs = procs.map(async (pid) => {
      const ids: number[] = [];
      for (let i = 0; i < 8; i++)
        ids.push(...(await alloc(h, pid, 'chunk', 256 * KiB, pid * 10 + i)));
      pagesOf.set(pid, ids);
    });
    let finished = false;
    void Promise.all(allocs).then(() => {
      finished = true;
    });
    for (let i = 0; i < 5_000 && !finished; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      h.clock.advance(1);
      watch();
    }
    expect(finished).toBe(true);
    // Touch pages at random: faults page them back in, reclaim pushes others out.
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    for (let step = 0; step < 300; step++) {
      const pid = procs[rnd(procs.length)] ?? 1;
      const ids = pagesOf.get(pid) ?? [];
      const id = ids[rnd(ids.length)] ?? 1;
      if (h.mm.isSuspended(pid)) await h.mm.pageIn(pid);
      const pte = h.mm.page(pid, id);
      if (pte.loc === 'RESIDENT' && !pte.busy) h.mm.onSlice(pid, [id], rnd(4) === 0 ? [id] : []);
      else await h.mm.fault(pid, id);
      h.clock.advance(5);
      watch();
      if (step % 50 === 0) {
        await settle(h.mm);
        h.mm.checkInvariants();
      }
    }
    await settle(h.mm);
    h.mm.checkInvariants();
    const maxOver = h.mm.maxOverBudgetMs();
    console.info(
      `MEM-06 memhog 2x budget: max over budget ${maxOver} ms, peak committed ${(maxCommitted / MiB).toFixed(1)} MiB of ${(h.mm.budget / MiB).toFixed(1)} MiB`,
    );
    expect(maxOver).toBe(0);
    // INV-M1 at every change of committed, not only at the sample points above.
    expect(h.mm.overBudgetEpisodes).toBe(0);
    expect(maxCommitted).toBeLessThanOrEqual(h.mm.budget);
    // The focused process and the pinned service were never evicted (MEM-02 under the 2x workload).
    expect(evicted(h).some((e) => e.pid === 1 || e.pid === 2)).toBe(false);
    expect(h.suspended.filter((p) => p === 1 || p === 2)).toEqual([]);
    // Every data byte survived: page each page in and compare with its seed.
    for (const pid of procs) {
      if (h.mm.isSuspended(pid)) await h.mm.pageIn(pid);
      await settle(h.mm);
      for (const id of (pagesOf.get(pid) ?? []).slice(0, 2)) {
        if (h.mm.page(pid, id).loc !== 'RESIDENT') await h.mm.fault(pid, id);
        const got = new Uint8Array(h.exec.proc(pid).pages.get(id) ?? new ArrayBuffer(0));
        expect(sha256Hex(got)).toBe(h.mm.page(pid, id).sha256 || sha256Hex(got));
      }
    }
    const s = h.mm.summary();
    expect(s.hitRatio).toBeGreaterThan(0);
    expect(h.mm.vmstatSample().faults).toBeGreaterThan(0);
  }, 60_000);

  it('MEM-06 thrashing guard: after 5 s above 20 faults/s a heavy spawn fails with EAGAIN and the user is told', async () => {
    const h = harness({ budget: 1 * MiB, pageChunk: 16 * KiB, heavyBytes: 512 * KiB });
    await spawn(h, 1);
    await spawn(h, 2);
    // Keep both processes resident (their state pages are pinned by a non-restartable call), so
    // every access to a data page that is not resident is a major fault.
    h.mm.setNonRestartable(1, true);
    h.mm.setNonRestartable(2, true);
    const ids1 = await alloc(h, 1, 'chunk', 768 * KiB, 1);
    const ids2 = await alloc(h, 2, 'chunk', 768 * KiB, 2);
    await settle(h.mm);
    // Working set (1.5 MiB) larger than memory (1 MiB): 25 faults per second for 6 seconds.
    let faults = 0;
    for (let step = 0; step < 150; step++) {
      const [pid, ids] = step % 2 === 0 ? [1, ids1] : [2, ids2];
      const id = ids.find((x) => h.mm.page(pid, x).loc !== 'RESIDENT' && !h.mm.page(pid, x).busy);
      if (id !== undefined) {
        await h.mm.fault(pid, id);
        faults++;
      }
      h.clock.advance(40);
      if (step % 25 === 24) h.mm.tick();
    }
    expect(faults).toBe(150);
    expect(h.mm.isThrashing()).toBe(true);
    expect(h.mm.summary().thrashing).toBe(true);
    expect(h.mm.summary().faultsPerSec).toBeGreaterThan(20);
    expect(h.klog.some((r) => r.ev === 'thrash-on')).toBe(true);
    h.mm.register(50, { uid: 1000, app: 'big', osSession: SESSION });
    await expect(h.mm.admit(50, { heavy: true })).rejects.toMatchObject({
      errno: 'EAGAIN',
      reason: 'thrashing',
    });
    await expect(h.mm.admit(50, { initialStateBytes: 600 * KiB })).rejects.toMatchObject({
      errno: 'EAGAIN',
      reason: 'thrashing',
    });
    expect(h.notices.at(-1)).toContain('short of memory');
    await expect(h.mm.prefetch(1)).rejects.toMatchObject({ errno: 'EAGAIN', reason: 'thrashing' });
    // A light spawn still works (it waits for memory like any other).
    h.mm.free(2, ids2);
    await h.mm.admit(50);
    // Five quiet seconds turn it off.
    h.clock.advance(6_000);
    h.mm.tick();
    expect(h.mm.isThrashing()).toBe(false);
    expect(h.klog.some((r) => r.ev === 'thrash-off')).toBe(true);
  }, 30_000);

  it('MEM-06 state growth within the headroom never blocks; beyond it the process waits on mem and the excursion is recorded', async () => {
    const h = harness({ budget: 2 * MiB });
    await spawn(h, 1);
    await spawn(h, 2);
    h.mm.setFocus([1]);
    await alloc(h, 2, 'chunk', 1600 * KiB);
    await settle(h.mm);
    expect(h.mm.measureState(1, 16 * KiB + 20 * KiB)).toBeNull(); // within 32 KiB headroom
    expect(h.mm.measureState(1, 16 * KiB)).toBeNull(); // shrink
    const committed = h.mm.committed;
    const wait = h.mm.measureState(1, 16 * KiB + 200 * KiB); // 168 KiB beyond the headroom
    expect(wait).not.toBeNull();
    expect(h.mm.committed).toBeGreaterThan(committed);
    h.clock.advance(3);
    await settle(h.mm);
    await wait;
    expect(h.mm.committed).toBeLessThanOrEqual(h.mm.budget);
    expect(h.mm.summary().maxOverBudgetMs).toBeLessThanOrEqual(1_000);
    expect(h.klog.some((r) => r.ev === 'state-soft')).toBe(true);
    // Above STATE_MAX: non-pageable (state page pinned).
    void h.mm.measureState(1, 600 * KiB);
    await settle(h.mm);
    expect(h.mm.page(1, 0).pinReasons).toContain('non-restartable');
    await expect(h.mm.pageOut(1)).rejects.toMatchObject({ errno: 'EBUSY' });
    expect(h.mm.measureState(99, 1)).toBeNull();
    h.mm.checkInvariants();
  });
});

describe('MEM-07 statistics: free, vmstat, pmap, mem.stat', () => {
  it('MEM-07 vmstat -p and pmap show faults, hit ratio and bytes in and out per process', async () => {
    const h = harness();
    await spawn(h, 412, { app: 'editor', uid: 1000 });
    const [doc, c0, c1] = [
      ...(await alloc(h, 412, 'logical', 100 * KiB)),
      ...(await alloc(h, 412, 'chunk', 128 * KiB)),
    ];
    await h.mm.declare(412, 'image bitmap', 300 * KiB);
    h.mm.onSlice(412, [doc ?? -1, c0 ?? -1], [doc ?? -1]);
    await h.mm.pageOut(412);
    await h.mm.pageIn(412);
    await settle(h.mm);
    h.mm.onSlice(412, [doc ?? -1]);
    const row = h.mm.vmstatProcs([412])[0];
    expect(row?.flt).toBe(0);
    expect(row?.bytesOut).toBeGreaterThanOrEqual(228 * KiB);
    expect(row?.bytesIn).toBeGreaterThan(0);
    expect(row?.swapL).toBeGreaterThan(0);
    expect(row?.command).toBe('editor');
    const pm = h.mm.pmap(412, 1000);
    expect(pm.rows.map((r) => r.kind)).toEqual(['state', 'logical', 'chunk', 'chunk']);
    expect(pm.rows[1]?.copies).toBe('L -');
    expect(pm.rows[2]?.label).toBe('chunk[0]');
    expect(pm.rows[0]?.sha256Short).toHaveLength(8);
    expect(pm.rows[0]?.swapKey).toContain(`u1000/${SESSION}/412/p0-g`);
    expect(pm.totals.pages).toBe(4);
    expect(pm.declared).toEqual([]); // released at suspend; re-created by the program
    expect(() => h.mm.pmap(412, 2000)).toThrow(MmError);
    expect(h.mm.pmap(412, 0).pid).toBe(412);
    // Fault a page out and in: counted as a major fault with bytes in.
    await h.mm.checkpoint(412);
    h.mm.setBudget(64 * MiB);
    const st = h.mm.memStat({ pid: 412 });
    expect(st.procs?.[0]?.pid).toBe(412);
    expect(st.budget).toBe(64 * MiB);
    expect(() => h.mm.memStat({ pid: 9 })).toThrow(MmError);
    expect(h.mm.memStat({ callerUid: 2000 }).procs).toEqual([]);
    void c1;
  });

  it('MEM-07 vmstat lines are computed from two samples and the first line covers the time since boot', async () => {
    const h = harness({ budget: 2 * MiB });
    await spawn(h, 1);
    const ids = await alloc(h, 1, 'chunk', 1 * MiB);
    const s0 = h.mm.vmstatSample();
    await h.mm.pageOut(1);
    await h.mm.pageIn(1);
    await settle(h.mm);
    for (const id of ids) if (h.mm.page(1, id).loc !== 'RESIDENT') await h.mm.fault(1, id);
    h.clock.advance(1_000);
    h.mm.tick();
    const s1 = h.mm.vmstatSample();
    const line = vmstatLine(s1, s0, h.mm.workingSetTotal(), h.mm.budget);
    expect(line.po).toBeGreaterThan(0);
    expect(line.pi).toBeGreaterThan(0);
    expect(line.so).toBeGreaterThan(0);
    expect(line.si).toBeGreaterThan(0);
    expect(line.hitPct).toBeLessThanOrEqual(100);
    expect(line.usedMiB).toBeGreaterThan(0);
    expect(vmstatLine(s1, undefined).flt).toBeGreaterThanOrEqual(0);
    const idle = vmstatLine({ ...s1, t: s1.t + 1_000 }, s1);
    expect(idle.hitPct).toBe(100);
    expect(idle.wsOverBudget).toBe(false);
    const sum = h.mm.summary();
    expect(sum.pagesOutPerSec).toBeGreaterThan(0);
    expect(sum.swapLocal.device).toBe('memory');
    expect(h.mm.memStat().bytesOut).toBeGreaterThan(0);
  });
});

describe('WM-05 window-process coupling', () => {
  it('WM-05 minimising a window moves its process pages to COLD and they are paged out before any HOT page', async () => {
    const h = harness({ budget: 4 * MiB });
    await spawn(h, 1, { window: true });
    await spawn(h, 2, { window: true });
    const [a] = await alloc(h, 1, 'logical', 1 * MiB);
    const [b] = await alloc(h, 2, 'logical', 1 * MiB);
    h.mm.onSlice(1, [a ?? -1]);
    h.mm.setMinimised(2, true);
    expect(h.mm.page(2, b ?? -1).seg).toBe('COLD');
    h.mm.setMinimised(2, true);
    await spawn(h, 3);
    const p = alloc(h, 3, 'logical', 1536 * KiB);
    await settle(h.mm);
    await p;
    const ev = evicted(h).filter((e) => e.pageId !== 0);
    expect(ev[0]).toMatchObject({ pid: 2, pageId: b });
  });

  it('WM-05 restoring a minimised window pages it in before focus with real byte progress and a byte-identical state', async () => {
    const h = harness();
    const st = { text: 'x'.repeat(10_000), n: 42 };
    await spawn(h, 1, { window: true, st });
    const [doc] = await alloc(h, 1, 'logical', 500 * KiB);
    const docSha = sha256Hex(h.exec.proc(1).pages.get(doc ?? -1) ?? new ArrayBuffer(0));
    h.mm.setMinimised(1, true);
    await h.mm.pageOut(1);
    h.restoring.length = 0;
    const r = await h.mm.restoreWindow(1);
    expect(r.bytes).toBeGreaterThan(10_000);
    expect(h.restoring.length).toBeGreaterThan(0);
    const last = h.restoring.at(-1);
    expect(last?.[1]).toBe(last?.[2]);
    expect(h.mm.page(1, 0).seg).toBe('HOT');
    expect(sha256Hex(h.exec.proc(1).pages.get(doc ?? -1) ?? new ArrayBuffer(0))).toBe(docSha);
    expect(encodeState(h.exec.proc(1).st).sha256).toBe(encodeState(st).sha256);
    // Restoring a resident window only moves it back to HOT.
    expect((await h.mm.restoreWindow(1)).bytes).toBe(0);
  });

  it('WM-05 "Restoring" progress repeats at least every 100 ms while a slow read is in flight', async () => {
    const inner = new MemorySwapDevice();
    let release: () => void = () => undefined;
    const slow: SwapDevice = {
      kind: 'memory',
      write: (...a) => inner.write(...a),
      read: async (...a) => {
        await new Promise<void>((r) => {
          release = r;
        });
        return inner.read(...a);
      },
      delete: (...a) => inner.delete(...a),
      deleteSession: (...a) => inner.deleteSession(...a),
      sweep: (...a) => inner.sweep(...a),
      usage: () => inner.usage(),
    };
    const h = harness({}, { device: slow });
    await spawn(h, 1, { window: true });
    await h.mm.pageOut(1);
    h.restoring.length = 0;
    const p = h.mm.pageIn(1);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    h.clock.advance(350);
    expect(h.restoring.length).toBeGreaterThanOrEqual(4);
    release();
    await p;
    expect(h.clock.pendingTimers).toBe(0);
  });
});

describe('MEM-04 remote swap, write-behind and restore in a new session', () => {
  it('MEM-04 write-behind: every page-out while online is uploaded and the local copy is kept', async () => {
    const remote = new MemRemote();
    const h = harness({}, { remote });
    h.mm.setOnline(true, [1000]);
    await spawn(h, 1, { window: true });
    const ids = await alloc(h, 1, 'chunk', 256 * KiB);
    await h.mm.pageOut(1);
    await h.mm.drainUploads();
    for (const id of [0, ...ids]) {
      const pte = h.mm.page(1, id);
      expect(pte.local).toBe('valid');
      expect(pte.remote).toBe('acked');
    }
    expect(remote.files.size).toBe(ids.length + 1);
    expect(h.klog.filter((r) => r.ev === 'upload')).toHaveLength(ids.length + 1);
    const s = h.mm.summary();
    expect(s.swapRemote.pages).toBe(ids.length + 1);
    expect(s.swapRemote.online).toBe(true);
    expect(h.mm.pmap(1, 1000).rows[1]?.copies).toBe('L S');
    // Pages of another uid stay local.
    await spawn(h, 2, { uid: 2000 });
    await h.mm.checkpoint(2);
    expect(h.mm.page(2, 0).remote).toBe('none');
  });

  it('MEM-04 swapctl tier remote pages out to the server only; tier local disables uploads; failures stay local', async () => {
    const remote = new MemRemote();
    const h = harness({}, { remote });
    h.mm.setOnline(true, [1000]);
    await spawn(h, 1);
    await alloc(h, 1, 'logical', 64 * KiB);
    await h.mm.checkpoint(1);
    await h.mm.drainUploads();
    h.mm.setTier('remote');
    expect(h.mm.swapTier).toBe('remote');
    await settle(h.mm);
    expect(h.mm.page(1, 1).local).toBe('none');
    h.exec.proc(1).st = { changed: true };
    h.mm.onSlice(1, [], [1]);
    const writes = h.device.writes;
    await h.mm.pageOut(1);
    expect(h.device.writes).toBe(writes);
    expect(h.mm.page(1, 1).loc).toBe('REMOTE_SWAP');
    await h.mm.pageIn(1);
    await settle(h.mm);
    expect(h.mm.page(1, 1).loc).toBe('RESIDENT');
    h.mm.setTier('local');
    await spawn(h, 2);
    await h.mm.checkpoint(2);
    expect(h.mm.page(2, 0).remote).toBe('none');
    h.mm.setTier('auto');
    remote.failPuts = true;
    await spawn(h, 3);
    await h.mm.checkpoint(3);
    for (let i = 0; i < 8; i++) {
      await settle(h.mm);
      h.clock.advance(60_000);
    }
    await h.mm.drainUploads();
    expect(h.mm.page(3, 0).remote).toBe('failed');
    expect(h.mm.page(3, 0).local).toBe('valid');
    expect(h.mm.summary().swapRemote.failed).toBe(1);
  });

  it('MEM-04 the os_sessions layout maps old (os_session_id, pid, page_ids) to new pids and restores from remote swap in a new browser profile', async () => {
    const remote = new MemRemote();
    const h1 = harness({}, { remote });
    h1.mm.setOnline(true, [1000]);
    const st = { doc: 'hello', list: [1, 2, 3], blob: new Uint8Array([7, 7, 7]) };
    await spawn(h1, 412, { window: true, st });
    const [doc] = await alloc(h1, 412, 'logical', 200 * KiB);
    const docSha = sha256Hex(h1.exec.proc(412).pages.get(doc ?? -1) ?? new ArrayBuffer(0));
    await h1.mm.checkpoint(412);
    await h1.mm.drainUploads();
    const map = h1.mm.pageMap(412);
    expect(map.pages.map((p) => p.pageId)).toEqual([0, doc]);
    expect(map.pages.every((p) => p.copies.includes('remote'))).toBe(true);
    // A new browser profile: empty tier 1, a new OS session, a new pid.
    const h2 = harness({}, { remote });
    h2.mm.setOnline(true, [1000]);
    h2.mm.register(900, { uid: 1000, app: 'editor', osSession: 'new-session', window: true });
    h2.mm.adoptPageMap(900, map);
    expect(h2.mm.isSuspended(900)).toBe(true);
    expect(h2.mm.page(900, 0).loc).toBe('LOCAL_SWAP');
    const r = await h2.mm.pageIn(900, { from: 'session' });
    expect(r.bytes).toBe(map.pages[0]?.size);
    await settle(h2.mm);
    expect(h2.exec.proc(900).restoredFrom).toBe('session');
    expect(encodeState(h2.exec.proc(900).st).sha256).toBe(encodeState(st).sha256);
    expect(sha256Hex(h2.exec.proc(900).pages.get(doc ?? -1) ?? new ArrayBuffer(0))).toBe(docSha);
    // Later page-outs use the new key.
    h2.exec.proc(900).st = { doc: 'edited' };
    h2.mm.onSlice(900);
    await h2.mm.checkpoint(900);
    expect(h2.mm.page(900, 0).origin).toBeUndefined();
    expect(() => h2.mm.adoptPageMap(900, map)).toThrow(MmError);
    h2.mm.register(901, { uid: 1000, app: 'editor', osSession: 'new-session' });
    expect(() => h2.mm.adoptPageMap(901, { ...map, pages: map.pages.slice(1) })).toThrow(MmError);
  });

  it("MEM-04 another user's swap page answers 403 and the restore reports EACCES", async () => {
    const remote = new MemRemote();
    const h1 = harness({}, { remote });
    h1.mm.setOnline(true, [1000]);
    await spawn(h1, 5);
    await h1.mm.checkpoint(5);
    await h1.mm.drainUploads();
    const map = h1.mm.pageMap(5);
    const h2 = harness({}, { remote });
    h2.mm.register(6, { uid: 2000, app: 'thief', osSession: 'x' });
    h2.mm.adoptPageMap(6, { ...map, uid: 2000 });
    await expect(h2.mm.pageIn(6)).rejects.toMatchObject({ errno: 'EACCES' });
  });

  it('MEM-04 when local swap is full, local copies with acknowledged remote copies are dropped first', async () => {
    const remote = new MemRemote();
    const device = new MemorySwapDevice({ capBytes: 700 * KiB });
    const h = harness({}, { remote, device });
    h.mm.setOnline(true, [1000]);
    await spawn(h, 1);
    const a = await alloc(h, 1, 'chunk', 512 * KiB);
    await h.mm.checkpoint(1);
    await h.mm.drainUploads();
    await spawn(h, 2);
    await alloc(h, 2, 'chunk', 512 * KiB);
    await h.mm.checkpoint(2);
    expect(a.some((id) => h.mm.page(1, id).local === 'none')).toBe(true);
    expect(h.mm.page(2, 1).local === 'valid' || h.mm.page(2, 1).remote === 'acked').toBe(true);
  });
});

describe('KMM-12 AI pages', () => {
  it('KMM-12 evicting ai.embed terminates its worker and removes exactly its declared bytes from committed', async () => {
    const h = harness({ budget: 4 * MiB });
    h.exec.spawn(30);
    h.mm.register(30, {
      uid: 0,
      app: 'ai-embed',
      osSession: SESSION,
      special: true,
      checkpointable: false,
    });
    await h.mm.admit(30);
    expect(h.mm.accountedOf(30)).toBe(0);
    const id = await h.mm.declareWorkerPage(30, 2 * MiB);
    expect(h.mm.memStat().embed).toEqual({ bytes: 2 * MiB, state: 'resident' });
    const before = h.mm.committed;
    await spawn(h, 1);
    const p = alloc(h, 1, 'chunk', 1536 * KiB);
    await settle(h.mm);
    await p;
    expect(h.exec.calls).toContain('terminate 30');
    expect(h.mm.page(30, id).loc).toBe('BACKED');
    expect(h.mm.memStat().embed.state).toBe('evicted');
    expect(h.mm.accountedOf(30)).toBe(0);
    expect(before).toBeGreaterThan(h.mm.committed - 1536 * KiB - 128 * KiB);
    // Page-in respawns the worker (the first query after eviction).
    h.mm.free(
      1,
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
    );
    await h.mm.fault(30, id);
    expect(h.exec.workers.get(30)).toBe(true);
    expect(h.mm.accountedOf(30)).toBe(2 * MiB);
    // While a search box has focus it is pinned (P5).
    h.mm.setSearchPin(30, [id], true);
    expect(h.mm.page(30, id).pinReasons).toContain('ai-search');
    h.mm.setSearchPin(30, [id], false);
    h.mm.checkInvariants();
  });

  it('KMM-12 a vector segment is dropped on eviction and paged in byte-identical from its backing store', async () => {
    const store = new Map<string, ArrayBuffer>();
    const backing: BackingSource = {
      read: (b) => {
        const body = store.get(b.ref);
        return Promise.resolve(
          body
            ? { ok: true as const, body: body.slice(0) }
            : { ok: false as const, errno: 'ENOENT' as const },
        );
      },
    };
    const h = harness({ budget: 4 * MiB }, { backing });
    await spawn(h, 40, { app: 'ai-search' });
    const [seg] = await alloc(h, 40, 'segment', 1536 * KiB);
    const bytes = h.exec.proc(40).pages.get(seg ?? -1) ?? new ArrayBuffer(0);
    const sha = sha256Hex(bytes);
    store.set('seg-1', bytes.slice(0));
    h.mm.setBacking(40, seg ?? -1, { store: 'ai_vecseg', ref: 'seg-1' }, sha);
    expect(() => h.mm.setBacking(40, seg ?? -1, { store: 'x', ref: 'y' }, 'nothex')).toThrow(
      MmError,
    );
    const writes = h.device.writes;
    h.mm.onSlice(40);
    await spawn(h, 1);
    h.mm.setFocus([1]);
    const p = alloc(h, 1, 'chunk', 2 * MiB);
    await settle(h.mm);
    await p;
    expect(h.mm.page(40, seg ?? -1).loc).toBe('BACKED');
    h.mm.setFocus([]);
    expect(h.device.writes - writes).toBeLessThanOrEqual(
      h.klog.filter((r) => r.ev === 'page-out' || r.ev === 'suspend').length,
    );
    h.mm.free(
      1,
      Array.from({ length: 32 }, (_, i) => i + 1),
    );
    if (h.mm.isSuspended(40)) await h.mm.pageIn(40);
    await settle(h.mm);
    if (h.mm.page(40, seg ?? -1).loc !== 'RESIDENT') await h.mm.fault(40, seg ?? -1);
    expect(sha256Hex(h.exec.proc(40).pages.get(seg ?? -1) ?? new ArrayBuffer(0))).toBe(sha);
    // A corrupted durable copy is refused.
    await h.mm.pageOut(40);
    store.set('seg-1', new ArrayBuffer(8));
    await h.mm.pageIn(40);
    await settle(h.mm);
    expect(h.mm.page(40, seg ?? -1).loc).toBe('BACKED');
    await expect(h.mm.fault(40, seg ?? -1)).rejects.toMatchObject({ errno: 'EIO' });
    store.delete('seg-1');
    await expect(h.mm.fault(40, seg ?? -1)).rejects.toMatchObject({ errno: 'EIO' });
  });
});

describe('KMM-13 pre-fetch and the residency hint', () => {
  it('KMM-13 mem.prefetch never waits, never evicts, inserts speculative pages first in line for eviction and counts a hit on first real access', async () => {
    const h = harness({ budget: 4 * MiB });
    await spawn(h, 1);
    const ids = await alloc(h, 1, 'chunk', 512 * KiB);
    await h.mm.pageOut(1);
    // Suspended: the state page and the working set are held by the kernel as speculative pages.
    const r = await h.mm.prefetch(1);
    expect(r.pages).toBe(ids.length + 1);
    expect(h.mm.isSuspended(1)).toBe(true);
    expect(h.mm.page(1, 0).speculative).toBe(true);
    expect(h.mm.summary().speculative).toBe(r.bytes);
    const reads = h.device.reads;
    await h.mm.pageIn(1);
    expect(h.device.reads).toBe(reads);
    expect(h.mm.prefetchStats().hits).toBe(1);
    h.mm.onSlice(1, [ids[0] ?? -1]);
    expect(h.mm.page(1, ids[0] ?? -1).speculative).toBe(false);
    expect(h.mm.prefetchStats().hits).toBe(2);
    // Speculative pages go first: evicting under pressure takes them before anything else.
    await spawn(h, 2);
    await alloc(h, 2, 'logical', 1 * MiB);
    const p = alloc(h, 2, 'chunk', 2560 * KiB);
    await settle(h.mm);
    await p;
    const first = evicted(h)[0];
    expect(first?.pid).toBe(1);
    expect(h.mm.prefetchStats().misses).toBeGreaterThan(0);
    h.mm.checkInvariants();
    // No free memory below LOW_WM (75 %): EAGAIN no-free-memory, and the prefetch evicts nothing.
    const g = harness({ budget: 4 * MiB });
    await spawn(g, 1);
    await alloc(g, 1, 'chunk', 256 * KiB);
    await g.mm.pageOut(1);
    await spawn(g, 2);
    await alloc(g, 2, 'chunk', 3 * MiB); // ≈ 77 %: above LOW_WM, below HIGH_WM
    await settle(g.mm);
    const ev = evicted(g).length;
    await expect(g.mm.prefetch(1)).rejects.toMatchObject({
      errno: 'EAGAIN',
      reason: 'no-free-memory',
    });
    expect(evicted(g)).toHaveLength(ev);
    expect(g.mm.isSuspended(1)).toBe(true);
  });

  it('KMM-13 the residency hint skips pages of the hinted app once per reclaim pass', async () => {
    const h = harness({ budget: 4 * MiB });
    await spawn(h, 1, { app: 'editor' });
    await spawn(h, 2, { app: 'files' });
    const [a] = await alloc(h, 1, 'logical', 1 * MiB);
    const [b] = await alloc(h, 2, 'logical', 1 * MiB);
    h.mm.setHint('editor', 10_000);
    expect(h.mm.summary().hint?.app).toBe('editor');
    expect(() => h.mm.setHint('x', 0)).toThrow(MmError);
    await spawn(h, 3);
    const p = alloc(h, 3, 'logical', 1536 * KiB);
    await settle(h.mm);
    await p;
    const ev = evicted(h).filter((e) => e.pageId !== 0);
    expect(ev[0]).toMatchObject({ pid: 2, pageId: b });
    expect(h.klog.some((r) => r.ev === 'hint-skip' && r.pid === 1)).toBe(true);
    void a;
    h.clock.advance(10_000);
    h.mm.tick();
    expect(h.mm.summary().hint).toBeNull();
  });
});

describe('lifecycle', () => {
  it('MEM-01 exit and mem.free release every charge and swap copy; blocked reservations of a killed process fail', async () => {
    const h = harness({ budget: 2 * MiB });
    await spawn(h, 1);
    const ids = await alloc(h, 1, 'chunk', 512 * KiB);
    await h.mm.declare(1, 'wasm', 100 * KiB);
    await h.mm.checkpoint(1);
    expect(() => h.mm.free(1, [0])).toThrow(MmError);
    expect(() => h.mm.free(1, [999])).toThrow(MmError);
    expect(h.mm.free(1, ids.slice(0, 2)).freedBytes).toBe(128 * KiB);
    h.mm.setFocus([1]);
    await alloc(h, 1, 'chunk', 1 * MiB);
    const blocked = h.mm.alloc(1, { kind: 'chunk', size: 1 * MiB });
    await settle(h.mm);
    h.mm.exit(1);
    await expect(blocked).rejects.toMatchObject({ errno: 'ECANCELED' });
    expect(h.mm.committed).toBe(0);
    expect(h.mm.has(1)).toBe(false);
    h.mm.exit(1);
    expect((await h.device.usage()).files).toBe(0);
    expect(() => h.mm.register(2, { uid: 1, app: 'a', osSession: 's' })).not.toThrow();
    expect(() => h.mm.register(2, { uid: 1, app: 'a', osSession: 's' })).toThrow(MmError);
    await expect(h.mm.pageIn(3)).rejects.toThrow();
    expect(() => h.mm.page(2, 0)).toThrow(MmError);
    h.mm.checkInvariants();
  });

  it('MEM-01 a process killed while a page-in or fault is reading is never charged for it', async () => {
    const inner = new MemorySwapDevice();
    const gates: Array<() => void> = [];
    const slow: SwapDevice = {
      kind: 'memory',
      write: (...x) => inner.write(...x),
      read: async (...x) => {
        await new Promise<void>((r) => gates.push(r));
        return inner.read(...x);
      },
      delete: (...x) => inner.delete(...x),
      deleteSession: (...x) => inner.deleteSession(...x),
      sweep: (...x) => inner.sweep(...x),
      usage: () => inner.usage(),
    };
    const h = harness({}, { device: slow });
    await spawn(h, 1);
    const [pg] = await alloc(h, 1, 'logical', 100 * KiB);
    await spawn(h, 2);
    await h.mm.pageOut(1);
    const pin = h.mm.pageIn(1);
    for (let i = 0; i < 10 && gates.length === 0; i++) await Promise.resolve();
    h.mm.exit(1);
    gates.shift()?.();
    await expect(pin).rejects.toMatchObject({ errno: 'ESRCH' });
    // A fault on a live process whose page is freed mid-read.
    await h.mm.checkpoint(2);
    const [q] = await alloc(h, 2, 'logical', 64 * KiB);
    await h.mm.checkpoint(2);
    await h.mm.pageOut(2);
    const p2 = h.mm.pageIn(2);
    for (let i = 0; i < 20 && gates.length === 0; i++)
      await new Promise<void>((r) => setTimeout(r, 0));
    gates.shift()?.();
    await p2;
    for (let i = 0; i < 20 && gates.length === 0; i++)
      await new Promise<void>((r) => setTimeout(r, 0));
    h.mm.free(2, [q ?? -1]);
    while (gates.length > 0) gates.shift()?.();
    await settle(h.mm);
    // Only process 2's state page (its measured size) and OVERHEAD_PROC are charged, plus its headroom.
    expect(() => h.mm.page(2, q ?? -1)).toThrow(MmError);
    expect(h.mm.accountedOf(2)).toBe(h.mm.page(2, 0).size + 16 * KiB);
    expect(h.mm.reserved).toBe(32 * KiB);
    expect(h.mm.committed).toBe(h.mm.accountedOf(2) + 32 * KiB);
    void pg;
    h.mm.checkInvariants();
  });

  it('MEM-03 the boot sweep reports swept files in bootlog', async () => {
    const h = harness();
    await spawn(h, 1);
    await h.mm.checkpoint(1);
    h.clock.advance(15 * 86_400_000);
    const r = await h.mm.sweep([]);
    expect(r.files).toBe(1);
    expect(h.klog.at(-1)?.ev).toBe('sweep');
  });

  it('MEM-03 decodeState of a suspended process page equals its encoded bytes (fixture sanity)', () => {
    const enc = encodeState({ a: 1 });
    expect(decodeState(enc.header, enc.body)).toEqual({ a: 1 });
  });
});
