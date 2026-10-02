/**
 * The kernel-side semantic index (rag-semantic-search.md §3.4; the `ai_files`, `ai_chunks`,
 * `ai_vecseg`, `ai_text` and `ai_lex` stores held in memory).
 *
 * - One dense FILE TABLE `fileIdx → {ino, inodeVersion}`; the readable set is a bitset over it.
 * - Vectors in `VectorIndex` segments of ONE model space (I-A5); a model change resets the index
 *   (the indexer re-embeds everything in class `backfill`).
 * - Chunk metadata without text; per-uid previews and BM25 postings ONLY for files the uid owns
 *   (I-A3): `put` rejects `preview`/`terms` from a caller that does not own the file (EPERM).
 * - `put` replaces a file's whole chunk set at once (I-A6): readers see the old or the new set.
 * - A Bloom filter over live content hashes (the team's `dsa/bloom`) answers "certainly new"
 *   without a map lookup (§3.9); it never takes part in a permission decision.
 *
 * Durability: this wave keeps the index in memory; after a reboot the indexer's reconciliation
 * re-embeds the user's files in the background at PRI 32 (the model is local). The IndexedDB
 * stores of §3.4 are a TODO(R2) behind the same class.
 */
import { DoubleHashBloom } from '@plotinium/dsa/bloom';
import type { IndexPut, IndexStatus } from '@plotinium/protocol';

import { Bm25Index } from '../search/bm25.ts';
import { VectorIndex } from '../search/vector-index.ts';
import type { FileSlot } from '../search/readable.ts';
import type { ChunkMeta } from '../search/results.ts';
import { type Result, fail, ok } from '../util/errors.ts';

export interface ChunkRec {
  readonly fileIdx: number;
  readonly seq: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly contentHash: string;
  readonly inodeVersion: number;
  /** Global vector row. */
  readonly row: number;
}

interface FileRec {
  fileIdx: number;
  ino: string;
  inodeVersion: number;
  owner: number;
  chunks: ChunkRec[];
  indexedAt: number;
}

const BLOOM_DESIGN = 16_384;

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const chunkKey = (ino: string, seq: number): string => `${ino}#${String(seq)}`;

export interface PutContext {
  /** The caller's effective uid (the indexer runs as the session uid). */
  readonly uid: number;
  /** The file's owner and version NOW (from the live tree); undefined when it no longer exists. */
  readonly current: { owner: number; version: number } | undefined;
  readonly now: number;
}

export class SemanticIndex {
  private model: string;
  private vectors: VectorIndex;
  private readonly files = new Map<string, FileRec>();
  private readonly slots: (FileSlot | undefined)[] = [];
  private readonly chunks = new Map<string, ChunkRec>();
  /** contentHash → live rows carrying it (vector reuse, `ai.index.lookup`). */
  private readonly byHash = new Map<string, Set<number>>();
  private readonly lex = new Map<number, Bm25Index>();
  /** `${uid}|${ino}#${seq}` → preview (≤ 240 chars), own files only. */
  private readonly previews = new Map<string, string>();
  private bloom: DoubleHashBloom;
  private bloomDesign = BLOOM_DESIGN;
  private liveHashes = 0;
  /** Bumped on every change of the file table (part of the readable-set cache key). */
  private gen = 0;

  constructor(modelKey: string) {
    this.model = modelKey;
    this.vectors = new VectorIndex(modelKey);
    this.bloom = new DoubleHashBloom({ nDesign: BLOOM_DESIGN });
  }

  get modelKey(): string {
    return this.model;
  }

  get generation(): number {
    return this.gen;
  }

  get fileTable(): readonly (FileSlot | undefined)[] {
    return this.slots;
  }

  get vectorIndex(): VectorIndex {
    return this.vectors;
  }

