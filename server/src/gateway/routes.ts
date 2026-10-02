/**
 * gateway/: /api/auth/* (backend-api.md §3.6.1, §3.8; security-model.md §3.6.4, §3.7; SRV-08,
 * SRV-19, SRV-20, OFF-03, BOOT-14). Primary owner R5, secondary reviewer R2.
 *
 * login     login-ip (onRequest) and login-user buckets, the login concurrency gate, then Argon2id
 *           under the hashing semaphore (2). Unknown names, root, guests, disabled and locked
 *           accounts all run a DUMMY verification with the same parameters and get the same
 *           401 EACCES, so neither the answer nor its timing tells them apart. A new session every
 *           time; a session presented with the request is revoked (fixation defence).
 * logout    revokes the current session (sockets and leases follow through the revocation
 *           listeners), expires the cookie; 204 even without a session.
 * me        AuthMe of the current session.
 * su        15-minute grant on the auth session; guests cannot su and nobody can su to a guest.
 * guest     one transaction: user guest-XXXX (uid 60000-60999), /home/guest-XXXX 0700, quota
 *           20 MiB / 500 inodes, a 2-hour session.
 * password  verify the current password, store a new Argon2id hash, bump password_version,
 *           revoke every other session and rotate the current one.
 * Audit events: login.success, login.failure, logout, session.revoke, su.grant, su.fail,
 * su.revoke, guest.create, password.change (backend-api.md §4.4).
 */
import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';
import type { Metrics } from '../obs/metrics.ts';
import type { RateLimiter } from '../ratelimit/limiter.ts';
import { hashPassword, needsRehash, parsePhc, verifyPassword, type Semaphore } from './argon2.ts';
import { clearedCookie, sessionCookie } from './cookies.ts';
import { LoginReq, PasswordReq, SuParams, SuReq, type AuthMe, type SuRes } from './schemas.ts';
import type { AuthState, CreatedSession, SessionService } from './sessions.ts';
import type { Slots } from './slots.ts';
import type { AccountKind, AuthStore, LoginUser } from './store.ts';
import { base32 } from './tokens.ts';

const KIB = 1024;
const MIB = 1024 * KIB;
const SU_GRANT_MS = 15 * 60_000;
export const GUEST_QUOTA_BYTES = 20 * MIB;
export const GUEST_QUOTA_INODES = 500;
const GUEST_FULL_RETRY_MS = 60_000;
const BUSY_RETRY_MS = 1_000;

export interface GatewayOptions {
  readonly config: Config;
  readonly sessions: SessionService | null;
  readonly store: AuthStore | null;
  readonly limiter: RateLimiter;
  readonly argon2: Semaphore;
  readonly loginSlots: Slots;
  readonly metrics: Metrics;
  readonly cookieName: string;
  readonly now: () => number;
  /** A su grant started (the sync plugin's grant registry: sockets see it at once). */
  readonly onSuGrant?: (
    authSessionId: string,
    grant: { readonly uid: number; readonly expiresAt: Date; readonly gids: readonly number[] },
  ) => void;
  /** A su grant was cleared (the elevated shell exited): SIGHUP 'su-revoked' to the sockets. */
  readonly onSuRevoke?: (authSessionId: string, uid: number) => void;
}

interface Ready {
  readonly sessions: SessionService;
  readonly store: AuthStore;
}

