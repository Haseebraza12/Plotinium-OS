/**
 * `application/vnd.plotinium.chunks` (rag-semantic-search.md §4.4): the binary body of
 * POST /api/index/put and GET /api/index/pull. Little-endian:
 *
 *   repeat: u32 metaLen | meta: UTF-8 JSON | 384 x f32 embedding
 *
 * meta = {ino, inodeVersion, seq, byteStart, byteEnd, lineStart, lineEnd, header, contentHash,
 *         modelKey, chunkId?, owned?, text?, reuse?}
 * On pull, `text` is present only when `owned` is true (I-A3).
 * Extension (incremental updates, rag-semantic-search.md §3.3): on put, `reuse: true` means "keep
 * the vector already stored for this contentHash" and the frame carries NO embedding bytes.
 *
 * Every frame is validated with Valibot; any malformation is EINVAL (the route answers 422).
 */
import { EMBED_DIMS, Ino, Sha256Hex } from '@plotinium/protocol';
import * as v from 'valibot';

import { ErrnoError } from '../../errno.ts';
import { HttpError } from '../../http/errors.ts';
import type { ChunkIn, IndexPutInput, PulledChunk } from './types.ts';

export const CHUNKS_CONTENT_TYPE = 'application/vnd.plotinium.chunks';
const VECTOR_BYTES = EMBED_DIMS * 4;
/** A chunk is at most 480 tokens; 256 KiB of metadata is far beyond any legitimate frame. */
export const MAX_META_BYTES = 256 * 1024;

const Int = (min: number) => v.pipe(v.number(), v.safeInteger(), v.minValue(min));

export const ChunkMeta = v.strictObject({
  ino: Ino,
  inodeVersion: Int(1),
  seq: Int(0),
  byteStart: Int(0),
  byteEnd: Int(1),
  lineStart: Int(1),
  lineEnd: Int(1),
  header: v.pipe(v.string(), v.maxBytes(512)),
  contentHash: Sha256Hex,
  modelKey: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  chunkId: v.optional(Int(1)),
  owned: v.optional(v.boolean()),
  text: v.optional(v.string()),
  reuse: v.optional(v.literal(true)),
});
export type ChunkMeta = v.InferOutput<typeof ChunkMeta>;

export interface ChunkFrame {
  readonly meta: ChunkMeta;
  /** null only for a put frame with `reuse: true`. */
  readonly embedding: Float32Array | null;
}

const bad = (msg: string, field = 'body'): ErrnoError => new ErrnoError('EINVAL', { field }, msg);

export function decodeFrames(
  buf: Uint8Array,
  opts: { readonly maxFrames: number; readonly maxMetaBytes?: number },
): ChunkFrame[] {
  const maxMeta = opts.maxMetaBytes ?? MAX_META_BYTES;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frames: ChunkFrame[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let off = 0;
  while (off < buf.byteLength) {
    if (frames.length >= opts.maxFrames) throw bad(`more than ${opts.maxFrames} chunks`);
    if (off + 4 > buf.byteLength) throw bad('truncated frame header');
    const metaLen = view.getUint32(off, true);
    off += 4;
    if (metaLen === 0 || metaLen > maxMeta) throw bad('bad metadata length');
    if (off + metaLen > buf.byteLength) throw bad('truncated metadata');
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(buf.subarray(off, off + metaLen)));
    } catch {
      throw bad('metadata is not UTF-8 JSON');
    }
    off += metaLen;
    const parsed = v.safeParse(ChunkMeta, json);
    if (!parsed.success) {
      const key = parsed.issues[0]?.path?.map((p) => String(p.key)).join('.') ?? 'meta';
      throw bad('invalid chunk metadata', `chunks[${frames.length}].${key}`);
    }
    const meta = parsed.output;
    if (meta.reuse === true) {
      frames.push({ meta, embedding: null });
      continue;
    }
    if (off + VECTOR_BYTES > buf.byteLength) throw bad('truncated embedding');
    const vec = new Float32Array(EMBED_DIMS);
    for (let i = 0; i < EMBED_DIMS; i++) vec[i] = view.getFloat32(off + i * 4, true);
    off += VECTOR_BYTES;
    frames.push({ meta, embedding: vec });
  }
  return frames;
}

export function encodeFrames(frames: readonly ChunkFrame[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of frames) {
    const meta = Buffer.from(JSON.stringify(f.meta), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(meta.length, 0);
    parts.push(head, meta);
    if (f.meta.reuse === true) continue;
    const e = f.embedding;
    if (e === null || e.length !== EMBED_DIMS)
      throw new RangeError('a frame needs a 384-d embedding');
    const vec = Buffer.alloc(VECTOR_BYTES);
    for (let i = 0; i < EMBED_DIMS; i++) vec.writeFloatLE(e[i] ?? 0, i * 4);
    parts.push(vec);
  }
  return Buffer.concat(parts);
}

/**
 * The put body as one IndexPutInput: every frame must name the same (ino, inodeVersion, modelKey)
 * and carry `text`. An EMPTY body clears the file's chunk set for that model; its identifiers then
 * come from `ids` (the route's query string).
 */
export function putInputFromFrames(
  frames: readonly ChunkFrame[],
  ids?: { readonly ino: string; readonly inodeVersion: number; readonly modelKey: string },
): IndexPutInput {
  const first = frames[0];
  if (first === undefined) {
    if (ids === undefined) throw bad('an empty put must name ino, inodeVersion and modelKey');
    return { ...ids, chunks: [] };
  }
  const { ino, inodeVersion, modelKey } = first.meta;
  const chunks: ChunkIn[] = frames.map((f, i) => {
    const m = f.meta;
    if (m.ino !== ino || m.inodeVersion !== inodeVersion || m.modelKey !== modelKey) {
      throw bad(
        'all chunks of a put must belong to one (ino, inodeVersion, modelKey)',
        `chunks[${i}]`,
      );
    }
    if (m.text === undefined) throw bad('every put chunk carries its text', `chunks[${i}].text`);
    return {
      seq: m.seq,
      byteStart: m.byteStart,
      byteEnd: m.byteEnd,
      lineStart: m.lineStart,
      lineEnd: m.lineEnd,
      header: m.header,
      text: m.text,
      contentHash: m.contentHash,
      embedding: f.embedding,
    };
  });
  return { ino, inodeVersion, modelKey, chunks };
}

/** POST /api/index/put body limit (backend-api.md §3.6). */
export const PUT_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Reads a raw request body (the chunks content type reaches handlers as a stream, so Fastify's
 * bodyLimit does not apply) into one buffer, refusing more than `maxBytes` with 413 EINVAL.
 */
export async function readBody(
  body: AsyncIterable<Buffer | string>,
  maxBytes: number = PUT_BODY_MAX_BYTES,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of body) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    n += b.length;
    if (n > maxBytes) {
      throw new HttpError(413, 'EINVAL', 'request body too large', { field: 'body' });
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** A pull page as frames (text and heading trail only for owned chunks, as the service built them). */
export function encodePullChunks(chunks: readonly PulledChunk[]): Buffer {
  return encodeFrames(
    chunks.map((c) => ({
      meta: {
        ino: c.ino,
        inodeVersion: c.inodeVersion,
        seq: c.seq,
        byteStart: c.byteStart,
        byteEnd: c.byteEnd,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        header: c.owned ? c.header : '',
        contentHash: c.contentHash,
        modelKey: c.modelKey,
        chunkId: c.chunkId,
        owned: c.owned,
        ...(c.owned && c.text !== undefined ? { text: c.text } : {}),
      },
      embedding: c.embedding,
    })),
  );
}
