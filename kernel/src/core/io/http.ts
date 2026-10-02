/**
 * The kernel's HTTPS client for the server routes it owns (backend-api.md §3.6; architecture §4.1
 * "HTTPS /api/* kernel ↔ server"): `/api/auth/{login,guest,me,logout}`, `/api/healthz` and
 * `/version.json`. Requests go through the host's same-origin `fetch` (the session cookie is
 * HttpOnly and rides along) and time out on the kernel timer heap, never on `setTimeout`.
 * Server replies are data: every body is validated before the kernel uses it.
 */
import type { KernelTimers } from '@plotinium/services';
import * as v from 'valibot';

import { INO } from '@plotinium/protocol';

import type { FetchLike } from './types.ts';

/** `GET /api/auth/me` and the login replies (server/src/gateway/schemas.ts `AuthMe`). */
export const AuthMeSchema = v.object({
  uid: v.pipe(v.number(), v.integer(), v.minValue(0)),
  username: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  kind: v.picklist(['root', 'user', 'guest', 'demo', 'examiner']),
  gid: v.pipe(v.number(), v.integer(), v.minValue(0)),
  groups: v.array(v.object({ gid: v.number(), name: v.string() })),
  home: v.string(),
  quota: v.object({
    quotaBytes: v.number(),
    quotaInodes: v.number(),
    usedBytes: v.number(),
    usedInodes: v.number(),
  }),
  passwordVersion: v.number(),
  offlineVerifier: v.object({ allowed: v.boolean() }),
  server: v.optional(v.object({ name: v.string(), version: v.string(), build: v.string() })),
});
export type AuthMe = v.InferOutput<typeof AuthMeSchema>;

const ErrorBody = v.object({
  errno: v.optional(v.string()),
  msg: v.optional(v.string()),
  retryAfterMs: v.optional(v.number()),
});

const VersionSchema = v.object({ name: v.string(), version: v.string(), build: v.string() });

/** The part of a snapshot page (backend-api.md §4.2) the home lookup reads. */
const SnapshotPageSchema = v.object({
  rows: v.array(
    v.object({
      parentIno: v.nullable(v.string()),
      name: v.nullable(v.string()),
      ino: v.string(),
      type: v.string(),
    }),
  ),
  next: v.optional(v.string()),
  complete: v.boolean(),
});

/** Pages of /home the home lookup reads at most (2,000 entries each). */
export const HOME_SNAPSHOT_PAGES_MAX = 8;
export type ServerVersion = v.InferOutput<typeof VersionSchema>;

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false;
      /** 0: no response (network failure or timeout). */
      readonly status: number;
      readonly errno: string | null;
      readonly retryAfterMs: number | null;
    };

/** Budget of one request: the non-critical services have 4 s in total, login 2 s. */
export const REQUEST_TIMEOUT_MS = 3_000;

const NETWORK_FAILURE = { ok: false, status: 0, errno: null, retryAfterMs: null } as const;

export class ServerApi {
  private readonly fetchFn: FetchLike | undefined;
  private readonly timers: KernelTimers;
  private readonly timeoutMs: number;

  constructor(
    fetchFn: FetchLike | undefined,
    timers: KernelTimers,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.fetchFn = fetchFn;
    this.timers = timers;
    this.timeoutMs = timeoutMs;
  }

  /** Whether this host can reach a server at all (the loopback host and tests cannot). */
  get available(): boolean {
    return this.fetchFn !== undefined;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<{ status: number; json: unknown } | null> {
    const fetchFn = this.fetchFn;
    if (fetchFn === undefined) return null;
    const abort = new AbortController();
    const timer = this.timers.at(this.timers.now() + timeoutMs, () => {
      abort.abort();
    });
    try {
      const res = await fetchFn(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: abort.signal,
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json: unknown = null;
      const text = await res.text();
      if (text !== '') {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } catch {
      return null;
    } finally {
      this.timers.cancel(timer);
    }
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: v.GenericSchema<unknown, T>,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<ApiResult<T>> {
    const r = await this.request(method, path, body, timeoutMs);
    if (r === null) return NETWORK_FAILURE;
    if (r.status >= 200 && r.status < 300) {
      const parsed = v.safeParse(schema, r.json);
      if (parsed.success) return { ok: true, status: r.status, body: parsed.output };
      return { ok: false, status: r.status, errno: 'EPROTO', retryAfterMs: null };
    }
    const e = v.safeParse(ErrorBody, r.json);
    return {
      ok: false,
      status: r.status,
      errno: e.success ? (e.output.errno ?? null) : null,
      retryAfterMs: e.success ? (e.output.retryAfterMs ?? null) : null,
    };
  }

  me(timeoutMs?: number): Promise<ApiResult<AuthMe>> {
    return this.call('GET', '/api/auth/me', AuthMeSchema, undefined, timeoutMs);
  }

  login(username: string, password: string): Promise<ApiResult<AuthMe>> {
    return this.call('POST', '/api/auth/login', AuthMeSchema, { username, password });
  }

  guest(): Promise<ApiResult<AuthMe>> {
    return this.call('POST', '/api/auth/guest', AuthMeSchema, {});
  }

  async logout(): Promise<void> {
    await this.request('POST', '/api/auth/logout', {});
  }

  /** `/version.json` (the identity check of boot-and-services.md §3.2.2); null when unreachable. */
  async version(timeoutMs?: number): Promise<ServerVersion | null> {
    const r = await this.call('GET', '/version.json', VersionSchema, undefined, timeoutMs);
    return r.ok ? r.body : null;
  }

  /**
   * The inode id the server minted for `/home/<username>` (C5), from a snapshot of /home
   * (`GET /api/sync/snapshot?scope=dir&ino=<HOME>`, following its pages): the id the device must
   * use for the home before sync can send ops under it (UI-006). `null`: the server has no such
   * home; `undefined`: the server did not answer in time.
   */
  async homeIno(username: string, timeoutMs?: number): Promise<string | null | undefined> {
    let after: string | undefined;
    for (let page = 0; page < HOME_SNAPSHOT_PAGES_MAX; page++) {
      const q = `/api/sync/snapshot?scope=dir&ino=${INO.HOME}&limit=2000${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`;
      const r = await this.call('GET', q, SnapshotPageSchema, undefined, timeoutMs);
      if (!r.ok) return r.status === 0 ? undefined : null;
      const row = r.body.rows.find((x) => x.parentIno === INO.HOME && x.name === username);
      if (row !== undefined) return row.type === 'd' ? row.ino : null;
      if (r.body.complete || r.body.next === undefined) return null;
      after = r.body.next;
    }
    return null;
  }

  /** `GET /api/healthz`: true when the server answered. */
  async healthz(timeoutMs?: number): Promise<boolean> {
    const r = await this.request('GET', '/api/healthz', undefined, timeoutMs);
    return r !== null && r.status >= 200 && r.status < 500;
  }
}
