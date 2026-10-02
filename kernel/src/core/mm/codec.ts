/**
 * Deterministic state codec (specs/03-kernel/memory-and-paging.md §3.8, KMM-07, MEM-03).
 *
 * Structured clone is not a byte format, so MEM-03's "byte-identical state" needs our own codec,
 * shared by executors (encode, decode), the kernel (fault verification) and blkio (header checks).
 *
 * Page file = a 64-byte little-endian header + the body:
 *
 * | Offset | Size | Field                                                   |
 * |--------|------|---------------------------------------------------------|
 * | 0      | 4    | magic `PLTP` (0x50 0x4C 0x54 0x50)                      |
 * | 4      | 2    | version = 1                                             |
 * | 6      | 2    | flags: bit 0 STATE, bit 1 RAW (data page), bit 2 CHUNK  |
 * | 8      | 4    | header length = 64                                      |
 * | 12     | 4    | jsonLen (0 for RAW)                                     |
 * | 16     | 4    | segCount                                                |
 * | 20     | 4    | reserved = 0                                            |
 * | 24     | 8    | bodyLen (uint32 low at 24, high at 28)                  |
 * | 32     | 32   | SHA-256 of the body                                     |
 *
 * STATE body: canonical JSON (RFC 8785 rules: sorted keys by UTF-16 code units, ECMAScript number
 * form, JSON.stringify string escaping); zero padding to a multiple of 8; a segment table of
 * segCount × (offset u32, length u32) relative to the body start; each segment's bytes padded
 * with zeros to a multiple of 8. RAW body: the page's bytes unchanged (no copy).
 *
 * Guarantee (INV-M7): encode(decode(b)) equals b byte for byte for every b that encode produced.
 * Complexity: O(bytes + Σ k log k over objects with k keys).
 */
import { sha256 as sha256Bytes, toHex } from '@plotinium/protocol';

import { MmError } from './errors.ts';

export const PAGE_MAGIC = Object.freeze([0x50, 0x4c, 0x54, 0x50] as const);
export const CODEC_VERSION = 1;
export const HEADER_LEN = 64;
export const FLAG_STATE = 1;
export const FLAG_RAW = 2;
export const FLAG_CHUNK = 4;
/** Nesting deeper than this is rejected with EINVAL (§3.8.2 rule 4). */
export const MAX_DEPTH = 256;

/** A synchronous SHA-256: bytes in, 32-byte digest out. Defaults to the protocol implementation. */
export type Digest = (bytes: Uint8Array) => Uint8Array;

export type SegType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64' | 'ab' | 'dv';

export interface PageHeader {
  readonly version: number;
  readonly flags: number;
  readonly headerLen: number;
  readonly jsonLen: number;
  readonly segCount: number;
  readonly bodyLen: number;
  /** Lower-case hex SHA-256 of the body, as stored in the header. */
  readonly sha256: string;
}

