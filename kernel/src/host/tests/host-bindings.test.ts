/**
 * Host bindings that run outside the browser-only entry points: KPS-13 ONE platform timer driving
 * the kernel timer heap (`drivePlatformTimer`, the heap as the services' `KernelTimers`), and the
 * blkio host's deferred swap device (memory-and-paging.md §3.10: every call waits for the blkio
 * handshake; when blkio cannot start, paging falls back to memory and says so).
 */
import { describe, expect, it } from 'vitest';

import type { SwapDevice, SwapKey } from '../../core/mm/swap.ts';
import { MemorySwapDevice } from '../../core/mm/swap.ts';
import { defaultHeapFactory } from '../../core/sched/scheduler.ts';
import { TimerHeap } from '../../core/sched/timers.ts';
import { DeferredSwapDevice, startBlkioHost } from '../blkio-host.ts';
import { ManualClock } from '../clock.ts';
import { drivePlatformTimer, kernelTimersOf } from '../kernel-timers.ts';

/** A platform timer whose callbacks run when the test advances the clock. */
function manualPlatform(clock: ManualClock) {
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  let sets = 0;
  return {
    set: (fn: () => void, ms: number): number => {
      sets++;
      pending.set(++next, { at: clock.now() + ms, fn });
      return next;
    },
    clear: (h: unknown): void => {
      pending.delete(h as number);
    },
    advance(ms: number): void {
      clock.advance(ms);
      for (const [k, v] of [...pending]) {
        if (v.at <= clock.now()) {
          pending.delete(k);
          v.fn();
        }
      }
    },
    get armed(): number {
      return pending.size;
    },
    get sets(): number {
      return sets;
    },
  };
}

describe('KPS-13 one platform timer for the kernel timer heap', () => {
  it('KPS-13 the platform timer is armed for the earliest deadline only, re-armed on every change, and stops cleanly', () => {
    const clock = new ManualClock();
    const heap = new TimerHeap(defaultHeapFactory);
    const platform = manualPlatform(clock);
    const stop = drivePlatformTimer(heap, clock, platform);
    const fired: string[] = [];
    heap.arm(100, () => fired.push('a'));
    heap.arm(300, () => fired.push('c'));
    expect(platform.armed).toBe(1);
    heap.arm(50, () => fired.push('early'));
    expect(platform.armed).toBe(1);
    platform.advance(60);
    expect(fired).toEqual(['early']);
    platform.advance(50);
    expect(fired).toEqual(['early', 'a']);
    expect(platform.armed).toBe(1);
    platform.advance(500);
    expect(fired).toEqual(['early', 'a', 'c']);
    expect(platform.armed).toBe(0);
    heap.arm(clock.now() + 10, () => fired.push('late'));
    stop();
    expect(platform.armed).toBe(0);
    platform.advance(100);
    expect(fired).not.toContain('late');
  });

  it("KPS-13 the services' KernelTimers share the heap: at, cancel, and an infinite deadline fires at once", () => {
    const clock = new ManualClock();
    const heap = new TimerHeap(defaultHeapFactory);
    const timers = kernelTimersOf(heap, () => clock.now());
    const fired: number[] = [];
    const a = timers.at(100, () => fired.push(1));
    timers.at(Number.POSITIVE_INFINITY, () => fired.push(2));
    const b = timers.at(50, () => fired.push(3), 1);
    expect(timers.cancel(b)).toBe(true);
    expect(timers.now()).toBe(0);
    heap.runDue(0);
    expect(fired).toEqual([2]);
    clock.advance(100);
    heap.runDue(clock.now());
    expect(fired).toEqual([2, 1]);
    expect(timers.cancel(a)).toBe(false);
  });
});

const KEY: SwapKey = { uid: 1001, osSession: 's1', pid: 7, pageId: 3 };

function recordingDevice(): SwapDevice & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: 'opfs',
    calls,
    write: (key, gen) => {
      calls.push(`write ${String(key.pageId)}@${String(gen)}`);
      return Promise.resolve({ ok: true, body: new ArrayBuffer(0), ms: 1 });
    },
    read: (key, gen) => {
      calls.push(`read ${String(key.pageId)}@${String(gen)}`);
      return Promise.resolve({ ok: false, errno: 'ENOENT' });
    },
    delete: (key) => {
      calls.push(`delete ${String(key.pageId)}`);
      return Promise.resolve();
    },
    deleteSession: (uid) => {
      calls.push(`deleteSession ${String(uid)}`);
      return Promise.resolve();
    },
    sweep: () => {
      calls.push('sweep');
      return Promise.resolve({ files: 2, bytes: 10 });
    },
    usage: () => {
      calls.push('usage');
      return Promise.resolve({ bytes: 10, files: 2 });
    },
  };
}

describe('MEM-05 the blkio host', () => {
  it('MEM-05 every call of the deferred device waits for the blkio connection, then goes to the real device', async () => {
    let connect: (d: SwapDevice) => void = () => undefined;
    const pending = new Promise<SwapDevice>((resolve) => {
      connect = resolve;
    });
    const dev = new DeferredSwapDevice(pending);
    expect(dev.kind).toBe('memory');
    const real = recordingDevice();
    const writing = dev.write(KEY, 2, new ArrayBuffer(64), new ArrayBuffer(8), 'x');
    const reading = dev.read(KEY, 2, 'x');
    expect(real.calls).toEqual([]);
    connect(real);
    await expect(writing).resolves.toMatchObject({ ok: true });
    await expect(reading).resolves.toMatchObject({ ok: false, errno: 'ENOENT' });
    await dev.delete(KEY, [2]);
    await dev.deleteSession(1001, 's1');
    await expect(dev.sweep([], 0)).resolves.toEqual({ files: 2, bytes: 10 });
    await expect(dev.usage()).resolves.toEqual({ bytes: 10, files: 2 });
    expect(await dev.whenReady()).toBe(real);
    expect(dev.kind).toBe('opfs');
    expect(real.calls).toEqual([
      'write 3@2',
      'read 3@2',
      'delete 3',
      'deleteSession 1001',
      'sweep',
      'usage',
    ]);
    expect(dev.note).toBeNull();
  });

  it('MEM-05 when blkio cannot start the device falls back to memory, notes why, and still pages', async () => {
    const why: string[] = [];
    const dev = new DeferredSwapDevice(Promise.reject(new Error('no OPFS and no IndexedDB')), (w) =>
      why.push(w),
    );
    const d = await dev.whenReady();
    expect(d).toBeInstanceOf(MemorySwapDevice);
    expect(dev.kind).toBe('memory');
    expect(dev.note).toContain('no OPFS and no IndexedDB');
    expect(why).toHaveLength(1);
    await expect(dev.usage()).resolves.toEqual({ bytes: 0, files: 0 });
  });

  it('MEM-04 startBlkioHost without a worker falls back to memory; with a same-origin fetch it builds the remote tier', async () => {
    const notes: string[] = [];
    const host = startBlkioHost({
      factory: null,
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      onFallback: (w) => notes.push(w),
    });
    await host.device.whenReady();
    expect(host.device.kind).toBe('memory');
    expect(notes[0]).toContain('no blkio worker in this host');
    expect(host.remote).toBeDefined();
    host.stop();
    const bare = startBlkioHost({ factory: null });
    await bare.device.whenReady();
    expect(bare.remote).toBeUndefined();
    bare.stop();
  });
});
