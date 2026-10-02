/**
 * Opaque session tokens (backend-api.md §3.8.1, SRV-08; security-model.md §3.7).
 *
 * Adapted from the Lucia single-file reference `code/auth_session.ts` (0BSD; attribution in
 * THIRD_PARTY.md). The token is `<id>.<secret>`:
 *   id     20 random bytes as lowercase base32 (32 characters, 160 bits): the auth_sessions key;
 *   secret 32 random bytes as base64url (43 characters, 256 bits).
 * Only SHA-256(secret) is stored, so a leaked database yields no usable token. The token appears
 * only in the cookie: never in a URL, a response body or a log line.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_BYTES = 20;
const SECRET_BYTES = 32;
const ID_RE = /^[a-z2-7]{32}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** RFC 4648 base32 in lowercase, without padding. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? '';
  return out;
}

export interface SessionToken {
  readonly id: string;
  readonly secret: string;
  /** `<id>.<secret>`, the cookie value. */
  readonly token: string;
  /** SHA-256 of the secret: the only part the database keeps. */
  readonly secretHash: Buffer;
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function newSessionToken(random: (n: number) => Buffer = randomBytes): SessionToken {
  const id = base32(random(ID_BYTES));
  const secret = random(SECRET_BYTES).toString('base64url');
  return { id, secret, token: `${id}.${secret}`, secretHash: hashSecret(secret) };
}

/** Splits a cookie value into id and secret; anything malformed is "no session". */
export function parseSessionToken(
  value: string | undefined,
): { id: string; secret: string } | null {
  if (value === undefined) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  return ID_RE.test(id) && SECRET_RE.test(secret) ? { id, secret } : null;
}

/** Constant-time comparison of SHA-256(secret) with the stored hash. */
export function secretMatches(secret: string, stored: Uint8Array): boolean {
  const h = hashSecret(secret);
  return stored.length === h.length && timingSafeEqual(h, stored);
}

/** 20 random base32 characters (100 bits): generated first-start and reset passwords (SRV-20). */
export function generatePassword(random: (n: number) => Buffer = randomBytes): string {
  return base32(random(13)).slice(0, 20);
}