export interface EncodedPage {
  /** The 64-byte header. */
  readonly header: ArrayBuffer;
  /** The body; for a RAW page this is the caller's buffer itself (no copy). */
  readonly body: ArrayBuffer;
  /** Hex SHA-256 of the body (the PTE checksum). */
  readonly sha256: string;
  /** Body length in bytes (the PTE size). */
  readonly bytes: number;
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON with binary segments
// ---------------------------------------------------------------------------------------------

type TypedCtor =
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Uint16ArrayConstructor
  | Int16ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor;

const TYPED: ReadonlyArray<readonly [TypedCtor, SegType]> = [
  [Uint8Array, 'u8'],
  [Int8Array, 'i8'],
  [Uint16Array, 'u16'],
  [Int16Array, 'i16'],
  [Uint32Array, 'u32'],
  [Int32Array, 'i32'],
  [Float32Array, 'f32'],
  [Float64Array, 'f64'],
];

const CTOR_BY_TYPE = new Map<SegType, TypedCtor>(TYPED.map(([c, t]) => [t, c]));

function reject(msg: string): never {
  throw new MmError('EINVAL', 'codec', `codec: ${msg}`);
}

function corrupt(msg: string): never {
  throw new MmError('EIO', 'checksum', `codec: ${msg}`);
}

/** Copy exactly the viewed bytes of a view or a whole ArrayBuffer. */
function viewBytes(buffer: ArrayBufferLike, offset: number, length: number): Uint8Array {
  if (!(buffer instanceof ArrayBuffer)) reject('shared or foreign buffers cannot be encoded');
  return new Uint8Array(buffer, offset, length).slice();
}

function segTypeOf(value: object): SegType | undefined {
  if (value instanceof ArrayBuffer)
    return Object.getPrototypeOf(value) === ArrayBuffer.prototype ? 'ab' : undefined;
  if (!ArrayBuffer.isView(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === DataView.prototype) return 'dv';
  for (const [ctor, t] of TYPED) if (proto === ctor.prototype) return t;
  return undefined;
}

interface Walk {
  readonly parts: string[];
  readonly segs: Uint8Array[];
  readonly stack: Set<object>;
}

function writeValue(value: unknown, depth: number, w: Walk): void {
  if (value === null) {
    w.parts.push('null');
    return;
  }
  if (typeof value === 'boolean') {
    w.parts.push(value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('NaN and ±Infinity are not allowed');
    // -0 is written as 0 (§3.8.2 rule 2); otherwise the ECMAScript Number::toString form.
    w.parts.push(Object.is(value, -0) ? '0' : JSON.stringify(value));
    return;
  }
  if (typeof value === 'string') {
    w.parts.push(JSON.stringify(value));
    return;
  }
  if (typeof value !== 'object') {
    // undefined (inside arrays or at the top), BigInt, symbols and functions (§3.8.2 rule 4).
    reject(`${typeof value} values are not allowed`);
  }
  const obj: object = value;
  const seg = segTypeOf(obj);
  if (seg !== undefined) {
    let bytes: Uint8Array;
    if (seg === 'ab') {
      const ab = obj as ArrayBuffer;
      bytes = viewBytes(ab, 0, ab.byteLength);
    } else {
      const view = obj as ArrayBufferView;
      bytes = viewBytes(view.buffer, view.byteOffset, view.byteLength);
    }
    w.parts.push(`{"$seg":${w.segs.length},"$t":"${seg}"}`);
    w.segs.push(bytes);
    return;
  }
  if (depth >= MAX_DEPTH) reject(`nesting deeper than ${MAX_DEPTH}`);
  if (w.stack.has(obj)) reject('cycles are not allowed');
  const proto: unknown = Object.getPrototypeOf(obj);
  if (Array.isArray(obj)) {
    if (proto !== Array.prototype) reject('array subclasses are not allowed');
    w.stack.add(obj);
    w.parts.push('[');
    const arr = obj as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) w.parts.push(',');
      writeValue(arr[i], depth + 1, w);
    }
    w.parts.push(']');
    w.stack.delete(obj);
    return;
  }
  if (proto !== Object.prototype && proto !== null) {
    reject('Map, Set, Date and class instances are not allowed');
  }
  if (Object.getOwnPropertySymbols(obj).length > 0) reject('symbol keys are not allowed');
  w.stack.add(obj);
  const rec = obj as Record<string, unknown>;
  // Array.prototype.sort without a comparator orders by UTF-16 code units (RFC 8785 §3.2.3).
  const keys = Object.keys(rec).sort();
  w.parts.push('{');
  let first = true;
  for (const key of keys) {
    const item = rec[key];
    if (item === undefined) continue;
    if (key.startsWith('$')) reject(`keys starting with $ are reserved (${key})`);
    if (!first) w.parts.push(',');
    first = false;
    w.parts.push(JSON.stringify(key), ':');
    writeValue(item, depth + 1, w);
  }
  w.parts.push('}');
  w.stack.delete(obj);
}

/**
 * Canonical JSON of `value` with every binary value moved to a segment (§3.8.2). Throws MmError
 * EINVAL for the rejected values of rule 4.
 */
export function canonicalize(value: unknown): { json: string; segments: Uint8Array[] } {
  const w: Walk = { parts: [], segs: [], stack: new Set() };
  writeValue(value, 0, w);
  return { json: w.parts.join(''), segments: w.segs };
}

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------

const pad8 = (n: number): number => Math.ceil(n / 8) * 8;

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new RangeError('codec: sha256 must be 64 lower-case hex digits');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Build the 64-byte header (§3.8.1). */
export function buildHeader(h: Omit<PageHeader, 'version' | 'headerLen'>): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_LEN);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  u8.set(PAGE_MAGIC, 0);
  dv.setUint16(4, CODEC_VERSION, true);
  dv.setUint16(6, h.flags, true);
  dv.setUint32(8, HEADER_LEN, true);
  dv.setUint32(12, h.jsonLen, true);
  dv.setUint32(16, h.segCount, true);
  dv.setUint32(20, 0, true);
  dv.setUint32(24, h.bodyLen >>> 0, true);
  dv.setUint32(28, Math.floor(h.bodyLen / 0x1_0000_0000), true);
  u8.set(hexToBytes(h.sha256), 32);
  return buf;
}

