import type { AddressInfo } from 'node:net';

import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { OpResult, OpSubmit } from '@plotinium/protocol';

import { MemoryAuthStore } from '../../tests/memory-auth-store.ts';
import { pluginApp } from '../../tests/plugin-app.ts';
import { UpgradeRefused, WsTestClient } from '../../tests/ws-client.ts';
import type { ConnAuth, Transport } from '../engine/sync/connection.ts';
import { ProtocolViolation, type OpOrigin } from '../engine/sync/engine.ts';
import type { SyncRuntime } from '../engine/sync/runtime.ts';
import { uuidv7 } from '../util/uuidv7.ts';
import { credOf, rawDataText, syncPlugin, MAX_SOCKETS_PER_SESSION } from './routes.ts';
import { SuGrants } from './su-grants.ts';

const ORIGIN = 'http://localhost:4717';
const ALICE = { 'x-test-uid': '1001' };

/** The hub surface the plugin uses, recorded. */
class FakeHub {
  sockets = 0;
  violation = false;
  readonly accepted: {
    auth: ConnAuth;
    transport: Transport;
    messages: string[];
    pongs: number;
    closed: number | null;
  }[] = [];
  readonly submitted: { origin: Omit<OpOrigin, 'connId' | 'deviceId'>; submit: OpSubmit }[] = [];

