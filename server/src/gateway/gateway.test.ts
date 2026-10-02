import { describe, expect, it } from 'vitest';

import { MemoryAuthStore } from '../../tests/memory-auth-store.ts';
import { clearedCookie, readCookie, sessionCookie } from './cookies.ts';
import { csrfRefusal } from './hooks.ts';
import { SessionService, sessionPolicy, type RevocationReason } from './sessions.ts';
import { Slots } from './slots.ts';
import {
  base32,
  generatePassword,
  hashSecret,
  newSessionToken,
  parseSessionToken,
  secretMatches,
} from './tokens.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function service(now: { t: number }) {
  const store = new MemoryAuthStore();
  store.addUser({ uid: 1100, username: 'alice' });
  store.addUser({ uid: 60_000, username: 'guest-abcd', kind: 'guest', primaryGid: 60_000 });
  const svc = new SessionService(
    store,
    sessionPolicy({ slidingDays: 10, absoluteDays: 30, guestHours: 2 }),
    () => now.t,
  );
  return { store, svc };
}

describe('SRV-08 opaque session tokens (backend-api.md §3.8.1)', () => {
  it('SRV-08 base32 follows RFC 4648 in lower case without padding', () => {
    expect(base32(Buffer.from('foobar'))).toBe('mzxw6ytboi');
    expect(base32(Buffer.from(''))).toBe('');
    expect(base32(Buffer.from('f'))).toBe('my');
  });

  it('SRV-08 a token is a 160-bit base32 id and a 256-bit base64url secret, and only SHA-256 of the secret is kept', () => {
    const t = newSessionToken();
    expect(t.id).toMatch(/^[a-z2-7]{32}$/);
    expect(t.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.token).toBe(`${t.id}.${t.secret}`);
    expect(t.secretHash).toEqual(hashSecret(t.secret));
    expect(t.secretHash.length).toBe(32);
    expect(newSessionToken().id).not.toBe(t.id);
    expect(parseSessionToken(t.token)).toEqual({ id: t.id, secret: t.secret });
    expect(secretMatches(t.secret, t.secretHash)).toBe(true);
    expect(secretMatches(`${t.secret.slice(0, -1)}x`, t.secretHash)).toBe(false);
    expect(secretMatches(t.secret, new Uint8Array(3))).toBe(false);
  });

  it('SRV-08 malformed cookie values are no session', () => {
    const t = newSessionToken();
    for (const bad of [
      undefined,
      '',
      'nodot',
      `${t.id}.`,
      `.${t.secret}`,
      `${t.id.toUpperCase()}.${t.secret}`,
      `${t.id}.${t.secret}x`,
      `${t.id}x.${t.secret}`,
    ]) {
      expect(parseSessionToken(bad)).toBeNull();
    }
  });

  it('SRV-20 generated passwords are 20 base32 characters from the CSPRNG', () => {
    const a = generatePassword();
    expect(a).toMatch(/^[a-z2-7]{20}$/);
    expect(generatePassword()).not.toBe(a);
  });
});

describe('SRV-08 the session cookie (security-model.md §4.1)', () => {
  it('SRV-08 the cookie is Path=/, Secure, HttpOnly, SameSite=Strict with Max-Age and no Domain', () => {
    const c = sessionCookie('__Host-plt_sid', 'abc.def', 12.7);
    expect(c).toBe('__Host-plt_sid=abc.def; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=12');
    expect(c).not.toMatch(/Domain/i);
    expect(sessionCookie('plt_sid', 'x', -5)).toContain('Max-Age=0');
    expect(clearedCookie('plt_sid')).toBe(
      'plt_sid=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0',
    );
  });

  it('SRV-08 only the named cookie is read from a Cookie header', () => {
    expect(readCookie('a=1; plt_sid=tok.en ; b=2', 'plt_sid')).toBe('tok.en');
    expect(readCookie('xplt_sid=1; junk', 'plt_sid')).toBeUndefined();
    expect(readCookie(undefined, 'plt_sid')).toBeUndefined();
  });
});

describe('SRV-06 CSRF (backend-api.md §3.3 step 5)', () => {
  const origins = new Set(['http://localhost:4717']);
  it('SRV-06 a state-changing request needs Sec-Fetch-Site same-origin, or an allowlisted Origin when the header is absent', () => {
    expect(csrfRefusal('GET', {}, origins)).toBeNull();
    expect(csrfRefusal('HEAD', {}, origins)).toBeNull();
    expect(csrfRefusal('POST', { 'sec-fetch-site': 'same-origin' }, origins)).toBeNull();
    expect(
      csrfRefusal(
        'POST',
        { 'sec-fetch-site': 'cross-site', origin: 'http://localhost:4717' },
        origins,
      ),
    ).toMatch(/cross-site/);
    expect(csrfRefusal('POST', { 'sec-fetch-site': 'same-site' }, origins)).not.toBeNull();
    expect(csrfRefusal('DELETE', { origin: 'http://localhost:4717' }, origins)).toBeNull();
    expect(csrfRefusal('PUT', { origin: 'http://localhost:4718' }, origins)).toMatch(/origin/);
    expect(csrfRefusal('POST', {}, origins)).toMatch(/no Sec-Fetch-Site/);
  });
});

