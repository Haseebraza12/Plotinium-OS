/**
 * Deterministic UUIDv7 for the seeds (database.md §3.27): the 48-bit timestamp is
 * 2026-09-01T00:00:00Z + i ms and the 74 random bits come from the seeded generator, with the
 * version (7) and variant (10) bits set. Sorts in creation order and never collides with the
 * well-known ids, whose timestamp is 0 (C5).
 */
import { randByte, type Rng } from './rng.ts';

export const SEED_UUID_EPOCH_MS = Date.UTC(2026, 8, 1, 0, 0, 0);

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

export function seededUuidv7(i: number, rng: Rng): string {
  let t = SEED_UUID_EPOCH_MS + i;
  const b = new Array<number>(16).fill(0);
  for (let k = 5; k >= 0; k--) {
    b[k] = t % 256;
    t = Math.floor(t / 256);
  }
  for (let k = 6; k < 16; k++) b[k] = randByte(rng);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  let s = '';
  for (let k = 0; k < 16; k++) {
    if (k === 4 || k === 6 || k === 8 || k === 10) s += '-';
    s += HEX[b[k] ?? 0] ?? '00';
  }
  return s;
}

/** 32 seeded random bytes as 64 hex digits (synthetic content hashes for bench blobs). */
export function seededSha256Hex(rng: Rng): string {
  let s = '';
  for (let k = 0; k < 32; k++) s += HEX[randByte(rng)] ?? '00';
  return s;
}
