/**
 * The storage port of `syncd` and its product implementation over the device `Store`
 * (virtual-file-system.md §3.13, §4.6; offline-and-sync.md §4.8). Every mutation is ONE strict
 * transaction built synchronously (C4): result application, remote apply, cursor and Lamport
 * writes, the `attempts` counter. Reads that a transaction cannot do (listing a directory for a
 * subtree eviction) happen in chunked read-only scans first.
 */
import type { Change, FeedCursor } from '@plotinium/protocol';

import type { StoreWrite } from '../ops/plan.ts';
import type { BlobRec, DentryRec, InodeRec, MetaRec, OutboxRec } from '../store/records.ts';
import { dirBounds } from '../store/store.ts';
import type { AnyStoreName, Store } from '../store/store.ts';
import { LAMPORT_KEY, metaNumber } from './lamport.ts';
import type { RemoteContext, RemoteOutput, SubtreeRows } from './remote.ts';
import { buildRemote, subtreeRoots } from './remote.ts';
import type { ClosureMember, ResultOutput, TxContext } from './results.ts';
import {
  buildAck,
  buildConflict,
  buildLocalCancel,
  buildReject,
  buildRevertedResult,
  cursorSeq,
  writeMeta,
} from './results.ts';
import type { SyncKeptAs, OpResultBody } from './types.ts';

/** How a final result is applied (chosen by syncd from the record and the result). */
export type ResultRequest =
  | {
      readonly kind: 'ack';
      readonly rec: OutboxRec;
      readonly result: OpResultBody;
      readonly ctx: TxContext;
    }
  | {
      readonly kind: 'conflict';
      readonly rec: OutboxRec;
      readonly result: OpResultBody;
      readonly keptAs: SyncKeptAs;
      readonly ctx: TxContext;
    }
  | {
      readonly kind: 'reject';
      readonly rec: OutboxRec;
      readonly result: OpResultBody;
      readonly members: readonly ClosureMember[];
      readonly ctx: TxContext;
    }
  | {
      readonly kind: 'reverted';
      readonly rec: OutboxRec;
      readonly result: OpResultBody;
      readonly ctx: TxContext;
    }
  | {
      readonly kind: 'cancel';
      readonly rec: OutboxRec;
      readonly members: readonly ClosureMember[];
      readonly ctx: TxContext;
    };

export interface ResultEffect {
  readonly writes: readonly StoreWrite[];
  readonly refetch: readonly string[];
  readonly rewritten: readonly OutboxRec[];
  readonly deleted: readonly string[];
  readonly parked: boolean;
}

export interface RemoteRequest {
  readonly touched: ReadonlySet<string>;
  readonly mirroredOwners: ReadonlySet<number>;
  /** Snapshot pages: directories whose full entry set the page carries. */
  readonly completeDir?: (row: InodeRec) => boolean;
}

export interface RemoteEffect {
  readonly writes: readonly StoreWrite[];
  readonly deferred: readonly Change[];
  readonly refetch: readonly string[];
  readonly seen: ReadonlySet<string>;
}

/** Everything `syncd` needs from the device database. */
export interface SyncStorage {
  /** Every outbox record, in commit (`seq`) order. */
  loadOutbox(): Promise<OutboxRec[]>;
  /** Per-owner feed cursors (`meta.resume:<ownerUid>`). */
  loadCursors(): Promise<Map<number, number>>;
  loadLamport(): Promise<number>;
  applyResult(req: ResultRequest): Promise<ResultEffect>;
  applyChanges(
    changes: readonly Change[],
    req: RemoteRequest,
    tx: TxContext,
  ): Promise<RemoteEffect>;
  /** Cursor and Lamport writes alone (own entries, snapshots, hello.ok). */
  writeMeta(tx: TxContext): Promise<void>;
  /** Persist `attempts + 1` before a frame leaves (a cascade never deletes a possibly-applied op). */
  noteSent(recs: readonly OutboxRec[]): Promise<OutboxRec[]>;
  blobUploaded(sha: string): Promise<boolean>;
  setUploaded(sha: string, uploaded: boolean): Promise<void>;
  /** The directories to snapshot so that `inos` are re-read (a directory itself, or a file's parents). */
  dirsOf(inos: readonly string[]): Promise<string[]>;
  /** A parked record the user discarded (audited by the caller): delete it and release its pin. */
  discardParked(rec: OutboxRec, now: number): Promise<void>;
}

