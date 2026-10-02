/**
 * Per-owner feed cursors on the client (offline-and-sync.md §3.8.4 "Client side"; C6, SYN-05).
 *
 * - `vfs.changed` entries are applied per owner in strictly increasing `seq`: `seq = cursor + 1` is
 *   applied, a later one waits in a reorder buffer, `seq ≤ cursor` is ignored.
 * - A gap older than FEED_GAP_MS makes `syncd` send `resume` for that owner from its cursor.
 * - `op.result.ownerSeqs` are the entries of our own ops: they advance the cursor through the same
 *   buffer, with nothing to apply (the change is already local).
 * - Cursors are acknowledged with `ack {cursors}` at most every 100 ms or every 64 entries.
 *
 * The tracker is memory only; every cursor it hands out is written by the caller in the same
 * transaction that applies the entry (INV-S5), and committed here only after `oncomplete`.
 */
import { FEED_GAP_MS } from '@plotinium/protocol';
import type { FeedCursor } from '@plotinium/protocol';

import type { Clock, Timer } from './ports.ts';
import type { VfsChangedBody } from './types.ts';

export const ACK_EVERY_MS = 100;
export const ACK_EVERY_ENTRIES = 64;
/** Cursors per `ack` frame (schema limit). */
export const ACK_MAX_CURSORS = 64;

type Slot = { readonly kind: 'entry'; readonly entry: VfsChangedBody } | { readonly kind: 'own' };

interface OwnerFeed {
  cursor: number;
  readonly buffer: Map<number, Slot>;
  gap: Timer | null;
}

export type Offer = 'apply' | 'buffered' | 'stale' | 'unmirrored';

export interface FeedCallbacks {
  /** A gap outlived FEED_GAP_MS: send `resume {ownerUid, fromSeq}`. */
  readonly onGap: (ownerUid: number, fromSeq: number) => void;
  /** Send `ack {cursors}`. */
  readonly onAck: (cursors: FeedCursor[]) => void;
}

export class FeedTracker {
  private readonly feeds = new Map<number, OwnerFeed>();
  private readonly dirty = new Set<number>();
  private pendingAcks = 0;
  private ackTimer: Timer | null = null;
  private readonly clock: Clock;
  private readonly cb: FeedCallbacks;

  constructor(clock: Clock, cb: FeedCallbacks) {
    this.clock = clock;
    this.cb = cb;
  }

  /** Mirror `ownerUid` from `seq` (0 = never synced). Keeps a higher existing cursor. */
  mirror(ownerUid: number, seq: number): void {
    const f = this.feeds.get(ownerUid);
    if (f === undefined) this.feeds.set(ownerUid, { cursor: seq, buffer: new Map(), gap: null });
    else if (seq > f.cursor) this.advance(ownerUid, seq);
  }

  /** Stop mirroring an owner (its last local inode is gone). */
  forget(ownerUid: number): void {
    const f = this.feeds.get(ownerUid);
    f?.gap?.cancel();
    this.feeds.delete(ownerUid);
    this.dirty.delete(ownerUid);
  }

  isMirrored(ownerUid: number): boolean {
    return this.feeds.has(ownerUid);
  }

  cursor(ownerUid: number): number | undefined {
    return this.feeds.get(ownerUid)?.cursor;
  }

  owners(): number[] {
    return [...this.feeds.keys()].sort((a, b) => a - b);
  }

  /** `hello.resume` / `resume.cursors`: `{ownerUid, fromSeq}` for every mirrored owner (≤ 64). */
  resumeCursors(): { ownerUid: number; fromSeq: number }[] {
    return this.owners()
      .slice(0, 64)
      .map((ownerUid) => ({ ownerUid, fromSeq: this.feeds.get(ownerUid)?.cursor ?? 0 }));
  }

  /** A snapshot of the owner was applied up to `headSeq` (§3.8.5). */
  reset(ownerUid: number, headSeq: number): void {
    const f = this.feeds.get(ownerUid);
    if (f === undefined) {
      this.feeds.set(ownerUid, { cursor: headSeq, buffer: new Map(), gap: null });
      return;
    }
    f.cursor = headSeq;
    for (const s of [...f.buffer.keys()]) if (s <= headSeq) f.buffer.delete(s);
    this.markDirty(ownerUid);
    this.checkGap(ownerUid);
  }

  /** A `vfs.changed` arrived. */
  offer(entry: VfsChangedBody): Offer {
    const f = this.feeds.get(entry.ownerUid);
    if (f === undefined) return 'unmirrored';
    if (entry.seq <= f.cursor || f.buffer.has(entry.seq)) return 'stale';
    if (entry.seq === f.cursor + 1) {
      f.buffer.set(entry.seq, { kind: 'entry', entry });
      return 'apply';
    }
    f.buffer.set(entry.seq, { kind: 'entry', entry });
    this.checkGap(entry.ownerUid);
    return 'buffered';
  }

