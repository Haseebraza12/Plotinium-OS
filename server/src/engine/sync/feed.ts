/**
 * The per-owner feed after COMMIT: entries, the reader port, and the in-process broadcaster
 * (offline-and-sync.md §3.8.2, §3.8.4 rules 3-5, §5.4; database.md §3.9.4, §3.15; SYN-05, SYN-17;
 * INV-S3, INV-S4; C9: no LISTEN/NOTIFY, no broker).
 *
 * Broadcaster order (SYN-17): two transactions of the same owner can resolve their COMMIT promises
 * on different pool connections, so entries may reach the broadcaster out of seq order. It keeps
 * `nextSeq[owner]` and holds an entry whose predecessor has not been emitted yet, in a min-heap on
 * seq (the team's dsa/heap through ExpiryIndex); if the gap is not filled within 1 s it reads the
 * missing rows from `feed` + `op_log` and emits them in order. Every subscriber therefore sees
 * each owner's entries in strictly increasing seq; subscribers drop anything at or below their
 * cursor, which also absorbs the rare duplicate of a late publish.
 */
import type { Change } from '@plotinium/protocol';

import type { Ino } from '../../vfs/types.ts';
import type { Clock, Timer } from './clock.ts';
import type { CommittedOp } from './engine.ts';
import { ExpiryIndex, type HeapFactory } from '../locks/expiry-index.ts';
import { contextInos, type DirContext, type DirContextSource, type DirNode } from './visibility.ts';

/** One `feed` row joined with its op_log payload. */
export interface FeedRow {
  readonly ownerUid: number;
  readonly seq: number;
  readonly opId: string;
  readonly commitTime: string;
  readonly lamport: number;
  readonly changes: readonly Change[];
  /** Directories whose entries changed (watch fan-out and refetch for large ops). */
  readonly dirs: readonly Ino[];
  /** op_log.effects was purged by retention: the receiver must re-snapshot. */
  readonly purged: boolean;
}

/** A row ready to deliver: the permission context is loaded once per entry (SYN-18). */
export interface FeedEntry extends FeedRow {
  /** The connection whose op this is (live broadcasts only): it gets op.result, not vfs.changed. */
  readonly originConnId: string | null;
  readonly context: DirContext;
}

export interface OwnerHead {
  /** users.feed_seq: the last seq handed out. */
  readonly feedSeq: number;
  /** users.feed_purged_seq: rows with owner_seq <= this were pruned (horizon = purged + 1). */
  readonly purgedSeq: number;
}

/** Reads the feed (Kysely implementation: feed-reader.ts). */
export interface FeedReader {
  heads(owners: readonly number[]): Promise<ReadonlyMap<number, OwnerHead>>;
  /** Rows with owner_seq > afterSeq, ascending, at most `limit`. */
  page(ownerUid: number, afterSeq: number, limit: number): Promise<readonly FeedRow[]>;
}

/** Attaches one DirContext (one query) to a batch of rows. */
export async function withContext(
  rows: readonly FeedRow[],
  dirs: DirContextSource,
  originConnId: string | null = null,
): Promise<FeedEntry[]> {
  if (rows.length === 0) return [];
  const inos = new Set<Ino>();
  for (const r of rows) for (const i of contextInos(r.changes)) inos.add(i);
  const context: DirContext =
    inos.size === 0 ? new Map<Ino, DirNode>() : await dirs.load([...inos]);
  return rows.map((r) => ({ ...r, originConnId, context }));
}

export interface FeedSubscriber {
  readonly connId: string;
  /** Called in strictly increasing seq per owner. Must not throw. */
  deliver(entry: FeedEntry): void;
}

export interface BroadcasterOptions {
  readonly clock: Clock;
  readonly reader: FeedReader;
  readonly dirs: DirContextSource;
  readonly createHeap?: HeapFactory;
  /** How long an out-of-order entry waits for its predecessor before the feed is read (1 s). */
  readonly gapWaitMs?: number;
  readonly onError?: (err: unknown, context: string) => void;
}

interface OwnerOrder {
  next: number | undefined;
  readonly held: ExpiryIndex;
  readonly entries: Map<string, FeedEntry>;
  timer: Timer | undefined;
  filling: boolean;
}

export class Broadcaster {
  readonly #o: BroadcasterOptions;
  readonly #subs = new Map<string, FeedSubscriber>();
  readonly #owners = new Map<number, OwnerOrder>();

  constructor(options: BroadcasterOptions) {
    this.#o = options;
  }

