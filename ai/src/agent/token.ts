/**
 * Plan tokens (syscall-abi.md §5.4; agentic-shell.md §3.13; AGT-03).
 *
 * token = `<planId>.<exp>.<b64url(HMAC-SHA-256(kBoot, pid|planId|planHash|dryRunHash|exp))>` with a
 * per-boot WebCrypto key that is non-extractable and never leaves the kernel worker. agentic-shell
 * also binds the grant hash (the sorted confirmed `(op, ino)` pairs); when a grant is given it is
 * appended to the MAC input, so a token cannot be replayed for another op set.
 *
 * `GrantTable` enforces the rest of §5.4 rule 5: pid-bound, 120 s expiry, single use, ops inside
 * the grant set, versions unchanged. Every check fails with EPERM `no-token` or `outside-grant`,
 * or EAGAIN `stale-plan`, and nothing runs.
 */
import { PLAN_TOKEN_TTL_MS, sha256Hex } from '@plotinium/protocol';

import { base64url, base64urlDecode, utf8 } from '../util/bytes.ts';
import { type Result, fail, ok } from '../util/errors.ts';

export interface TokenClaims {
  pid: number;
  planId: string;
  planHash: string;
  dryRunHash: string;
  /** SHA-256 of the sorted `(op, ino)` pairs; omitted for the ABI's bare form. */
  grantHash?: string;
}

/** A fresh per-boot HMAC-SHA-256 key: non-extractable. */
export async function generateTokenKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function grantHash(pairs: ReadonlyArray<readonly [string, string]>): string {
  return sha256Hex(
    pairs
      .map(([op, ino]) => `${op}:${ino}`)
      .sort()
      .join('\n'),
  );
}

function macInput(c: TokenClaims, exp: number): Uint8Array<ArrayBuffer> {
  const parts = [c.pid, c.planId, c.planHash, c.dryRunHash];
  if (c.grantHash !== undefined) parts.push(c.grantHash);
  parts.push(exp);
  return utf8(parts.join('|')) as Uint8Array<ArrayBuffer>;
}

export async function issueToken(
  key: CryptoKey,
  claims: TokenClaims,
  now: number,
): Promise<{ token: string; exp: number }> {
  const exp = now + PLAN_TOKEN_TTL_MS;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, macInput(claims, exp)));
  return { token: `${claims.planId}.${exp}.${base64url(mac)}`, exp };
}

/** Constant-time MAC check (WebCrypto verify), expiry and plan id. */
export async function verifyToken(
  key: CryptoKey,
  token: string,
  claims: TokenClaims,
  now: number,
): Promise<Result<number>> {
  const m = /^([0-9a-f-]{36})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (m === null) return fail('EPERM', 'no-token');
  const [, planId, expText, macText] = m;
  const exp = Number(expText);
  if (planId !== claims.planId || !Number.isSafeInteger(exp)) return fail('EPERM', 'no-token');
  const mac = base64urlDecode(macText ?? '');
  if (mac?.length !== 32) return fail('EPERM', 'no-token');
  const good = await crypto.subtle.verify(
    'HMAC',
    key,
    mac as Uint8Array<ArrayBuffer>,
    macInput(claims, exp),
  );
  if (!good) return fail('EPERM', 'no-token');
  if (now > exp) return fail('EPERM', 'no-token', undefined, 'token expired');
  return ok(exp);
}

interface Grant {
  claims: TokenClaims;
  token: string;
  set: ReadonlySet<string>;
  expected: ReadonlyArray<{ ino: string; version: number }>;
}

export interface BatchCheck {
  pid: number;
  token: string | undefined;
  planId: string | undefined;
  /** The `(op, ino)` pairs of the submitted ops. */
  pairs: ReadonlyArray<readonly [string, string]>;
  /** Current version of an inode in the live tree. */
  versionOf(ino: string): number | undefined;
}

/** Kernel grant table: one live grant per plan, consumed by the first `batch` that passes. */
export class GrantTable {
  private readonly grants = new Map<string, Grant>();
  private readonly key: CryptoKey;

  constructor(key: CryptoKey) {
    this.key = key;
  }

  async issue(
    claims: TokenClaims,
    pairs: ReadonlyArray<readonly [string, string]>,
    expected: ReadonlyArray<{ ino: string; version: number }>,
    now: number,
  ): Promise<{ token: string; exp: number }> {
    const t = await issueToken(this.key, claims, now);
    this.grants.set(claims.planId, {
      claims,
      token: t.token,
      set: new Set(pairs.map(([op, ino]) => `${op}:${ino}`)),
      expected,
    });
    return t;
  }

  /** §5.4 rule 5, phase 1 (no transaction open). The grant is deleted before phase 2. */
  async check(b: BatchCheck, now: number): Promise<Result<undefined>> {
    if (b.token === undefined || b.planId === undefined) return fail('EPERM', 'no-token');
    const g = this.grants.get(b.planId);
    if (g === undefined) return fail('EPERM', 'no-token');
    if (g.claims.pid !== b.pid) return fail('EPERM', 'no-token');
    const v = await verifyToken(this.key, b.token, g.claims, now);
    if (!v.ok) {
      if (now > (Number(b.token.split('.')[1]) || 0)) this.grants.delete(b.planId);
      return v;
    }
    if (!b.pairs.every(([op, ino]) => g.set.has(`${op}:${ino}`)))
      return fail('EPERM', 'outside-grant');
    if (g.expected.some((e) => b.versionOf(e.ino) !== e.version)) {
      this.grants.delete(b.planId);
      return fail('EAGAIN', 'stale-plan');
    }
    this.grants.delete(b.planId);
    return ok(undefined);
  }

  get size(): number {
    return this.grants.size;
  }
}
