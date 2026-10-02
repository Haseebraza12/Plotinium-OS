/**
 * S7 ring buffer benchmarks (specs/08-dsa/data-structures.md §7, §8.8). Gated on IMPLEMENTED.
 * Capacities must be powers of two, so n = 10^3, 10^4, 10^5 run at the next power of two.
 * Shape (§7.2): push/shift flat (≤ 2×) across capacities. Targets (recorded): ≤ 50 ns per
 * push/shift pair; ByteRing ≥ 500 MB/s with 4 KiB chunks.
 */
import { describe, it } from 'vitest';

import { ByteRingBuffer, IMPLEMENTED, RingBuffer } from '../src/ringbuffer/index.ts';
import { BATCH, measureCurve, record, recordMemory, SIZES } from './harness.ts';

const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(n));
const CHUNK = 4_096;

describe.runIf(IMPLEMENTED)('dsa/ringbuffer benchmarks (S7)', () => {
  it('DSA-RING-01 push/shift is flat across capacities and ByteRing throughput is reported', async ({
    bench,
    expect,
  }) => {
    const pushShift = await measureCurve(bench, {
      structure: 'ringbuffer',
      op: 'push+shift (half full)',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const ring = new RingBuffer<number>(nextPow2(n));
        for (let i = 0; i < n / 2; i++) ring.push(i);
        // Read the imported BATCH once, outside the timed loop: under Vitest's module runner every
        // read of an imported binding is a getter call, which cost ~4× the ring operation itself.
        const batch = BATCH;
        return () => {
          for (let i = 0; i < batch; i++) {
            ring.push(i);
            ring.shift();
          }
        };
      },
    });
    const overwrite = await measureCurve(bench, {
      structure: 'ringbuffer',
      op: 'push (full, overwrite)',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const ring = new RingBuffer<number>(nextPow2(n));
        for (let i = 0; i < nextPow2(n); i++) ring.push(i);
        const batch = BATCH; // see above: no module-runner getter inside the timed loop
        return () => {
          for (let i = 0; i < batch; i++) ring.push(i);
        };
      },
    });
    const bytes = await measureCurve(bench, {
      structure: 'ringbuffer',
      op: 'ByteRing write+read 4 KiB',
      variant: 'bytes',
      sizes: [65_536],
      batch: CHUNK,
      setup: (capacity) => {
        const pipe = new ByteRingBuffer(capacity);
        const src = new Uint8Array(CHUNK).fill(7);
        const dst = new Uint8Array(CHUNK);
        return () => {
          pipe.write(src);
          pipe.read(dst);
        };
      },
    });
    const perByte = bytes.timings[0];
    if (perByte !== undefined) {
      // ns per byte → MB/s: 1e9 / ns / 1e6.
      const mbPerSecond = 1e3 / perByte.meanNs;
      record({
        structure: 'ringbuffer',
        variant: 'bytes',
        op: 'ByteRing throughput',
        timing: perByte,
        budget: {
          metric: 'MB/s',
          limit: 500,
          value: mbPerSecond,
          pass: mbPerSecond >= 500,
          hard: false,
        },
      });
    }
    expect(pushShift.ratio).toBeLessThanOrEqual(2);
    expect(overwrite.ratio).toBeLessThanOrEqual(2);
  });

  it('DSA-GEN-09 ring bytes per entry at 10^3, 10^4 and 10^5 are recorded', ({ expect }) => {
    for (const n of SIZES) {
      const ring = new RingBuffer<number>(nextPow2(n));
      for (let i = 0; i < n; i++) ring.push(i);
      const rec = recordMemory('ringbuffer', n, null, ring.stats());
      expect(rec.bytesPerEntryAllocated).toBeGreaterThan(0);
    }
  });
});
