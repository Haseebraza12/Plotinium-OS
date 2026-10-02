/**
 * The gateway's request hooks (backend-api.md §3.3 steps 4-7; security-model.md §3.7, §5.2).
 *
 *   4 onRequest      session resolution from the cookie: sets request.plt.auth (never fails by
 *                    itself; a database error only marks the request so step 6 answers 503)
 *   5 preValidation  CSRF for every method but GET and HEAD: Sec-Fetch-Site must be same-origin;
 *                    without it (a non-browser client) Origin must be in the exact allowlist;
 *                    with neither -> 403 EACCES csrf (SRV-06)
 *   6 preValidation  route authentication: public, session (401 EACCES), root
 *   7 preValidation  principal (SRV-19): X-Plotinium-Principal absent -> the session uid; present
 *                    -> it must be the session uid or the uid of a live su grant (403 EACCES
 *                    principal); root routes need principal uid 0 (403 EPERM root-only)
 * The hooks are added to the root instance before any plugin, so they cover every route.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Principal } from '../http/context.ts';
import { sendError } from '../http/errors.ts';
import { clearedCookie, readCookie, sessionCookie } from './cookies.ts';
import type { SessionService } from './sessions.ts';
import type { AuthStore } from './store.ts';

export interface GatewayRuntime {
  /** null: no database is configured; session routes answer 503. */
  readonly sessions: SessionService | null;
  readonly store: AuthStore | null;
  readonly cookieName: string;
  readonly origins: ReadonlySet<string>;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const PRINCIPAL_RE = /^\d{1,10}$/;

/** Why a state-changing request is refused as cross-site, or null when it is acceptable. */
export function csrfRefusal(
  method: string,
  headers: { readonly 'sec-fetch-site'?: string | string[]; readonly origin?: string | string[] },
  origins: ReadonlySet<string>,
): string | null {
  if (SAFE_METHODS.has(method)) return null;
  const site = headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin' ? null : 'cross-site request';
  const origin = headers.origin;
  if (origin === undefined) return 'no Sec-Fetch-Site or Origin header';
  return typeof origin === 'string' && origins.has(origin) ? null : 'origin not allowed';
}

export function installSessionHook(app: FastifyInstance, gw: GatewayRuntime): void {
  app.addHook('onRequest', async (request, reply) => {
    request.plt.auth = null;
    const value = readCookie(request.headers.cookie, gw.cookieName);
    if (value === undefined || gw.sessions === null) return;
    try {
      const r = await gw.sessions.validate(value);
      request.plt.auth = r.auth;
      if (r.auth === null) void reply.header('set-cookie', clearedCookie(gw.cookieName));
      else if (r.slid) {
        void reply.header(
          'set-cookie',
          sessionCookie(gw.cookieName, value, gw.sessions.maxAgeSeconds(r.auth.expiresAt)),
        );
      }
    } catch (err) {
      request.plt.authUnavailable = true;
      request.log.warn({ err }, 'session lookup failed');
    }
  });
}

export function installAccessHooks(app: FastifyInstance, gw: GatewayRuntime): void {
  app.addHook('preValidation', async (request, reply) => {
    if (request.is404) return undefined; // unknown routes answer 404 ENOSYS, never 401
    const refusal = csrfRefusal(request.method, request.headers, gw.origins);
    if (refusal !== null)
      return sendError(request, reply, 403, 'EACCES', refusal, { reason: 'csrf' });

    const level = request.routeOptions.config.auth ?? 'session';
    const auth = request.plt.auth ?? null;
    if (level !== 'public') {
      if (auth === null && request.plt.authUnavailable === true) {
        return sendError(
          request,
          reply,
          503,
          'EIO',
          'session store unavailable',
          { reason: 'server' },
          1000,
        );
      }
      if (auth === null) return sendError(request, reply, 401, 'EACCES', 'not logged in');
    }
    if (auth === null) return undefined;

    const principal = await resolvePrincipal(request, gw);
    if (principal === null) {
      if (level === 'public') return undefined;
      return sendError(request, reply, 403, 'EACCES', 'principal not granted', {
        reason: 'principal',
      });
    }
    request.plt.principal = principal;
    request.plt.uid = principal.uid;
    if (level === 'root' && principal.uid !== 0) {
      return sendError(request, reply, 403, 'EPERM', 'root only', { reason: 'root-only' });
    }
    return undefined;
  });
}

async function resolvePrincipal(
  request: FastifyRequest,
  gw: GatewayRuntime,
): Promise<Principal | null> {
  const auth = request.plt.auth;
  if (auth === null || auth === undefined) return null;
  const self: Principal = { uid: auth.uid, realUid: auth.uid, gids: auth.gids };
  const raw = request.headers['x-plotinium-principal'];
  if (raw === undefined) return self;
  if (typeof raw !== 'string' || !PRINCIPAL_RE.test(raw)) return null;
  const want = Number(raw);
  if (want === auth.uid) return self;
  if (auth.suGrant === null || auth.suGrant.uid !== want || gw.store === null) return null;
  const creds = await gw.store.credentials(want);
  return creds === null ? null : { uid: creds.uid, realUid: auth.uid, gids: creds.gids };
}
