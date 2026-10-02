/**
 * Deterministic state codec (memory-and-paging.md §3.8, §8; MEM-03, KMM-07).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildHeader,
  bytesEqual,
  canonicalize,
  decodeRaw,
  decodeState,
  encodeRaw,
  encodeState,
  encodeStateAsync,
  FLAG_CHUNK,
  FLAG_RAW,
  FLAG_STATE,
  HEADER_LEN,
  headersEqual,
  joinPageFile,
  MAX_DEPTH,
  parseHeader,
  sha256Hex,
  splitPageFile,
  verifyPage,
  verifyPageAsync,
} from './codec.ts';
import vectors from './codec.vectors.json';
import { MmError } from './errors.ts';

function expectErrno(fn: () => unknown, errno: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MmError);
    expect((e as MmError).errno).toBe(errno);
    return;
  }
  throw new Error(`expected ${errno}`);
}

const hex = (b: ArrayBuffer): string =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('codec vectors (codec.vectors.json)', () => {
  it.each(vectors.plain)(
    'MEM-03 codec vector "$name" encodes to the recorded canonical JSON and SHA-256',
    (v) => {
      const value: unknown = JSON.parse(v.inputJson);
      expect(canonicalize(value).json).toBe(v.canonical);
      const enc = encodeState(value);
      expect(enc.sha256).toBe(v.bodySha256);
      expect(enc.bytes).toBe(v.bodyBytes);
      expect(enc.body.byteLength % 8).toBe(0);
    },
  );

  it('MEM-03 codec vectors: key order, -0, omitted undefined properties and typed-array segments encode identically every time', () => {
    const make = (): Record<string, unknown> => ({
      name: 'x',
      i16: new Int16Array([-1, 2]),
      f: new Float64Array([1.5, -0]),
      dv: new DataView(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer, 1, 4),
      bytes: new Uint8Array([1, 2, 3]),
      ab: new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]).buffer,
      gone: undefined,
    });
    const a = encodeState(make());
    const b = encodeState(make());
    expect(bytesEqual(a.body, b.body)).toBe(true);
    expect(bytesEqual(a.header, b.header)).toBe(true);
    expect(canonicalize(make()).json).toBe(vectors.segments.canonical);
    expect(a.sha256).toBe(vectors.segments.bodySha256);
    expect(a.bytes).toBe(vectors.segments.bodyBytes);
    expect(hex(a.header)).toBe(vectors.segments.headerHex);
    // Insertion order does not matter.
    expect(encodeState({ b: 1, a: [2, { d: 3, c: 4 }] }).sha256).toBe(
      encodeState({ a: [2, { c: 4, d: 3 }], b: 1 }).sha256,
    );
  });
});

describe('codec round trip', () => {
  it('MEM-03 decode restores values and fresh typed arrays; re-encoding is byte-identical', () => {
    const shared = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const st = {
      n: 1,
      s: 'héllo',
      nested: { list: [1, 'two', null, false], empty: {} },
      view: new Uint32Array(shared.buffer, 4, 1),
      dv: new DataView(shared.buffer, 2, 3),
      f32: new Float32Array([0.5, 2]),
      i8: new Int8Array([-128, 127]),
      u16: new Uint16Array([65535]),
      i32: new Int32Array([-5]),
      whole: shared.buffer,
    };
    const enc = encodeState(st);
    const out = decodeState(enc.header, enc.body, { expectedSha: enc.sha256 }) as typeof st;
    expect(out.n).toBe(1);
    expect(out.s).toBe('héllo');
    expect(out.nested).toEqual({ list: [1, 'two', null, false], empty: {} });
    expect(out.view).toBeInstanceOf(Uint32Array);
    expect([...new Uint8Array(out.view.buffer)]).toEqual([50, 60, 70, 80]);
    expect(out.dv).toBeInstanceOf(DataView);
    expect(out.dv.byteLength).toBe(3);
    expect(out.f32).toBeInstanceOf(Float32Array);
    expect([...out.i8]).toEqual([-128, 127]);
    expect([...out.u16]).toEqual([65535]);
    expect([...out.i32]).toEqual([-5]);
    expect(out.whole).toBeInstanceOf(ArrayBuffer);
    expect(out.whole.byteLength).toBe(8);
    // Two views of one buffer are encoded twice: aliasing is not preserved.
    expect(out.view.buffer).not.toBe(out.whole);
    const again = encodeState(out);
    expect(bytesEqual(again.body, enc.body)).toBe(true);
    expect(bytesEqual(again.header, enc.header)).toBe(true);
  });

  it('MEM-03 property: encode(decode(b)) equals b for random states (fast-check)', () => {
    const leaf = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.integer(),
      fc.string(),
      fc.uint8Array({ maxLength: 40 }),
      fc.float64Array({ noNaN: true, maxLength: 6 }),
    );
    const key = fc.string({ maxLength: 8 }).filter((k) => !k.startsWith('$') && k !== '__proto__');
    const state = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small' },
        leaf,
        fc.array(tie('node'), { maxLength: 4 }),
        fc.dictionary(key, tie('node'), { maxKeys: 4 }),
      ),
    })).node;
    fc.assert(
      fc.property(state, (st) => {
        const a = encodeState(st);
        const decoded = decodeState(a.header, a.body);
        const b = encodeState(decoded);
        return bytesEqual(a.header, b.header) && bytesEqual(a.body, b.body);
      }),
      { numRuns: 300 },
    );
  });

  it('MEM-03 raw pages keep the caller buffer unchanged and verify on decode', () => {
    const bytes = new Uint8Array([5, 4, 3, 2, 1]).buffer;
    const enc = encodeRaw(bytes, { chunk: true });
    expect(enc.body).toBe(bytes);
    const h = parseHeader(enc.header);
    expect(h.flags).toBe(FLAG_RAW | FLAG_CHUNK);
    expect(h.jsonLen).toBe(0);
    expect(h.segCount).toBe(0);
    expect(decodeRaw(enc.header, enc.body, { expectedSha: enc.sha256 })).toBe(bytes);
    expect(encodeRaw(bytes, { sha256: enc.sha256 }).sha256).toBe(enc.sha256);
    expect(parseHeader(encodeRaw(bytes).header).flags).toBe(FLAG_RAW);
    expectErrno(() => decodeState(enc.header, enc.body), 'EIO');
    const st = encodeState({ a: 1 });
    expectErrno(() => decodeRaw(st.header, st.body), 'EIO');
  });

  it('MEM-03 page files split back into header and body', () => {
    const enc = encodeState({ a: [1, 2, 3] });
    const file = joinPageFile(enc.header, enc.body);
    expect(file.byteLength).toBe(HEADER_LEN + enc.bytes);
    const { header, body } = splitPageFile(file);
    expect(headersEqual(header, enc.header)).toBe(true);
    expect(bytesEqual(body, enc.body)).toBe(true);
    expectErrno(() => splitPageFile(new ArrayBuffer(10)), 'EIO');
  });
});

describe('codec rejections and corruption', () => {
  it('MEM-03 codec rejects cycles, functions, BigInt, Map, NaN and $-prefixed keys with EINVAL', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const cycArr: unknown[] = [];
    cycArr.push(cycArr);
    class Thing {
      x = 1;
    }
    const symKey = { [Symbol('s')]: 1 };
    const bad: unknown[] = [
      cyc,
      cycArr,
      { f: () => 1 },
      { b: 10n },
      { m: new Map() },
      { s: new Set() },
      { d: new Date(0) },
      { t: new Thing() },
      { n: Number.NaN },
      { i: Number.POSITIVE_INFINITY },
      { $x: 1 },
      [undefined],
      undefined,
      Symbol('x'),
      symKey,
      { c: new Uint8ClampedArray(2) },
      { big: new BigInt64Array(1) },
      { sub: new (class extends Array<number> {})() },
    ];
    for (const v of bad) expectErrno(() => encodeState(v), 'EINVAL');
    let deep: unknown = 1;
    for (let i = 0; i < MAX_DEPTH + 1; i++) deep = [deep];
    expectErrno(() => encodeState(deep), 'EINVAL');
    let ok: unknown = 1;
    for (let i = 0; i < MAX_DEPTH; i++) ok = [ok];
    expect(() => encodeState(ok)).not.toThrow();
    // Shared (non-cyclic) references are fine and encoded twice.
    const leaf = { v: 1 };
    expect(canonicalize({ a: leaf, b: leaf }).json).toBe('{"a":{"v":1},"b":{"v":1}}');
    // null-prototype objects are plain data.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 1;
    expect(canonicalize(bare).json).toBe('{"k":1}');
  });

  it('MEM-03 decode checks magic, version, lengths and the SHA-256 before parsing (EIO)', () => {
    const enc = encodeState({ hello: 'world', seg: new Uint8Array([1, 2, 3]) });
    const flipBody = enc.body.slice(0);
    const fb = new Uint8Array(flipBody);
    fb[0] = (fb[0] ?? 0) ^ 1;
    expectErrno(() => decodeState(enc.header, flipBody), 'EIO');
    expectErrno(() => decodeState(enc.header, enc.body, { expectedSha: '0'.repeat(64) }), 'EIO');
    expectErrno(() => decodeState(enc.header, enc.body.slice(0, 8)), 'EIO');
    const badMagic = enc.header.slice(0);
    new Uint8Array(badMagic)[0] = 0;
    expectErrno(() => decodeState(badMagic, enc.body), 'EIO');
    const badVersion = enc.header.slice(0);
    new DataView(badVersion).setUint16(4, 2, true);
    expectErrno(() => parseHeader(badVersion), 'EIO');
    const badLen = enc.header.slice(0);
    new DataView(badLen).setUint32(8, 32, true);
    expectErrno(() => parseHeader(badLen), 'EIO');
    const badReserved = enc.header.slice(0);
    new DataView(badReserved).setUint32(20, 1, true);
    expectErrno(() => parseHeader(badReserved), 'EIO');
    expectErrno(() => parseHeader(new ArrayBuffer(10)), 'EIO');
    expect(headersEqual(new ArrayBuffer(10), enc.header)).toBe(false);
    expect(headersEqual(enc.header, badMagic)).toBe(false);
    expect(verifyPage(new Uint8Array(enc.header), enc.body).flags).toBe(FLAG_STATE);
  });

  it('MEM-03 decode rejects inconsistent bodies whose hash matches (corrupt tables, bad JSON)', () => {
    const forge = (body: Uint8Array, jsonLen: number, segCount: number): ArrayBuffer =>
      buildHeader({
        flags: FLAG_STATE,
        jsonLen,
        segCount,
        bodyLen: body.byteLength,
        sha256: sha256Hex(body),
      });
    const text = new TextEncoder().encode('{"a":1}\0');
    expectErrno(() => decodeState(forge(text, 100, 0), text.buffer), 'EIO');
    expectErrno(() => decodeState(forge(text, 7, 5), text.buffer), 'EIO');
    const notJson = new TextEncoder().encode('{"a":}\0\0');
    expectErrno(() => decodeState(forge(notJson, 6, 0), notJson.buffer), 'EIO');
    const badUtf8 = new Uint8Array([0x22, 0xff, 0x22, 0, 0, 0, 0, 0]);
    expectErrno(() => decodeState(forge(badUtf8, 3, 0), badUtf8.buffer), 'EIO');
    // A segment reference that points past the table, an unknown type, a reserved key.
    for (const json of [
      '{"x":{"$seg":3,"$t":"u8"}}',
      '{"x":{"$seg":0,"$t":"zz"}}',
      '{"$x":1}',
      '{"x":{"$seg":"0","$t":"u8"}}',
    ]) {
      const jb = new TextEncoder().encode(json);
      const bodyLen = Math.ceil(jb.byteLength / 8) * 8 + 8 + 8;
      const body = new Uint8Array(bodyLen);
      body.set(jb);
      const tableOff = Math.ceil(jb.byteLength / 8) * 8;
      new DataView(body.buffer).setUint32(tableOff, tableOff + 8, true);
      new DataView(body.buffer).setUint32(tableOff + 4, 1, true);
      expectErrno(() => decodeState(forge(body, jb.byteLength, 1), body.buffer), 'EIO');
    }
    // A segment whose length is not a whole number of elements.
    const jb = new TextEncoder().encode('{"x":{"$seg":0,"$t":"u32"}}');
    const tableOff = Math.ceil(jb.byteLength / 8) * 8;
    const body = new Uint8Array(tableOff + 16);
    body.set(jb);
    new DataView(body.buffer).setUint32(tableOff, tableOff + 8, true);
    new DataView(body.buffer).setUint32(tableOff + 4, 3, true);
    expectErrno(() => decodeState(forge(body, jb.byteLength, 1), body.buffer), 'EIO');
    // A segment beyond the body.
    new DataView(body.buffer).setUint32(tableOff + 4, 400, true);
    expectErrno(() => decodeState(forge(body, jb.byteLength, 1), body.buffer), 'EIO');
    expect(() =>
      buildHeader({ flags: 1, jsonLen: 0, segCount: 0, bodyLen: 0, sha256: 'xyz' }),
    ).toThrow(RangeError);
  });

  it('MEM-03 the async variants (crypto.subtle) produce identical bytes and verify the same way', async () => {
    const subtleHex = async (b: Uint8Array<ArrayBuffer>): Promise<string> =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    const st = { a: [1, 2], seg: new Uint16Array([7, 8]), s: 'x' };
    const sync = encodeState(st);
    const async = await encodeStateAsync(st, subtleHex);
    expect(async.sha256).toBe(sync.sha256);
    expect(bytesEqual(async.body, sync.body)).toBe(true);
    expect(bytesEqual(async.header, sync.header)).toBe(true);
    expect((await verifyPageAsync(async.header, async.body, subtleHex, async.sha256)).flags).toBe(
      FLAG_STATE,
    );
    const bad = async.body.slice(0);
    const u8 = new Uint8Array(bad);
    u8[0] = (u8[0] ?? 0) ^ 1;
    await expect(verifyPageAsync(async.header, bad, subtleHex)).rejects.toMatchObject({
      errno: 'EIO',
    });
    await expect(
      verifyPageAsync(async.header, async.body.slice(8), subtleHex),
    ).rejects.toMatchObject({ errno: 'EIO' });
    await expect(
      verifyPageAsync(async.header, async.body, subtleHex, '0'.repeat(64)),
    ).rejects.toMatchObject({ errno: 'EIO' });
  });

  it('MEM-03 large bodies record a 64-bit body length', () => {
    const h = buildHeader({
      flags: FLAG_RAW,
      jsonLen: 0,
      segCount: 0,
      bodyLen: 2 ** 33 + 5,
      sha256: '0'.repeat(64),
    });
    expect(parseHeader(h).bodyLen).toBe(2 ** 33 + 5);
  });
});
