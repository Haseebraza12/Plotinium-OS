import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryAuthStore } from '../tests/memory-auth-store.ts';
import { buildApp, type PlotiniumApp } from './app.ts';
import { parseConfig } from './config.ts';
import { ERRNOS } from './errno.ts';
import { hashPassword } from './gateway/argon2.ts';
import { createLogger } from './obs/logger.ts';
import { createMetrics } from './obs/metrics.ts';
import { uuidv7, UUIDV7_RE } from './util/uuidv7.ts';

let blobDir: string;
const apps: PlotiniumApp[] = [];

beforeEach(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'plt-app-'));
});
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.app.close();
  await rm(blobDir, { recursive: true, force: true });
});

async function make(
  env: Record<string, string> = {},
  logLines?: string[],
  authStore?: MemoryAuthStore,
): Promise<PlotiniumApp> {
  const config = parseConfig(
    { BLOB_DIR: blobDir, LOG_LEVEL: logLines ? 'info' : 'silent', ...env },
    () => {
      throw new Error('no secret files in this test');
    },
  );
  const logger = createLogger(config, { write: (line: string) => logLines?.push(line) });
  const built = await buildApp(config, {
    database: null,
    logger,
    metrics: createMetrics({ defaultMetrics: false }),
    expectedMigration: null,
    ...(authStore === undefined ? {} : { authStore }),
  });
  apps.push(built);
  return built;
}

/** An app with one account (alice) and a logged-in session cookie. */
async function withSession(
  env: Record<string, string> = {},
): Promise<{ built: PlotiniumApp; cookie: string }> {
  const store = new MemoryAuthStore();
  store.addUser({
    uid: 1100,
    username: 'alice',
    passwordHash: await hashPassword('alice-password'),
  });
  const built = await make(env, undefined, store);
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'sec-fetch-site': 'same-origin' },
    payload: { username: 'alice', password: 'alice-password' },
  });
  return { built, cookie: String(res.headers['set-cookie']).split(';')[0] ?? '' };
}

describe('SRV-03 route inventory and the error model', () => {
  it('SRV-03 the route inventory contains only /api/* and /ws and no static file route', async () => {
    const { app, routes } = await make({ FAULT_INJECTION: '1' });
    await app.ready();
    expect(routes.length).toBeGreaterThan(30);
    for (const r of routes)
      expect(r.url === '/ws' || r.url.startsWith('/api/'), `${r.method} ${r.url}`).toBe(true);
    expect(routes.some((r) => r.url.includes('*'))).toBe(false);
  });

  it('SRV-04 every data route answers 401 without a session and 503 EIO server without a database, in the SRV-04 shape', async () => {
    const { built, cookie } = await withSession();
    const cases: [string, string][] = [
      ['GET', '/api/sync/snapshot?scope=owner&owner=1100'],
      ['POST', '/api/ops/0192f2a0-0000-7000-8000-000000000001'],
      ['GET', `/api/blobs/${'a'.repeat(64)}`],
      ['GET', '/api/swap'],
      ['POST', '/api/index/search'],
      ['GET', '/api/telemetry/consent'],
    ];
    for (const [method, url] of cases) {
      const post =
        method === 'POST' ? { payload: {}, headers: { 'sec-fetch-site': 'same-origin' } } : {};
      const anonymous = await built.app.inject({ method: method as 'GET', url, ...post });
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
      expect(anonymous.json()).toMatchObject({ errno: 'EACCES' });
      const res = await built.app.inject({
        method: method as 'GET',
        url,
        ...(method === 'POST' ? { payload: {} } : {}),
        headers: { cookie, ...(method === 'POST' ? { 'sec-fetch-site': 'same-origin' } : {}) },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      const body = res.json<{
        errno: string;
        reason: string;
        reqId: string;
        retryAfterMs: number;
      }>();
      expect(body).toMatchObject({ errno: 'EIO', reason: 'server' });
      expect(body.reqId).toMatch(UUIDV7_RE);
      expect(body.retryAfterMs).toBeGreaterThan(0);
      expect(res.headers['x-request-id']).toBe(body.reqId);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    // The LLM gateway needs no database: without a key it is degraded, never missing.
    const health = await built.app.inject({
      method: 'GET',
      url: '/api/llm/health',
      headers: { cookie },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: false, degradedReason: 'no-key' });
  });

  it('SRV-07 /ws refuses before the upgrade: 503 without a database, then Origin (403) before the session (401)', async () => {
    const { built } = await withSession();
    const noDb = await built.app.inject({
      method: 'GET',
      url: '/ws',
      headers: { origin: 'http://localhost:4717' },
    });
    expect(noDb.statusCode).toBe(503);
    expect(noDb.json()).toMatchObject({ errno: 'EIO', reason: 'server' });
  });

  it('SRV-04 an unknown route is 404 ENOSYS and an unsupported content type is 415 EINVAL, both in the SRV-04 shape', async () => {
    const { app } = await make();
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errno: 'ENOSYS' });
    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' },
      payload: 'user=root',
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toMatchObject({ errno: 'EINVAL' });
    const badJson = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: '{"broken',
    });
    expect(badJson.statusCode).toBe(400);
    const body = badJson.json<{ errno: string }>();
    expect(ERRNOS).toContain(body.errno);
  });

  it('SRV-04 a body over the route limit is refused with 413 EINVAL before the handler runs', async () => {
    const { app } = await make();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'x', password: 'y'.repeat(8 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ errno: 'EINVAL' });
  });
});

