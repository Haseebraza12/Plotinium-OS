/**
 * Incremental index bookkeeping of `ai.indexer` (rag-semantic-search.md §3.2.1, §3.3).
 *
 * - A content change re-chunks the file and embeds ONLY chunks whose `contentHash` is not already
 *   stored (`ai.index.lookup`); known hashes are sent as `reuseOf`, so their vectors are reused.
 * - A rename changes nothing stored (the header holds no file name).
 * - Unlink drops the file's rows; chmod needs nothing (the filter reads the live tree).
 * - Chunk text (`preview`, BM25 `terms`) goes into `ai.index.put` only for files the session uid
 *   owns (I-A3); the kernel rejects it otherwise with EPERM.
 * - Reconciliation at start compares `(ino, inodeVersion)` with the live tree and enqueues stale or
 *   missing files, and drops inos that no longer exist.
 */
import type { IndexPut } from '@plotinium/protocol';

import { termFrequencies } from '../search/bm25.ts';
import { makeSnippet } from '../search/citations.ts';
import { type ChunkDraft, chunkText } from './chunker.ts';
import type { TextKind } from './extract.ts';
import { contentHash, contentHashSync } from './hash.ts';
import { type TokenCounter, approxWordPiece } from './tokens.ts';

export interface HashedChunk extends ChunkDraft {
  contentHash: string;
}

type IndexChunk = IndexPut['chunks'][number];

/** Chunk a file and hash every chunk (chunker-v1 + SHA-256 per chunk). */
export async function hashChunks(
  text: string,
  kind: TextKind,
  modelKey: string,
  counter: TokenCounter = approxWordPiece,
): Promise<HashedChunk[]> {
  const drafts = chunkText(text, kind, counter);
  const out: HashedChunk[] = [];
  for (const d of drafts)
    out.push({ ...d, contentHash: await contentHash(modelKey, d.header, d.text) });
  return out;
}

/** `hashChunks` without `await` (executor programs), same result. */
export function hashChunksSync(
  text: string,
  kind: TextKind,
  modelKey: string,
  counter: TokenCounter = approxWordPiece,
): HashedChunk[] {
  return chunkText(text, kind, counter).map((d) => ({
    ...d,
    contentHash: contentHashSync(modelKey, d.header, d.text),
  }));
}

export interface UpdatePlan {
  ino: string;
  inodeVersion: number;
  modelKey: string;
  own: boolean;
  chunks: HashedChunk[];
  /** Distinct hashes that must be embedded, in first-occurrence order. */
  toEmbed: HashedChunk[];
  reused: number;
}

/**
 * Decide which chunks need an embedding. `known[i]` answers `ai.index.lookup` for the i-th
 * distinct hash; a hash repeated inside the file is embedded once.
 */
export function planUpdate(args: {
  ino: string;
  inodeVersion: number;
  modelKey: string;
  own: boolean;
  chunks: HashedChunk[];
  known: ReadonlySet<string>;
}): UpdatePlan {
  const toEmbed: HashedChunk[] = [];
  const queued = new Set<string>();
  let reused = 0;
  for (const c of args.chunks) {
    if (args.known.has(c.contentHash)) reused++;
    else if (!queued.has(c.contentHash)) {
      queued.add(c.contentHash);
      toEmbed.push(c);
    }
  }
  return { ...args, toEmbed, reused };
}

/** The distinct hashes of a chunk list, for `ai.index.lookup` (at most 512 per call). */
export function distinctHashes(chunks: readonly HashedChunk[]): string[] {
  return [...new Set(chunks.map((c) => c.contentHash))];
}

/**
 * Build `ai.index.put`. `vectors` holds the new embeddings by hash; any other chunk reuses a stored
 * vector. Returns undefined when a needed vector is missing (the job is retried).
 */