  socketsOf(): number {
    return this.sockets;
  }
  accept(transport: Transport, auth: ConnAuth) {
    const rec = {
      auth,
      transport,
      messages: [] as string[],
      pongs: 0,
      closed: null as number | null,
    };
    this.accepted.push(rec);
    return {
      onMessage: (text: string) => {
        rec.messages.push(text);
        transport.send(text.toUpperCase()); // echo, so the test can see the send path
      },
      onPong: () => {
        rec.pongs++;
      },
      onClose: (code: number) => {
        rec.closed = code;
      },
    };
  }
  submitOp(origin: Omit<OpOrigin, 'connId' | 'deviceId'>, submit: OpSubmit): Promise<OpResult> {
    this.submitted.push({ origin, submit });
    if (this.violation) return Promise.reject(new ProtocolViolation('not yours'));
    return Promise.resolve({ opId: submit.opId, status: 'applied', duplicate: false, lamport: 7 });
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

async function make(over: { draining?: boolean; noSync?: boolean } = {}) {
  const hub = new FakeHub();
  const store = new MemoryAuthStore();
  store.addUser({ uid: 1001, username: 'alice' });
  store.addUser({ uid: 0, username: 'root', kind: 'root', primaryGid: 0 });
  const suGrants = new SuGrants({ onEnded: () => undefined });
  const app = await pluginApp(async (a) => {
    await a.register(websocket, { options: { maxPayload: 65_536, perMessageDeflate: false } });
    await syncPlugin(a, {
      sync: over.noSync === true ? null : ({ hub } as unknown as SyncRuntime),
      snapshot: null,
      store,
      origins: new Set([ORIGIN]),
      draining: () => over.draining === true,
      suGrants,
      now: Date.now,
    });
  });
  apps.push(app);
  return { app, hub, store, suGrants };
}

const op = (opId = uuidv7(), principal = 1001): OpSubmit => ({
  opId,
  osSessionId: uuidv7(),
  cseq: 1,
  lamport: 1,
  principal,
  clientTime: new Date().toISOString(),
  op: {
    kind: 'create',
    parentIno: uuidv7(),
    name: 'big.txt',
    ino: uuidv7(),
    type: 'f',
    mode: 0o644,
    mtime: 1,
  },
  base: { kind: 'versions', entries: [] },
  audit: { actor: 'user', pid: 42 },
});

describe('SRV-07 the /ws upgrade and POST /api/ops (backend-api.md §3.7; offline-and-sync.md §4.1)', () => {
  it('SRV-07 the checks run in the §3.7 order before any upgrade: draining, origin, Sec-Fetch-Site, session, store, socket cap', async () => {
    const get = (app: FastifyInstance, headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/ws', headers });
    const drain = await make({ draining: true });
    expect((await get(drain.app, { ...ALICE, origin: ORIGIN })).statusCode).toBe(503);
    const noDb = await make({ noSync: true });
    expect((await get(noDb.app, { ...ALICE, origin: ORIGIN })).json()).toMatchObject({
      reason: 'server',
    });

    const { app, hub } = await make();
    const status = async (headers: Record<string, string>) => (await get(app, headers)).statusCode;
    expect(await status({ ...ALICE, origin: 'https://evil.example' })).toBe(403);
    expect(await status({ ...ALICE })).toBe(403); // no Origin at all
    expect(await status({ ...ALICE, origin: ORIGIN, 'sec-fetch-site': 'same-site' })).toBe(403);
    expect(await status({ origin: ORIGIN })).toBe(401);
    expect(await status({ origin: ORIGIN, 'x-test-auth-down': '1' })).toBe(503);
    hub.sockets = MAX_SOCKETS_PER_SESSION;
    const capped = await get(app, { ...ALICE, origin: ORIGIN });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ errno: 'EAGAIN', reason: 'rate' });
    hub.sockets = 0;
    // A plain GET that passes every check is not a WebSocket: 426.
    expect(await status({ ...ALICE, origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).toBe(426);
  });

  it('SYN-01 an accepted socket is handed to the hub with the cookie identity; frames, pongs and the close reach the connection', async () => {
    const { app, hub, suGrants } = await make();
    suGrants.set('session-1001', { uid: 0, expiresAt: new Date(Date.now() + 60_000), gids: [0] });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/ws`;
    await expect(WsTestClient.connect(url, { origin: ORIGIN })).rejects.toBeInstanceOf(
      UpgradeRefused,
    );

    // The harness keys the session on x-test-uid; the ws client can send it as a header.
    const c = await WsTestClient.connect(url, { origin: ORIGIN, 'x-test-uid': '1001' });
    expect(hub.accepted).toHaveLength(1);
    const rec = hub.accepted[0];
    expect(rec?.auth).toMatchObject({ uid: 1001, username: 'alice', kind: 'user', gids: [100] });
    expect(rec?.auth.suGrants().map((g) => g.uid)).toEqual([0]);
    expect(rec?.auth.gidsOf?.(0)).toEqual([0]);
    expect(rec?.auth.gidsOf?.(1002)).toEqual([1002]);
    expect(rec?.transport.bufferedAmount).toBe(0);
    c.sendRaw('{"v":1}');
    await expect.poll(() => rec?.messages).toEqual(['{"v":1}']);
    rec?.transport.ping();
    await expect.poll(() => rec?.pongs).toBe(1);
    rec?.transport.close(4401, 'revoked');
    expect((await c.closed).code).toBe(4401);
    await expect.poll(() => rec?.closed).toBe(4401);
  });

  it('SYN-01 POST /api/ops/{opId} validates the body, matches the path id, passes the principal rules to the hub and maps a foreign OS session to 403', async () => {
    const { app, hub, suGrants } = await make();
    const post = (url: string, body: unknown, headers: Record<string, string> = ALICE) =>
      app.inject({ method: 'POST', url, headers, payload: body as object });
    const body = op();
    const ok = await post(`/api/ops/${body.opId}`, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ opId: body.opId, status: 'applied', duplicate: false, lamport: 7 });
    const origin = hub.submitted[0]?.origin;
    expect(origin?.uid).toBe(1001);
    expect(origin?.mayActAs(1001)).toBe(true);
    expect(origin?.mayActAs(0)).toBe(false);
    expect(origin?.gidsOf(1001)).toEqual([100]);

    expect((await post(`/api/ops/${uuidv7()}`, body)).statusCode).toBe(409);
    expect((await post(`/api/ops/${body.opId}`, { ...body, cseq: -1 })).statusCode).toBe(400);
    expect((await post('/api/ops/not-a-uuid', body)).statusCode).toBe(400);
    expect((await post(`/api/ops/${body.opId}`, body, {})).statusCode).toBe(401);

    // Under a live su grant the principal's groups come from the grant registry.
    suGrants.set('session-1001', {
      uid: 0,
      expiresAt: new Date(Date.now() + 60_000),
      gids: [0, 10],
    });
    const asRoot = op(uuidv7(), 0);
    expect((await post(`/api/ops/${asRoot.opId}`, asRoot)).statusCode).toBe(200);
    const rootOrigin = hub.submitted.at(-1)?.origin;
    expect(rootOrigin?.mayActAs(0)).toBe(true);
    expect(rootOrigin?.gidsOf(0)).toEqual([0, 10]);

    hub.violation = true;
    const foreign = op();
    const denied = await post(`/api/ops/${foreign.opId}`, foreign);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ errno: 'EACCES', reason: 'principal' });
  });

  it('SRV-04 without a database the snapshot and ops routes answer 503 EIO server', async () => {
    const { app } = await make({ noSync: true });
    const snap = await app.inject({
      method: 'GET',
      url: '/api/sync/snapshot?scope=owner&owner=1001',
      headers: ALICE,
    });
    expect(snap.statusCode).toBe(503);
    const body = op();
    const ops = await app.inject({
      method: 'POST',
      url: `/api/ops/${body.opId}`,
      headers: ALICE,
      payload: body,
    });
    expect(ops.statusCode).toBe(503);
  });

  it('SYN-01 rawDataText joins every ws payload shape and credOf puts the primary group first', () => {
    expect(rawDataText(Buffer.from('ab'))).toBe('ab');
    expect(rawDataText([Buffer.from('a'), Buffer.from('b')])).toBe('ab');
    expect(rawDataText(new TextEncoder().encode('ab').buffer)).toBe('ab');
    expect(credOf({ uid: 5, realUid: 5, gids: [100, 7] })).toEqual({
      uid: 5,
      gid: 100,
      groups: [100, 7],
    });
    expect(credOf({ uid: 5, realUid: 5, gids: [] })).toEqual({ uid: 5, gid: 5, groups: [5] });
  });
});
