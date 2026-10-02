/**
 * The broadcaster's per-owner order and the per-owner resume stream (offline-and-sync.md §3.8.2,
 * §3.8.4, §5.4; SYN-05, SYN-17; INV-S3, INV-S4), and per-owner resume convergence (VFS-10).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Change } from '@plotinium/protocol';

import { CancelRegistry } from '../../vfs/cancel.ts';
import { testHeapFactory } from '../locks/tests/test-heap.ts';
import { ContentWriteHandler } from './content-write.ts';
import { SyncEngine, type CommittedOp, type OpOrigin } from './engine.ts';
import {
  Broadcaster,
  type FeedEntry,
  type FeedReader,
  type FeedRow,
  type OwnerHead,
} from './feed.ts';
import {
  OwnerStream,
  resumeMode,
  snapshotUrl,
  type SendResult,
  type StreamSink,
} from './resume.ts';
import { FakeDb, HOME, ROOT_DIR, sha, uid7, writeOp, type FakeTx } from './tests/fake-db.ts';
import { ManualClock, flush } from './tests/manual-clock.ts';
import type { DirContext, DirContextSource, DirNode } from './visibility.ts';

const OWNER = 1002;

function row(seq: number, owner = OWNER): FeedRow {
  return {
    ownerUid: owner,
    seq,
    opId: uid7(0x9500, seq),
    commitTime: '2026-11-14T06:00:00.000Z',
    lamport: seq,
    changes: [{ kind: 'upsert', ino: uid7(2, seq), version: seq }],
    dirs: [],
    purged: false,
  };
}

class MemoryFeed implements FeedReader, DirContextSource {
  rows: FeedRow[] = [];
  purged = 0;
  reads = 0;
  /** Awaited before a page is returned (lets tests interleave commits). */
  gate: (() => Promise<void>) | null = null;
  failNext = false;

  heads(owners: readonly number[]): Promise<ReadonlyMap<number, OwnerHead>> {
    const m = new Map<number, OwnerHead>();
    for (const o of owners)
      m.set(o, {
        feedSeq: this.rows.filter((r) => r.ownerUid === o).length + this.purged,
        purgedSeq: this.purged,
      });
    return Promise.resolve(m);
  }

  async page(owner: number, after: number, limit: number): Promise<readonly FeedRow[]> {
    this.reads++;
    if (this.gate !== null) await this.gate();
    if (this.failNext) {
      this.failNext = false;
      throw new Error('db down');
    }
    return this.rows
      .filter((r) => r.ownerUid === owner && r.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  load(): Promise<DirContext> {
    return Promise.resolve(new Map<string, DirNode>());
  }
}

class CaptureSink implements StreamSink {
  readonly got: number[] = [];
  readonly done: number[] = [];
  readonly snapshots: string[] = [];
  answer: (e: FeedEntry) => SendResult = () => 'sent';
  sendEntry(entry: FeedEntry): SendResult {
    const r = this.answer(entry);
    if (r === 'sent') this.got.push(entry.seq);
    return r;
  }
  sendResumeDone(_owner: number, head: number): void {
    this.done.push(head);
  }
  sendSnapshotRequired(owner: number, reason: string, head: number): void {
    this.snapshots.push(`${owner}:${reason}:${head}`);
  }
}

const entry = (seq: number, originConnId: string | null = null): FeedEntry => ({
  ...row(seq),
  originConnId,
  context: new Map(),
});

function committed(seq: number, owner = OWNER): CommittedOp {
  const r = row(seq, owner);
  return {
    opId: r.opId,
    originConnId: null,
    osSessionId: uid7(3, 9),
    ownerSeqs: [{ ownerUid: owner, seq }],
    commitTime: r.commitTime,
    lamport: seq,
    effects: { changes: r.changes, dirs: [] },
  };
}

describe('SYN-17 broadcaster order (§3.8.4 rule 4, §5.4)', () => {
  function setup() {
    const clock = new ManualClock();
    const feed = new MemoryFeed();
    const errors: string[] = [];
    const b = new Broadcaster({
      clock,
      reader: feed,
      dirs: feed,
      createHeap: testHeapFactory,
      onError: (_e, c) => errors.push(c),
    });
    const seen: number[] = [];
    const unsubscribe = b.subscribe({ connId: 'c1', deliver: (e) => seen.push(e.seq) });
    return { clock, feed, b, seen, unsubscribe, errors };
  }

  it('SYN-17 entries whose COMMIT promises resolve out of order are emitted in strictly increasing seq', async () => {
    const { b, seen } = setup();
    await b.committed(committed(1));
    await b.committed(committed(3));
    await b.committed(committed(4));
    expect(seen).toEqual([1]);
    await b.committed(committed(2));
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(b.nextSeq(OWNER)).toBe(5);
  });

  it('SYN-17 a predecessor that never arrives is read from the feed after 1 s and emitted in order', async () => {
    const { b, seen, clock, feed } = setup();
    feed.rows = [row(1), row(2), row(3)];
    await b.committed(committed(1));
    await b.committed(committed(3));
    expect(seen).toEqual([1]);
    await clock.advance(999);
    expect(seen).toEqual([1]);
    await clock.advance(1);
    await flush();
    expect(seen).toEqual([1, 2, 3]);
    await b.committed(committed(2)); // the late publish: receivers drop it by cursor
    expect(seen).toEqual([1, 2, 3, 2]);
  });

  it('SYN-17 an entry whose context cannot be loaded is recovered by the gap reader instead of being lost', async () => {
    const { b, seen, clock, feed, errors } = setup();
    feed.rows = [row(1)];
    const failing = new Broadcaster({
      clock,
      reader: feed,
      dirs: { load: () => Promise.reject(new Error('down')) },
      createHeap: testHeapFactory,
      onError: (_e, c) => errors.push(c),
    });
    const got: number[] = [];
    failing.subscribe({ connId: 'x', deliver: (e) => got.push(e.seq) });
    const withChanges = committed(1);
    await failing.committed({
      ...withChanges,
      effects: {
        changes: [{ kind: 'upsert', ino: uid7(2, 1), version: 1, parentIno: uid7(1, 1) }],
        dirs: [],
      },
    });
    expect(errors).toContain('broadcast-context');
    feed.rows = [{ ...row(1), changes: [] }];
    await clock.advance(1_000);
    await flush();
    expect(got).toEqual([1]);
    expect(seen).toEqual([]);
    failing.stop();
    b.stop();
  });

  it('SYN-17 a subscriber that throws does not stop delivery to the others; unsubscribe stops delivery', async () => {
    const { b, seen, unsubscribe, errors } = setup();
    b.subscribe({
      connId: 'bad',
      deliver: () => {
        throw new Error('boom');
      },
    });
    await b.committed(committed(1));
    expect(seen).toEqual([1]);
    expect(errors).toContain('deliver');
    unsubscribe();
    await b.committed(committed(2));
    expect(seen).toEqual([1]);
    expect(b.subscribers).toBe(1);
  });

  it('SYN-17 a gap-read failure is reported and retried', async () => {
    const { b, seen, clock, feed, errors } = setup();
    feed.rows = [row(1), row(2), row(3)];
    await b.committed(committed(1));
    await b.committed(committed(3));
    feed.failNext = true;
    await clock.advance(1_000);
    await flush();
    expect(errors).toContain('broadcast-gap');
    await clock.advance(1_000);
    await flush();
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('SYN-05 per-owner resume (§3.8.4 server rules 1-3)', () => {
  it('SYN-05 stream inside [purged, head], snapshot below the horizon, reset above the head', () => {
    expect(resumeMode(0, { feedSeq: 10, purgedSeq: 0 })).toEqual({ mode: 'stream' });
    expect(resumeMode(10, { feedSeq: 10, purgedSeq: 5 })).toEqual({ mode: 'stream' });
    expect(resumeMode(5, { feedSeq: 10, purgedSeq: 5 })).toEqual({ mode: 'stream' });
    expect(resumeMode(4, { feedSeq: 10, purgedSeq: 5 })).toEqual({
      mode: 'snapshot',
      reason: 'horizon',
    });
    expect(resumeMode(11, { feedSeq: 10, purgedSeq: 0 })).toEqual({
      mode: 'snapshot',
      reason: 'reset',
    });
    expect(snapshotUrl(1002)).toBe('/api/sync/snapshot?scope=owner&owner=1002');
  });

  it('SYN-05 streaming respects FEED_WINDOW: at most the window is sent before an ack, then resume.done at the head', async () => {
    const feed = new MemoryFeed();
    feed.rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const sink = new CaptureSink();
    const s = new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 0,
      connId: 'c',
      reader: feed,
      dirs: feed,
      sink,
      feedWindow: 4,
    });
    void s.start();
    await flush();
    expect(sink.got).toEqual([1, 2, 3, 4]);
    s.ack(4);
    await flush();
    expect(sink.got).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    s.ack(8);
    await flush();
    expect(sink.got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sink.done).toEqual([10]);
    expect(s.state).toBe('live');
    s.live(entry(11));
    s.live(entry(11)); // a duplicate is dropped
    s.live(entry(9)); // an old one too
    s.live({ ...entry(12), ownerUid: 7 }); // another owner's entry is not this stream's
    expect(sink.got.at(-1)).toBe(11);
    expect(s.cursor).toBe(11);
  });

  it('SYN-17 entries committed while a connection streams its backlog are delivered once and in order (fast-check interleavings)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 30 }),
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 7 }),
        async (backlog, bursts, page) => {
          const feed = new MemoryFeed();
          feed.rows = Array.from({ length: backlog }, (_, i) => row(i + 1));
          const sink = new CaptureSink();
          const stream = new OwnerStream({
            ownerUid: OWNER,
            fromSeq: 0,
            connId: 'c',
            reader: feed,
            dirs: feed,
            sink,
            feedWindow: 64,
            pageSize: page,
          });
          let next = backlog + 1;
          let burst = 0;
          // Before every page read, some transactions commit and are broadcast live.
          feed.gate = () => {
            const n = bursts[burst++] ?? 0;
            for (let i = 0; i < n; i++) {
              feed.rows.push(row(next));
              stream.live(entry(next));
              next++;
            }
            return Promise.resolve();
          };
          await stream.start();
          feed.gate = null;
          for (let i = 0; i < 3; i++) {
            feed.rows.push(row(next));
            stream.live(entry(next));
            next++;
          }
          const expected = Array.from({ length: next - 1 }, (_, i) => i + 1);
          expect(sink.got).toEqual(expected); // each (owner, seq) exactly once, increasing, no gap
          expect(stream.state).toBe('live');
        },
      ),
      { seed: 17, numRuns: 150 },
    );
  });

  it('SYN-17 over PENDING_LIVE_MAX buffered entries the list is dropped and streaming continues from the database', async () => {
    const feed = new MemoryFeed();
    feed.rows = [row(1), row(2)];
    const sink = new CaptureSink();
    const stream = new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 0,
      connId: 'c',
      reader: feed,
      dirs: feed,
      sink,
      pendingMax: 2,
      pageSize: 2,
    });
    let once = false;
    feed.gate = () => {
      if (!once) {
        once = true;
        for (let s = 3; s <= 7; s++) {
          feed.rows.push(row(s));
          stream.live(entry(s));
        }
      }
      return Promise.resolve();
    };
    await stream.start();
    expect(sink.got).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(stream.pending).toBe(0);
  });

  it('SYN-05 rows pruned between two pages (a gap) or a failing read end in snapshot.required', async () => {
    const feed = new MemoryFeed();
    feed.rows = [row(5), row(6)];
    const sink = new CaptureSink();
    const s = new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 2,
      connId: 'c',
      reader: feed,
      dirs: feed,
      sink,
    });
    await s.start();
    expect(sink.snapshots).toEqual([`${OWNER}:horizon:2`]);
    expect(s.state).toBe('snapshot');
    s.live(entry(7));
    await s.start();
    expect(sink.got).toEqual([]);

    const broken = new MemoryFeed();
    broken.failNext = true;
    const errors: unknown[] = [];
    const sink2 = new CaptureSink();
    const s2 = new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 0,
      connId: 'c',
      reader: broken,
      dirs: broken,
      sink: sink2,
      onError: (e) => errors.push(e),
    });
    await s2.start();
    expect(sink2.snapshots).toEqual([`${OWNER}:gap-unrecoverable:0`]);
    expect(errors).toHaveLength(1);

    const purged = new MemoryFeed();
    purged.rows = [{ ...row(1), purged: true }];
    const sink3 = new CaptureSink();
    await new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 0,
      connId: 'c',
      reader: purged,
      dirs: purged,
      sink: sink3,
    }).start();
    expect(sink3.snapshots).toEqual([`${OWNER}:horizon:0`]);
  });

  it('SYN-05 the originating connection is not sent its own op, but its cursor advances', async () => {
    const feed = new MemoryFeed();
    const sink = new CaptureSink();
    const s = new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 0,
      connId: 'me',
      reader: feed,
      dirs: feed,
      sink,
    });
    await s.start();
    expect(sink.done).toEqual([0]);
    s.live(entry(1, 'me'));
    s.live(entry(2, 'other'));
    expect(sink.got).toEqual([2]);
    expect(s.cursor).toBe(2);
  });

  it('SYN-12 a coalesced live entry switches the owner back to streaming from the database: nothing is lost', async () => {
    const feed = new MemoryFeed();
    const sink = new CaptureSink();
    const s = new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 0,
      connId: 'c',
      reader: feed,
      dirs: feed,
      sink,
    });
    await s.start();
    sink.answer = () => 'coalesced';
    feed.rows.push(row(1));
    s.live(entry(1));
    expect(sink.got).toEqual([]);
    sink.answer = () => 'sent';
    await flush();
    expect(sink.got).toEqual([1]);
    expect(s.state).toBe('live');
    s.coalesce();
    await flush();
    expect(s.state).toBe('live');
    sink.answer = () => 'closed';
    s.live(entry(2));
    expect(s.state).toBe('stopped');
  });

  it('SYN-05 stop ends a stream that is waiting for acks', async () => {
    const feed = new MemoryFeed();
    feed.rows = Array.from({ length: 5 }, (_, i) => row(i + 1));
    const sink = new CaptureSink();
    const s = new OwnerStream({
      ownerUid: OWNER,
      fromSeq: 0,
      connId: 'c',
      reader: feed,
      dirs: feed,
      sink,
      feedWindow: 2,
    });
    const done = s.start();
    await flush();
    s.stop();
    await done;
    expect(sink.got).toEqual([1, 2]);
    expect(s.state).toBe('stopped');
  });
});

