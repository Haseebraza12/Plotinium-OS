/**
 * Resume through the per-owner feed, for one (connection, owner) (offline-and-sync.md §3.8.4
 * server rules 1-3, §5.4 streamOwner; SYN-05, SYN-17; INV-S4).
 *
 *   mode      fromSeq in [feed_purged_seq, feed_seq] -> stream; fromSeq below the horizon ->
 *             snapshot.required 'horizon'; fromSeq above the head (database restored) -> 'reset'
 *   stream    feed rows with owner_seq > fromSeq, ascending, in pages, one vfs.changed each, with at
 *             most FEED_WINDOW (256) entries sent but not yet covered by an `ack`
 *   switch    while streaming, live broadcasts for the owner are APPENDED to a pending list, never
 *             dropped. When a page comes back short (the head H), the pending entries with seq > H
 *             are sent in order, those <= H discarded, the owner switches to live delivery and
 *             `resume.done {ownerUid, headSeq}` is sent - all synchronously in one event-loop turn,
 *             so no entry can slip between the last check and the switch. Over PENDING_LIVE_MAX
 *             (1,000) pending entries the list is dropped and streaming continues from the database.
 *   live      each entry is delivered once, in increasing seq; entries at or below the cursor are
 *             dropped (a late duplicate); the originating connection is not sent its own op
 *             (op.result.ownerSeqs covers it) but its cursor advances. Backpressure (coalesce)
 *             switches the owner back to streaming from the database: nothing is lost.
 */
import { FEED_WINDOW, PENDING_LIVE_MAX } from '@plotinium/protocol';

import { withContext, type FeedEntry, type FeedReader, type OwnerHead } from './feed.ts';
import type { DirContextSource } from './visibility.ts';

export type SnapshotReason = 'horizon' | 'reset' | 'gap-unrecoverable';
export type ResumeDecision =
  { readonly mode: 'stream' } | { readonly mode: 'snapshot'; readonly reason: 'horizon' | 'reset' };

/** Server rule 1 of §3.8.4. `fromSeq` is the last seq the client applied (0 = never). */
export function resumeMode(fromSeq: number, head: OwnerHead): ResumeDecision {
  if (fromSeq > head.feedSeq) return { mode: 'snapshot', reason: 'reset' };
  if (fromSeq < head.purgedSeq) return { mode: 'snapshot', reason: 'horizon' };
  return { mode: 'stream' };
}

/** The URL of the owner snapshot (backend-api.md §3.6.2). */
export function snapshotUrl(ownerUid: number): string {
  return `/api/sync/snapshot?scope=owner&owner=${ownerUid}`;
}

export type SendResult = 'sent' | 'coalesced' | 'closed';

/** Where a stream's frames go (the connection; it filters by the receiver's permissions). */
export interface StreamSink {
  sendEntry(entry: FeedEntry, phase: 'stream' | 'live'): SendResult;
  sendResumeDone(ownerUid: number, headSeq: number): void;
  sendSnapshotRequired(ownerUid: number, reason: SnapshotReason, headSeq: number): void;
}

export interface OwnerStreamOptions {
  readonly ownerUid: number;
  readonly fromSeq: number;
  /** The connection id: its own ops are not echoed back as vfs.changed. */
  readonly connId: string;
  readonly reader: FeedReader;
  readonly dirs: DirContextSource;
  readonly sink: StreamSink;
  readonly feedWindow?: number;
  readonly pageSize?: number;
  readonly pendingMax?: number;
  readonly onError?: (err: unknown) => void;
}

export type StreamState = 'streaming' | 'live' | 'snapshot' | 'stopped';

export class OwnerStream {
  readonly ownerUid: number;
  readonly #o: OwnerStreamOptions;
  readonly #window: number;
  readonly #pageSize: number;
  readonly #pendingMax: number;
  #state: StreamState = 'streaming';
  #cursor: number;
  #acked: number;
  #pending: FeedEntry[] = [];
  #overflowed = false;
  #loop: Promise<void> | null = null;
  #again = false;
  #wake: (() => void) | null = null;

  constructor(options: OwnerStreamOptions) {
    this.ownerUid = options.ownerUid;
    this.#o = options;
    this.#cursor = options.fromSeq;
    this.#acked = options.fromSeq;
    this.#window = options.feedWindow ?? FEED_WINDOW;
    this.#pageSize = Math.max(1, Math.min(options.pageSize ?? 256, this.#window));
    this.#pendingMax = options.pendingMax ?? PENDING_LIVE_MAX;
  }

  get state(): StreamState {
    return this.#state;
  }

  /** The last seq delivered (or skipped as the connection's own op). */
  get cursor(): number {
    return this.#cursor;
  }

