/**
 * The client exact vector index of `ai.search` (rag-semantic-search.md §3.4, §5.3).
 *
 * Vectors live in Float32Array segments of 1,024 rows × 384 dims (1.5 MiB each), with the row maps
 * `rowFile` (dense `fileIdx`) and `rowSeq` and a `live` bitset, exactly the `ai_vecseg` layout, so
 * a segment is one pageable page. Rows are appended and tombstoned; compaction is the kernel's.
 *
 * `scan` applies the readable bitset BEFORE scoring (I-A1): a row whose file is not readable is
 * skipped without computing its dot product. Vectors are unit length, so cosine = dot. The top K'
 * are kept with the team's `dsa/heap` BoundedTopK (injected); ties at the admission threshold are
 * resolved by `(ino, seq)` ascending so the client agrees with the server oracle (§5.3).
 */
import { EMBED_DIMS } from '@plotinium/protocol';

import type { TopKFactory } from '../util/deps.ts';
import { type Result, fail, ok } from '../util/errors.ts';
import { type Bitset, bitsetFor, clearBit, hasBit, setBit } from './bits.ts';

export const SEGMENT_ROWS = 1_024;
export const DIMS = EMBED_DIMS;
/** The server rejects vectors with |‖v‖ − 1| ≥ 1e-3 (§3.6); the client applies the same rule. */
export const UNIT_TOLERANCE = 1e-3;

export interface VectorSegment {
  readonly segId: number;
  readonly vectors: Float32Array;
  readonly rowFile: Int32Array;
  readonly rowSeq: Int32Array;
  readonly live: Bitset;
  /** Rows used (appended), live or tombstoned. */
  rows: number;
}

export interface ScanHit {
  /** Global row id: `segId * 1024 + row`. */
  row: number;
  fileIdx: number;
  seq: number;
  score: number;
}

export interface ScanResult {
  hits: ScanHit[];
  /** Rows whose dot product was computed (all live AND readable). */
  scored: number;
}

export function l2Norm(v: Float32Array): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function isUnit(v: Float32Array): boolean {
  return v.length === DIMS && Math.abs(l2Norm(v) - 1) < UNIT_TOLERANCE;
}

function dot(q: Float32Array, m: Float32Array, offset: number): number {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += (q[i] ?? 0) * (m[offset + i] ?? 0);
  return s;
}

function newSegment(segId: number): VectorSegment {
  return {
    segId,
    vectors: new Float32Array(SEGMENT_ROWS * DIMS),
    rowFile: new Int32Array(SEGMENT_ROWS),
    rowSeq: new Int32Array(SEGMENT_ROWS),
    live: bitsetFor(SEGMENT_ROWS),
    rows: 0,
  };
}

/** One model space (I-A5): an index holds vectors of exactly one `modelKey`. */
export class VectorIndex {
  readonly modelKey: string;
  private readonly segments: VectorSegment[] = [];
  private liveRows = 0;
  private deadRows = 0;

  constructor(modelKey: string) {
    this.modelKey = modelKey;
  }

  get live(): number {
    return this.liveRows;
  }

  get tombstoned(): number {
    return this.deadRows;
  }

  get segmentCount(): number {
    return this.segments.length;
  }

  /** Append one unit vector; returns its global row id, or EINVAL for a bad vector. */
  append(fileIdx: number, seq: number, vector: Float32Array): Result<number> {
    if (!isUnit(vector))
      return fail('EINVAL', undefined, undefined, 'vector must be 384-d and unit length');
    if (!Number.isInteger(fileIdx) || fileIdx < 0 || !Number.isInteger(seq) || seq < 0)
      return fail('EINVAL');
    let seg = this.segments[this.segments.length - 1];
    if (seg === undefined || seg.rows === SEGMENT_ROWS) {
      seg = newSegment(this.segments.length);
      this.segments.push(seg);
    }
    const r = seg.rows++;
    seg.vectors.set(vector, r * DIMS);
    seg.rowFile[r] = fileIdx;
    seg.rowSeq[r] = seq;
    setBit(seg.live, r);
    this.liveRows++;
    return ok(seg.segId * SEGMENT_ROWS + r);
  }

