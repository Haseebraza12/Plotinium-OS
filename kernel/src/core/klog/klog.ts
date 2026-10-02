/**
 * The kernel log ring (processes-and-scheduling.md §3.1 KLOG_SIZE, §3.4 rule 5; syscall-abi.md
 * §3.7 trace level). 8,192 entries; the oldest are overwritten, `dropped` counts them, and
 * followers (`dmesg -w`, the boot log forwarder, the PROC-06 test) see every record as it is
 * appended, so a complete trace can always be captured even when the ring wraps.
 *
 * The ring itself is `dsa/ringbuffer` (C16, owner R5). While that structure is not implemented
 * the kernel uses `ArrayRing` below. TODO(dsa/ringbuffer): delete ArrayRing once
 * RINGBUFFER_IMPLEMENTED is true; `createKlogRing` already switches on the flag.
 */
import { RINGBUFFER_IMPLEMENTED, RingBuffer } from '@plotinium/dsa';

import type { KlogInput, KlogLevel, KlogRecord } from './records.ts';
import { levelOf } from './records.ts';

export const KLOG_SIZE = 8_192;

/** The subset of `dsa` `Ring<T>` the klog uses. */
export interface RecordRing<T> {
  push(x: T): void;
  at(i: number): T | undefined;
  readonly size: number;
  readonly capacity: number;
  readonly dropped: number;
}

/**
 * Stand-in overwrite ring over a plain array. TODO(dsa/ringbuffer): remove (see module comment).
 */
export class ArrayRing<T> implements RecordRing<T> {
  private readonly slots: (T | undefined)[];
  private head = 0;
  private count = 0;
  private overwritten = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError('ring capacity must be a positive integer');
    this.capacity = capacity;
    this.slots = new Array<T | undefined>(capacity).fill(undefined);
  }

  get size(): number {
    return this.count;
  }

  get dropped(): number {
    return this.overwritten;
  }

  push(x: T): void {
    const tail = (this.head + this.count) % this.capacity;
    this.slots[tail] = x;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
      this.overwritten++;
    }
  }

  at(i: number): T | undefined {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) return undefined;
    return this.slots[(this.head + i) % this.capacity];
  }
}

export function createKlogRing(capacity: number): RecordRing<KlogRecord> {
  return RINGBUFFER_IMPLEMENTED
    ? new RingBuffer<KlogRecord>(capacity, 'overwrite')
    : new ArrayRing<KlogRecord>(capacity);
}

export interface KlogReadOptions {
  /** Only records with `seq` greater than this. */
  readonly since?: number;
  /** Only records of exactly this level (Linux `dmesg --level` semantics). */
  readonly level?: KlogLevel;
  /** At most this many records: the first after `since`, otherwise the newest. */
  readonly limit?: number;
  readonly filter?: (rec: KlogRecord) => boolean;
}

export type KlogFollower = (rec: KlogRecord) => void;

export class Klog {
  private readonly ring: RecordRing<KlogRecord>;
  private nextSeq = 1;
  private readonly followers = new Set<KlogFollower>();

  constructor(ring: RecordRing<KlogRecord> = createKlogRing(KLOG_SIZE)) {
    this.ring = ring;
  }

  get size(): number {
    return this.ring.size;
  }

  get capacity(): number {
    return this.ring.capacity;
  }

  /** Records overwritten since boot. */
  get dropped(): number {
    return this.ring.dropped;
  }

  /** Sequence number of the newest record, 0 before the first. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  append(input: KlogInput): KlogRecord {
    const rec: KlogRecord = { ...input, seq: this.nextSeq++ };
    this.ring.push(rec);
    for (const f of this.followers) {
      try {
        f(rec);
      } catch {
        // A faulty follower must not break the kernel log; it simply misses nothing else.
      }
    }
    return rec;
  }

  /** Convenience for subsystem lines. */
  line(t: number, sub: string, level: KlogLevel, msg: string, pid?: number): KlogRecord {
    return this.append(
      pid === undefined
        ? { kind: 'line', t, sub, level, msg }
        : { kind: 'line', t, sub, level, msg, pid },
    );
  }

  /** O(size): records oldest → newest that match `opts`. */
  read(opts: KlogReadOptions = {}): KlogRecord[] {
    const out: KlogRecord[] = [];
    const since = opts.since ?? 0;
    for (let i = 0; i < this.ring.size; i++) {
      const rec = this.ring.at(i);
      if (rec === undefined || rec.seq <= since) continue;
      if (opts.level !== undefined && levelOf(rec) !== opts.level) continue;
      if (opts.filter && !opts.filter(rec)) continue;
      out.push(rec);
    }
    const limit = opts.limit;
    if (limit === undefined || out.length <= limit) return out;
    return opts.since === undefined ? out.slice(out.length - limit) : out.slice(0, limit);
  }

  /** Stream every future record; returns the unfollow function. */
  follow(f: KlogFollower): () => void {
    this.followers.add(f);
    return () => {
      this.followers.delete(f);
    };
  }
}