/** Parse and validate a header; EIO on a bad magic, version or length. */
export function parseHeader(header: ArrayBuffer | Uint8Array): PageHeader {
  const u8 = header instanceof Uint8Array ? header : new Uint8Array(header);
  if (u8.byteLength < HEADER_LEN) corrupt('short header');
  for (let i = 0; i < 4; i++) if (u8[i] !== PAGE_MAGIC[i]) corrupt('bad magic');
  const dv = new DataView(u8.buffer, u8.byteOffset, HEADER_LEN);
  const version = dv.getUint16(4, true);
  if (version !== CODEC_VERSION) corrupt(`unsupported version ${version}`);
  const headerLen = dv.getUint32(8, true);
  if (headerLen !== HEADER_LEN) corrupt(`bad header length ${headerLen}`);
  if (dv.getUint32(20, true) !== 0) corrupt('reserved field is not zero');
  const bodyLen = dv.getUint32(24, true) + dv.getUint32(28, true) * 0x1_0000_0000;
  return {
    version,
    flags: dv.getUint16(6, true),
    headerLen,
    jsonLen: dv.getUint32(12, true),
    segCount: dv.getUint32(16, true),
    bodyLen,
    sha256: toHex(u8.subarray(32, 64)),
  };
}

/** True when two 64-byte headers are equal byte for byte. */
export function headersEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.byteLength < HEADER_LEN || y.byteLength < HEADER_LEN) return false;
  for (let i = 0; i < HEADER_LEN; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Hex SHA-256 of a buffer (synchronous). */
export function sha256Hex(bytes: ArrayBuffer | Uint8Array, digest: Digest = sha256Bytes): string {
  return toHex(digest(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
}

// ---------------------------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------------------------

const utf8 = new TextEncoder();

/**
 * Encode a process state as a STATE page (§3.8.1). Throws MmError EINVAL when the state holds a
 * rejected value (the checkpoint fails and the process becomes non-pageable, §6).
 */
export function encodeState(value: unknown, digest: Digest = sha256Bytes): EncodedPage {
  const { json, segments } = canonicalize(value);
  const jsonBytes = utf8.encode(json);
  const tableOff = pad8(jsonBytes.byteLength);
  let cursor = tableOff + segments.length * 8;
  const offsets: number[] = [];
  for (const seg of segments) {
    offsets.push(cursor);
    cursor += pad8(seg.byteLength);
  }
  const bodyLen = cursor;
  const body = new ArrayBuffer(bodyLen);
  const u8 = new Uint8Array(body);
  const dv = new DataView(body);
  u8.set(jsonBytes, 0);
  segments.forEach((seg, i) => {
    const off = offsets[i] ?? 0;
    dv.setUint32(tableOff + i * 8, off, true);
    dv.setUint32(tableOff + i * 8 + 4, seg.byteLength, true);
    u8.set(seg, off);
  });
  const sha = toHex(digest(u8));
  const header = buildHeader({
    flags: FLAG_STATE,
    jsonLen: jsonBytes.byteLength,
    segCount: segments.length,
    bodyLen,
    sha256: sha,
  });
  return { header, body, sha256: sha, bytes: bodyLen };
}

/** An asynchronous hex SHA-256 (crypto.subtle in executors and blkio). */
export type DigestHexAsync = (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;

/**
 * `encodeState` with an asynchronous digest: the executor hashes with `crypto.subtle.digest`
 * once, while encoding (§3.9.1 step 2). The bytes are identical to `encodeState`'s.
 */
export async function encodeStateAsync(
  value: unknown,
  digestHex: DigestHexAsync,
): Promise<EncodedPage> {
  const { json, segments } = canonicalize(value);
  const jsonBytes = utf8.encode(json);
  const tableOff = pad8(jsonBytes.byteLength);
  let cursor = tableOff + segments.length * 8;
  const offsets: number[] = [];
  for (const seg of segments) {
    offsets.push(cursor);
    cursor += pad8(seg.byteLength);
  }
  const body = new ArrayBuffer(cursor);
  const u8 = new Uint8Array(body);
  const dv = new DataView(body);
  u8.set(jsonBytes, 0);
  segments.forEach((seg, i) => {
    const off = offsets[i] ?? 0;
    dv.setUint32(tableOff + i * 8, off, true);
    dv.setUint32(tableOff + i * 8 + 4, seg.byteLength, true);
    u8.set(seg, off);
  });
  const sha = await digestHex(u8);
  const header = buildHeader({
    flags: FLAG_STATE,
    jsonLen: jsonBytes.byteLength,
    segCount: segments.length,
    bodyLen: cursor,
    sha256: sha,
  });
  return { header, body, sha256: sha, bytes: cursor };
}

/** `verifyPage` with an asynchronous digest (blkio read-back, remote page-in). */
export async function verifyPageAsync(
  header: ArrayBuffer | Uint8Array,
  body: ArrayBuffer,
  digestHex: DigestHexAsync,
  expectedSha?: string,
): Promise<PageHeader> {
  const h = parseHeader(header);
  if (h.bodyLen !== body.byteLength)
    corrupt(`body length ${body.byteLength} ≠ header ${h.bodyLen}`);
  if (expectedSha !== undefined && h.sha256 !== expectedSha)
    corrupt('header hash differs from the page table');
  if ((await digestHex(new Uint8Array(body))) !== h.sha256) corrupt('body hash mismatch');
  return h;
}

/** Wrap a data page's bytes as a RAW page; the body is `bytes` itself, unchanged (§3.8.1). */
export function encodeRaw(
  bytes: ArrayBuffer,
  opts: { chunk?: boolean; digest?: Digest; sha256?: string } = {},
): EncodedPage {
  const sha = opts.sha256 ?? sha256Hex(bytes, opts.digest);
  const header = buildHeader({
    flags: FLAG_RAW | (opts.chunk === true ? FLAG_CHUNK : 0),
    jsonLen: 0,
    segCount: 0,
    bodyLen: bytes.byteLength,
    sha256: sha,
  });
  return { header, body: bytes, sha256: sha, bytes: bytes.byteLength };
}

// ---------------------------------------------------------------------------------------------
// Verify and decode
// ---------------------------------------------------------------------------------------------

/**
 * Check a page file's header against its body: lengths, the header hash, the body's SHA-256, and
 * optionally the PTE's expected hash. Returns the parsed header; throws MmError EIO `checksum`.
 * The body is hashed before anything is parsed (§3.8.2: "decode checks magic, version, lengths and
 * the SHA-256 before parsing").
 */
export function verifyPage(
  header: ArrayBuffer | Uint8Array,
  body: ArrayBuffer,
  expectedSha?: string,
  digest: Digest = sha256Bytes,
): PageHeader {
  const h = parseHeader(header);
  if (h.bodyLen !== body.byteLength)
    corrupt(`body length ${body.byteLength} ≠ header ${h.bodyLen}`);
  if (expectedSha !== undefined && h.sha256 !== expectedSha)
    corrupt('header hash differs from the page table');
  const actual = sha256Hex(body, digest);
  if (actual !== h.sha256) corrupt('body hash mismatch');
  return h;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function reviveSegments(
  value: unknown,
  segs: readonly ArrayBuffer[],
  types: SegType[],
  depth: number,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH + 1) corrupt('nesting too deep');
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) arr[i] = reviveSegments(arr[i], segs, types, depth + 1);
    return arr;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 2 && keys[0] === '$seg' && keys[1] === '$t') {
    const idx = rec.$seg;
    const t = rec.$t;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= segs.length) {
      corrupt('bad segment reference');
    }
    const bytes = segs[idx];
    if (bytes === undefined || typeof t !== 'string') corrupt('bad segment reference');
    types[idx] = t as SegType;
    if (t === 'ab') return bytes;
    if (t === 'dv') return new DataView(bytes);
    const ctor = CTOR_BY_TYPE.get(t as SegType);
    if (ctor === undefined) corrupt(`unknown segment type ${t}`);
    if (bytes.byteLength % ctor.BYTES_PER_ELEMENT !== 0)
      corrupt('segment length is not a whole number of elements');
    return new ctor(bytes);
  }
  for (const key of keys) {
    if (key.startsWith('$')) corrupt(`reserved key ${key}`);
    rec[key] = reviveSegments(rec[key], segs, types, depth + 1);
  }
  return rec;
}

/**
 * Decode a STATE page back into the state value. Verifies the header, lengths and SHA-256 first
 * (MmError EIO `checksum` on any mismatch). Every binary value is a fresh buffer.
 */
export function decodeState(
  header: ArrayBuffer | Uint8Array,
  body: ArrayBuffer,
  opts: { expectedSha?: string; digest?: Digest } = {},
): unknown {
  const h = verifyPage(header, body, opts.expectedSha, opts.digest);
  if ((h.flags & FLAG_STATE) === 0) corrupt('not a state page');
  if (h.jsonLen > h.bodyLen) corrupt('json length beyond the body');
  const tableOff = pad8(h.jsonLen);
  if (tableOff + h.segCount * 8 > h.bodyLen) corrupt('segment table beyond the body');
  const dv = new DataView(body);
  const segs: ArrayBuffer[] = [];
  for (let i = 0; i < h.segCount; i++) {
    const off = dv.getUint32(tableOff + i * 8, true);
    const len = dv.getUint32(tableOff + i * 8 + 4, true);
    if (off + len > h.bodyLen) corrupt('segment beyond the body');
    segs.push(body.slice(off, off + len));
  }
  let text: string;
  try {
    text = utf8Decoder.decode(new Uint8Array(body, 0, h.jsonLen));
  } catch {
    corrupt('json is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    corrupt('json does not parse');
  }
  const types: SegType[] = [];
  return reviveSegments(parsed, segs, types, 0);
}

/** Verify a RAW page and return its body (the same buffer). */
export function decodeRaw(
  header: ArrayBuffer | Uint8Array,
  body: ArrayBuffer,
  opts: { expectedSha?: string; digest?: Digest } = {},
): ArrayBuffer {
  const h = verifyPage(header, body, opts.expectedSha, opts.digest);
  if ((h.flags & FLAG_RAW) === 0) corrupt('not a raw page');
  return body;
}

// ---------------------------------------------------------------------------------------------
// Page files (header + body in one buffer, for tier-2 uploads)
// ---------------------------------------------------------------------------------------------

/** Concatenate header and body into one page file. */
export function joinPageFile(header: ArrayBuffer, body: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(body), header.byteLength);
  return out.buffer;
}

/** Split a page file into header and body (copies); EIO when shorter than the header. */
export function splitPageFile(file: ArrayBuffer): { header: ArrayBuffer; body: ArrayBuffer } {
  if (file.byteLength < HEADER_LEN) corrupt('page file shorter than its header');
  return { header: file.slice(0, HEADER_LEN), body: file.slice(HEADER_LEN) };
}

/** True when two buffers hold the same bytes. */
export function bytesEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false;
  return true;
}
