/**
 * TEST-ONLY doubles for the team-written structures (C16: dsa/lru and dsa/heap stay
 * IMPLEMENTED = false until their owner writes them; product code never uses these doubles).
 * They follow the documented semantics of dsa/src/lru/index.ts and dsa/src/heap/index.ts with
 * O(n) operations, which is fine for tests. Also: a manual clock and a fake executor.
 */
import type { DsaStats, IndexedMinHeap, LRU } from '@plotinium/dsa';

import { decodeState, encodeRaw, encodeState, sha256Hex } from '../codec.ts';
import type { CheckpointResult, ExecPage, MemExecutorPort } from '../mm.ts';
import type { MmClock } from '../reserve.ts';

const STATS: DsaStats = { size: 0, capacity: 0, bytesAllocated: 0, bytesUsed: 0 };

interface Slot<V> {
  value: V;
  pins: number;
  spec: boolean;
}

/** LRU<K, V> double: `order` holds the evictable keys, LRU first, MRU last. */
export class ListLru<K, V> implements LRU<K, V> {
  private readonly slots = new Map<K, Slot<V>>();
  private order: K[] = [];
  readonly capacity = undefined;

  private unlink(key: K): void {
    const i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
  }
  get(key: K): V | undefined {
    const s = this.slots.get(key);
    if (!s) return undefined;
    s.spec = false;
    if (s.pins === 0) {
      this.unlink(key);
      this.order.push(key);
    }
    return s.value;
  }
  peek(key: K): V | undefined {
    return this.slots.get(key)?.value;
  }
  has(key: K): boolean {
    return this.slots.has(key);
  }
  put(key: K, value: V): [K, V] | undefined {
    const s = this.slots.get(key);
    if (s) {
      s.value = value;
      s.spec = false;
      if (s.pins === 0) {
        this.unlink(key);
        this.order.push(key);
      }
      return undefined;
    }
    this.slots.set(key, { value, pins: 0, spec: false });
    this.order.push(key);
    return undefined;
  }
  putAtLru(key: K, value: V): [K, V] | undefined {
    const s = this.slots.get(key);
    if (s) {
      s.value = value;
      s.spec = true;
      if (s.pins === 0) {
        this.unlink(key);
        this.order.unshift(key);
      }
      return undefined;
    }
    this.slots.set(key, { value, pins: 0, spec: true });
    this.order.unshift(key);
    return undefined;
  }
  touch(key: K): boolean {
    return this.get(key) !== undefined || this.slots.has(key);
  }
  moveToLru(key: K): boolean {
    const s = this.slots.get(key);
    if (!s) return false;
    if (s.pins === 0) {
      this.unlink(key);
      this.order.unshift(key);
    }
    return true;
  }
  evict(): [K, V] | undefined {
    const key = this.order.shift();
    if (key === undefined) return undefined;
    const s = this.slots.get(key);
    this.slots.delete(key);
    return s ? [key, s.value] : undefined;
  }
  peekLru(): K | undefined {
    return this.order[0];
  }
  delete(key: K): boolean {
    if (!this.slots.has(key)) return false;
    this.slots.delete(key);
    this.unlink(key);
    return true;
  }
  pin(key: K): void {
    const s = this.slots.get(key);
    if (!s) throw new Error('NOT_FOUND');
    if (s.pins++ === 0) this.unlink(key);
  }
  unpin(key: K): void {
    const s = this.slots.get(key);
    if (!s) throw new Error('NOT_FOUND');
    if (s.pins === 0) throw new Error('INVALID');
    if (--s.pins === 0) this.order.push(key);
  }
  isPinned(key: K): boolean {
    return (this.slots.get(key)?.pins ?? 0) > 0;
  }
  isSpeculative(key: K): boolean {
    return this.slots.get(key)?.spec ?? false;
  }
  get size(): number {
    return this.slots.size;
  }
  get evictableSize(): number {
    return this.order.length;
  }
  *keysMruToLru(): IterableIterator<K> {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const k = this.order[i];
      if (k !== undefined) yield k;
    }
  }
  stats(): DsaStats {
    return { ...STATS, size: this.slots.size };
  }
  checkInvariants(): void {
    for (const k of this.order) if ((this.slots.get(k)?.pins ?? 1) !== 0) throw new Error('L2');
  }
}

/** IndexedMinHeap double over a sorted array. */
export class ArrayHeap implements IndexedMinHeap {
  private items: Array<{ h: number; k: number }> = [];

