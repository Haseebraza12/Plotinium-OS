/**
 * The indexer work queue and its throttle (rag-semantic-search.md §3.2.6; RAG-01, RAG-02).
 *
 * The queue is a `dsa/heap` IndexedMinHeap keyed by `classRank · 2^40 + enqueuedAt` with
 * `enqueuedAt` in monotonic milliseconds (data-structures.md §9 note to this spec), so every key is
 * an exact integer below 2^53. Classes, highest first: deadline (pending > 15 s), hot, hit, normal,
 * backfill. The heap is injected: ai/ never implements it (C16).
 *
 * Throttle: while the user was active in the last second the indexer sleeps after each chunk for
 * as long as the embedding took (50 % duty cycle); a deadline job never sleeps.
 */
import type { IndexedMinHeap } from '../util/deps.ts';

export const JOB_CLASSES = ['deadline', 'hot', 'hit', 'normal', 'backfill'] as const;
export type JobClass = (typeof JOB_CLASSES)[number];

const CLASS_SHIFT = 2 ** 40;
export const DEADLINE_AFTER_MS = 15_000;
export const ACTIVE_WINDOW_MS = 1_000;

export function queueKey(cls: JobClass, enqueuedAt: number): number {
  return JOB_CLASSES.indexOf(cls) * CLASS_SHIFT + Math.max(0, Math.floor(enqueuedAt));
}

interface Job {
  ino: string;
  cls: JobClass;
  enqueuedAt: number;
}

export class IndexQueue {
  private readonly heap: IndexedMinHeap;
  private readonly byIno = new Map<string, number>();
  private readonly jobs = new Map<number, Job>();
  private readonly free: number[] = [];
  private next = 0;

  constructor(heap: IndexedMinHeap) {
    this.heap = heap;
  }

  get size(): number {
    return this.heap.size;
  }

  /** Enqueue or promote; a job never moves to a lower class and keeps its first `enqueuedAt`. */
  enqueue(ino: string, cls: JobClass, now: number): void {
    const handle = this.byIno.get(ino);
    if (handle !== undefined) {
      const job = this.jobs.get(handle);
      if (job !== undefined && JOB_CLASSES.indexOf(cls) < JOB_CLASSES.indexOf(job.cls)) {
        job.cls = cls;
        this.heap.changePriority(handle, queueKey(cls, job.enqueuedAt));
      }
      return;
    }
    const h = this.free.pop() ?? this.next++;
    this.byIno.set(ino, h);
    this.jobs.set(h, { ino, cls, enqueuedAt: now });
    this.heap.push(h, queueKey(cls, now));
  }

  /** Move jobs pending longer than 15 s to the deadline class (RAG-02 under continuous typing). */
  age(now: number): number {
    let moved = 0;
    for (const [h, job] of this.jobs) {
      if (job.cls !== 'deadline' && now - job.enqueuedAt > DEADLINE_AFTER_MS) {
        job.cls = 'deadline';
        this.heap.changePriority(h, queueKey('deadline', job.enqueuedAt));
        moved++;
      }
    }
    return moved;
  }

  pop(): { ino: string; cls: JobClass; enqueuedAt: number } | undefined {
    const h = this.heap.pop();
    if (h === undefined) return undefined;
    const job = this.jobs.get(h);
    this.jobs.delete(h);
    this.free.push(h);
    if (job === undefined) return undefined;
    this.byIno.delete(job.ino);
    return { ...job };
  }

  remove(ino: string): boolean {
    const h = this.byIno.get(ino);
    if (h === undefined) return false;
    this.heap.remove(h);
    this.byIno.delete(ino);
    this.jobs.delete(h);
    this.free.push(h);
    return true;
  }

  classOf(ino: string): JobClass | undefined {
    const h = this.byIno.get(ino);
    return h === undefined ? undefined : this.jobs.get(h)?.cls;
  }
}

/** Milliseconds to sleep after one embedded chunk (the 50 % duty cycle of §3.2.6). */
export function sleepAfterChunk(args: {
  lastEmbedMs: number;
  lastInputAt: number;
  now: number;
  cls: JobClass;
}): number {
  if (args.cls === 'deadline') return 0;
  return args.now - args.lastInputAt < ACTIVE_WINDOW_MS ? Math.max(0, args.lastEmbedMs) : 0;
}