  /**
   * The entry to apply next for `ownerUid` (its seq is `cursor + 1`) and the cursor after it,
   * which also covers our own entries that directly follow it.
   */
  nextEntry(ownerUid: number): { entry: VfsChangedBody; cursorAfter: number } | null {
    const f = this.feeds.get(ownerUid);
    if (f === undefined) return null;
    const slot = f.buffer.get(f.cursor + 1);
    if (slot?.kind !== 'entry') return null;
    let after = slot.entry.seq;
    while (f.buffer.get(after + 1)?.kind === 'own') after++;
    return { entry: slot.entry, cursorAfter: after };
  }

  /** The caller's transaction for an entry committed with cursor `seq`. */
  advance(ownerUid: number, seq: number): void {
    const f = this.feeds.get(ownerUid);
    if (f === undefined || seq <= f.cursor) return;
    f.cursor = seq;
    for (const s of [...f.buffer.keys()]) if (s <= seq) f.buffer.delete(s);
    this.markDirty(ownerUid);
    this.checkGap(ownerUid);
  }

  /** The cursor writes our own entries allow right now (for the result transaction). */
  planOwn(ownerSeqs: readonly FeedCursor[]): FeedCursor[] {
    const out: FeedCursor[] = [];
    const byOwner = new Map<number, Set<number>>();
    for (const c of ownerSeqs) {
      if (!this.feeds.has(c.ownerUid)) continue;
      let s = byOwner.get(c.ownerUid);
      if (s === undefined) byOwner.set(c.ownerUid, (s = new Set()));
      s.add(c.seq);
    }
    for (const [ownerUid, seqs] of byOwner) {
      const f = this.feeds.get(ownerUid);
      if (f === undefined) continue;
      let c = f.cursor;
      while (seqs.has(c + 1) || f.buffer.get(c + 1)?.kind === 'own') c++;
      if (c > f.cursor) out.push({ ownerUid, seq: c });
    }
    return out;
  }

  /** After the result transaction: record our own entries and take the planned cursors. */
  commitOwn(ownerSeqs: readonly FeedCursor[], planned: readonly FeedCursor[]): void {
    for (const c of ownerSeqs) {
      const f = this.feeds.get(c.ownerUid);
      if (f === undefined || c.seq <= f.cursor) continue;
      f.buffer.set(c.seq, { kind: 'own' });
    }
    for (const p of planned) this.advance(p.ownerUid, p.seq);
    for (const c of ownerSeqs) this.checkGap(c.ownerUid);
  }

  /** Owners with an entry ready to apply. */
  ready(): number[] {
    return this.owners().filter((o) => this.nextEntry(o) !== null);
  }

  /** Send the pending acknowledgement now. */
  flushAck(): void {
    this.ackTimer?.cancel();
    this.ackTimer = null;
    this.pendingAcks = 0;
    if (this.dirty.size === 0) return;
    const cursors: FeedCursor[] = [];
    for (const ownerUid of [...this.dirty].sort((a, b) => a - b)) {
      const seq = this.feeds.get(ownerUid)?.cursor;
      if (seq !== undefined) cursors.push({ ownerUid, seq });
    }
    this.dirty.clear();
    for (let i = 0; i < cursors.length; i += ACK_MAX_CURSORS)
      this.cb.onAck(cursors.slice(i, i + ACK_MAX_CURSORS));
  }

  /** The connection closed: timers stop, buffers stay (the server re-streams from the cursor). */
  pause(): void {
    this.ackTimer?.cancel();
    this.ackTimer = null;
    this.pendingAcks = 0;
    this.dirty.clear();
    for (const f of this.feeds.values()) {
      f.gap?.cancel();
      f.gap = null;
    }
  }

  private markDirty(ownerUid: number): void {
    this.dirty.add(ownerUid);
    this.pendingAcks++;
    if (this.pendingAcks >= ACK_EVERY_ENTRIES) {
      this.flushAck();
      return;
    }
    this.ackTimer ??= this.clock.after(ACK_EVERY_MS, () => {
      this.ackTimer = null;
      this.flushAck();
    });
  }

  /** Arm or cancel the gap timer of an owner (§3.8.4 client rule 1). */
  private checkGap(ownerUid: number): void {
    const f = this.feeds.get(ownerUid);
    if (f === undefined) return;
    const waiting = f.buffer.size > 0 && !f.buffer.has(f.cursor + 1);
    if (!waiting) {
      f.gap?.cancel();
      f.gap = null;
      return;
    }
    f.gap ??= this.clock.after(FEED_GAP_MS, () => {
      f.gap = null;
      const still = f.buffer.size > 0 && !f.buffer.has(f.cursor + 1);
      if (still && this.feeds.get(ownerUid) === f) this.cb.onGap(ownerUid, f.cursor);
    });
  }
}
