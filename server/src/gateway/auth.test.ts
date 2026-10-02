import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MemoryAuthStore } from '../../tests/memory-auth-store.ts';
import { buildApp, type PlotiniumApp } from '../app.ts';
import { parseConfig } from '../config.ts';
import { createLogger } from '../obs/logger.ts';
import { createMetrics } from '../obs/metrics.ts';
import { hashPassword } from './argon2.ts';
import type { AuthMe } from './schemas.ts';

const PW = {
  alice: 'alice-correct-horse',
  bob: 'bob-battery-staple',
  root: 'root-secret-password',
};
const SAME = { 'sec-fetch-site': 'same-origin' };
let hashes: Record<keyof typeof PW, string>;
let blobDir: string;
const apps: PlotiniumApp[] = [];

beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'plt-auth-'));
  hashes = {
    alice: await hashPassword(PW.alice),
    bob: await hashPassword(PW.bob),
    root: await hashPassword(PW.root),
  };
});
afterAll(async () => {
  await rm(blobDir, { recursive: true, force: true });
});
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.app.close();
});

interface Harness {
  readonly built: PlotiniumApp;
  readonly store: MemoryAuthStore;
  readonly clock: { t: number };
  readonly lines: string[];
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const store = new MemoryAuthStore();
  store.addUser({
    uid: 0,
    username: 'root',
    kind: 'root',
    passwordHash: hashes.root,
    primaryGid: 0,
  });
  store.addUser({ uid: 1100, username: 'alice', passwordHash: hashes.alice, groups: [200] });
  store.addUser({ uid: 1101, username: 'bob', passwordHash: hashes.bob, groups: [200] });
  store.addUser({ uid: 1001, username: 'user01', passwordHash: '!' });
  store.addUser({ uid: 1102, username: 'carol', passwordHash: hashes.alice, disabled: true });
  const clock = { t: Date.UTC(2026, 9, 1, 8) };
  const lines: string[] = [];
  const config = parseConfig(
    { BLOB_DIR: blobDir, LOG_LEVEL: 'info', FAULT_INJECTION: '1', ...env },
    () => {
      throw new Error('no secret files in this test');
    },
  );
  const built = await buildApp(config, {
    database: null,
    authStore: store,
    logger: createLogger(config, { write: (line: string) => lines.push(line) }),
    metrics: createMetrics({ defaultMetrics: false }),
    expectedMigration: null,
    now: () => clock.t,
  });
  apps.push(built);
  return { built, store, clock, lines };
}

type Inject = PlotiniumApp['app']['inject'];
type Res = Awaited<ReturnType<Inject>>;

async function login(
  h: Harness,
  username: string,
  password: string,
  cookie?: string,
): Promise<Res> {
  return h.built.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...SAME, ...(cookie === undefined ? {} : { cookie }) },
    payload: { username, password },
  });
}

const cookieOf = (res: Res): string => String(res.headers['set-cookie']).split(';')[0] ?? '';

