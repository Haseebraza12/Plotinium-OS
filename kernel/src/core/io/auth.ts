/**
 * The `auth` service's port (boot-and-services.md §3.2.2, §3.3; security-model.md §3.7):
 * `/version.json` names the server this client talks to (a foreign server is never trusted), and
 * `GET /api/auth/me` validates the session cookie (which also slides it). Offline, or for a local
 * session, the service is DEGRADED with the tray reason and heals on `online` (OFF-04).
 */
import type { AuthCheck, AuthPort } from '@plotinium/services';

import type { BuildIdentity } from '../host.ts';
import type { NetMonitor } from '../net/monitor.ts';
import type { ServerApi } from './http.ts';
import type { ConsoleSession } from './login.ts';

/** Each request of a check (the `auth` service has 4 s in total; both run in parallel). */
export const AUTH_REQUEST_MS = 1_500;

export interface AuthIoDeps {
  readonly api: ServerApi;
  readonly net: NetMonitor;
  readonly identity: BuildIdentity;
  readonly console: () => ConsoleSession | null;
  /** A newer build is on the server (OFF-05): `update.available`. */
  readonly newer: (v: { version: string; build: string }) => void;
}

export class AuthIo implements AuthPort {
  private readonly deps: AuthIoDeps;
  private readonly onlineCbs = new Set<() => void>();

  constructor(deps: AuthIoDeps) {
    this.deps = deps;
  }

  async check(): Promise<AuthCheck> {
    const { api, net, identity } = this.deps;
    const s = this.deps.console();
    if (!api.available) {
      net.setReachable('offline');
      return s?.mode === 'local'
        ? { status: 'local', why: 'no server in this build' }
        : { status: 'offline' };
    }
    const [version, me] = await Promise.all([
      api.version(AUTH_REQUEST_MS),
      api.me(AUTH_REQUEST_MS),
    ]);
    if (me.status === 0 && version === null) {
      net.setReachable('offline');
      return { status: 'offline' };
    }
    net.setReachable('online');
    if (version !== null) {
      if (version.name !== identity.name) return { status: 'foreign-server', name: version.name };
      net.setServerBuild(version.build);
    }
    if (s?.mode === 'local' || s?.mode === 'offline') {
      net.setAuthRequired(s.mode === 'offline');
      return { status: 'local', why: s.mode === 'offline' ? 'offline verifier' : 'local guest' };
    }
    if (!me.ok) {
      net.setAuthRequired(me.status === 401 || me.status === 403);
      return me.status === 0 ? { status: 'offline' } : { status: 'auth-required' };
    }
    net.setAuthRequired(false);
    const newer =
      version !== null && (version.version !== identity.version || version.build !== identity.build)
        ? { version: version.version, build: version.build }
        : null;
    if (newer !== null) this.deps.newer(newer);
    return { status: 'ok', username: me.body.username, newer };
  }

  onOnline(cb: () => void): () => void {
    this.onlineCbs.add(cb);
    return () => this.onlineCbs.delete(cb);
  }

  /** The router's `online` event. */
  online(): void {
    for (const cb of [...this.onlineCbs]) cb();
  }
}