  get indexedFiles(): number {
    return this.files.size;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  /** A new model space: everything is dropped and re-indexed in the background (§3.3 last row). */
  resetModel(modelKey: string): void {
    if (modelKey === this.model) return;
    this.model = modelKey;
    this.vectors = new VectorIndex(modelKey);
    this.files.clear();
    this.slots.length = 0;
    this.chunks.clear();
    this.byHash.clear();
    this.lex.clear();
    this.previews.clear();
    this.bloom = new DoubleHashBloom({ nDesign: BLOOM_DESIGN });
    this.bloomDesign = BLOOM_DESIGN;
    this.liveHashes = 0;
    this.gen++;
  }

  /** `ai.index.lookup`: whether each hash already has a stored vector (Bloom first). */
  lookup(hashes: readonly string[]): boolean[] {
    return hashes.map((h) => {
      if (!/^[0-9a-f]{64}$/.test(h)) return false;
      if (!this.bloom.mayContain(hexBytes(h))) return false;
      return (this.byHash.get(h)?.size ?? 0) > 0;
    });
  }

  private vectorForHash(hash: string): Float32Array | undefined {
    for (const row of this.byHash.get(hash) ?? []) {
      const v = this.vectors.vectorOf(row);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  private addHash(hash: string, row: number): void {
    let rows = this.byHash.get(hash);
    if (rows === undefined) {
      rows = new Set();
      this.byHash.set(hash, rows);
      this.liveHashes++;
      if (this.liveHashes > this.bloomDesign) {
        this.bloomDesign *= 2;
        this.bloom = new DoubleHashBloom({ nDesign: this.bloomDesign });
        for (const h of this.byHash.keys()) this.bloom.add(hexBytes(h));
      } else this.bloom.add(hexBytes(hash));
    }
    rows.add(row);
  }

  private dropHash(hash: string, row: number): void {
    const rows = this.byHash.get(hash);
    if (rows === undefined) return;
    rows.delete(row);
    if (rows.size === 0) {
      this.byHash.delete(hash);
      this.liveHashes--;
    }
  }

  private removeRows(rec: FileRec): void {
    const lex = this.lex.get(rec.owner);
    for (const c of rec.chunks) {
      this.vectors.tombstone(c.row);
      this.dropHash(c.contentHash, c.row);
      this.chunks.delete(chunkKey(rec.ino, c.seq));
      lex?.remove(c.row);
    }
    for (const key of [...this.previews.keys()])
      if (key.includes(`|${rec.ino}#`)) this.previews.delete(key);
  }

  /**
   * `ai.index.put`: validate everything first, then replace the file's chunk set in one step.
   * EAGAIN when the inode changed (or is gone) since the indexer read it; EPERM for text of a
   * file the caller does not own (I-A3); EINVAL for another model space, a bad vector or a reuse
   * of a hash that is not stored.
   */
  put(p: IndexPut, ctx: PutContext): Result<{ rows: number }> {
    if (p.modelKey !== this.model) return fail('EINVAL', 'model-key');
    if (ctx.current === undefined || ctx.current.version !== p.inodeVersion)
      return fail('EAGAIN', 'stale');
    const own = ctx.current.owner === ctx.uid;
    const vectors: Float32Array[] = [];
    for (const c of p.chunks) {
      if (!own && (c.preview !== undefined || c.terms !== undefined))
        return fail('EPERM', 'foreign-text');
      let v: Float32Array | undefined = c.vector;
      if (v === undefined && c.reuseOf !== undefined) v = this.vectorForHash(c.reuseOf);
      if (v === undefined) return fail('EINVAL', 'missing-vector');
      vectors.push(v);
    }
    const old = this.files.get(p.ino);
    // Validate the vectors against a scratch index before touching the live one (I-A6).
    const probe = new VectorIndex(this.model);
    for (const v of vectors) if (!probe.append(0, 0, v).ok) return fail('EINVAL', 'bad-vector');

    let fileIdx: number;
    if (old !== undefined) {
      this.removeRows(old);
      fileIdx = old.fileIdx;
    } else {
      fileIdx = this.slots.length;
      this.slots.push(undefined);
    }
    let lex = this.lex.get(ctx.current.owner);
    if (lex === undefined && own) {
      lex = new Bm25Index();
      this.lex.set(ctx.current.owner, lex);
    }
    const recs: ChunkRec[] = [];
    p.chunks.forEach((c, i) => {
      const v = vectors[i];
      if (v === undefined) return;
      const appended = this.vectors.append(fileIdx, c.seq, v);
      if (!appended.ok) return;
      const rec: ChunkRec = {
        fileIdx,
        seq: c.seq,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        byteStart: c.byteStart,
        byteEnd: c.byteEnd,
        contentHash: c.contentHash,
        inodeVersion: p.inodeVersion,
        row: appended.value,
      };
      recs.push(rec);
      this.chunks.set(chunkKey(p.ino, c.seq), rec);
      this.addHash(c.contentHash, appended.value);
      if (own && c.preview !== undefined)
        this.previews.set(`${String(ctx.uid)}|${chunkKey(p.ino, c.seq)}`, c.preview);
      if (own && c.terms !== undefined) lex?.put(appended.value, fileIdx, c.seq, c.terms);
    });
    this.files.set(p.ino, {
      fileIdx,
      ino: p.ino,
      inodeVersion: p.inodeVersion,
      owner: ctx.current.owner,
      chunks: recs,
      indexedAt: ctx.now,
    });
    this.slots[fileIdx] = { ino: p.ino, inodeVersion: p.inodeVersion };
    this.gen++;
    return ok({ rows: recs.length });
  }

  /** `ai.index.drop`: tombstone the rows and forget the text of these inodes. */
  drop(inos: readonly string[]): number {
    let rows = 0;
    for (const ino of inos) {
      const rec = this.files.get(ino);
      if (rec === undefined) continue;
      rows += rec.chunks.length;
      this.removeRows(rec);
      this.files.delete(ino);
      this.slots[rec.fileIdx] = undefined;
    }
    if (rows > 0) this.gen++;
    return rows;
  }

  /** chown: the old owner's text for `ino` goes (I-A3); vectors stay (they hold no text). */
  dropOwnerText(ino: string, newOwner: number): void {
    const rec = this.files.get(ino);
    if (rec === undefined || rec.owner === newOwner) return;
    const lex = this.lex.get(rec.owner);
    for (const c of rec.chunks) lex?.remove(c.row);
    for (const key of [...this.previews.keys()])
      if (key.startsWith(`${String(rec.owner)}|${ino}#`)) this.previews.delete(key);
    rec.owner = newOwner;
  }

  fileOf(ino: string): { fileIdx: number; inodeVersion: number; owner: number } | undefined {
    const rec = this.files.get(ino);
    return rec === undefined
      ? undefined
      : { fileIdx: rec.fileIdx, inodeVersion: rec.inodeVersion, owner: rec.owner };
  }

  chunkMeta(ino: string, seq: number): ChunkMeta | undefined {
    const c = this.chunks.get(chunkKey(ino, seq));
    return c === undefined
      ? undefined
      : { lineStart: c.lineStart, lineEnd: c.lineEnd, inodeVersion: c.inodeVersion };
  }

  preview(uid: number, ino: string, seq: number): string | undefined {
    return this.previews.get(`${String(uid)}|${chunkKey(ino, seq)}`);
  }

  /** The uid's own BM25 postings (empty when the uid owns nothing indexed). */
  lexOf(uid: number): Bm25Index {
    return this.lex.get(uid) ?? new Bm25Index();
  }

  /** `ai.index.status({files: true})`: what is indexed, for the indexer's reconciliation. */
  fileList(): NonNullable<IndexStatus['files']> {
    return [...this.files.values()].map((f) => ({
      ino: f.ino,
      inodeVersion: f.inodeVersion,
      state: 'indexed',
    }));
  }
}
