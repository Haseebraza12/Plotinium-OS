/**
 * Shapes of the index API logic (backend-api.md §3.12; rag-semantic-search.md §3.6, §4.4, §4.5;
 * database.md §3.20, §4.11.18). HTTP bodies are owned by rag-semantic-search.md §4.4.
 *
 * TODO(protocol): protocol/src has no `http/` module yet for the /api/index bodies; the Valibot
 * schemas below (schemas.ts) are local until protocol/src/http/index.ts exists.
 */

/** The effective principal of a request: uid and gids (primary first), from the server only. */
export interface Requester {
  readonly uid: number;
  readonly gids: readonly number[];
}

/** file_chunks.model_key CHECK (database.md §4.6). */
export const MODEL_KEY_RE = /^[a-z0-9._@-]{1,64}$/;
/** backend-api.md §3.12: k <= 50; verify <= 50 items; pull limit <= 2,000. */
export const SEARCH_K_MAX = 50;
export const VERIFY_MAX_ITEMS = 50;
export const PULL_LIMIT_MAX = 2000;
/** rag-semantic-search.md §3.2.2: files over 2 MiB are never embedded; the put reads at most this. */
export const PUT_BLOB_MAX_BYTES = 2 * 1024 * 1024;
/** protocol IndexPut: at most 4,096 chunks per file. */
export const PUT_MAX_CHUNKS = 4096;
/** snippets are at most 240 characters. */
export const SNIPPET_CHARS = 240;
/** |‖v‖ − 1| < 1e-3 (rag-semantic-search.md §3.6). */
export const UNIT_NORM_TOLERANCE = 1e-3;

export interface ChunkIn {
  readonly seq: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly header: string;
  readonly text: string;
  /** Hex SHA-256(modelKey ‖ 0x00 ‖ header ‖ 0x00 ‖ text). */
  readonly contentHash: string;
  /**
   * The 384-d unit vector, or null to REUSE the vector already stored for the same contentHash
   * on this file and model (incremental update: only changed chunks are re-embedded and uploaded).
   */
  readonly embedding: Float32Array | null;
}

export interface IndexPutInput {
  readonly ino: string;
  readonly inodeVersion: number;
  readonly modelKey: string;
  readonly chunks: readonly ChunkIn[];
}

export type IndexPutResult =
  { readonly applied: true; readonly rows: number } | { readonly duplicate: true };

export interface PullQuery {
  readonly modelKey: string;
  /** chunk_id cursor; 0 = from the start. */
  readonly after: number;
  readonly limit: number;
}

export interface PulledChunk {
  readonly chunkId: number;
  readonly ino: string;
  readonly inodeVersion: number;
  readonly seq: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** '' for files the requester does not own (the heading trail is file text, I-A3). */
  readonly header: string;
  readonly contentHash: string;
  readonly modelKey: string;
  /** The requester owns the file (current inodes.uid). */
  readonly owned: boolean;
  /** Only when `owned` (I-A3: no foreign text leaves the server through pull). */
  readonly text?: string;
  readonly embedding: Float32Array;
}

export interface PullPage {
  readonly chunks: readonly PulledChunk[];
  /** X-Next-After: the cursor to continue from (the last chunk id, or `after` when empty). */
  readonly nextAfter: number;
  readonly complete: boolean;
  /** X-Manifest-Files: readable files that have chunks for this model key. */
  readonly manifestFiles: number;
}

export interface SearchQuery {
  readonly modelKey: string;
  readonly vector: Float32Array;
  readonly k: number;
  /** Restrict to the subtree of this directory (still reached from / with x on every ancestor). */
  readonly scopeIno?: string | null;
}

export interface SearchHit {
  readonly ino: string;
  /** The smallest readable path of the file (hard links: at least one traversable link). */
  readonly path: string;
  readonly seq: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly score: number;
  readonly snippet: string;
}

export interface VerifyItem {
  readonly ino: string;
  readonly seq: number;
  readonly inodeVersion: number;
}

export interface VerifyResult {
  readonly ino: string;
  readonly seq: number;
  readonly readable: boolean;
  /** Only when readable: the current path, the CURRENT inode version and the stored snippet. */
  readonly path?: string;
  readonly inodeVersion?: number;
  readonly snippet?: string;
}

/** The current inode row of a file, as the put needs it. */
export interface FileMeta {
  readonly ino: string;
  readonly type: 'f' | 'd' | 'l';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly version: number;
  readonly size: number;
  /** Hex SHA-256 of the current content blob; null for an empty file. */
  readonly blobSha256: string | null;
}

export type ReplaceOutcome =
  | { readonly ok: true; readonly rows: number }
  | { readonly ok: false; readonly reason: 'stale-version' }
  | { readonly ok: false; readonly reason: 'missing-embedding'; readonly seq: number };

/** The storage side of the index API; every method is one statement or one short transaction. */
export interface IndexDb {
  fileMeta(ino: string): Promise<FileMeta | null>;
  /** The inode_version of the stored chunk set of (ino, modelKey), or null when there is none. */
  storedVersion(ino: string, modelKey: string): Promise<number | null>;
  /**
   * One short transaction (database.md §3.20): the index-put advisory lock, the version re-check,
   * DELETE of the (ino, modelKey) set, INSERT of the new rows (vectors of `embedding: null` chunks
   * copied from the replaced rows with the same content hash).
   */
  replaceChunks(input: IndexPutInput): Promise<ReplaceOutcome>;
  pull(
    req: Requester,
    q: PullQuery,
  ): Promise<{ readonly rows: readonly PulledChunk[]; readonly manifestFiles: number }>;
  search(req: Requester, q: SearchQuery): Promise<readonly SearchHit[]>;
  verify(
    req: Requester,
    modelKey: string,
    items: readonly VerifyItem[],
  ): Promise<readonly VerifyResult[]>;
}