  subscribe(sub: FeedSubscriber): () => void {
    this.#subs.set(sub.connId, sub);
    return () => {
      if (this.#subs.get(sub.connId) === sub) this.#subs.delete(sub.connId);
    };
  }

  get subscribers(): number {
    return this.#subs.size;
  }

  /** The next seq the broadcaster will emit for `owner` (undefined before its first entry). */
  nextSeq(owner: number): number | undefined {
    return this.#owners.get(owner)?.next;
  }

  /** After COMMIT (engine.onCommitted): one entry per owner the op consumed a seq of. */
  committed(c: CommittedOp): Promise<void> {
    const rows: FeedRow[] = c.ownerSeqs.map((s) => ({
      ownerUid: s.ownerUid,
      seq: s.seq,
      opId: c.opId,
      commitTime: c.commitTime,
      lamport: c.lamport,
      changes: c.effects.changes,
      dirs: c.effects.dirs,
      purged: false,
    }));
    return withContext(rows, this.#o.dirs, c.originConnId).then(
      (entries) => {
        for (const e of entries) this.#arrive(e);
      },
      (err: unknown) => {
        // Without a context the entry cannot be filtered: let the gap timer read it back instead.
        this.#o.onError?.(err, 'broadcast-context');
        for (const r of rows) this.#expectGap(r.ownerUid, r.seq);
      },
    );
  }

  stop(): void {
    for (const o of this.#owners.values()) o.timer?.cancel();
  }

  #order(owner: number): OwnerOrder {
    let o = this.#owners.get(owner);
    if (o === undefined) {
      o = {
        next: undefined,
        held: new ExpiryIndex(this.#o.createHeap),
        entries: new Map<string, FeedEntry>(),
        timer: undefined,
        filling: false,
      };
      this.#owners.set(owner, o);
    }
    return o;
  }

  #arrive(e: FeedEntry): void {
    const o = this.#order(e.ownerUid);
    if (o.next === undefined) o.next = e.seq; // first entry since start: nothing earlier is known
    if (e.seq < o.next) {
      this.#fanOut(e); // a late publish of an entry the gap reader already emitted: receivers dedupe
      return;
    }
    const key = String(e.seq);
    if (!o.entries.has(key)) {
      o.entries.set(key, e);
      o.held.upsert(key, e.seq);
    }
    this.#drain(e.ownerUid, o);
  }

  /** The entry `seq` of `owner` exists but could not be prepared: make sure the gap reader runs. */
  #expectGap(owner: number, seq: number): void {
    const o = this.#order(owner);
    if (o.next === undefined) o.next = seq;
    this.#armGap(owner, o);
  }

  #drain(owner: number, o: OwnerOrder): void {
    for (;;) {
      const next = o.next;
      if (next === undefined) return;
      const due = o.held.popDue(next);
      if (due.length === 0) break;
      for (const d of due) {
        const e = o.entries.get(d.id);
        o.entries.delete(d.id);
        if (e === undefined) continue;
        if (e.seq === next) o.next = next + 1;
        this.#fanOut(e);
      }
    }
    if (o.held.size > 0) this.#armGap(owner, o);
    else {
      o.timer?.cancel();
      o.timer = undefined;
    }
  }

  #armGap(owner: number, o: OwnerOrder): void {
    if (o.timer !== undefined || o.filling) return;
    o.timer = this.#o.clock.setTimer(this.#o.gapWaitMs ?? 1_000, () => {
      o.timer = undefined;
      void this.#fill(owner, o);
    });
  }

  /** Reads the missing rows next .. (first held - 1) from the feed and emits them in order. */
  async #fill(owner: number, o: OwnerOrder): Promise<void> {
    const next = o.next;
    if (next === undefined) return;
    const firstHeld = o.held.peekDeadline();
    const upTo = firstHeld === undefined ? next : firstHeld - 1;
    o.filling = true;
    try {
      const want = Math.max(1, upTo - next + 1);
      const rows = await this.#o.reader.page(owner, next - 1, Math.min(want, 256));
      const entries = await withContext(rows, this.#o.dirs);
      for (const e of entries) {
        if (o.next !== undefined && e.seq === o.next) {
          o.next = e.seq + 1;
          this.#fanOut(e);
        }
      }
      // A predecessor that is still not readable (pruned) is skipped rather than blocking the owner.
      if (
        firstHeld !== undefined &&
        o.next !== undefined &&
        o.next < firstHeld &&
        rows.length === 0
      )
        o.next = firstHeld;
    } catch (err) {
      this.#o.onError?.(err, 'broadcast-gap');
    } finally {
      o.filling = false;
    }
    this.#drain(owner, o);
  }

  #fanOut(e: FeedEntry): void {
    for (const sub of this.#subs.values()) {
      try {
        sub.deliver(e);
      } catch (err) {
        this.#o.onError?.(err, 'deliver');
      }
    }
  }
}
