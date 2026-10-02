/**
 * UI-006: with a server and a WebSocket, the default sync engine links (sync LIVE, lockd RUNNING),
 * a new home takes the id the server minted (C5), local writes drain from the outbox, leases are
 * taken on the server, and a home that cannot be linked leaves sync degraded with a reason instead
 * of sending ops the server would reject.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { RetOf } from '@plotinium/protocol';
import { INO, uuidv7 } from '@plotinium/protocol';
import type { SocketFactory, SocketHandlers } from '@plotinium/vfs/sync';

import type { Program } from '../../../runtime/sys.ts';
import { errnoOf } from '../../../runtime/sys.ts';
import { provisionLocalUser } from '../../fs/users.ts';
import type { IoDeps } from '../types.ts';
import type { World } from './world.ts';
import { bootWorld, fakeServer, loginWaiting } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

/** The server's id for /home/alice (what the server's seed minted). */
const SERVER_HOME = uuidv7();

interface Frame {
  readonly t: string;
  readonly id: number;
  readonly body: Record<string, unknown>;
}

/** A protocol-level fake of `/ws`: handshake, resume, ops applied, leases granted. */
function fakeWs(uid: number, username: string) {
  const sent: Frame[] = [];
  let out = 0;
  let fence = 0;
  let lamport = 0;
  const factory: SocketFactory = (_url: string, h: SocketHandlers) => {
    const reply = (t: string, body: unknown): void => {
      const f = { v: 1, t, id: ++out, body };
      queueMicrotask(() => {
        h.onMessage(JSON.stringify(f));
      });
    };
    queueMicrotask(() => {
      h.onOpen();
    });
    return {
      send: (data: string) => {
        const f = JSON.parse(data) as Frame;
        sent.push(f);
        const b = f.body;
        switch (f.t) {
          case 'hello': {
            const resume = b['resume'] as { ownerUid: number; fromSeq: number }[];
            reply('hello.ok', {
              proto: 1,
              osSessionId: b['osSessionId'],
              server: {
                name: 'Plotinium',
                version: '0.1.0-dev.0',
                build: '0000000',
                date: '2026-09-30',
              },
              serverTime: new Date().toISOString(),
              lamport,
              auth: { uid, username, gids: [100], kind: 'user', suGrants: [] },
              limits: {
                maxPayload: 65_536,
                opEnvelopeMax: 61_440,
                maxBatch: 32,
                creditWindow: 16,
                feedWindow: 256,
                maxLeases: 64,
                maxWatches: 32,
              },
              timers: { leaseTtlMs: 30_000, hbMs: 10_000, deadManMs: 30_000 },
              owners: resume.map((c) => ({
                ownerUid: c.ownerUid,
                fromSeq: c.fromSeq,
                headSeq: 0,
                horizonSeq: 0,
                mode: 'stream',
              })),
              keptLeases: [],
              lostLeases: [],
            });
            for (const c of resume) reply('resume.done', { ownerUid: c.ownerUid, headSeq: 0 });
            return;
          }
          case 'op.submit':
            reply('op.result', {
              opId: b['opId'],
              status: 'applied',
              duplicate: false,
              lamport: ++lamport,
            });
            return;
          case 'lock.acquire':
            reply('lock.granted', {
              reqId: b['reqId'],
              leaseId: uuidv7(),
              ino: b['ino'],
              mode: b['mode'],
              fence: ++fence,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
              ttlMs: 30_000,
            });
            return;
          case 'hb':
            reply('hb.ack', {
              t: b['t'],
              serverTime: new Date().toISOString(),
              renewed: [],
              lost: [],
            });
            return;
        }
      },
      close: () => undefined,
    };
  };
  return { factory, sent };
}