  get pending(): number {
    return this.#pending.length;
  }

  /** Starts (or restarts) streaming from the cursor. Resolves when this pass has finished. */
  start(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'snapshot') return Promise.resolve();
    this.#state = 'streaming';
    if (this.#loop !== null) {
      this.#again = true;
      return this.#loop;
    }
    this.#loop = this.#run().finally(() => {
      this.#loop = null;
    });
    return this.#loop;
  }

  /** The client applied every entry up to `seq` (ack frame or piggy-backed ack). */
  ack(seq: number): void {
    if (seq > this.#acked) this.#acked = Math.min(seq, this.#cursor);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** A live broadcast for this owner (already in seq order from the broadcaster). */
  live(entry: FeedEntry): void {
    if (entry.ownerUid !== this.ownerUid) return;
    switch (this.#state) {
      case 'streaming':
        if (entry.seq <= this.#cursor) return;
        if (this.#pending.length >= this.#pendingMax) {
          this.#pending = [];
          this.#overflowed = true;
          return;
        }
        this.#pending.push(entry);
        return;
      case 'live':
        this.#deliverLive(entry);
        return;
      case 'snapshot':
      case 'stopped':
        return;
    }
  }

  /** Backpressure: stop live sends and resume this owner from the database. */
  coalesce(): void {
    if (this.#state === 'live') void this.start();
  }

  stop(): void {
    this.#state = 'stopped';
    this.#pending = [];
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #deliverLive(entry: FeedEntry): void {
    if (entry.seq <= this.#cursor) return;
    if (entry.originConnId === this.#o.connId) {
      this.#cursor = entry.seq;
      this.#acked = Math.max(this.#acked, entry.seq); // the op.result already told the client
      return;
    }
    const r = this.#o.sink.sendEntry(entry, 'live');
    if (r === 'sent') this.#cursor = entry.seq;
    else if (r === 'coalesced') void this.start();
    else this.stop();
  }

  async #run(): Promise<void> {
    try {
      do {
        this.#again = false;
        await this.#pass();
      } while (this.#again && this.#state === 'streaming');
    } catch (err) {
      this.#o.onError?.(err);
      if (this.#state === 'streaming') {
        this.#state = 'snapshot';
        this.#o.sink.sendSnapshotRequired(this.ownerUid, 'gap-unrecoverable', this.#cursor);
      }
    }
  }

  async #pass(): Promise<void> {
    for (;;) {
      if (this.#state !== 'streaming') return;
      while (this.#cursor - this.#acked >= this.#window) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        if (this.#state !== 'streaming') return;
      }
      const limit = Math.min(this.#pageSize, this.#window - (this.#cursor - this.#acked));
      const rows = await this.#o.reader.page(this.ownerUid, this.#cursor, limit);
      if (this.#state !== 'streaming') return;
      const first = rows[0];
      if ((first !== undefined && first.seq !== this.#cursor + 1) || rows.some((r) => r.purged)) {
        // Rows were pruned between two pages (or never existed): only a snapshot is complete.
        this.#state = 'snapshot';
        this.#pending = [];
        this.#o.sink.sendSnapshotRequired(this.ownerUid, 'horizon', this.#cursor);
        return;
      }
      const entries = await withContext(rows, this.#o.dirs);
      if (this.#state !== 'streaming') return;
      for (const e of entries) {
        if (e.seq <= this.#cursor) continue;
        const r = this.#o.sink.sendEntry(e, 'stream');
        if (r === 'closed') {
          this.stop();
          return;
        }
        this.#cursor = e.seq;
      }
      if (rows.length < limit) {
        // Caught up with the head: switch synchronously (no await from here to the end).
        if (this.#overflowed) {
          this.#overflowed = false;
          this.#pending = [];
          continue; // the dropped live entries are in the feed: read them from the database
        }
        const pending = this.#pending;
        this.#pending = [];
        for (const e of pending) {
          if (e.seq <= this.#cursor) continue;
          this.#deliverLiveSwitch(e);
          if (this.#stopped()) return;
        }
        this.#state = 'live';
        this.#o.sink.sendResumeDone(this.ownerUid, this.#cursor);
        return;
      }
    }
  }

  /** Re-reads the state after a call that may have stopped the stream (defeats narrowing). */
  #stopped(): boolean {
    return this.#state === 'stopped';
  }

  /** Pending entries at the switch: like live delivery, but a coalesce keeps the owner streaming. */
  #deliverLiveSwitch(entry: FeedEntry): void {
    if (entry.originConnId === this.#o.connId) {
      this.#cursor = entry.seq;
      return;
    }
    const r = this.#o.sink.sendEntry(entry, 'stream');
    if (r === 'closed') this.stop();
    else this.#cursor = entry.seq;
  }
}
