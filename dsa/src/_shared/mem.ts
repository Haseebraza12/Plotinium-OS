/**
 * Bytes-per-entry probe for dsa/ benchmarks (specs/08-dsa/data-structures.md §7.1 "Memory",
 * DSA-GEN-09). Node only: benchmarks and tests import it, product code never does (ESLint treats
 * this file as a test file, so it may read `process`).
 *
 * measured = Δ(heapUsed + arrayBuffers) / n between two forced collections. `gc` exists only when
 * Node runs with --expose-gc; without it the measured value is null and the benchmark still
 * reports the allocated and used bytes from the structure's own `stats()`.
 */

export interface MemMeasurement<T> {
  /** What `build` returned; kept alive until after the second snapshot. */
  readonly value: T;
  readonly bytesPerEntryMeasured: number | null;
}

function heapBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** Build a structure of `n` entries and report the heap growth per entry. */
export function measureBytesPerEntry<T>(n: number, build: () => T): MemMeasurement<T> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined || n <= 0) return { value: build(), bytesPerEntryMeasured: null };
  gc();
  const before = heapBytes();
  const value = build();
  gc();
  const after = heapBytes();
  return { value, bytesPerEntryMeasured: (after - before) / n };
}