/** The auth fake plus the /home snapshot the home lookup reads. */
function server() {
  const s = fakeServer();
  const blobs: string[] = [];
  const fetch: NonNullable<NonNullable<IoDeps['platform']>['fetch']> = (path, init) => {
    if (path.startsWith('/api/blobs/') && init?.method === 'PUT') {
      blobs.push(path.slice('/api/blobs/'.length));
      return Promise.resolve(new Response('{}', { status: 201 }));
    }
    if (path.startsWith('/api/sync/snapshot?scope=dir&ino=')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            rows: [
              { parentIno: INO.ROOT, name: 'home', ino: INO.HOME, type: 'd' },
              { parentIno: INO.HOME, name: 'alice', ino: SERVER_HOME, type: 'd' },
            ],
            complete: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return s.fetch(path, init);
  };
  return { s, fetch, blobs };
}

async function boot(
  opts: { prepare?: (w: World) => Promise<void>; bootFlags?: readonly string[] } = {},
) {
  const { s, fetch, blobs } = server();
  const ws = fakeWs(1100, 'alice');
  const w = await bootWorld({
    server: s,
    io: {
      ...(opts.bootFlags === undefined ? {} : { bootFlags: opts.bootFlags }),
      platform: {
        channel: () => new MessageChannel(),
        subtle: crypto.subtle,
        fetch,
        origin: 'https://plotinium.test',
        online: true,
        socket: ws.factory,
      },
    },
  });
  worlds.push(w);
  await w.until(() => loginWaiting(w));
  await opts.prepare?.(w);
  const r = await w.login({ user: 'alice', secret: 'alice-pass' });
  expect(r.ok).toBe(true);
  await w.until(() => w.stateOf('desktop') === 'starting' || w.stateOf('desktop') === 'running');
  w.interactive();
  return { w, ws, s, blobs };
}

interface Out {
  wrote?: RetOf<'writeFile'>;
  lease?: RetOf<'lock.acquire'>;
  err?: string;
}

function writeAndLock(out: Out): Program<Out> {
  return {
    init: () => out,
    *run(ctx, st) {
      try {
        st.wrote = yield* ctx.sys.writeFile({
          path: '/home/alice/notes.txt',
          data: new TextEncoder().encode('synced').buffer,
        });
        st.lease = yield* ctx.sys['lock.acquire']({
          path: '/home/alice/notes.txt',
          mode: 'X',
          wait: false,
        });
      } catch (e) {
        st.err = errnoOf(e) ?? String(e);
      }
      return 0;
    },
  };
}

describe('UI-006 sync links when a server and a socket exist', () => {
  it('UI-006 sync LIVE, lockd RUNNING, the home is the server’s, writes drain, leases are the server’s', async () => {
    const { w, ws, blobs } = await boot();
    await w.until(() => w.stateOf('sync') === 'running' && w.stateOf('lockd') === 'running');
    expect(ws.sent.map((f) => f.t)).toContain('hello');

    const fs = w.io.fs();
    expect(fs?.tree.user(1100)?.homeIno).toBe(SERVER_HOME);

    const out: Out = {};
    const p = w.lb.spawn(writeAndLock(out), { name: 'probe', uid: 1100, gid: 100 });
    await w.lb.run(p.pid);
    expect(out.err).toBeUndefined();
    await w.until(() => ws.sent.some((f) => f.t === 'op.submit'));
    await w.until(() => w.io.net.status().queuedOps === 0);
    expect(w.io.net.status().state).toBe('online');
    expect(out.lease?.scope).toBe('server');
    // The content went up first (PUT /api/blobs/<sha>, read from the local chunks).
    expect(blobs).toHaveLength(1);
    expect(ws.sent.some((f) => f.t === 'lock.acquire')).toBe(true);
  });

  it('UI-006 the nosync boot flag keeps the device standalone (kill switch)', async () => {
    const { w, ws } = await boot({ bootFlags: ['test:nosync'] });
    await w.until(() => w.stateOf('sync') === 'degraded');
    expect(w.mgr.status().find((x) => x.name === 'sync')?.reason).toMatch(
      /^sync client not linked/,
    );
    expect(ws.sent).toEqual([]);
  });

  it('UI-166 logging out says `bye {reason: logout}` on the socket before the session ends', async () => {
    const { w, ws } = await boot();
    await w.until(() => w.stateOf('sync') === 'running');
    w.io.router({ t: 'login.logout' });
    await w.until(() => ws.sent.some((f) => f.t === 'bye'));
    expect(ws.sent.find((f) => f.t === 'bye')?.body).toEqual({ reason: 'logout' });
  });

  it('UI-006 a non-empty home made offline keeps its id and sync says why instead of sending', async () => {
    const { w, ws } = await boot({
      prepare: async (world) => {
        const fs = world.io.fs();
        if (fs === null) throw new Error('not mounted');
        await provisionLocalUser(fs, { uid: 1100, username: 'alice', homeIno: uuidv7() });
        await fs.store.tx(
          ['dentries'],
          'strict',
          (t) => {
            const home = fs.tree.user(1100)?.homeIno ?? '';
            t.put('dentries', { parent: home, name: 'old.txt', ino: uuidv7(), dtype: 'f' });
          },
          { label: 'test: a file in the offline home' },
        );
      },
    });
    await w.until(() => w.stateOf('sync') === 'degraded');
    const sync = w.mgr.status().find((x) => x.name === 'sync');
    expect(sync?.reason).toMatch(/^home folder made offline on this device/);
    expect(ws.sent.some((f) => f.t === 'hello')).toBe(false);
    expect(w.io.fs()?.tree.user(1100)?.homeIno).not.toBe(SERVER_HOME);
  });

  it('UI-006 an EMPTY home made offline takes the server’s id at sign-in and sync links', async () => {
    const { w } = await boot({
      prepare: async (world) => {
        const fs = world.io.fs();
        if (fs === null) throw new Error('not mounted');
        await provisionLocalUser(fs, { uid: 1100, username: 'alice', homeIno: uuidv7() });
      },
    });
    await w.until(() => w.stateOf('sync') === 'running');
    expect(w.io.fs()?.tree.user(1100)?.homeIno).toBe(SERVER_HOME);
  });
});