  /** Mark a row dead; false when it is unknown or already dead. */
  tombstone(row: number): boolean {
    const seg = this.segments[Math.floor(row / SEGMENT_ROWS)];
    const r = row % SEGMENT_ROWS;
    if (seg === undefined || r >= seg.rows || !hasBit(seg.live, r)) return false;
    clearBit(seg.live, r);
    this.liveRows--;
    this.deadRows++;
    return true;
  }

  /** The stored vector of a live row (a copy), for tests and page-out checks. */
  vectorOf(row: number): Float32Array | undefined {
    const seg = this.segments[Math.floor(row / SEGMENT_ROWS)];
    const r = row % SEGMENT_ROWS;
    if (seg === undefined || r >= seg.rows || !hasBit(seg.live, r)) return undefined;
    return seg.vectors.slice(r * DIMS, (r + 1) * DIMS);
  }

  /** Read-only view of the segments (the kernel pages them; the scan walks them). */
  segmentsView(): readonly VectorSegment[] {
    return this.segments;
  }
}

export interface ScanOptions {
  /** The model key of the query vector; must equal the index's (I-A5). */
  modelKey: string;
  qvec: Float32Array;
  /** Readable bitset over `fileIdx`, computed from the live tree before ranking (RAG-03). */
  readable: Bitset;
  kPrime: number;
  topK: TopKFactory;
  /** Tie-break key of a file (its ino); ties sort ascending by `(tieKey, seq)`. */
  tieKey?: (fileIdx: number) => string;
}

function compareHits(tieKey: (fileIdx: number) => string): (a: ScanHit, b: ScanHit) => number {
  return (a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ka = tieKey(a.fileIdx);
    const kb = tieKey(b.fileIdx);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.seq - b.seq;
  };
}

/** Exact top-K' scan over permitted live rows (§5.3). */
export function scan(index: VectorIndex, opts: ScanOptions): Result<ScanResult> {
  if (opts.modelKey !== index.modelKey)
    return fail('EINVAL', undefined, undefined, 'model key mismatch');
  if (opts.qvec.length !== DIMS) return fail('EINVAL');
  if (!Number.isInteger(opts.kPrime) || opts.kPrime < 1) return fail('EINVAL');
  const tieKey = opts.tieKey ?? ((f: number) => f.toString(36).padStart(8, '0'));
  const heap = opts.topK(opts.kPrime);
  const segments = index.segmentsView();
  let scored = 0;
  // Highest score evicted or rejected while equal to the threshold: if it equals the final
  // threshold, the heap's first-come rule may have dropped a tied row that sorts earlier.
  let tiedOut = Number.NEGATIVE_INFINITY;
  const locate = (row: number): ScanHit => {
    const seg = segments[Math.floor(row / SEGMENT_ROWS)];
    const r = row % SEGMENT_ROWS;
    return { row, fileIdx: seg?.rowFile[r] ?? -1, seq: seg?.rowSeq[r] ?? -1, score: 0 };
  };
  for (const seg of segments) {
    for (let r = 0; r < seg.rows; r++) {
      if (!hasBit(seg.live, r) || !hasBit(opts.readable, seg.rowFile[r] ?? -1)) continue;
      const s = dot(opts.qvec, seg.vectors, r * DIMS);
      scored++;
      const full = heap.size >= opts.kPrime;
      const min = full ? heap.minScore() : undefined;
      heap.offer(seg.segId * SEGMENT_ROWS + r, s);
      if (min !== undefined && s >= min) tiedOut = Math.max(tiedOut, min);
    }
  }
  const drained = heap.drainDescending().map((h) => ({ ...locate(h.handle), score: h.score }));
  const threshold = drained.length === opts.kPrime ? drained[drained.length - 1]?.score : undefined;
  let hits = drained;
  if (threshold !== undefined && tiedOut === threshold) {
    hits = drained.filter((h) => h.score > threshold);
    const tied: ScanHit[] = [];
    for (const seg of segments) {
      for (let r = 0; r < seg.rows; r++) {
        if (!hasBit(seg.live, r) || !hasBit(opts.readable, seg.rowFile[r] ?? -1)) continue;
        const s = dot(opts.qvec, seg.vectors, r * DIMS);
        if (s === threshold) tied.push({ ...locate(seg.segId * SEGMENT_ROWS + r), score: s });
      }
    }
    tied.sort(compareHits(tieKey));
    hits = hits.concat(tied.slice(0, opts.kPrime - hits.length));
  }
  hits.sort(compareHits(tieKey));
  return ok({ hits, scored });
}
