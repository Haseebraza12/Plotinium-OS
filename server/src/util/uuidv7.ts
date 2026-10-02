/**
 * UUIDv7 (RFC 9562 §5.7) for server-minted ids: request ids, arm ids, audit correlation (C5).
 * 48-bit Unix time in milliseconds, version 7, 74 random bits, variant 10.
 * Inode ids minted inside PostgreSQL use uuidv7() (PG 18) instead.
 */
import { randomBytes } from 'node:crypto';

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

export function uuidv7(nowMs: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new RangeError(`uuidv7: timestamp out of range: ${nowMs}`);
  }
  if (random.length < 10) throw new RangeError('uuidv7: need 10 random bytes');
  const b = new Uint8Array(16);
  let t = nowMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | ((random[0] ?? 0) & 0x0f); // version 7
  b[7] = random[1] ?? 0;
  b[8] = 0x80 | ((random[2] ?? 0) & 0x3f); // variant 10
  for (let i = 9; i < 16; i++) b[i] = random[i - 6] ?? 0;
  let s = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
    s += HEX[b[i] ?? 0] ?? '00';
  }
  return s;
}

export const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