describe('SRV-08 login, me and logout (backend-api.md §3.6.1)', () => {
  it('SRV-08 a login sets the plt_sid cookie with the §3.8.2 attributes, returns AuthMe and stores only the secret hash', async () => {
    const h = await harness();
    const res = await login(h, 'alice', PW.alice);
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^plt_sid=[a-z2-7]{32}\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=864000$/,
    );
    const me = res.json<AuthMe>();
    expect(me).toMatchObject({
      uid: 1100,
      username: 'alice',
      kind: 'user',
      gid: 100,
      groups: [
        { gid: 100, name: 'users' },
        { gid: 200, name: 'team' },
      ],
      home: '/home/alice',
      suGrants: [],
      passwordVersion: 1,
      offlineVerifier: { allowed: true },
      server: { name: 'Plotinium', version: '0.1.0' },
    });
    const token = cookieOf(res).split('=')[1] ?? '';
    const [id, secret] = token.split('.');
    const stored = h.store.sessions.get(id ?? '');
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(h.store.audits.map((a) => a.event)).toEqual(['login.success']);

    const again = await h.built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieOf(res) },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<AuthMe>().session.expiresAt).toBe(me.session.expiresAt);
  });

  it('SRV-08 me without a session is 401 EACCES and logout is idempotent and expires the cookie', async () => {
    const h = await harness();
    const none = await h.built.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ errno: 'EACCES' });
    const res = await login(h, 'alice', PW.alice);
    const revoked: string[] = [];
    h.built.sessions?.onRevoke((ids) => revoked.push(...ids));
    const out = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...SAME, cookie: cookieOf(res) },
    });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect(revoked).toHaveLength(1);
    expect(
      (
        await h.built.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookieOf(res) },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await h.built.app.inject({ method: 'POST', url: '/api/auth/logout', headers: SAME }))
        .statusCode,
    ).toBe(204);
    expect(h.store.audits.map((a) => a.event)).toEqual([
      'login.success',
      'session.revoke',
      'logout',
    ]);
  });

  it('SRV-08 the session id changes at every login and a pre-set cookie value is never accepted', async () => {
    const h = await harness();
    const first = await login(h, 'alice', PW.alice);
    const second = await login(h, 'alice', PW.alice, cookieOf(first));
    expect(cookieOf(second)).not.toBe(cookieOf(first));
    // the session presented with the second login was revoked (fixation defence)
    expect(
      (
        await h.built.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookieOf(first) },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.built.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookieOf(second) },
        })
      ).statusCode,
    ).toBe(200);
    const planted = await h.built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: {
        cookie:
          'plt_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    expect(planted.statusCode).toBe(401);
    expect(String(planted.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('SEC-06 unknown, root, guest, disabled and locked accounts get the same 401 as a wrong password after a real Argon2 verification', async () => {
    const h = await harness();
    await h.built.app.inject({ method: 'POST', url: '/api/auth/guest', headers: SAME });
    const bodies = new Set<string>();
    for (const [user, pw] of [
      ['alice', 'wrong-password'],
      ['nobody', 'whatever'],
      ['root', PW.root],
      ['carol', PW.alice],
      ['user01', 'anything'],
      ['guest-zzzz', 'x'],
    ] as const) {
      const res = await login(h, user, pw);
      expect(res.statusCode, user).toBe(401);
      const { reqId: _reqId, ...rest } = res.json<Record<string, unknown>>();
      bodies.add(JSON.stringify(rest));
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ errno: 'EACCES', msg: 'invalid username or password' }),
    ]);
    const text = await h.built.metrics.registry.getSingleMetricAsString('plotinium_argon2_seconds');
    // every attempt verified, the unknown and locked ones against the dummy hash
    expect(text).toMatch(/^plotinium_argon2_seconds_count 6$/m);
    const failures = h.store.audits.filter((a) => a.event === 'login.failure');
    expect(failures).toHaveLength(6);
    expect(failures.find((a) => a.detail?.['username'] === 'nobody')).toMatchObject({
      uid: 0,
      actor: 'system',
      outcome: 'denied',
    });
  });

  it('SRV-09 the login-user class delays but never locks an account', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++)
      expect((await login(h, 'alice', `wrong-${i}`)).statusCode).toBe(401);
    const limited = await login(h, 'alice', PW.alice);
    expect(limited.statusCode).toBe(429);
    const body = limited.json<{ errno: string; reason: string; retryAfterMs: number }>();
    expect(body).toMatchObject({ errno: 'EAGAIN', reason: 'rate' });
    h.clock.t += body.retryAfterMs;
    expect((await login(h, 'alice', PW.alice)).statusCode).toBe(200);
    expect((await login(h, 'bob', PW.bob)).statusCode).toBe(200); // another user from the same IP is unaffected
  });

  it('SRV-05 a schema-invalid login body is refused with 400 EINVAL and detail.field before any lookup', async () => {
    const h = await harness();
    const res = await login(h, 'Not A Name', 'x');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errno: 'EINVAL', detail: { field: 'username' } });
    const extra = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: SAME,
      payload: { username: 'alice', password: 'x', uid: 0 },
    });
    expect(extra.statusCode).toBe(400);
    expect(h.store.audits).toHaveLength(0);
  });

  it('SRV-06 a cross-site POST is refused with 403 EACCES csrf before the handler runs', async () => {
    const h = await harness();
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
      {},
    ]) {
      const res = await h.built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers,
        payload: { username: 'alice', password: PW.alice },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errno: 'EACCES', reason: 'csrf' });
    }
    const allowed = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:4717' },
      payload: { username: 'alice', password: PW.alice },
    });
    expect(allowed.statusCode).toBe(200);
    expect(h.store.audits.map((a) => a.event)).toEqual(['login.success']);
  });

  it('SRV-02 a production origin uses the __Host- cookie prefix', async () => {
    const h = await harness({ APP_ORIGIN: 'https://plotinium.example' });
    const res = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: SAME,
      payload: { username: 'alice', password: PW.alice },
    });
    expect(String(res.headers['set-cookie'])).toMatch(/^__Host-plt_sid=/);
  });

  it('SRV-15 log lines never contain the session token or the password', async () => {
    const h = await harness();
    const res = await login(h, 'alice', PW.alice);
    await h.built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieOf(res) },
    });
    const text = h.lines.join('');
    expect(text).toContain('"route":"/api/auth/login"');
    expect(text).toContain('"uid":1100');
    expect(text).not.toContain(PW.alice);
    expect(text).not.toContain(cookieOf(res).split('=')[1]);
  });
});

