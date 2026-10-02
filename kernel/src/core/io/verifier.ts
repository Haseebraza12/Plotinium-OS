/**
 * The offline login verifier (security-model.md §3.8, §4.2, §5.3; OFF-03, SEC-07).
 *
 * - Created only after a successful ONLINE login and never for uid 0 or a guest
 *   (`AuthMe.offlineVerifier.allowed`), off the boot critical path (after desktop-interactive).
 * - `verifier = SHA-256(PBKDF2-HMAC-SHA256(password, salt16, 600,000, 256 bits))`, per-uid salt;
 *   the password bytes are zeroed after use. No plain-text password is ever stored.
 * - Offline check: constant-time comparison; after 5 failures a back-off of 2^n × 30 s (a UX gate).
 * - Expires 30 days after the last online login; a different `passwordVersion` deletes it.
 * Records live in IndexedDB `credentials` (key: username), durability strict.
 */
import type { FsStore } from '../fs/store.ts';

export const PBKDF2_ITERATIONS = 600_000;
export const VERIFIER_TTL_MS = 30 * 86_400_000;
const FAILURES_BEFORE_BACKOFF = 5;
const BACKOFF_BASE_MS = 30_000;

export interface OfflineVerifierRec {
  readonly uid: number;
  readonly username: string;
  readonly gid: number;
  readonly groups: readonly number[];
  readonly kind: string;
  readonly kdf: 'PBKDF2-SHA256';
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly verifier: Uint8Array;
  readonly passwordVersion: number;
  readonly createdAt: string;
  readonly lastOnlineAuthAt: string;
  readonly expiresAt: string;
  failures: number;
  lockedUntil: string | null;
}

export type OfflineCheck =
  | { readonly ok: true; readonly rec: OfflineVerifierRec }
  | {
      readonly ok: false;
      readonly why: 'none' | 'expired' | 'locked' | 'wrong';
      readonly retryAfterMs?: number;
    };

function isRec(x: unknown): x is OfflineVerifierRec {
  if (x === null || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r['uid'] === 'number' &&
    typeof r['username'] === 'string' &&
    r['salt'] instanceof Uint8Array &&
    r['verifier'] instanceof Uint8Array &&
    typeof r['expiresAt'] === 'string'
  );
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class OfflineVerifier {
  private readonly store: () => FsStore | null;
  private readonly subtle: SubtleCrypto | undefined;
  private readonly random: (n: number) => Uint8Array;
  private readonly now: () => number;
  private readonly iterations: number;

  constructor(deps: {
    store: () => FsStore | null;
    subtle: SubtleCrypto | undefined;
    random: (n: number) => Uint8Array;
    now: () => number;
    /** Tests only: fewer iterations. */
    iterations?: number;
  }) {
    this.store = deps.store;
    this.subtle = deps.subtle;
    this.random = deps.random;
    this.now = deps.now;
    this.iterations = deps.iterations ?? PBKDF2_ITERATIONS;
  }

  get available(): boolean {
    return this.subtle !== undefined && this.store() !== null;
  }

  private async derive(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
  ): Promise<Uint8Array> {
    const subtle = this.subtle;
    if (subtle === undefined) throw new Error('no WebCrypto');
    const pw = new Uint8Array(password);
    const key = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
    pw.fill(0);
    const dk = new Uint8Array(
      await subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
        key,
        256,
      ),
    );
    const v = new Uint8Array(await subtle.digest('SHA-256', dk));
    dk.fill(0);
    return v;
  }

  async get(username: string): Promise<OfflineVerifierRec | null> {
    const store = this.store();
    if (store === null) return null;
    const r = await store.get<unknown>('credentials', username);
    return isRec(r) ? r : null;
  }

  async usernames(): Promise<string[]> {
    const store = this.store();
    if (store === null) return [];
    const out: string[] = [];
    const now = this.now();
    await store.scan<unknown>('credentials', null, (r) => {
      if (isRec(r) && Date.parse(r.expiresAt) > now) out.push(r.username);
    });
    return out;
  }

  /** Create or refresh the verifier after an online login; zeroes `password`. */
  async create(
    u: {
      uid: number;
      username: string;
      gid: number;
      groups: readonly number[];
      kind: string;
      passwordVersion: number;
    },
    password: Uint8Array,
  ): Promise<void> {
    const store = this.store();
    try {
      if (store === null || this.subtle === undefined) return;
      if (u.uid === 0 || u.kind === 'guest' || u.kind === 'root') return;
      const salt = this.random(16);
      const verifier = await this.derive(password, salt, this.iterations);
      const now = new Date(this.now());
      const rec: OfflineVerifierRec = {
        uid: u.uid,
        username: u.username,
        gid: u.gid,
        groups: [...u.groups],
        kind: u.kind,
        kdf: 'PBKDF2-SHA256',
        iterations: this.iterations,
        salt,
        verifier,
        passwordVersion: u.passwordVersion,
        createdAt: now.toISOString(),
        lastOnlineAuthAt: now.toISOString(),
        expiresAt: new Date(this.now() + VERIFIER_TTL_MS).toISOString(),
        failures: 0,
        lockedUntil: null,
      };
      await store.tx(['credentials'], 'strict', (t) => t.put('credentials', rec), {
        label: 'offline verifier',
      });
    } finally {
      password.fill(0);
    }
  }

  /** A different password version (changed on another device): drop the verifier. */
  async invalidateIfStale(username: string, passwordVersion: number): Promise<void> {
    const r = await this.get(username);
    const store = this.store();
    if (r === null || store === null || r.passwordVersion === passwordVersion) return;
    await store.tx(['credentials'], 'strict', (t) => t.del('credentials', username), {
      label: 'verifier stale',
    });
  }

  /** §5.3 offline verification; zeroes `password`. */
  async check(username: string, password: Uint8Array): Promise<OfflineCheck> {
    const store = this.store();
    try {
      const r = await this.get(username);
      if (r === null || store === null || r.uid === 0) return { ok: false, why: 'none' };
      const now = this.now();
      if (r.lockedUntil !== null && now < Date.parse(r.lockedUntil))
        return { ok: false, why: 'locked', retryAfterMs: Date.parse(r.lockedUntil) - now };
      if (now > Date.parse(r.expiresAt)) {
        await store.tx(['credentials'], 'strict', (t) => t.del('credentials', username), {
          label: 'verifier expired',
        });
        return { ok: false, why: 'expired' };
      }
      const got = await this.derive(password, r.salt, r.iterations);
      const ok = constantTimeEqual(got, r.verifier);
      got.fill(0);
      const failures = ok ? 0 : r.failures + 1;
      const over = failures - FAILURES_BEFORE_BACKOFF;
      const lockedUntil =
        over >= 0 ? new Date(now + 2 ** over * BACKOFF_BASE_MS).toISOString() : null;
      const next: OfflineVerifierRec = { ...r, failures, lockedUntil };
      await store.tx(['credentials'], 'strict', (t) => t.put('credentials', next), {
        label: 'verifier check',
      });
      return ok ? { ok: true, rec: next } : { ok: false, why: 'wrong' };
    } finally {
      password.fill(0);
    }
  }
}
