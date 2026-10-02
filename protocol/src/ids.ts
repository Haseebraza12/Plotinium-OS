/**
 * UUIDv7 ids (C5) and derived ids (offline-and-sync.md §3.3.2).
 *
 * - Every inode id and op id is a UUIDv7 (RFC 9562 §5.7): a 48-bit Unix-epoch millisecond
 *   timestamp, version 7, 12 bits `rand_a`, variant `10`, 62 bits `rand_b`. The server default is
 *   PostgreSQL 18's `uuidv7()`; the client generator is below.
 * - The generator is monotonic within one realm (RFC 9562 §6.2 method 1): `rand_a` is a 12-bit
 *   counter seeded at random in its lower half each millisecond and incremented for ids created in
 *   the same millisecond (or after the clock moved backwards); on counter overflow the timestamp is
 *   advanced by 1 ms. `rand_b` is always fresh randomness from `crypto.getRandomValues`.
 * - Well-known ids (wellknown.ts) use the same layout with timestamp 0, so they validate as UUIDv7
 *   and sort before every generated id.
 */
import { sha256 } from './sha256.ts';

/** Canonical lower-case UUIDv7 text (also matches the well-known ids). */
export const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Any canonical lower-case RFC 9562 UUID (the `Uuid` definition of offline-and-sync.md §4.2). */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_REGEX.test(value);
}

/** The 16 bytes of a canonical UUID string. Throws on anything that is not canonical text. */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_REGEX.test(uuid)) throw new TypeError(`not a canonical UUID: ${uuid}`);
  const hex = uuid.replaceAll('-', '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Canonical lower-case text of 16 UUID bytes. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RangeError(`a UUID has 16 bytes, got ${bytes.length}`);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The 48-bit millisecond timestamp of a UUIDv7 (0 for the well-known ids). */
export function uuidV7Timestamp(uuid: string): number {
  const bytes = uuidToBytes(uuid);
  let ms = 0;
  for (let i = 0; i < 6; i++) ms = ms * 256 + (bytes[i] ?? 0);
  return ms;
}

export interface UuidV7GeneratorOptions {
  /** Wall clock in epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
  /** Fills a byte array with random bytes (default `crypto.getRandomValues`). */
  readonly random?: (bytes: Uint8Array<ArrayBuffer>) => void;
}

const TIMESTAMP_MAX = 2 ** 48 - 1;

/**
 * Create a monotonic UUIDv7 generator. Each realm (kernel worker, server process) owns one; ids
 * from one generator are strictly increasing in byte (and text) order.
 */
export function createUuidV7Generator(options: UuidV7GeneratorOptions = {}): () => string {
  const now = options.now ?? (() => Date.now());
  const random =
    options.random ??
    ((bytes: Uint8Array<ArrayBuffer>) => {
      crypto.getRandomValues(bytes);
    });
  let lastMs = -1;
  let counter = 0;
  const scratch = new Uint8Array(2);

  const seedCounter = (): number => {
    random(scratch);
    // Lower half of the 12-bit space leaves at least 2048 increments before overflow.
    return (((scratch[0] ?? 0) << 8) | (scratch[1] ?? 0)) & 0x7ff;
  };

  return () => {
    const clock = Math.floor(now());
    if (!Number.isSafeInteger(clock) || clock < 0 || clock > TIMESTAMP_MAX) {
      throw new RangeError(`clock value out of the UUIDv7 range: ${clock}`);
    }
    if (clock > lastMs) {
      lastMs = clock;
      counter = seedCounter();
    } else {
      counter++;
      if (counter > 0xfff) {
        if (lastMs >= TIMESTAMP_MAX) throw new RangeError('UUIDv7 timestamp exhausted');
        lastMs++;
        counter = seedCounter();
      }
    }
    const bytes = new Uint8Array(16);
    random(bytes);
    let ms = lastMs;
    for (let i = 5; i >= 0; i--) {
      bytes[i] = ms % 256;
      ms = Math.floor(ms / 256);
    }
    bytes[6] = 0x70 | (counter >>> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    return bytesToUuid(bytes);
  };
}

let defaultGenerator: (() => string) | undefined;

/** A new UUIDv7 from this realm's default monotonic generator. */
export function uuidv7(): string {
  defaultGenerator ??= createUuidV7Generator();
  return defaultGenerator();
}

/**
 * The derived id of the copy of source inode `srcIno` made by op `opId` (offline-and-sync.md
 * §3.3.2): a UUIDv7 whose 48-bit timestamp is the timestamp of `opId` and whose 74 remaining bits
 * (`rand_a` then `rand_b`) are the first 74 bits of SHA-256(opId ‖ srcIno), with the version and
 * variant bits set as RFC 9562 requires.
 *
 * Encoding (Plotinium protocol decision, pending confirmation in database.md): the hash input is
 * the 32 bytes of the two ids' binary forms, opId first. In PostgreSQL this is
 * `sha256(uuid_send(op_id) || uuid_send(src_ino))`, so set-based server copies can compute the
 * same value in SQL.
 */
export function deriveIno(opId: string, srcIno: string): string {
  const op = uuidToBytes(opId);
  const src = uuidToBytes(srcIno);
  const input = new Uint8Array(32);
  input.set(op, 0);
  input.set(src, 16);
  const digest = sha256(input);

  let hashHead = 0n;
  for (let i = 0; i < 10; i++) hashHead = (hashHead << 8n) | BigInt(digest[i] ?? 0);
  const first74 = hashHead >> 6n; // 80 bits read, keep the top 74
  const randA = first74 >> 62n;
  const randB = first74 & ((1n << 62n) - 1n);

  let timestamp = 0n;
  for (let i = 0; i < 6; i++) timestamp = (timestamp << 8n) | BigInt(op[i] ?? 0);

  const value = (timestamp << 80n) | (7n << 76n) | (randA << 64n) | (2n << 62n) | randB;
  const out = new Uint8Array(16);
  let rest = value;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytesToUuid(out);
}
