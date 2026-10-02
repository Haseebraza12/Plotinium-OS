/**
 * buildApp(config): the Fastify 5 modular monolith (C9; backend-api.md §3.1-§3.3, SRV-01, SRV-03).
 *
 * One process serves every route under /api/* plus /ws. Caddy serves the static shell and sets
 * EVERY security header; there is no helmet and no @fastify/static here. Plugins are registered in
 * dependency order and talk through decorators, never HTTP. Tests use `app.inject()`.
 *
 * Hook order (§3.3; the first failing step decides the error). Every hook is added to the root
 * instance BEFORE any plugin is registered, so it covers every route:
 *   onRequest     1 reqId (UUIDv7, echoed as X-Request-Id); 2 client IP (X-Forwarded-For only from
 *                 TRUST_PROXY_CIDRS, via trustProxy); 3 IP-keyed rate classes; 4 session (gateway)
 *   preValidation 5 CSRF, 6 route authentication, 7 principal (gateway); 8 uid-keyed rate classes
 *   handler       9 Valibot parsing of the input (http/validate.ts), then the route
 *   onSend        Cache-Control: no-store on /api responses
 *   onResponse    one log line and the HTTP metrics
 */
import websocket from '@fastify/websocket';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Logger } from 'pino';

import { FaultArming } from './admin/faults.ts';
import { KyselyAdminDb } from './admin/probes.ts';
import { adminPlugin } from './admin/routes.ts';
import { originAllowlist, sessionCookieName, type Config } from './config.ts';
import { createDatabase, type Database } from './db/client.ts';
import { createIndexEngine } from './engine/index/index.ts';
import { createLlmEngine, type LlmEngine } from './engine/llm/index.ts';
import { createSwapEngine } from './engine/swap/index.ts';
import { createSyncRuntime, type SyncRuntime } from './engine/sync/runtime.ts';
import { Semaphore } from './gateway/argon2.ts';
import { installAccessHooks, installSessionHook } from './gateway/hooks.ts';
import { KyselyAuthStore } from './gateway/kysely-store.ts';
import { gatewayPlugin } from './gateway/routes.ts';
import { SessionService, sessionPolicy } from './gateway/sessions.ts';
import { Slots } from './gateway/slots.ts';
import type { AuthStore } from './gateway/store.ts';
import type { RequestContext } from './http/context.ts';
import { installErrorHandling, sendError } from './http/errors.ts';
import { indexPlugin } from './index/routes.ts';
import { DAY_MS, HOUR_MS, Jobs } from './jobs.ts';
import { llmPlugin } from './llm/routes.ts';
import { locksPlugin } from './locks/plugin.ts';
import { registerHealthRoutes, ReadinessState } from './obs/health.ts';
import { createLogger } from './obs/logger.ts';
import { createMetrics, type Metrics } from './obs/metrics.ts';
import { RATE_CLASSES, rateOverridesFor, type RateClassName } from './ratelimit/classes.ts';
import { RateLimiter } from './ratelimit/limiter.ts';
import { KyselyBlobDb } from './storage/blob-db.ts';
import { FsBlobStore } from './storage/fs-blobstore.ts';
import { blobsPlugin } from './storage/routes.ts';
import { swapPlugin } from './swap/routes.ts';
import { syncPlugin } from './sync/routes.ts';
import { SnapshotService } from './sync/snapshot.ts';
import { SuGrants } from './sync/su-grants.ts';
import { KyselyTelemetryStore } from './telemetry/store.ts';
import { telemetryPlugin } from './telemetry/routes.ts';
import { wireBuild } from './util/build.ts';
import { uuidv7 } from './util/uuidv7.ts';
import { structuralHandlers } from './vfs/ops/index.ts';
import { CancelRegistry } from './vfs/cancel.ts';

export interface AppDeps {
  /** undefined: created from config.database (and closed with the app); null: no database. */
  readonly database?: Database | null;
  /** undefined: FsBlobStore at config.blobDir; null: none (readyz skips the check). */
  readonly blobStore?: FsBlobStore | null;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly now?: () => number;
  /** Newest migration shipped with this build (from db/migrations); null disables the check. */
  readonly expectedMigration?: string | null;
  /** undefined: KyselyAuthStore on the database (none without one); tests pass a double. */
  readonly authStore?: AuthStore | null;
  /** undefined: built from config.llm when AI=1 (tests inject one with a fake provider). */
  readonly llmEngine?: LlmEngine | null;
  /** false: no background jobs (tests that count timers). Default true. */
  readonly jobs?: boolean;
}

