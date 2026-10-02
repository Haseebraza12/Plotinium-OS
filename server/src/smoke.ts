/**
 * Deploy smoke check (deployment-and-ci.md §3.3 "verify"; backend-api.md §3.7, §3.16): readiness,
 * a login, and one WebSocket protocol v1 handshake against a RUNNING server.
 *
 *   node server/src/smoke.ts [baseUrl]                       default http://127.0.0.1:3000
 *   docker compose exec -T app node server/src/smoke.ts      inside the app container
 *   node server/src/smoke.ts http://localhost:4717           through Caddy, from the host
 *
 * Environment: SMOKE_ORIGIN (default APP_ORIGIN or http://localhost:4717), SMOKE_USER and
 * SMOKE_PASSWORD (without them a guest session is created; the guest class allows 3 per hour per
 * IP). Every server frame is parsed with the protocol's S2CFrame schema. Prints one JSON line per
 * step and exits 0 when all passed, 1 otherwise. Never prints the cookie or the password.
 */
import * as v from 'valibot';
import WebSocket from 'ws';

import { HelloOk, PROTO, S2CFrame } from '@plotinium/protocol';

import { rawDataText } from './sync/routes.ts';
import { uuidv7 } from './util/uuidv7.ts';

const TIMEOUT_MS = 10_000;

function report(step: string, ok: boolean, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ step, ok, ...detail })}\n`);
}

async function session(base: string, origin: string): Promise<{ cookie: string; uid: number }> {
  const user = process.env['SMOKE_USER'];
  const password = process.env['SMOKE_PASSWORD'];
  const guest = user === undefined || password === undefined;
  const res = await fetch(`${base}${guest ? '/api/auth/guest' : '/api/auth/login'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(guest ? {} : { username: user, password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json()) as { uid?: number; username?: string; errno?: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (!res.ok || cookie === '')
    throw new Error(`${guest ? 'guest' : 'login'} failed: ${res.status} ${body.errno ?? ''}`);
  report(guest ? 'guest' : 'login', true, { status: res.status, username: body.username });
  return { cookie, uid: body.uid ?? -1 };
}

function hello(base: string, origin: string, cookie: string, uid: number): Promise<void> {
  const url = `${base.replace(/^http/, 'ws')}/ws`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { origin, cookie } });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('no hello.ok within 10 s'));
    }, TIMEOUT_MS);
    socket.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`upgrade refused: ${res.statusCode ?? 0}`));
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('message', (data) => {
      const text = rawDataText(data);
      const parsed = v.safeParse(S2CFrame, JSON.parse(text));
      if (!parsed.success) {
        clearTimeout(timer);
        socket.terminate();
        reject(new Error(`a server frame failed the S2CFrame schema: ${text.slice(0, 200)}`));
        return;
      }
      const f = parsed.output;
      if (f.t !== 'hello.ok') return;
      clearTimeout(timer);
      const ok = v.parse(HelloOk, f.body);
      report('ws-hello', ok.auth.uid === uid, {
        proto: ok.proto,
        server: ok.server,
        uid: ok.auth.uid,
        kind: ok.auth.kind,
        leaseTtlMs: ok.timers.leaseTtlMs,
        owners: ok.owners.map((o) => `${o.ownerUid}:${o.mode}`),
      });
      socket.send(JSON.stringify({ v: 1, t: 'bye', id: 2, body: { reason: 'logout' } }));
      socket.close(1000);
      resolve();
    });
    socket.once('open', () => {
      report('ws-open', true, { url });
      socket.send(
        JSON.stringify({
          v: 1,
          t: 'hello',
          id: 1,
          body: {
            proto: PROTO,
            build: { name: 'Plotinium', version: '0.1.0', build: '0000000', date: '1970-01-01' },
            osSessionId: uuidv7(),
            deviceId: uuidv7(),
            kernelEpoch: 1,
            lamport: 0,
            outbox: { pending: 0, held: 0 },
            heldLeases: [],
            resume: uid >= 0 ? [{ ownerUid: uid, fromSeq: 0 }] : [],
          },
        }),
      );
    });
  });
}

async function main(): Promise<void> {
  const base = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const origin =
    process.env['SMOKE_ORIGIN'] ?? process.env['APP_ORIGIN'] ?? 'http://localhost:4717';
  const ready = await fetch(`${base}/api/readyz`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await ready.json()) as Record<string, unknown>;
  report('readyz', ready.ok, { status: ready.status, ...body });
  if (!ready.ok) throw new Error('not ready');
  const { cookie, uid } = await session(base, origin);
  await hello(base, origin, cookie, uid);
  const out = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: {
      origin,
      cookie,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  report('logout', out.status === 204, { status: out.status });
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    report('failed', false, { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);
