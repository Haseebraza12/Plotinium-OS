/**
 * Per-request context and route config types (Fastify declaration merging).
 * `request.plt` is set in the first onRequest hook (app.ts) and read by the gateway hooks,
 * handlers, logging and metrics.
 */
import type { Errno } from '../errno.ts';
import type { AuthState } from '../gateway/sessions.ts';
import type { RateClassName } from '../ratelimit/classes.ts';

/** The uid an operation runs as (SRV-19): the session uid or a live su grant's uid. */
export interface Principal {
  readonly uid: number;
  /** The login uid (differs from uid under su). */
  readonly realUid: number;
  /** Primary gid first, then supplementary groups, read from the database (never the client). */
  readonly gids: readonly number[];
}

/** Route authentication level (backend-api.md §3.6): default 'session'. */
export type AuthLevel = 'public' | 'session' | 'root';

export interface RequestContext {
  errno?: Errno;
  reason?: string;
  /** The validated cookie session (hook 4), or null when there is none. */
  auth?: AuthState | null;
  /** Session resolution failed because the database did not answer (503, never 401). */
  authUnavailable?: boolean;
  /** Effective principal (hook 7). */
  principal?: Principal;
  /** Effective principal uid, used by uid-keyed rate classes and log lines. */
  uid?: number;
  osSessionId?: string;
  opId?: string;
  /** The client process id from OpSubmit.audit.pid. */
  pid?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    plt: RequestContext;
  }
  interface FastifyContextConfig {
    /** Rate class of the route (backend-api.md §3.9). IP classes run in onRequest. */
    rateClass?: RateClassName;
    /** /api/llm/* answers EAIUNAVAIL 'rate' instead of EAGAIN 'rate' (agentic-shell.md §3.20). */
    rateErrno?: 'EAGAIN' | 'EAIUNAVAIL';
    /** Route authentication (§3.3 step 6); omitted means 'session'. */
    auth?: AuthLevel;
  }
}