describe('SEC-06 the login concurrency gate', () => {
  it('SEC-06 a full gate refuses at once and a release frees one slot', () => {
    const g = new Slots(2);
    expect([g.tryAcquire(), g.tryAcquire(), g.tryAcquire()]).toEqual([true, true, false]);
    g.release();
    expect(g.held).toBe(1);
    expect(g.tryAcquire()).toBe(true);
    g.release();
    g.release();
    g.release();
    expect(g.held).toBe(0);
    expect(() => new Slots(0)).toThrow(RangeError);
  });
});

describe('SRV-08 session validation, sliding expiry and revocation (backend-api.md §3.8.3, §3.8.4)', () => {
  it('SRV-08 the sliding expiry is written at most once per hour and never passes the 30-day absolute cap', async () => {
    const now = { t: Date.UTC(2026, 9, 1) };
    const { store, svc } = service(now);
    const s = await svc.create(1100, 'user', 'test-agent');
    expect(s.record.expiresAt.getTime() - now.t).toBe(10 * DAY);
    expect(s.record.absoluteExpiresAt.getTime() - now.t).toBe(30 * DAY);
    now.t += 30 * 60_000;
    expect((await svc.validate(s.token.token)).slid).toBe(false);
    expect(store.touches).toBe(0);
    now.t += 31 * 60_000; // > 1 h since creation
    const slid = await svc.validate(s.token.token);
    expect(slid.slid).toBe(true);
    expect(slid.auth?.expiresAt.getTime()).toBe(now.t + 10 * DAY);
    expect(store.touches).toBe(1);
    expect((await svc.validate(s.token.token)).slid).toBe(false);
    expect(store.touches).toBe(1);
    // keep using it every 9 days: expiry slides but stops at the absolute cap
    for (let i = 0; i < 3; i++) {
      now.t += 9 * DAY;
      const r = await svc.validate(s.token.token);
      expect(r.auth).not.toBeNull();
      expect(r.auth?.expiresAt.getTime()).toBeLessThanOrEqual(s.record.absoluteExpiresAt.getTime());
    }
    now.t = s.record.absoluteExpiresAt.getTime();
    expect((await svc.validate(s.token.token)).auth).toBeNull();
    expect(store.sessions.get(s.record.id)?.revokedAt).not.toBeNull();
    expect(store.audits.at(-1)).toMatchObject({
      event: 'session.revoke',
      actor: 'system',
      detail: { reason: 'expired' },
    });
  });

  it('SRV-08 a guest session ends 2 hours after creation regardless of activity', async () => {
    const now = { t: Date.UTC(2026, 9, 1) };
    const { store, svc } = service(now);
    const s = await svc.create(60_000, 'guest', undefined);
    expect(s.record.expiresAt.getTime()).toBe(s.record.absoluteExpiresAt.getTime());
    expect(s.record.expiresAt.getTime() - now.t).toBe(2 * HOUR);
    now.t += 90 * 60_000;
    expect((await svc.validate(s.token.token)).auth?.kind).toBe('guest');
    expect(store.touches).toBe(0); // guests never slide
    now.t += 31 * 60_000;
    expect((await svc.validate(s.token.token)).auth).toBeNull();
  });

  it('SRV-08 a wrong secret, a revoked session and a disabled account are no session', async () => {
    const now = { t: Date.UTC(2026, 9, 1) };
    const { store, svc } = service(now);
    const s = await svc.create(1100, 'user', 'x'.repeat(600));
    expect(Buffer.byteLength(s.record.userAgent ?? '')).toBe(512);
    expect((await svc.validate(`${s.record.id}.${newSessionToken().secret}`)).auth).toBeNull();
    expect((await svc.validate(newSessionToken().token)).auth).toBeNull();
    const u = store.users.get(1100);
    if (u !== undefined) u.disabled = true;
    expect((await svc.validate(s.token.token)).auth).toBeNull();
    expect(store.sessions.get(s.record.id)?.revokedAt).not.toBeNull();
    expect((await svc.validate(s.token.token)).auth).toBeNull(); // already revoked
  });

  it('SRV-08 revocation notifies the listeners once with the revoked ids', async () => {
    const now = { t: Date.UTC(2026, 9, 1) };
    const { svc } = service(now);
    const seen: [readonly string[], RevocationReason][] = [];
    svc.onRevoke((ids, reason) => seen.push([ids, reason]));
    const a = await svc.create(1100, 'user', undefined);
    const b = await svc.create(1100, 'user', undefined);
    expect(await svc.revoke([a.record.id, b.record.id], 'password', 1100)).toEqual([
      a.record.id,
      b.record.id,
    ]);
    expect(await svc.revoke([a.record.id], 'logout', 1100)).toEqual([]);
    expect(seen).toEqual([[[a.record.id, b.record.id], 'password']]);
  });

  it('SRV-19 an su grant is reported only while it is live', async () => {
    const now = { t: Date.UTC(2026, 9, 1) };
    const { store, svc } = service(now);
    const s = await svc.create(1100, 'user', undefined);
    await store.setSuGrant(s.record.id, { uid: 0, expiresAt: new Date(now.t + 15 * 60_000) });
    expect((await svc.validate(s.token.token)).auth?.suGrant).toEqual({
      uid: 0,
      expiresAt: new Date(now.t + 15 * 60_000),
    });
    now.t += 16 * 60_000;
    expect((await svc.validate(s.token.token)).auth?.suGrant).toBeNull();
  });
});