  push(handle: number, key: number): void {
    if (this.has(handle)) throw new Error('DUPLICATE');
    this.items.push({ h: handle, k: key });
    this.items.sort((a, b) => a.k - b.k);
  }
  pop(): number | undefined {
    return this.items.shift()?.h;
  }
  peek(): number | undefined {
    return this.items[0]?.h;
  }
  peekKey(): number | undefined {
    return this.items[0]?.k;
  }
  changePriority(handle: number, key: number): boolean {
    const it = this.items.find((x) => x.h === handle);
    if (!it) return false;
    it.k = key;
    this.items.sort((a, b) => a.k - b.k);
    return true;
  }
  remove(handle: number): boolean {
    const i = this.items.findIndex((x) => x.h === handle);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
  replaceTop(handle: number, key: number): number | undefined {
    const top = this.pop();
    this.push(handle, key);
    return top;
  }
  has(handle: number): boolean {
    return this.items.some((x) => x.h === handle);
  }
  keyOf(handle: number): number | undefined {
    return this.items.find((x) => x.h === handle)?.k;
  }
  get size(): number {
    return this.items.length;
  }
  clear(): void {
    this.items = [];
  }
  stats(): DsaStats {
    return { ...STATS, size: this.items.length };
  }
  checkInvariants(): void {
    // sorted by construction
  }
}

/** A manual clock: `advance` fires due timers in time order. */
export class ManualClock implements MmClock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  schedule(ms: number, fn: () => void): () => void {
    const id = this.seq++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return () => {
      this.timers.delete(id);
    };
  }
  get pendingTimers(): number {
    return this.timers.size;
  }
  /** Advance by `ms`, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: { id: number; at: number; fn: () => void } | undefined;
      for (const [id, tm] of this.timers)
        if (tm.at <= end && (!next || tm.at < next.at)) next = { id, ...tm };
      if (!next) break;
      this.timers.delete(next.id);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
  }
}

export interface FakeProc {
  st: unknown;
  pages: Map<number, ArrayBuffer>;
  loaded: boolean;
  restoredFrom: 'page-in' | 'session' | null;
}

/**
 * An executor pool double: holds each process's `st` and page bytes like the runtime would,
 * encodes with the real codec, and transfers buffers (the source copy is detached from its map).
 */
export class FakeExecutor implements MemExecutorPort {
  readonly procs = new Map<number, FakeProc>();
  readonly calls: string[] = [];
  /** When set, `checkpoint` answers EINVAL (the codec rejected the state). */
  rejectCheckpoint = false;
  /** When set, `pageOut` throws. */
  failPageOut = false;
  workers = new Map<number, boolean>();

  spawn(pid: number, st: unknown = { n: 0 }): FakeProc {
    const p: FakeProc = { st, pages: new Map(), loaded: true, restoredFrom: null };
    this.procs.set(pid, p);
    return p;
  }

  proc(pid: number): FakeProc {
    const p = this.procs.get(pid);
    if (!p) throw new Error(`fake executor: no pid ${pid}`);
    return p;
  }

  /** The program allocated page `id`: fill it with bytes. */
  fill(pid: number, id: number, bytes: Uint8Array | ArrayBuffer): void {
    const ab = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
    this.proc(pid).pages.set(id, ab);
  }

  pageOut(pid: number, pageIds: number[]): Promise<ExecPage[]> {
    this.calls.push(`pageOut ${pid} ${pageIds.join(',')}`);
    if (this.failPageOut) return Promise.reject(new Error('pageOut failed'));
    const p = this.proc(pid);
    const out: ExecPage[] = [];
    for (const id of pageIds) {
      const body = p.pages.get(id) ?? new ArrayBuffer(0);
      p.pages.delete(id);
      const enc = encodeRaw(body);
      out.push({ pageId: id, header: enc.header, body: enc.body, sha256: enc.sha256 });
    }
    return Promise.resolve(out);
  }

  checkpoint(pid: number, release: boolean): Promise<CheckpointResult> {
    this.calls.push(`checkpoint ${pid} ${release}`);
    if (this.rejectCheckpoint)
      return Promise.resolve({ ok: false, errno: 'EINVAL', msg: 'codec rejected the state' });
    const enc = encodeState(this.proc(pid).st);
    return Promise.resolve({
      ok: true,
      header: enc.header,
      body: enc.body,
      sha256: enc.sha256,
      bytes: enc.bytes,
    });
  }

  pageIn(pid: number, pageId: number, body: ArrayBuffer, sha256: string): Promise<void> {
    this.calls.push(`pageIn ${pid} ${pageId}`);
    if (sha256Hex(body) !== sha256)
      return Promise.reject(new Error('fake executor: pageIn checksum mismatch'));
    this.proc(pid).pages.set(pageId, body);
    return Promise.resolve();
  }

  release(pid: number, pageIds: number[], dropProcess: boolean): Promise<{ bytes: number }> {
    this.calls.push(`release ${pid} ${pageIds.join(',')} ${dropProcess}`);
    const p = this.proc(pid);
    let bytes = 0;
    for (const id of pageIds) {
      bytes += p.pages.get(id)?.byteLength ?? 0;
      p.pages.delete(id);
    }
    if (dropProcess) {
      p.st = undefined;
      p.loaded = false;
    }
    return Promise.resolve({ bytes });
  }

  restore(
    pid: number,
    page: { header: ArrayBuffer; body: ArrayBuffer; sha256: string },
    from: 'page-in' | 'session',
  ): Promise<void> {
    this.calls.push(`restore ${pid} ${from}`);
    const p = this.procs.get(pid) ?? this.spawn(pid);
    p.st = decodeState(page.header, page.body, { expectedSha: page.sha256 });
    p.loaded = true;
    p.restoredFrom = from;
    return Promise.resolve();
  }

  terminateWorker(pid: number): Promise<void> {
    this.calls.push(`terminate ${pid}`);
    this.workers.set(pid, false);
    return Promise.resolve();
  }

  respawnWorker(pid: number): Promise<void> {
    this.calls.push(`respawn ${pid}`);
    this.workers.set(pid, true);
    return Promise.resolve();
  }
}

/** Random incompressible bytes from a seeded generator (deterministic tests). */
export function randomBytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