export interface PlotiniumApp {
  readonly app: FastifyInstance;
  readonly config: Config;
  readonly readiness: ReadinessState;
  readonly metrics: Metrics;
  readonly limiter: RateLimiter;
  readonly cancel: CancelRegistry;
  readonly database: Database | null;
  readonly blobStore: FsBlobStore | null;
  /** Session creation, validation and revocation (null without a database or auth store). */
  readonly sessions: SessionService | null;
  /** The sync engine, lock manager, broadcaster and /ws hub (null without a database). */
  readonly sync: SyncRuntime | null;
  /** The LLM gateway (null when AI=0). */
  readonly llm: LlmEngine | null;
  /** Live su grants per auth session, as the sockets see them. */
  readonly suGrants: SuGrants;
  /** The fault-injection arms (null unless FAULT_INJECTION=1 outside production). */
  readonly faults: FaultArming | null;
  /**
   * Graceful shutdown step 2 (backend-api.md §3.17): every socket finishes its running op for up
   * to `graceMs`, then gets `bye restart` / 1012; leases stay. Idempotent; call before app.close().
   */
  drainSockets(graceMs: number): Promise<void>;
  /** Every registered route (method, url), in registration order. */
  readonly routes: readonly { readonly method: string; readonly url: string }[];
}

const MIB = 1024 * 1024;

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<PlotiniumApp> {
  const logger = deps.logger ?? createLogger(config);
  const metrics = deps.metrics ?? createMetrics();
  const ownsDatabase = deps.database === undefined;
  const database =
    deps.database !== undefined
      ? deps.database
      : config.database === null
        ? null
        : createDatabase(config.database, {
            onIdleError: (err) => logger.warn({ err }, 'idle database client error'),
          });
  const blobStore = deps.blobStore !== undefined ? deps.blobStore : new FsBlobStore(config.blobDir);
  const limiter = new RateLimiter({
    ...(deps.now === undefined ? {} : { now: deps.now }),
    // Production keeps the §3.9 table; local and ci allow more guest sign-ins per IP (UI-005).
    overrides: rateOverridesFor(config.env),
    onDenied: (name) => metrics.rateLimited.inc({ class: name }),
  });
  const cancel = new CancelRegistry();
  const now = deps.now ?? Date.now;
  const authStore =
    deps.authStore !== undefined
      ? deps.authStore
      : database === null
        ? null
        : new KyselyAuthStore(database.db);
  const sessions =
    authStore === null ? null : new SessionService(authStore, sessionPolicy(config.session), now);
  const gateway = {
    sessions,
    store: authStore,
    cookieName: sessionCookieName(config),
    origins: originAllowlist(config),
  };
  const build = wireBuild(config.build);
  const faultInjection = config.faultInjection && config.env !== 'production';

  // ---------------------------------------------------------------------------------------------
  // Engines (each null when what it needs is missing; its routes then answer 503 EIO 'server')
  // ---------------------------------------------------------------------------------------------
  let sync: SyncRuntime | null = null;
  const suGrants = new SuGrants({
    now,
    onEnded: (authSessionId, uid, reason) => sync?.hub.suEnded(authSessionId, uid, reason),
  });
  const adminDb = database === null ? null : new KyselyAdminDb(database.db);
  const faults = !faultInjection
    ? null
    : new FaultArming({
        now,
        audit: (event, arm) => {
          adminDb
            ?.audit({
              uid: 0,
              realUid: arm.armedBy,
              osSessionId: arm.osSessionId,
              syscall: 'debug.inject',
              outcome: event === 'fire' ? 'attempt' : 'ok',
              detail: { event, op: arm.op, target: arm.target, failAtNode: arm.failAtNode ?? null },
            })
            .catch((err: unknown) => logger.warn({ err }, 'fault audit failed'));
        },
      });
  if (database !== null && authStore !== null) {
    const db = database;
    const store = authStore;
    sync = createSyncRuntime({
      db: db.db,
      cancel,
      build,
      leaseTtlMs: config.leaseTtlMs,
      lockTimeoutMs: config.database?.lockTimeoutMs ?? 2_000,
      statementTimeoutMs: config.database?.statementTimeoutMs ?? 10_000,
      timeZone: config.timeZone,
      validateAuth: async (id) => {
        const s = await store.findSession(id);
        const n = now();
        return (
          s !== null &&
          s.revokedAt === null &&
          !s.disabled &&
          s.expiresAt.getTime() > n &&
          s.absoluteExpiresAt.getTime() > n
        );
      },
      cancelBackendPid: (pid) => {
        db.pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
      },
      handlers: structuralHandlers({ timeZone: config.timeZone }),
      ...(faults === null ? {} : { faultFor: (submit) => faults.take(submit) }),
      onError: (err, context) => logger.warn({ err, context }, 'sync'),
    });
    // Rebuilds the lease expiry index from `locks` BEFORE the server listens (§3.18.2 step 3).
    await sync.start();
  }
  sessions?.onRevoke((ids) => {
    suGrants.forget(ids);
    // bye revoked + 4401 on every socket of the sessions, and their OS sessions' leases released.
    sync?.hub.revoke(ids).catch((err: unknown) => logger.warn({ err }, 'revocation fan-out'));
  });

  const llm: LlmEngine | null = !config.ai
    ? null
    : deps.llmEngine !== undefined
      ? deps.llmEngine
      : createLlmEngine({
          llm: config.llm,
          timeZone: config.timeZone,
          db: database?.db ?? null,
          limiter,
          logger,
          observer: {
            onRequest: (e) => {
              metrics.llmRequests.inc({ model: e.model, status: e.status });
              metrics.llmCostUsd.inc({ model: e.model }, e.costMicroUsd / 1_000_000);
              metrics.llmLatency.observe({ model: e.model }, e.latencyMs / 1000);
              if (e.tokens !== null) {
                metrics.llmTokens.inc({ kind: 'input' }, e.tokens.input);
                metrics.llmTokens.inc({ kind: 'output' }, e.tokens.output);
                metrics.llmTokens.inc({ kind: 'cache_read' }, e.tokens.cacheRead);
                metrics.llmTokens.inc({ kind: 'cache_write' }, e.tokens.cacheWrite);
              }
            },
            onBudgetRatio: (scope, ratio) => metrics.llmBudgetRatio.set({ scope }, ratio),
            onBug: (err) => logger.error({ err }, 'llm gateway bug'),
          },
        });

  const swap =
    database === null || blobStore === null
      ? null
      : createSwapEngine({
          db: database.db,
          blobs: blobStore,
          quotaBytes: config.swapMaxBytes,
          maxRawBytes: config.swapPageMaxRawBytes,
        });
  const index =
    !config.ai || database === null || blobStore === null
      ? null
      : createIndexEngine({ db: database.db, blobs: blobStore });
  const telemetry = database === null ? null : new KyselyTelemetryStore(database.db);

  const readiness = new ReadinessState(
    config,
    {
      db: database,
      expectedMigration: deps.expectedMigration ?? null,
      blobStore,
      metrics,
      ...(llm === null ? {} : { llmState: () => llm.gateway.state }),
    },
    deps.now,
  );

  const fastifyLogger: FastifyBaseLogger = logger;
  const app: FastifyInstance = Fastify({
    loggerInstance: fastifyLogger,
    genReqId: () => uuidv7(),
    // Our own onResponse hook writes the one canonical line per request (SRV-15).
    logController: new LogController({ requestIdLogLabel: 'reqId', disableRequestLogging: true }),
    trustProxy: [...config.trustProxyCidrs],
    bodyLimit: 1 * MIB,
    return503OnClosing: true,
  });

  // A reference-type default would be shared by every request, so the context starts as null and
  // each request gets its own object in the first onRequest hook.
  app.decorateRequest('plt', null as unknown as RequestContext);

  // The route inventory (SRV-03: only /api/* and /ws), kept for tests and diagnostics.
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });

  app.addHook('onRequest', (request, reply, done) => {
    request.plt = {};
    void reply.header('x-request-id', request.id);
    done();
  });

  // IP-keyed rate classes (hook 3). uid-keyed classes run in preValidation (hook 8), once the
  // gateway has resolved the principal. A denied request is answered here and goes no further.
  app.addHook('onRequest', (request, reply, done) => {
    const name = request.routeOptions.config.rateClass;
    if (name !== undefined && RATE_CLASSES[name].key === 'ip') {
      const r = limiter.take(name, request.ip);
      if (!r.ok) {
        deny(request, reply, name, r.retryAfterMs);
        return;
      }
    }
    done();
  });
  installSessionHook(app, gateway);
  installAccessHooks(app, gateway);
  app.addHook('preValidation', (request, reply, done) => {
    const name = request.routeOptions.config.rateClass;
    const uid = request.plt.uid;
    if (name !== undefined && uid !== undefined && RATE_CLASSES[name].key === 'uid') {
      const r = limiter.take(name, String(uid));
      if (!r.ok) {
        deny(request, reply, name, r.retryAfterMs);
        return;
      }
    }
    done();
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith('/api') && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const labels = { route, method: request.method, status: String(reply.statusCode) };
    metrics.httpRequests.inc(labels);
    metrics.httpDuration.observe(labels, reply.elapsedTime / 1000);
    const p = request.plt;
    request.log.info(
      {
        route,
        method: request.method,
        status: reply.statusCode,
        durMs: Math.round(reply.elapsedTime * 10) / 10,
        ...(p.uid === undefined ? {} : { uid: p.uid }),
        ...(p.osSessionId === undefined ? {} : { osSessionId: p.osSessionId }),
        ...(p.opId === undefined ? {} : { opId: p.opId }),
        ...(p.pid === undefined ? {} : { pid: p.pid }),
        ...(p.errno === undefined ? {} : { errno: p.errno }),
        ...(p.reason === undefined ? {} : { reason: p.reason }),
      },
      'request',
    );
    done();
  });

  // Streaming bodies (blobs, swap pages, index chunks) reach their handlers as the raw stream.
  // Any other content type than JSON or these is refused with 415 EINVAL (§3.3 step 5).
  app.removeContentTypeParser('text/plain');
  const passStream = (
    _request: FastifyRequest,
    payload: unknown,
    done: (err: null, body: unknown) => void,
  ) => {
    done(null, payload);
  };
  app.addContentTypeParser('application/octet-stream', passStream);
  app.addContentTypeParser(/^application\/vnd\.plotinium\.[a-z0-9.+-]+$/, passStream);

  installErrorHandling(app);
  // Before every route, so its onRoute hook can wrap /ws (upgrades dispatch through the router,
  // so every hook above runs BEFORE the upgrade). Frames <= 64 KB, no compression (§3.7).
  await app.register(websocket, { options: { maxPayload: 65_536, perMessageDeflate: false } });

  registerHealthRoutes(app, readiness);
  await app.register(gatewayPlugin, {
    config,
    sessions,
    store: authStore,
    limiter,
    argon2: new Semaphore(config.argon2MaxConcurrency),
    loginSlots: new Slots(config.loginMaxConcurrency),
    metrics,
    cookieName: gateway.cookieName,
    now,
    onSuGrant: (authSessionId, grant) => suGrants.set(authSessionId, grant),
    onSuRevoke: (authSessionId, uid) => suGrants.revoke(authSessionId, uid),
  });
  await app.register(locksPlugin);
  await app.register(blobsPlugin, {
    store: database === null ? null : blobStore,
    db: database === null ? null : new KyselyBlobDb(database.db),
    maxBytes: config.blobMaxBytes,
    limiter,
    metrics,
  });
  await app.register(syncPlugin, {
    sync,
    snapshot: database === null ? null : new SnapshotService(database.db),
    store: authStore,
    origins: gateway.origins,
    draining: () => readiness.phase === 'draining' || (sync?.hub.draining ?? false),
    suGrants,
    now,
    metrics,
  });
  await app.register(swapPlugin, { swap, metrics });
  if (config.ai && llm !== null) {
    await app.register(indexPlugin, { index });
    await app.register(llmPlugin, {
      gateway: llm.gateway,
      log: (fields, msg) => logger.info(fields, msg),
    });
  }
  await app.register(telemetryPlugin, { store: telemetry });
  await app.register(adminPlugin, { faultInjection, faults, db: adminDb });

  // ---------------------------------------------------------------------------------------------
  // Background jobs (§3.18.2 step 5)
  // ---------------------------------------------------------------------------------------------
  const jobs = new Jobs({
    onError: (job, err) => logger.warn({ err, job }, 'job failed'),
    onRun: (job, result) => metrics.jobRuns.inc({ job, result }),
  });
  if (deps.jobs !== false) {
    if (blobStore !== null) jobs.every('blob-tmp', HOUR_MS, () => blobStore.sweepTmp());
    if (swap !== null) jobs.every('swap-retention', DAY_MS, () => swap.sweepRetention());
    if (llm !== null && database !== null)
      jobs.every('llm-abandoned', 5 * 60_000, () => llm.gateway.sweepAbandoned(), true);
    if (telemetry !== null)
      jobs.every('telemetry-retention', DAY_MS, () =>
        telemetry.sweepRetention(config.telemetryRetentionDays),
      );
  }

  let drained: Promise<void> | null = null;
  const drainSockets = (graceMs: number): Promise<void> =>
    (drained ??= sync === null ? Promise.resolve() : sync.hub.shutdown(graceMs));

  app.addHook('onClose', async () => {
    jobs.stop();
    suGrants.stop();
    await drainSockets(0);
    if (ownsDatabase && database !== null) await database.close();
  });

  return {
    app,
    config,
    readiness,
    metrics,
    limiter,
    cancel,
    database,
    blobStore,
    sessions,
    sync,
    llm,
    suGrants,
    faults,
    drainSockets,
    routes,
  };
}

function deny(
  request: FastifyRequest,
  reply: FastifyReply,
  name: RateClassName,
  retryAfterMs: number,
): void {
  const errno = request.routeOptions.config.rateErrno ?? 'EAGAIN';
  void sendError(
    request,
    reply,
    429,
    errno,
    'rate limit exceeded',
    { reason: 'rate', class: name },
    retryAfterMs,
  );
}
