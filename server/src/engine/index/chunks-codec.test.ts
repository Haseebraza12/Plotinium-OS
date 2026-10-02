import { Readable } from 'node:stream';

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  CHUNKS_CONTENT_TYPE,
  decodeFrames,
  encodeFrames,
  encodePullChunks,
  putInputFromFrames,
  readBody,
  type ChunkFrame,
} from './chunks-codec.ts';
import { PullQueryString, PutQueryString, SearchBody, VerifyBody } from './schemas.ts';
import { testIno } from './tests/graph.ts';

const INO = testIno(7);
const vec = (x: number): Float32Array => new Float32Array(384).fill(x);
const meta = (seq: number, extra: Partial<ChunkFrame['meta']> = {}): ChunkFrame['meta'] => ({
  ino: INO,
  inodeVersion: 3,
  seq,
  byteStart: seq * 10,
  byteEnd: seq * 10 + 5,
  lineStart: 1,
  lineEnd: 1,
  header: 'H',
  contentHash: 'a'.repeat(64),
  modelKey: 'mk@1-384',
  text: `chunk ${seq}`,
  ...extra,
});

describe('application/vnd.plotinium.chunks (rag-semantic-search.md §4.4)', () => {
  it('RAG-02 frames round-trip: little-endian u32 length, JSON metadata, 384 f32; reuse frames carry no vector', () => {
    const frames: ChunkFrame[] = [
      { meta: meta(0), embedding: vec(0.25) },
      { meta: meta(1, { reuse: true }), embedding: null },
      { meta: meta(2, { text: 'ünïcødé ✓' }), embedding: vec(-1) },
    ];
    const buf = encodeFrames(frames);
    expect(CHUNKS_CONTENT_TYPE).toBe('application/vnd.plotinium.chunks');
    expect(buf.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify(frames[0]?.meta)));
    const back = decodeFrames(buf, { maxFrames: 10 });
    expect(back).toEqual(frames);
    const put = putInputFromFrames(back);
    expect(put).toMatchObject({ ino: INO, inodeVersion: 3, modelKey: 'mk@1-384' });
    expect(put.chunks.map((c) => [c.seq, c.embedding === null, c.text])).toEqual([
      [0, false, 'chunk 0'],
      [1, true, 'chunk 1'],
      [2, false, 'ünïcødé ✓'],
    ]);
    expect(() => encodeFrames([{ meta: meta(0), embedding: null }])).toThrow(RangeError);
  });

  it('RAG-02 malformed bodies are EINVAL: truncation, bad lengths, bad JSON, bad metadata, too many frames', () => {
    const good = encodeFrames([{ meta: meta(0), embedding: vec(0) }]);
    const bad =
      (b: Uint8Array, maxFrames = 10) =>
      () =>
        decodeFrames(b, { maxFrames });
    expect(bad(good.subarray(0, 2))).toThrow(/truncated frame header/);
    expect(bad(good.subarray(0, 20))).toThrow(/truncated metadata/);
    expect(bad(good.subarray(0, good.length - 1))).toThrow(/truncated embedding/);
    const zero = Buffer.alloc(4);
    expect(bad(zero)).toThrow(/bad metadata length/);
    const notJson = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('{{{')]);
    expect(bad(notJson)).toThrow(/not UTF-8 JSON/);
    const badMeta = encodeFrames([{ meta: { ...meta(0), seq: -1 }, embedding: vec(0) }]);
    let field: unknown;
    try {
      decodeFrames(badMeta, { maxFrames: 10 });
    } catch (e) {
      field = (e as { detail?: Record<string, unknown> }).detail?.['field'];
    }
    expect(field).toBe('chunks[0].seq');
    expect(bad(Buffer.concat([good, good]), 1)).toThrow(/more than 1 chunks/);
    expect(() => decodeFrames(good, { maxFrames: 10, maxMetaBytes: 10 })).toThrow(
      /bad metadata length/,
    );
  });

  it('RAG-02 a put body names one (ino, inodeVersion, modelKey) and carries text; an empty put takes ids from the query', () => {
    const mixed = decodeFrames(
      encodeFrames([
        { meta: meta(0), embedding: vec(0) },
        { meta: meta(1, { inodeVersion: 4 }), embedding: vec(0) },
      ]),
      { maxFrames: 10 },
    );
    expect(() => putInputFromFrames(mixed)).toThrow(/one \(ino, inodeVersion, modelKey\)/);
    const { text: _t, ...noText } = meta(0);
    expect(() =>
      putInputFromFrames(
        decodeFrames(encodeFrames([{ meta: noText, embedding: vec(0) }]), { maxFrames: 1 }),
      ),
    ).toThrow(/carries its text/);
    expect(() => putInputFromFrames([])).toThrow(/empty put/);
    expect(putInputFromFrames([], { ino: INO, inodeVersion: 2, modelKey: 'mk' })).toEqual({
      ino: INO,
      inodeVersion: 2,
      modelKey: 'mk',
      chunks: [],
    });
  });

  it('RAG-03 a pull page carries text and the heading trail only for owned chunks', () => {
    const base = {
      chunkId: 9,
      ino: INO,
      inodeVersion: 3,
      seq: 0,
      byteStart: 0,
      byteEnd: 5,
      lineStart: 1,
      lineEnd: 1,
      contentHash: 'b'.repeat(64),
      modelKey: 'mk',
      embedding: vec(0.5),
    };
    const buf = encodePullChunks([
      { ...base, owned: true, header: 'Mine', text: 'own text' },
      { ...base, chunkId: 10, owned: false, header: 'Leaked?', text: 'foreign text' },
    ]);
    const [own, foreign] = decodeFrames(buf, { maxFrames: 5 });
    expect(own?.meta).toMatchObject({ chunkId: 9, owned: true, header: 'Mine', text: 'own text' });
    expect(foreign?.meta).toMatchObject({ chunkId: 10, owned: false, header: '' });
    expect(foreign?.meta.text).toBeUndefined();
    expect(foreign?.embedding).toEqual(vec(0.5));
  });

  it('RAG-02 the raw put body is read with a hard 4 MiB cap (413 EINVAL beyond it)', async () => {
    expect((await readBody(Readable.from([Buffer.from('ab'), 'cd']))).toString()).toBe('abcd');
    await expect(readBody(Readable.from([Buffer.alloc(3)]), 2)).rejects.toMatchObject({
      status: 413,
      errno: 'EINVAL',
    });
  });

  it('RAG-03 the JSON bodies and query strings are validated with the §4.4 shapes', () => {
    expect(v.parse(SearchBody, { modelKey: 'mk', vector: Array(384).fill(0) })).toMatchObject({
      k: 5,
    });
    expect(v.safeParse(SearchBody, { modelKey: 'mk', vector: [1], k: 5 }).success).toBe(false);
    expect(
      v.safeParse(SearchBody, { modelKey: 'mk', vector: Array(384).fill(0), k: 51 }).success,
    ).toBe(false);
    expect(
      v.safeParse(VerifyBody, {
        modelKey: 'mk',
        items: Array(51).fill({ ino: INO, seq: 0, inodeVersion: 1 }),
      }).success,
    ).toBe(false);
    expect(
      v.parse(VerifyBody, { modelKey: 'mk', items: [{ ino: INO, seq: 0, inodeVersion: 1 }] }).items,
    ).toHaveLength(1);
    expect(v.parse(PullQueryString, { modelKey: 'mk' })).toEqual({
      modelKey: 'mk',
      after: 0,
      limit: 2000,
    });
    expect(v.parse(PullQueryString, { modelKey: 'mk', after: '42', limit: '10' })).toEqual({
      modelKey: 'mk',
      after: 42,
      limit: 10,
    });
    expect(v.safeParse(PullQueryString, { modelKey: 'mk', limit: '2001' }).success).toBe(false);
    expect(v.safeParse(PullQueryString, { modelKey: 'mk', limit: '0' }).success).toBe(false);
    expect(v.parse(PutQueryString, { ino: INO, inodeVersion: '3', modelKey: 'mk' })).toEqual({
      ino: INO,
      inodeVersion: 3,
      modelKey: 'mk',
    });
  });
});