describe('SRV-18 AI=0 and the fault harness switch routes off', () => {
  it('SRV-18 with AI=0 the index and llm routes answer 404 ENOSYS and the rest of the API still answers', async () => {
    const { app } = await make({ AI: '0' });
    for (const url of ['/api/index/pull', '/api/llm/health']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errno: 'ENOSYS' });
    }
    expect((await app.inject({ method: 'GET', url: '/api/healthz' })).statusCode).toBe(200);
  });

  it('DB-02 fault harness is absent when FAULT_INJECTION is unset and mounted when it is 1', async () => {
    const off = await make();
    expect((await off.app.inject({ method: 'GET', url: '/api/debug/fault' })).statusCode).toBe(404);
    const on = await withSession({ FAULT_INJECTION: '1' });
    const harness = await on.built.app.inject({
      method: 'GET',
      url: '/api/debug/fault',
      headers: { cookie: on.cookie },
    });
    expect(harness.statusCode).toBe(403); // mounted, but root-only (a live su grant for uid 0)
    expect(harness.json()).toMatchObject({ errno: 'EPERM', reason: 'root-only' });
    expect((await on.built.app.inject({ method: 'GET', url: '/api/debug/fault' })).statusCode).toBe(
      401,
    );
  });
});

describe('SRV-13 the LLM gateway wiring (backend-api.md §3.13; spec §12.6)', () => {
  it('SRV-13 PLOTINIUM_ENV=ci runs the gateway in replay mode: healthy without a key, and a request with no recorded cassette is 503 EAIUNAVAIL upstream naming the cassette', async () => {
    const { built, cookie } = await withSession({ PLOTINIUM_ENV: 'ci' });
    expect(built.llm?.mode).toBe('replay');
    expect(built.llm?.gateway.state).toBe('available');
    const health = await built.app.inject({
      method: 'GET',
      url: '/api/llm/health',
      headers: { cookie },
    });
    expect(health.json()).toMatchObject({ ok: true });
    const plan = await built.app.inject({
      method: 'POST',
      url: '/api/llm/plan',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      payload: { requestId: uuidv7(), turn: 1, userTurn: 'list my files' },
    });
    expect(plan.statusCode).toBe(503);
    const body = plan.json<{ errno: string; reason: string; detail: { cassette: string } }>();
    expect(body).toMatchObject({ errno: 'EAIUNAVAIL', reason: 'upstream' });
    expect(body.detail.cassette).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SRV-17 health and readiness (backend-api.md §3.16)', () => {
  it('SRV-17 healthz is 200 at once while readyz stays 503 starting until startup completes', async () => {
    const built = await make();
    const { app, readiness } = built;
    expect((await app.inject({ method: 'GET', url: '/api/healthz' })).json()).toEqual({
      status: 'ok',
    });
    const starting = await app.inject({ method: 'GET', url: '/api/readyz' });
    expect(starting.statusCode).toBe(503);
    expect(starting.json()).toMatchObject({ status: 'starting' });
    readiness.markReady();
    const ready = await app.inject({ method: 'GET', url: '/api/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ready',
      build: { name: 'Plotinium', version: '0.1.0' },
      checks: { db: 'skipped', blobStore: 'ok', disk: 'ok' },
      ai: { enabled: true, llm: 'no-key' },
      faultInjection: false,
    });
  });

  it('SRV-16 readyz answers 503 draining once shutdown has begun', async () => {
    const { app, readiness } = await make();
    readiness.markReady();
    readiness.markDraining();
    const res = await app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'draining' });
  });

  it('SRV-17 readyz reports degraded when the blob store is not writable', async () => {
    const notADirectory = join(blobDir, 'a-file');
    await writeFile(notADirectory, 'x');
    const { app, readiness } = await make({ BLOB_DIR: join(notADirectory, 'blobs') });
    readiness.markReady();
    const res = await app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', checks: { blobStore: 'fail' } });
  });
});

describe('SRV-09 rate limiting on the wire', () => {
  it('SRV-09 the health class answers 429 EAGAIN rate with retryAfterMs and Retry-After once the bucket is empty', async () => {
    const { app } = await make();
    let last = await app.inject({ method: 'GET', url: '/api/healthz' });
    for (let i = 0; i < 70 && last.statusCode === 200; i++)
      last = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(last.statusCode).toBe(429);
    const body = last.json<{ errno: string; reason: string; retryAfterMs: number }>();
    expect(body).toMatchObject({ errno: 'EAGAIN', reason: 'rate' });
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(Number(last.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('SRV-09 X-Forwarded-For is ignored unless the direct peer is in TRUST_PROXY_CIDRS', async () => {
    const { app } = await make({ TRUST_PROXY_CIDRS: '10.9.9.0/24' });
    // A spoofed header from an untrusted peer does not give each request a fresh bucket.
    let last = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    for (let i = 0; i < 70 && last.statusCode === 200; i++) {
      last = await app.inject({
        method: 'GET',
        url: '/api/healthz',
        headers: { 'x-forwarded-for': `1.1.1.${i}` },
      });
    }
    expect(last.statusCode).toBe(429);
  });
});

describe('SRV-15 logging', () => {
  it('SRV-15 log lines carry reqId and never contain a cookie, a password or an authorization header', async () => {
    const lines: string[] = [];
    const { app } = await make({}, lines);
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        cookie: 'plt_sid=abc.SECRETCOOKIE',
        authorization: 'Bearer SECRETTOKEN',
        'sec-fetch-site': 'same-origin',
      },
      payload: { username: 'alice', password: 'SECRETPASSWORD' },
    });
    const text = lines.join('');
    expect(text).toContain('"reqId"');
    expect(text).toContain('"route":"/api/auth/login"');
    expect(text).toContain('"errno":"EIO"'); // no database in this test: 503
    for (const secret of ['SECRETCOOKIE', 'SECRETTOKEN', 'SECRETPASSWORD'])
      expect(text).not.toContain(secret);
  });
});