describe('BOOT-14 guest accounts (backend-api.md §3.6.1)', () => {
  it('BOOT-14 a guest gets a private home, a 20 MB / 500-inode quota and a 2-hour session, and cannot su', async () => {
    const h = await harness();
    const res = await h.built.app.inject({ method: 'POST', url: '/api/auth/guest', headers: SAME });
    expect(res.statusCode).toBe(201);
    const me = res.json<AuthMe>();
    expect(me.username).toMatch(/^guest-[a-z2-7]{4}$/);
    expect(me).toMatchObject({
      uid: 60_000,
      kind: 'guest',
      gid: 60_000,
      home: `/home/${me.username}`,
      offlineVerifier: { allowed: false },
    });
    expect(me.quota).toMatchObject({ quotaBytes: 20 * 1024 * 1024, quotaInodes: 500 });
    expect(new Date(me.session.absoluteExpiresAt).getTime() - h.clock.t).toBe(2 * 3_600_000);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=7200');
    const su = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/su',
      headers: { ...SAME, cookie: cookieOf(res) },
      payload: { target: 'root', password: PW.root },
    });
    expect(su.statusCode).toBe(403);
    expect(su.json()).toMatchObject({ errno: 'EPERM', reason: 'guest' });
    const pw = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...SAME, cookie: cookieOf(res) },
      payload: { current: 'x', next: 'long-enough-password' },
    });
    expect(pw.json()).toMatchObject({ errno: 'EPERM', reason: 'guest' });
    const alice = await login(h, 'alice', PW.alice);
    const toGuest = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/su',
      headers: { ...SAME, cookie: cookieOf(alice) },
      payload: { target: me.username, password: 'x' },
    });
    expect(toGuest.json()).toMatchObject({ errno: 'EPERM', reason: 'guest' });
  });

  it('BOOT-14 guests are refused with 403 EPERM when disabled and with 429 when every slot is taken', async () => {
    const off = await harness({ GUEST_ENABLED: '0' });
    const disabled = await off.built.app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      headers: SAME,
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({ errno: 'EPERM' });
    const one = await harness({ GUEST_MAX_ACTIVE: '1' });
    expect(
      (await one.built.app.inject({ method: 'POST', url: '/api/auth/guest', headers: SAME }))
        .statusCode,
    ).toBe(201);
    const full = await one.built.app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      headers: { ...SAME, 'x-forwarded-for': '1.2.3.4' },
    });
    expect(full.statusCode).toBe(429);
    expect(full.json()).toMatchObject({ errno: 'EAGAIN', reason: 'rate' });
  });
});