describe('VFS-10 per-owner resume convergence', () => {
  it('VFS-10 bob edits /home/shared while alice is offline; after resume her mirror equals the server rows', async () => {
    const db = new FakeDb();
    const BOB = 1002;
    const SHARED = uid7(1, 3);
    db.addUser(0, 'root');
    db.addUser(1001, 'alice');
    db.addUser(BOB, 'bob');
    db.addDir(ROOT_DIR, null, '', 0);
    db.addDir(HOME, ROOT_DIR, 'home', 0);
    db.addDir(SHARED, HOME, 'shared', BOB, 0o755);
    const files = [uid7(2, 1), uid7(2, 2), uid7(2, 3)];
    files.forEach((f, i) =>
      db.addFile(f, SHARED, `f${i}.md`, BOB, { mode: 0o644, sha: sha(1), size: 1 }),
    );
    for (let i = 2; i < 40; i++) db.addBlob(sha(i), i);
    db.addSession(uid7(3, 2), BOB);
    const engine = new SyncEngine<FakeTx>({
      steps: db.steps,
      cancel: new CancelRegistry(),
      lockTimeoutMs: 1,
      statementTimeoutMs: 1,
      feed: db.feedSql,
      handlerFor: (s) => new ContentWriteHandler(db.content, s, { timeZone: 'UTC' }),
      sessions: { ownsOsSession: () => Promise.resolve(true) },
    });
    const bob: OpOrigin = {
      connId: 'b',
      uid: BOB,
      deviceId: null,
      mayActAs: (p) => p === BOB,
      gidsOf: (p) => [p],
    };
    // alice's mirror as of seq 0
    const mirror = new Map(files.map((f) => [f, 1]));
    const versions = new Map(files.map((f) => [f, 1]));
    for (let k = 0; k < 12; k++) {
      const f = files[k % files.length] ?? '';
      const base = versions.get(f) ?? 1;
      const r = await engine.applyOp(
        bob,
        writeOp({
          opId: uid7(0x9600, k),
          osSessionId: uid7(3, 2),
          cseq: k + 1,
          principal: BOB,
          ino: f,
          sha: sha(k + 2),
          size: k + 2,
          baseVersion: base,
        }),
      );
      versions.set(f, r.versions?.[0]?.version ?? -1);
    }
    const sink: StreamSink = {
      sendEntry: (e) => {
        for (const c of e.changes as Change[])
          if (mirror.has(c.ino) && c.version > (mirror.get(c.ino) ?? 0))
            mirror.set(c.ino, c.version);
        return 'sent';
      },
      sendResumeDone: () => undefined,
      sendSnapshotRequired: () => undefined,
    };
    await new OwnerStream({
      ownerUid: BOB,
      fromSeq: 0,
      connId: 'alice',
      reader: db.reader,
      dirs: db.reader,
      sink,
    }).start();
    for (const f of files) expect(mirror.get(f)).toBe(db.inode(f)?.version);
    expect(db.feedIsGapFree()).toBe(true);
  });
});