export function buildIndexPut(
  plan: UpdatePlan,
  vectors: ReadonlyMap<string, Float32Array<ArrayBuffer>>,
): IndexPut | undefined {
  const chunks: IndexChunk[] = [];
  for (const c of plan.chunks) {
    const chunk: IndexChunk = {
      seq: c.seq,
      byteStart: c.byteStart,
      byteEnd: c.byteEnd,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      header: c.header,
      contentHash: c.contentHash,
    };
    const vector = vectors.get(c.contentHash);
    if (vector !== undefined) chunk.vector = vector;
    else if (plan.toEmbed.some((e) => e.contentHash === c.contentHash)) return undefined;
    else chunk.reuseOf = c.contentHash;
    if (plan.own) {
      chunk.preview = makeSnippet(c.text);
      chunk.terms = termFrequencies(c.text);
    }
    chunks.push(chunk);
  }
  return { ino: plan.ino, inodeVersion: plan.inodeVersion, modelKey: plan.modelKey, chunks };
}

export type VfsTopic =
  'vfs.create' | 'vfs.write' | 'vfs.rename' | 'vfs.unlink' | 'vfs.chmod' | 'vfs.chown';

/** What the indexer does for a VFS event (§3.3 table). */
export type EventAction = 'reindex' | 'drop' | 'none' | 'drop-old-owner-text';

export function actionFor(topic: VfsTopic, lastLink = true): EventAction {
  switch (topic) {
    case 'vfs.create':
    case 'vfs.write':
      return 'reindex';
    case 'vfs.unlink':
      return lastLink ? 'drop' : 'none';
    case 'vfs.chown':
      return 'drop-old-owner-text';
    case 'vfs.rename':
    case 'vfs.chmod':
      return 'none';
  }
}

export const DEBOUNCE_MS = 1_500;

/** Per-ino 1.5 s debounce that coalesces bursts such as editor autosave (§3.2.1). */
export class Debouncer {
  private readonly due = new Map<string, number>();
  private readonly delayMs: number;

  constructor(delayMs = DEBOUNCE_MS) {
    this.delayMs = delayMs;
  }

  touch(ino: string, now: number): void {
    this.due.set(ino, now + this.delayMs);
  }

  cancel(ino: string): void {
    this.due.delete(ino);
  }

  /** Inos whose quiet period ended, removed from the debouncer, earliest first. */
  take(now: number): string[] {
    const ready = [...this.due.entries()].filter(([, t]) => t <= now).sort((a, b) => a[1] - b[1]);
    for (const [ino] of ready) this.due.delete(ino);
    return ready.map(([ino]) => ino);
  }

  get pending(): number {
    return this.due.size;
  }
}

export interface IndexedFile {
  ino: string;
  inodeVersion: number;
}

export interface LiveFile {
  ino: string;
  version: number;
  /** Eligible under §3.2.2 rules 1 and 4 (the path and extension checks). */
  eligible: boolean;
}

export interface Reconciliation {
  /** Stale or missing files, to (re)index. */
  enqueue: string[];
  /** Indexed inos that no longer exist or are no longer eligible. */
  drop: string[];
  /** Everything, when the model key changed (class `backfill`). */
  backfill: boolean;
}

/** Reconciliation at start (§3.2.1): the index against the current tree. */
export function reconcile(
  indexed: readonly IndexedFile[],
  live: readonly LiveFile[],
  indexModelKey: string,
  currentModelKey: string,
): Reconciliation {
  const liveByIno = new Map(live.map((f) => [f.ino, f]));
  const indexedByIno = new Map(indexed.map((f) => [f.ino, f]));
  const backfill = indexModelKey !== currentModelKey;
  const drop = indexed.filter((f) => liveByIno.get(f.ino)?.eligible !== true).map((f) => f.ino);
  const enqueue = live
    .filter((f) => f.eligible)
    .filter((f) => backfill || indexedByIno.get(f.ino)?.inodeVersion !== f.version)
    .map((f) => f.ino);
  return { enqueue, drop, backfill };
}
