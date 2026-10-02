/**
 * sync/: the /ws upgrade, the per-owner feed, snapshots and large ops (backend-api.md §3.6.2, §3.7;
 * offline-and-sync.md; SRV-07, OFF-02, VFS-09, VFS-10). Primary owner R2, secondary reviewer R5.
 *
 * GET /ws   a @fastify/websocket route. Its preValidation runs BEFORE the upgrade, in the order of
 *           §3.7: draining -> 503; the ws-upgrade bucket (the IP-keyed onRequest hook) -> 429;
 *           Origin exactly in the allowlist -> else 403; Sec-Fetch-Site, when present, must be
 *           same-origin -> else 403; a valid cookie session -> else 401 (503 when the session store
 *           did not answer); at most 4 open sockets per auth session -> else 429. A refused upgrade
 *           never becomes a WebSocket. After the upgrade the listeners are attached SYNCHRONOUSLY
 *           (messages that arrive before a listener exists would be lost) and the connection is
 *           handed to the hub, which arms the 5 s hello timer and the ping cycle.
 * POST /api/ops/{opId}   ops over 60 KB: Valibot OpSubmit (400 EINVAL), body.opId must equal the
 *           path (409 EINVAL). The op joins the op lane of its OS session's live socket, otherwise
 *           runs directly; every op outcome is 200 with the op.result body. A foreign OS session is
 *           403 EACCES.
 * GET /api/sync/snapshot  see ./snapshot.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import * as v from 'valibot';
import type { RawData, WebSocket } from 'ws';

import { OpSubmit, UuidV7 } from '@plotinium/protocol';
import type { Cred } from '@plotinium/vfs/perm';

import { ProtocolViolation } from '../engine/sync/engine.ts';
import type { SyncRuntime } from '../engine/sync/runtime.ts';
import type { AuthState } from '../gateway/sessions.ts';
import type { AuthStore } from '../gateway/store.ts';
import type { Principal } from '../http/context.ts';
import { HttpError, sendError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';
import type { Metrics } from '../obs/metrics.ts';
import { parseSnapshotQuery, SnapshotQueryString, type SnapshotService } from './snapshot.ts';
import type { SuGrants } from './su-grants.ts';

const MIB = 1024 * 1024;
/** backend-api.md §3.7 step 6. */
export const MAX_SOCKETS_PER_SESSION = 4;
const BUSY_RETRY_MS = 1_000;

export interface SyncPluginOptions {
  /** null: no database; every sync route answers 503 EIO 'server'. */
  readonly sync: SyncRuntime | null;
  readonly snapshot: SnapshotService | null;
  readonly store: AuthStore | null;
  /** APP_ORIGIN and ALLOWED_ORIGINS (exact match, SRV-07). */
  readonly origins: ReadonlySet<string>;
  /** Graceful shutdown has begun (backend-api.md §3.17 step 1). */
  readonly draining: () => boolean;
  readonly suGrants: SuGrants;
  readonly now: () => number;
  readonly metrics?: Metrics;
}

interface Upgrade {
  readonly auth: AuthState;
  readonly username: string;
}

const OpIdParams = v.object({ opId: UuidV7 });

/** The ws message payload as text (binary frames are refused by the router, close 1003). */
export function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export function credOf(p: Principal): Cred {
  const gid = p.gids[0] ?? p.uid;
  return { uid: p.uid, gid, groups: p.gids.length > 0 ? p.gids : [gid] };
}