export function gatewayPlugin(app: FastifyInstance, opts: GatewayOptions): Promise<void> {
  const { config, limiter, metrics, cookieName, now } = opts;
  const pepper = config.authPepper;
  const hashOpts = { semaphore: opts.argon2, ...(pepper === undefined ? {} : { pepper }) };
  let dummy: Promise<string> | undefined;
  const dummyHash = (): Promise<string> =>
    (dummy ??= hashPassword(randomBytes(24).toString('base64'), hashOpts));

  const ready = (): Ready => {
    if (opts.sessions === null || opts.store === null) {
      throw new HttpError(503, 'EIO', 'database unavailable', { reason: 'server' }, BUSY_RETRY_MS);
    }
    return { sessions: opts.sessions, store: opts.store };
  };

  const timedVerify = async (phc: string, password: string): Promise<boolean> => {
    const end = metrics.argon2Seconds.startTimer();
    try {
      return await verifyPassword(phc, password, hashOpts);
    } finally {
      end();
    }
  };

  /** Verifies `password` against `user` when it can log in; otherwise burns a dummy verification. */
  const verifyOrDummy = async (
    user: LoginUser | null,
    password: string,
    eligible: boolean,
  ): Promise<boolean> => {
    const phc =
      eligible && user?.passwordHash != null && parsePhc(user.passwordHash) !== null
        ? user.passwordHash
        : null;
    const ok = await timedVerify(phc ?? (await dummyHash()), password);
    return ok && phc !== null;
  };

  const take = (name: 'login-user' | 'su', key: string): void => {
    const r = limiter.take(name, key);
    if (!r.ok)
      throw new HttpError(429, 'EAGAIN', 'too many attempts', { reason: 'rate' }, r.retryAfterMs);
  };

  const setSession = (
    reply: FastifyReply,
    sessions: SessionService,
    created: CreatedSession,
  ): void => {
    void reply.header(
      'set-cookie',
      sessionCookie(
        cookieName,
        created.token.token,
        sessions.maxAgeSeconds(created.record.expiresAt),
      ),
    );
  };

  const stateOf = (
    uid: number,
    kind: AccountKind,
    gids: readonly number[],
    created: CreatedSession,
  ): AuthState => ({
    authSessionId: created.record.id,
    uid,
    kind,
    gids,
    suGrant: null,
    expiresAt: created.record.expiresAt,
    absoluteExpiresAt: created.record.absoluteExpiresAt,
  });

  const me = async (store: AuthStore, auth: AuthState): Promise<AuthMe> => {
    const profile = await store.profile(auth.uid);
    if (profile === null) throw new HttpError(401, 'EACCES', 'not logged in');
    const grant = auth.suGrant;
    const suName = grant === null ? null : await store.usernameOf(grant.uid);
    return {
      uid: profile.uid,
      username: profile.username,
      kind: profile.kind,
      gid: profile.primaryGid,
      groups: profile.groups,
      home: profile.uid === 0 ? '/root' : `/home/${profile.username}`,
      quota: {
        quotaBytes: profile.quotaBytes,
        quotaInodes: profile.quotaInodes,
        usedBytes: profile.usedBytes,
        usedInodes: profile.usedInodes,
      },
      suGrants:
        grant === null || suName === null
          ? []
          : [{ uid: grant.uid, username: suName, expiresAt: grant.expiresAt.toISOString() }],
      session: {
        expiresAt: auth.expiresAt.toISOString(),
        absoluteExpiresAt: auth.absoluteExpiresAt.toISOString(),
      },
      passwordVersion: profile.passwordVersion,
      offlineVerifier: { allowed: profile.uid !== 0 && profile.kind !== 'guest' },
      telemetryOptIn: profile.telemetryOptIn,
      server: {
        name: 'Plotinium',
        version: config.build.version,
        build: config.build.sha.slice(0, 12),
        date: config.build.date,
      },
    };
  };

  /** Revokes a session presented together with a login (fixation defence, T-04). */
  const revokePresented = async (
    request: FastifyRequest,
    sessions: SessionService,
  ): Promise<void> => {
    const presented = request.plt.auth ?? null;
    if (presented !== null) {
      await sessions.revoke([presented.authSessionId], 'login', presented.uid);
      metrics.authRevocations.inc({ reason: 'login' });
    }
  };

  const authOf = (request: FastifyRequest): AuthState => {
    const auth = request.plt.auth ?? null;
    if (auth === null) throw new HttpError(401, 'EACCES', 'not logged in');
    return auth;
  };

  // ---------------------------------------------------------------------------------------------
  app.post(
    '/api/auth/login',
    { bodyLimit: 4 * KIB, config: { rateClass: 'login-ip', auth: 'public' } },
    async (request, reply) => {
      const { sessions, store } = ready();
      const body = parseInput(LoginReq, request.body);
      take('login-user', `${body.username}\u0000${request.ip}`);
      if (!opts.loginSlots.tryAcquire()) {
        throw new HttpError(
          429,
          'EAGAIN',
          'too many logins in progress',
          { reason: 'rate' },
          BUSY_RETRY_MS,
        );
      }
      try {
        const user = await store.findLoginUser(body.username);
        const eligible =
          user !== null && user.kind !== 'root' && user.kind !== 'guest' && !user.disabled;
        const ok = await verifyOrDummy(user, body.password, eligible);
        if (!ok || user === null || user.passwordHash === null) {
          metrics.authLogins.inc({ result: 'failure' });
          await store.audit({
            event: 'login.failure',
            uid: user?.uid ?? 0,
            realUid: user?.uid ?? 0,
            actor: 'system',
            outcome: 'denied',
            errno: 'EACCES',
            detail: { username: body.username, ip: request.ip, known: user !== null },
          });
          throw new HttpError(401, 'EACCES', 'invalid username or password');
        }
        if (needsRehash(user.passwordHash)) {
          await store.updatePassword(user.uid, await hashPassword(body.password, hashOpts), false);
        }
        const creds = await store.credentials(user.uid);
        const created = await sessions.create(user.uid, user.kind, request.headers['user-agent']);
        await revokePresented(request, sessions);
        setSession(reply, sessions, created);
        await store.audit({
          event: 'login.success',
          uid: user.uid,
          realUid: user.uid,
          actor: 'user',
          outcome: 'ok',
          detail: { ip: request.ip },
        });
        metrics.authLogins.inc({ result: 'success' });
        request.plt.uid = user.uid;
        return await reply
          .code(200)
          .send(await me(store, stateOf(user.uid, user.kind, creds?.gids ?? [], created)));
      } finally {
        opts.loginSlots.release();
      }
    },
  );

  app.post(
    '/api/auth/logout',
    { bodyLimit: 1 * KIB, config: { rateClass: 'api', auth: 'public' } },
    async (request, reply) => {
      const auth = request.plt.auth ?? null;
      if (auth !== null) {
        const { sessions, store } = ready();
        await sessions.revoke([auth.authSessionId], 'logout', auth.uid);
        metrics.authRevocations.inc({ reason: 'logout' });
        await store.audit({
          event: 'logout',
          uid: auth.uid,
          realUid: auth.uid,
          actor: 'user',
          outcome: 'ok',
        });
      }
      return reply.header('set-cookie', clearedCookie(cookieName)).code(204).send();
    },
  );

  app.get('/api/auth/me', { config: { rateClass: 'api' } }, async (request, reply) => {
    const { store } = ready();
    return reply.send(await me(store, authOf(request)));
  });

  app.post(
    '/api/auth/su',
    { bodyLimit: 4 * KIB, config: { auth: 'session' } },
    async (request, reply) => {
      const { store } = ready();
      const auth = authOf(request);
      const body = parseInput(SuReq, request.body);
      take('su', `${auth.authSessionId}\u0000${body.target}`);
      if (auth.kind === 'guest')
        throw new HttpError(403, 'EPERM', 'guests cannot su', { reason: 'guest' });
      const target = await store.findLoginUser(body.target);
      if (target?.kind === 'guest')
        throw new HttpError(403, 'EPERM', 'cannot su to a guest', { reason: 'guest' });
      const ok = await verifyOrDummy(target, body.password, target !== null && !target.disabled);
      if (!ok || target === null) {
        await store.audit({
          event: 'su.fail',
          uid: auth.uid,
          realUid: auth.uid,
          actor: 'user',
          outcome: 'denied',
          errno: 'EACCES',
          detail: { target: body.target },
        });
        throw new HttpError(403, 'EACCES', 'authentication failure');
      }
      const expiresAt = new Date(now() + SU_GRANT_MS);
      await store.setSuGrant(auth.authSessionId, { uid: target.uid, expiresAt });
      await store.audit({
        event: 'su.grant',
        uid: target.uid,
        realUid: auth.uid,
        actor: 'user',
        outcome: 'ok',
        detail: { target: target.username },
      });
      // The grant registry schedules the expiry notification (proc.signal SIGHUP 'su-expired').
      if (opts.onSuGrant !== undefined) {
        const creds = await store.credentials(target.uid);
        opts.onSuGrant(auth.authSessionId, {
          uid: target.uid,
          expiresAt,
          gids: creds?.gids ?? [target.uid],
        });
      }
      const res: SuRes = {
        grant: { uid: target.uid, username: target.username, expiresAt: expiresAt.toISOString() },
      };
      return reply.send(res);
    },
  );

  app.delete('/api/auth/su/:uid', { config: { rateClass: 'api' } }, async (request, reply) => {
    const { store } = ready();
    const auth = authOf(request);
    const { uid } = parseInput(SuParams, request.params);
    if (auth.suGrant?.uid !== uid) throw new HttpError(404, 'ENOENT', 'no such grant');
    await store.setSuGrant(auth.authSessionId, null);
    await store.audit({ event: 'su.revoke', uid, realUid: auth.uid, actor: 'user', outcome: 'ok' });
    opts.onSuRevoke?.(auth.authSessionId, uid); // proc.signal SIGHUP 'su-revoked' to the sockets
    return reply.code(204).send();
  });

  app.post(
    '/api/auth/guest',
    { bodyLimit: 1 * KIB, config: { rateClass: 'guest-ip', auth: 'public' } },
    async (request, reply) => {
      if (!config.guest.enabled)
        throw new HttpError(403, 'EPERM', 'guest accounts are disabled', { reason: 'disabled' });
      const { sessions, store } = ready();
      const created = sessions.newSession('guest', request.headers['user-agent']);
      const r = await store.createGuest({
        now: new Date(now()),
        maxActive: config.guest.maxActive,
        quotaBytes: GUEST_QUOTA_BYTES,
        quotaInodes: GUEST_QUOTA_INODES,
        suffix: () => base32(randomBytes(3)).slice(0, 4),
        session: created.record,
      });
      if (!r.ok) {
        metrics.authLogins.inc({ result: 'guest-full' });
        throw new HttpError(
          429,
          'EAGAIN',
          'no guest slot is free',
          { reason: 'rate' },
          GUEST_FULL_RETRY_MS,
        );
      }
      await revokePresented(request, sessions);
      setSession(reply, sessions, created);
      await store.audit({
        event: 'guest.create',
        uid: r.uid,
        realUid: r.uid,
        actor: 'user',
        outcome: 'ok',
        detail: { username: r.username, ip: request.ip },
      });
      metrics.authLogins.inc({ result: 'guest' });
      request.plt.uid = r.uid;
      const creds = await store.credentials(r.uid);
      return reply
        .code(201)
        .send(await me(store, stateOf(r.uid, 'guest', creds?.gids ?? [], created)));
    },
  );

  app.post(
    '/api/auth/password',
    { bodyLimit: 4 * KIB, config: { auth: 'session' } },
    async (request, reply) => {
      const { sessions, store } = ready();
      const auth = authOf(request);
      const body = parseInput(PasswordReq, request.body);
      take('su', `${auth.authSessionId}\u0000password`);
      if (auth.kind === 'guest')
        throw new HttpError(403, 'EPERM', 'guests have no password', { reason: 'guest' });
      const username = await store.usernameOf(auth.uid);
      const user = username === null ? null : await store.findLoginUser(username);
      if (!(await verifyOrDummy(user, body.current, user !== null))) {
        throw new HttpError(403, 'EACCES', 'the current password is wrong');
      }
      await store.updatePassword(auth.uid, await hashPassword(body.next, hashOpts), true);
      const others = (await store.liveSessionIds(auth.uid, new Date(now()))).filter(
        (id) => id !== auth.authSessionId,
      );
      await sessions.revoke(others, 'password', auth.uid);
      const created = await sessions.create(auth.uid, auth.kind, request.headers['user-agent']);
      await sessions.revoke([auth.authSessionId], 'password', auth.uid);
      metrics.authRevocations.inc({ reason: 'password' }, others.length + 1);
      setSession(reply, sessions, created);
      await store.audit({
        event: 'password.change',
        uid: auth.uid,
        realUid: auth.uid,
        actor: 'user',
        outcome: 'ok',
      });
      return reply.code(204).send();
    },
  );

  return Promise.resolve();
}