const OUTBOX_ALL = { lower: 0, upper: Number.MAX_SAFE_INTEGER } as const;
const RESUME_KEYS = { lower: 'resume:', upper: 'resume:￿' } as const;
const SCOPE_RESULT: readonly AnyStoreName[] = [
  'inodes',
  'dentries',
  'blobs',
  'users',
  'undo',
  'outbox',
  'meta',
];

function effectOf(out: ResultOutput): ResultEffect {
  return {
    writes: out.log.writes,
    refetch: [...out.refetch],
    rewritten: [...out.rewritten.values()],
    deleted: [...out.deleted],
    parked: out.parked,
  };
}

function remoteEffectOf(out: RemoteOutput): RemoteEffect {
  return {
    writes: out.log.writes,
    deferred: out.deferred,
    refetch: [...out.refetch],
    seen: out.seen,
  };
}

/** `SyncStorage` over the VFS `Store` (IdbStore in the product; the same class in tests). */
export class StoreSyncStorage implements SyncStorage {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async loadOutbox(): Promise<OutboxRec[]> {
    const out: OutboxRec[] = [];
    await this.store.scan<OutboxRec>('outbox', OUTBOX_ALL, (r) => out.push(r));
    return out;
  }

  async loadCursors(): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    await this.store.scan<MetaRec>('meta', RESUME_KEYS, (m) => {
      const uid = Number(m.k.slice('resume:'.length));
      if (Number.isSafeInteger(uid) && uid >= 0) out.set(uid, cursorSeq(m));
    });
    return out;
  }

  async loadLamport(): Promise<number> {
    return metaNumber(await this.store.get<MetaRec>('meta', LAMPORT_KEY));
  }

  async applyResult(req: ResultRequest): Promise<ResultEffect> {
    let out: ResultOutput | null = null;
    await this.store.tx(
      SCOPE_RESULT,
      'strict',
      (t) => {
        switch (req.kind) {
          case 'ack':
            out = buildAck(t, req.rec, req.result, req.ctx);
            break;
          case 'conflict':
            out = buildConflict(t, req.rec, req.result, req.keptAs, req.ctx);
            break;
          case 'reject':
            out = buildReject(t, req.rec, req.members, req.result, req.ctx);
            break;
          case 'reverted':
            out = buildRevertedResult(t, req.rec, req.result, req.ctx);
            break;
          case 'cancel':
            out = buildLocalCancel(t, req.rec, req.members, req.ctx);
            break;
        }
      },
      { label: `sync:${req.kind}` },
    );
    if (out === null) throw new Error('result transaction built nothing');
    return effectOf(out);
  }

  async applyChanges(
    changes: readonly Change[],
    req: RemoteRequest,
    tx: TxContext,
  ): Promise<RemoteEffect> {
    const subtrees = await this.readSubtrees(changes);
    const ctx: RemoteContext = {
      touched: req.touched,
      mirroredOwners: req.mirroredOwners,
      subtrees,
      ...(req.completeDir === undefined ? {} : { completeDir: req.completeDir }),
    };
    let out: RemoteOutput | null = null;
    // Remote apply is relaxed (VFS §3.11): re-applying after a crash is harmless (version rule).
    await this.store.tx(
      ['inodes', 'dentries', 'blobs', 'meta'],
      'relaxed',
      (t) => {
        out = buildRemote(t, changes, ctx, tx);
      },
      { label: 'sync:remote' },
    );
    if (out === null) throw new Error('remote transaction built nothing');
    return remoteEffectOf(out);
  }

  async writeMeta(tx: TxContext): Promise<void> {
    if (tx.cursors.length === 0 && tx.lamport === null) return;
    await this.store.tx(['meta'], 'strict', (t) => writeMeta(t, tx), { label: 'sync:meta' });
  }

  async noteSent(recs: readonly OutboxRec[]): Promise<OutboxRec[]> {
    const next = recs.map((r) => ({ ...r, attempts: r.attempts + 1 }));
    await this.store.tx(
      ['outbox'],
      'strict',
      (t) => {
        for (const r of next) {
          // Only rewrite a record that still exists (a result may have deleted it meanwhile).
          if (r.seq === undefined) continue;
          t.get<OutboxRec>('outbox', r.seq, undefined, (cur) => {
            if (cur?.opId === r.opId) t.put('outbox', { ...cur, attempts: cur.attempts + 1 });
          });
        }
      },
      { label: 'sync:sent' },
    );
    return next;
  }

  async blobUploaded(sha: string): Promise<boolean> {
    const b = await this.store.get<BlobRec>('blobs', sha);
    return b?.uploaded === true;
  }

  async setUploaded(sha: string, uploaded: boolean): Promise<void> {
    await this.store.tx(
      ['blobs'],
      'relaxed',
      (t) => {
        t.get<BlobRec>('blobs', sha, undefined, (b) => {
          if (b !== undefined && b.uploaded !== uploaded) t.put('blobs', { ...b, uploaded });
        });
      },
      { label: 'sync:uploaded' },
    );
  }

  async dirsOf(inos: readonly string[]): Promise<string[]> {
    const rows = await this.store.getMany<InodeRec>('inodes', inos);
    const dirs = new Set<string>();
    for (let i = 0; i < inos.length; i++) {
      const ino = inos[i];
      if (ino === undefined) continue;
      const row = rows[i];
      if (row?.type === 'd') {
        dirs.add(ino);
        continue;
      }
      for (const d of await this.store.getByIndex<DentryRec>('dentries', 'by_ino', ino))
        dirs.add(d.parent);
    }
    return [...dirs];
  }

  async discardParked(rec: OutboxRec, now: number): Promise<void> {
    await this.store.tx(
      ['outbox', 'blobs'],
      'strict',
      (t) => {
        if (rec.seq !== undefined) t.del('outbox', rec.seq);
        for (const sha of rec.blobs) {
          t.get<BlobRec>('blobs', sha, undefined, (b) => {
            if (b === undefined) return;
            const refcount = Math.max(0, b.refcount - 1);
            t.put(
              'blobs',
              refcount === 0
                ? { ...b, refcount, zeroSince: b.zeroSince ?? now }
                : { ...b, refcount },
            );
          });
        }
      },
      { label: 'sync:discard' },
    );
  }

  /** Descendants of every directory the changes may remove (chunked read-only scans). */
  private async readSubtrees(changes: readonly Change[]): Promise<Map<string, SubtreeRows>> {
    const candidates = changes.filter((c) => c.kind !== 'upsert').map((c) => c.ino);
    const out = new Map<string, SubtreeRows>();
    if (candidates.length === 0) return out;
    const rows = await this.store.getMany<InodeRec>('inodes', candidates);
    const types = new Map<string, 'f' | 'd' | 'l'>();
    candidates.forEach((ino, i) => {
      const r = rows[i];
      if (r !== undefined) types.set(ino, r.type);
    });
    for (const root of subtreeRoots(changes, (ino) => types.get(ino))) {
      const inodes: InodeRec[] = [];
      const dentries: DentryRec[] = [];
      const queue = [root];
      const seen = new Set<string>([root]);
      while (queue.length > 0) {
        const dir = queue.shift();
        if (dir === undefined) break;
        const kids: DentryRec[] = [];
        await this.store.scan<DentryRec>('dentries', dirBounds(dir), (d) => kids.push(d));
        dentries.push(...kids);
        const recs = await this.store.getMany<InodeRec>(
          'inodes',
          kids.map((d) => d.ino),
        );
        for (const r of recs) {
          if (r === undefined || seen.has(r.ino)) continue;
          seen.add(r.ino);
          inodes.push(r);
          if (r.type === 'd') queue.push(r.ino);
        }
      }
      out.set(root, { inodes, dentries });
    }
    return out;
  }
}

/** The cursor list for a transaction context. */
export function txContext(
  now: number,
  timeZone: string,
  cursors: readonly FeedCursor[] = [],
  lamport: number | null = null,
): TxContext {
  return { now, timeZone, cursors, lamport };
}