describe('SRV-19 su grants and the principal header (backend-api.md §3.8.6; security-model.md §5.2)', () => {
  it('SRV-19 an X-Plotinium-Principal header without a live grant is refused with 403 EACCES principal', async () => {
    const h = await harness();
    const c = cookieOf(await login(h, 'alice', PW.alice));
    const res = await h.built.app.inject({
      method: 'GET',
      url: '/api/sync/snapshot',
      headers: { cookie: c, 'x-plotinium-principal': '0' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errno: 'EACCES', reason: 'principal' });
    const self = await h.built.app.inject({
      method: 'GET',
      url: '/api/sync/snapshot',
      headers: { cookie: c, 'x-plotinium-principal': '1100' },
    });
    // The principal is accepted; the snapshot itself needs the database this harness lacks.
    expect(self.statusCode).toBe(503);
    expect(self.json()).toMatchObject({ errno: 'EIO', reason: 'server' });
    const junk = await h.built.app.inject({
      method: 'GET',
      url: '/api/sync/snapshot',
      headers: { cookie: c, 'x-plotinium-principal': 'root' },
    });
    expect(junk.statusCode).toBe(403);
  });

  it('SRV-19 su to root grants 15 minutes, root routes then accept principal 0, and DELETE clears the grant', async () => {
    const h = await harness();
    const c = cookieOf(await login(h, 'alice', PW.alice));
    const probes = (principal?: string) =>
      h.built.app.inject({
        method: 'GET',
        url: '/api/admin/probes',
        headers: {
          cookie: c,
          ...(principal === undefined ? {} : { 'x-plotinium-principal': principal }),
        },
      });
    expect((await probes()).json()).toMatchObject({ errno: 'EPERM', reason: 'root-only' });

    const wrong = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/su',
      headers: { ...SAME, cookie: c },
      payload: { target: 'root', password: 'nope' },
    });
    const unknown = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/su',
      headers: { ...SAME, cookie: c },
      payload: { target: 'nobody', password: 'nope' },
    });
    for (const r of [wrong, unknown]) {
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ errno: 'EACCES', msg: 'authentication failure' });
    }
    const ok = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/su',
      headers: { ...SAME, cookie: c },
      payload: { target: 'root', password: PW.root },
    });
    expect(ok.statusCode).toBe(200);
    const grant = ok.json<{ grant: { uid: number; username: string; expiresAt: string } }>().grant;
    expect(grant).toEqual({
      uid: 0,
      username: 'root',
      expiresAt: new Date(h.clock.t + 15 * 60_000).toISOString(),
    });
    // root passes the route-auth hook; the probes themselves need the database (503 here).
    expect((await probes('0')).json()).toMatchObject({ errno: 'EIO', reason: 'server' });
    const me = await h.built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: c },
    });
    expect(me.json<AuthMe>().suGrants).toEqual([grant]);

    h.clock.t += 16 * 60_000; // grants are never extended by use
    expect((await probes('0')).json()).toMatchObject({ errno: 'EACCES', reason: 'principal' });
    expect(
      (
        await h.built.app.inject({
          method: 'DELETE',
          url: '/api/auth/su/0',
          headers: { ...SAME, cookie: c },
        })
      ).statusCode,
    ).toBe(404);

    await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/su',
      headers: { ...SAME, cookie: c },
      payload: { target: 'root', password: PW.root },
    });
    expect(
      (
        await h.built.app.inject({
          method: 'DELETE',
          url: '/api/auth/su/0',
          headers: { ...SAME, cookie: c },
        })
      ).statusCode,
    ).toBe(204);
    expect((await probes('0')).statusCode).toBe(403);
    expect(h.store.audits.map((a) => a.event)).toEqual([
      'login.success',
      'su.fail',
      'su.fail',
      'su.grant',
      'su.grant',
      'su.revoke',
    ]);
  });
});

describe('SRV-08 password change (backend-api.md §3.6.1)', () => {
  it('SRV-08 a password change revokes every other session of the user and rotates the current one', async () => {
    const h = await harness();
    const phone = cookieOf(await login(h, 'alice', PW.alice));
    const laptop = cookieOf(await login(h, 'alice', PW.alice));
    const short = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...SAME, cookie: laptop },
      payload: { current: PW.alice, next: 'short' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ errno: 'EINVAL', detail: { field: 'next' } });
    const wrong = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...SAME, cookie: laptop },
      payload: { current: 'wrong-current', next: 'a-brand-new-password' },
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await h.built.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...SAME, cookie: laptop },
      payload: { current: PW.alice, next: 'a-brand-new-password' },
    });
    expect(ok.statusCode).toBe(204);
    const rotated = cookieOf(ok);
    expect(rotated).not.toBe(laptop);
    for (const old of [phone, laptop]) {
      expect(
        (await h.built.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: old } }))
          .statusCode,
      ).toBe(401);
    }
    const me = await h.built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: rotated },
    });
    expect(me.json<AuthMe>().passwordVersion).toBe(2);
    expect((await login(h, 'alice', PW.alice)).statusCode).toBe(401);
    expect((await login(h, 'alice', 'a-brand-new-password')).statusCode).toBe(200);
    expect(h.store.users.get(1100)?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
});

describe('SRV-08 database outages', () => {
  it('SRV-08 a session store outage answers 503 EIO instead of logging the user out', async () => {
    const h = await harness();
    const c = cookieOf(await login(h, 'alice', PW.alice));
    h.store.down = true;
    const res = await h.built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: c },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errno: 'EIO', reason: 'server' });
    expect(res.headers['retry-after']).toBe('1');
  });

  it('SRV-08 without a database the auth routes answer 503 EIO', async () => {
    const config = parseConfig({ BLOB_DIR: blobDir, LOG_LEVEL: 'silent' }, () => '');
    const built = await buildApp(config, {
      database: null,
      metrics: createMetrics({ defaultMetrics: false }),
      expectedMigration: null,
    });
    apps.push(built);
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: SAME,
      payload: { username: 'alice', password: 'x' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errno: 'EIO' });
    expect(
      (await built.app.inject({ method: 'POST', url: '/api/auth/guest', headers: SAME }))
        .statusCode,
    ).toBe(503);
  });
});
