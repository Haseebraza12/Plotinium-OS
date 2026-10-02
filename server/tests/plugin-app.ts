/**
 * A bare Fastify instance for route-plugin tests (fastify.inject, no database): the same request
 * context, body parsers and SRV-04 error handler as buildApp (server/src/app.ts), with the gateway's
 * session and principal hooks replaced by one test header. The gateway itself is tested in
 * server/src/gateway/*.test.ts; this harness isolates the plugin under test.
 *
 *   x-test-uid: 1001            the cookie session of uid 1001 (kind 'user', gids [100])
 *   x-test-principal: 0         with a live su grant for that uid (principal 0 = root routes)
 *   x-test-auth-down: 1         the session store did not answer (request.plt.authUnavailable)
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { RequestContext } from '../src/http/context.ts';
import { installErrorHandling } from '../src/http/errors.ts';

const HOUR_MS = 3_600_000;

export async function pluginApp(
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  app.decorateRequest('plt', null as unknown as RequestContext);
  app.addHook('onRequest', (request, _reply, done) => {
    request.plt = {};
    if (request.headers['x-test-auth-down'] === '1') request.plt.authUnavailable = true;
    const raw = request.headers['x-test-uid'];
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const uid = Number(raw);
      const p = request.headers['x-test-principal'];
      const principal = typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : uid;
      const now = Date.now();
      request.plt.auth = {
        authSessionId: `session-${uid}`,
        uid,
        kind: 'user',
        gids: [100],
        suGrant: principal === uid ? null : { uid: principal, expiresAt: new Date(now + HOUR_MS) },
        expiresAt: new Date(now + HOUR_MS),
        absoluteExpiresAt: new Date(now + 24 * HOUR_MS),
      };
      request.plt.principal = {
        uid: principal,
        realUid: uid,
        gids: principal === 0 ? [0] : [100],
      };
      request.plt.uid = principal;
    }
    done();
  });
  // Root-only routes (config.auth 'root') answer as the gateway's route-auth hook does.
  app.addHook('preValidation', (request: FastifyRequest, reply, done) => {
    if (request.routeOptions.config.auth === 'root' && request.plt.principal?.uid !== 0) {
      void reply.code(403).send({ errno: 'EPERM', reason: 'root-only' });
      return;
    }
    done();
  });
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
  await register(app);
  await app.ready();
  return app;
}
