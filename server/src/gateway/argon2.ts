/**
 * Password hashing with node:crypto Argon2id (C10; backend-api.md §3.8.5; OFF-03, SEC-06).
 *
 * Parameters (OWASP): m = 19456 KiB, t = 2, p = 1, 16-byte salt, 32-byte tag, stored as a PHC
 * string `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>` (standard base64 without padding).
 * An optional pepper (AUTH_PEPPER_FILE) is passed as Argon2's `secret`.
 * At most ARGON2_MAX_CONCURRENCY (2) hashes run at once: Argon2 runs on the libuv pool that
 * FsBlobStore streams also use. crypto.argon2 needs Node >= 24.7 built against OpenSSL >= 3.2
 * (the official node:24-trixie-slim image); the startup self-test checks it (SRV-17).
 */
import * as crypto from 'node:crypto';

export const ARGON2_PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const SALT_BYTES = 16;

export type Argon2Params = Parameters<typeof crypto.argon2Sync>[1];

/** True when this Node build has node:crypto argon2 (Node >= 24.7, OpenSSL >= 3.2). */
export function argon2Available(): boolean {
  return typeof (crypto as { argon2?: unknown }).argon2 === 'function';
}

export function argon2id(params: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.argon2('argon2id', params, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** A counting semaphore: at most `limit` tasks run at once; the rest wait in FIFO order. */
export class Semaphore {
  readonly limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Semaphore limit must be >= 1');
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#active++;
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next !== undefined)
        next(); // hand the slot over without releasing it
      else this.#active--;
    }
  }
}

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');

export interface PhcArgon2id {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export function parsePhc(phc: string): PhcArgon2id | null {
  const m = PHC_RE.exec(phc);
  if (m === null) return null;
  const [, mem, t, p, salt, tag] = m;
  return {
    memory: Number(mem),
    passes: Number(t),
    parallelism: Number(p),
    salt: Buffer.from(salt ?? '', 'base64'),
    tag: Buffer.from(tag ?? '', 'base64'),
  };
}

export interface HashOptions {
  readonly pepper?: string;
  readonly semaphore?: Semaphore;
}

export async function hashPassword(password: string, options: HashOptions = {}): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const run = () =>
    argon2id({
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      ...ARGON2_PARAMS,
      ...(options.pepper === undefined ? {} : { secret: Buffer.from(options.pepper, 'utf8') }),
    });
  const tag = await (options.semaphore ? options.semaphore.run(run) : run());
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** Constant-time verification. A malformed or locked hash ('!') verifies as false. */
export async function verifyPassword(
  phc: string,
  password: string,
  options: HashOptions = {},
): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (parsed === null || parsed.tag.length < 16) return false;
  const run = () =>
    argon2id({
      message: Buffer.from(password, 'utf8'),
      nonce: parsed.salt,
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.tag.length,
      ...(options.pepper === undefined ? {} : { secret: Buffer.from(options.pepper, 'utf8') }),
    });
  const tag = await (options.semaphore ? options.semaphore.run(run) : run());
  return tag.length === parsed.tag.length && crypto.timingSafeEqual(tag, parsed.tag);
}

/** True when the stored hash uses parameters other than the current ones (rehash at login). */
export function needsRehash(phc: string): boolean {
  const p = parsePhc(phc);
  return (
    p === null ||
    p.memory !== ARGON2_PARAMS.memory ||
    p.passes !== ARGON2_PARAMS.passes ||
    p.parallelism !== ARGON2_PARAMS.parallelism ||
    p.tag.length !== ARGON2_PARAMS.tagLength
  );
}