export function syncPlugin(app: FastifyInstance, opts: SyncPluginOptions): Promise<void> {
  const { sync, suGrants } = opts;
  const upgrades = new WeakMap<FastifyRequest, Upgrade>();

  const refuse = (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    errno: 'EACCES' | 'EAGAIN' | 'EIO',
    msg: string,
    reason?: string,
    retryAfterMs?: number,
  ): FastifyReply =>
    sendError(
      request,
      reply,
      status,
      errno,
      msg,
      reason === undefined ? {} : { reason },
      retryAfterMs,
    );

  /**
   * The @fastify/websocket route shape. Its own type augmentation of 'fastify' does not resolve
   * under pnpm (the package has no fastify link), so the extra `wsHandler` key is typed here.
   */
  const wsRoute: RouteOptions & {
    readonly wsHandler: (socket: WebSocket, request: FastifyRequest) => void;
  } = {
    method: 'GET',
    url: '/ws',
    config: { rateClass: 'ws-upgrade', auth: 'public' },
    preValidation: async (request, reply) => {
      if (opts.draining())
        return refuse(request, reply, 503, 'EIO', 'draining', 'draining', BUSY_RETRY_MS);
      if (sync === null || opts.store === null)
        return refuse(request, reply, 503, 'EIO', 'database unavailable', 'server', BUSY_RETRY_MS);
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !opts.origins.has(origin))
        return refuse(request, reply, 403, 'EACCES', 'origin not allowed', 'origin');
      const site = request.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin')
        return refuse(request, reply, 403, 'EACCES', 'cross-site request', 'csrf');
      const auth = request.plt.auth ?? null;
      if (auth === null) {
        if (request.plt.authUnavailable === true)
          return refuse(
            request,
            reply,
            503,
            'EIO',
            'session store unavailable',
            'server',
            BUSY_RETRY_MS,
          );
        return refuse(request, reply, 401, 'EACCES', 'not logged in');
      }
      if (sync.hub.socketsOf(auth.authSessionId) >= MAX_SOCKETS_PER_SESSION)
        return refuse(request, reply, 429, 'EAGAIN', 'too many sockets', 'rate', BUSY_RETRY_MS);
      const username = await opts.store.usernameOf(auth.uid);
      if (username === null) return refuse(request, reply, 401, 'EACCES', 'not logged in');
      if (auth.suGrant !== null && auth.suGrant.expiresAt.getTime() > opts.now()) {
        const creds = await opts.store.credentials(auth.suGrant.uid);
        suGrants.seed(auth.authSessionId, {
          uid: auth.suGrant.uid,
          expiresAt: auth.suGrant.expiresAt,
          gids: creds?.gids ?? [auth.suGrant.uid],
        });
      }
      request.plt.uid = auth.uid;
      upgrades.set(request, { auth, username });
      return undefined;
    },
    // A plain GET (no Upgrade header) that passed the checks.
    handler: (request, reply) =>
      sendError(request, reply, 426, 'EINVAL', 'WebSocket upgrade required', {
        reason: 'upgrade-required',
      }),
    wsHandler: (socket: WebSocket, request: FastifyRequest) => {
      const up = upgrades.get(request);
      if (up === undefined || sync === null) {
        socket.close(1011, 'server');
        return;
      }
      upgrades.delete(request);
      const { auth, username } = up;
      const conn = sync.hub.accept(
        {
          send: (text) => socket.send(text),
          close: (code, reason) => socket.close(code, reason),
          terminate: () => socket.terminate(),
          ping: () => socket.ping(),
          get bufferedAmount() {
            return socket.bufferedAmount;
          },
          pauseReading: (ms) => {
            socket.pause();
            setTimeout(() => socket.resume(), ms).unref();
          },
        },
        {
          authSessionId: auth.authSessionId,
          uid: auth.uid,
          username,
          kind: auth.kind === 'root' ? 'user' : auth.kind,
          gids: auth.gids,
          suGrants: () => suGrants.grantsOf(auth.authSessionId),
          gidsOf: (uid) => suGrants.gidsOf(auth.authSessionId, uid) ?? [uid],
        },
      );
      opts.metrics?.wsConnections.inc();
      // Synchronously, before anything else can run (backend-api.md §3.7).
      socket.on('message', (data, isBinary) =>
        conn.onMessage(isBinary ? '' : rawDataText(data), isBinary),
      );
      socket.on('pong', () => conn.onPong());
      socket.on('close', (code) => {
        opts.metrics?.wsConnections.dec();
        opts.metrics?.wsCloses.inc({ code: String(code) });
        conn.onClose(code);
      });
    },
  };
  app.route(wsRoute);

  app.get(
    '/api/sync/snapshot',
    { config: { rateClass: 'snapshot' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (opts.snapshot === null)
        throw new HttpError(
          503,
          'EIO',
          'database unavailable',
          { reason: 'server' },
          BUSY_RETRY_MS,
        );
      const principal = request.plt.principal;
      if (principal === undefined) throw new HttpError(401, 'EACCES', 'not logged in');
      const q = parseSnapshotQuery(parseInput(SnapshotQueryString, request.query));
      return reply.send(await opts.snapshot.page(credOf(principal), q));
    },
  );

  app.post(
    '/api/ops/:opId',
    { bodyLimit: 4 * MIB, config: { rateClass: 'ops' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (sync === null)
        throw new HttpError(
          503,
          'EIO',
          'database unavailable',
          { reason: 'server' },
          BUSY_RETRY_MS,
        );
      const auth = request.plt.auth ?? null;
      if (auth === null) throw new HttpError(401, 'EACCES', 'not logged in');
      const { opId } = parseInput(OpIdParams, request.params);
      const body = parseInput(OpSubmit, request.body);
      if (body.opId !== opId)
        throw new HttpError(409, 'EINVAL', 'body opId differs from the path', {
          reason: 'id-mismatch',
          field: 'opId',
        });
      request.plt.opId = body.opId;
      request.plt.osSessionId = body.osSessionId;
      if (body.audit?.pid !== undefined) request.plt.pid = body.audit.pid;

      const live = (p: number): boolean => {
        const g = auth.suGrant;
        const granted =
          suGrants.grantsOf(auth.authSessionId).some((x) => x.uid === p) ||
          (g !== null && g.uid === p && g.expiresAt.getTime() > opts.now());
        return granted;
      };
      let principalGids: readonly number[] | undefined;
      if (body.principal !== auth.uid && live(body.principal)) {
        principalGids =
          suGrants.gidsOf(auth.authSessionId, body.principal) ??
          (await opts.store?.credentials(body.principal))?.gids;
      }
      try {
        const result = await sync.hub.submitOp(
          {
            uid: auth.uid,
            mayActAs: (p) => p === auth.uid || live(p),
            gidsOf: (p) => (p === auth.uid ? auth.gids : (principalGids ?? [p])),
          },
          body,
        );
        return await reply.send(result);
      } catch (e) {
        if (e instanceof ProtocolViolation)
          throw new HttpError(403, 'EACCES', 'the OS session is not yours', {
            reason: 'principal',
          });
        throw e;
      }
    },
  );

  return Promise.resolve();
}
