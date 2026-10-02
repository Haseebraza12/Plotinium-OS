/**
 * MemoryIndexDb: the IndexDb contract over an in-memory tree and chunk table, built on the
 * executable specification of the readable set (reference.ts). Unit tests use it; it has the same
 * semantics as KyselyIndexDb (the database-gated tests compare the two on the same graphs).
 */
import {
  readableTopDown,
  verifyUpward,
  type GraphDentry,
  type GraphInode,
  type PermGraph,
} from './reference.ts';
import type {
  FileMeta,
  IndexDb,
  IndexPutInput,
  PulledChunk,
  PullQuery,
  ReplaceOutcome,
  Requester,
  SearchHit,
  SearchQuery,
  VerifyItem,
  VerifyResult,
} from './types.ts';

export interface MemoryInode extends GraphInode {
  version: number;
  size: number;
  blobSha256: string | null;
}

export interface StoredChunk {
  readonly chunkId: number;
  readonly ino: string;
  readonly inodeVersion: number;
  readonly modelKey: string;
  readonly seq: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly header: string;
  readonly text: string;
  readonly contentHash: string;
  readonly embedding: Float32Array;
}

export class MemoryIndexDb implements IndexDb {
  readonly inodes = new Map<string, MemoryInode>();
  dentries: GraphDentry[] = [];
  chunks: StoredChunk[] = [];
  readonly rootIno: string;
  #nextId = 1;

  constructor(rootIno: string) {
    this.rootIno = rootIno;
  }

  graph(): PermGraph {
    return { rootIno: this.rootIno, inodes: this.inodes, dentries: this.dentries };
  }

  /** Deleting an inode cascades to its chunks (file_chunks_ino_fk ON DELETE CASCADE). */
  unlinkInode(ino: string): void {
    this.inodes.delete(ino);
    this.dentries = this.dentries.filter((d) => d.ino !== ino);
    this.chunks = this.chunks.filter((c) => c.ino !== ino);
  }

  fileMeta(ino: string): Promise<FileMeta | null> {
    const n = this.inodes.get(ino);
    return Promise.resolve(
      n === undefined
        ? null
        : {
            ino,
            type: n.type,
            mode: n.mode,
            uid: n.uid,
            gid: n.gid,
            version: n.version,
            size: n.size,
            blobSha256: n.blobSha256,
          },
    );
  }

  storedVersion(ino: string, modelKey: string): Promise<number | null> {
    let v: number | null = null;
    for (const c of this.chunks) {
      if (c.ino === ino && c.modelKey === modelKey) v = Math.max(v ?? 0, c.inodeVersion);
    }
    return Promise.resolve(v);
  }

  replaceChunks(input: IndexPutInput): Promise<ReplaceOutcome> {
    const n = this.inodes.get(input.ino);
    if (n === undefined || n.type !== 'f' || n.version !== input.inodeVersion) {
      return Promise.resolve({ ok: false, reason: 'stale-version' });
    }
    const old = this.chunks.filter((c) => c.ino === input.ino && c.modelKey === input.modelKey);
    const fresh: StoredChunk[] = [];
    for (const c of input.chunks) {
      const embedding = c.embedding ?? old.find((o) => o.contentHash === c.contentHash)?.embedding;
      if (embedding === undefined)
        return Promise.resolve({ ok: false, reason: 'missing-embedding', seq: c.seq });
      fresh.push({
        chunkId: 0,
        ino: input.ino,
        inodeVersion: input.inodeVersion,
        modelKey: input.modelKey,
        seq: c.seq,
        byteStart: c.byteStart,
        byteEnd: c.byteEnd,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        header: c.header,
        text: c.text,
        contentHash: c.contentHash,
        embedding,
      });
    }
    this.chunks = this.chunks.filter(
      (c) => !(c.ino === input.ino && c.modelKey === input.modelKey),
    );
    for (const c of fresh) this.chunks.push({ ...c, chunkId: this.#nextId++ });
    return Promise.resolve({ ok: true, rows: fresh.length });
  }

  pull(
    req: Requester,
    q: PullQuery,
  ): Promise<{ rows: readonly PulledChunk[]; manifestFiles: number }> {
    const readable = readableTopDown(this.graph(), req);
    const visible = this.chunks.filter((c) => c.modelKey === q.modelKey && readable.has(c.ino));
    const manifestFiles = new Set(visible.map((c) => c.ino)).size;
    const rows = visible
      .filter((c) => c.chunkId > q.after)
      .sort((a, b) => a.chunkId - b.chunkId)
      .slice(0, q.limit)
      .map((c): PulledChunk => {
        const owned = this.inodes.get(c.ino)?.uid === req.uid;
        return {
          chunkId: c.chunkId,
          ino: c.ino,
          inodeVersion: c.inodeVersion,
          seq: c.seq,
          byteStart: c.byteStart,
          byteEnd: c.byteEnd,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          header: owned ? c.header : '',
          contentHash: c.contentHash,
          modelKey: c.modelKey,
          owned,
          ...(owned ? { text: c.text } : {}),
          embedding: c.embedding,
        };
      });
    return Promise.resolve({ rows, manifestFiles });
  }

  search(req: Requester, q: SearchQuery): Promise<readonly SearchHit[]> {
    const readable = readableTopDown(this.graph(), req, q.scopeIno ?? null);
    const scored = this.chunks
      .filter((c) => c.modelKey === q.modelKey && readable.has(c.ino))
      .map((c) => ({ c, score: dot(c.embedding, q.vector) }))
      .sort((a, b) => b.score - a.score || cmp(a.c.ino, b.c.ino) || a.c.seq - b.c.seq)
      .slice(0, q.k);
    return Promise.resolve(
      scored.map(({ c, score }) => ({
        ino: c.ino,
        path: readable.get(c.ino) ?? '',
        seq: c.seq,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        score,
        snippet: snippetOf(c.text),
      })),
    );
  }

  verify(
    req: Requester,
    modelKey: string,
    items: readonly VerifyItem[],
  ): Promise<readonly VerifyResult[]> {
    const up = verifyUpward(
      this.graph(),
      req,
      items.map((i) => i.ino),
    );
    return Promise.resolve(
      items.map((it): VerifyResult => {
        const r = up.get(it.ino);
        const n = this.inodes.get(it.ino);
        if (r === undefined || !r.readable || n === undefined)
          return { ino: it.ino, seq: it.seq, readable: false };
        const chunk = this.chunks.find(
          (c) =>
            c.ino === it.ino &&
            c.seq === it.seq &&
            c.modelKey === modelKey &&
            c.inodeVersion === n.version,
        );
        return {
          ino: it.ino,
          seq: it.seq,
          readable: true,
          path: r.path ?? '',
          inodeVersion: n.version,
          ...(chunk === undefined ? {} : { snippet: snippetOf(chunk.text) }),
        };
      }),
    );
  }
}

/** left(text, 240): the first 240 characters (code points), as PostgreSQL counts them. */
export function snippetOf(text: string): string {
  return Array.from(text).slice(0, 240).join('');
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
