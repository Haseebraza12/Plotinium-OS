/**
 * telemetry/: opt-in telemetry sync (backend-api.md §3.14; predictive-prefetch.md §3.3; PRE-05).
 * Primary owner R4, secondary reviewer R2. Telemetry stays on the device unless the user opts in;
 * the server accepts rows only while users.telemetry_opt_in is true, in the same statement
 * (./store.ts). Everything is keyed by the LOGIN uid of the cookie session: telemetry describes the
 * person at the keyboard, not an su principal, and no route reads another uid's events.
 *
 * GET    /api/telemetry/consent   200 {optIn, since?}
 * PUT    /api/telemetry/consent   {optIn} -> 200 {optIn, since?}; opting out deletes the server copy
 * POST   /api/telemetry           {events: 1..500} -> 202 {accepted, duplicates}; 403 EPERM opt-in
 * GET    /api/telemetry?after=&limit=   200 {events, next?}; 403 EPERM opt-in
 * DELETE /api/telemetry           204 (at any time)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';

import { TelemetryEvent } from '@plotinium/protocol';

import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';
import type { TelemetryStore } from './store.ts';

const KIB = 1024;
const BUSY_RETRY_MS = 1_000;
export const TELEMETRY_UPLOAD_MAX = 500;
export const TELEMETRY_LIST_MAX = 2000;

const ConsentReq = v.strictObject({ optIn: v.boolean() });
const Upload = v.strictObject({
  events: v.pipe(v.array(TelemetryEvent), v.minLength(1), v.maxLength(TELEMETRY_UPLOAD_MAX)),
});
const ListQuery = v.object({
  after: v.optional(v.pipe(v.string(), v.maxLength(256))),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,4}$/),
      v.transform(Number),
      v.minValue(1),
      v.maxValue(TELEMETRY_LIST_MAX),
    ),
  ),
});

export interface TelemetryPluginOptions {
  /** null: no database; every route answers 503 EIO 'server'. */
  readonly store: TelemetryStore | null;
}

export function telemetryPlugin(app: FastifyInstance, opts: TelemetryPluginOptions): Promise<void> {
  const ready = (request: FastifyRequest): { store: TelemetryStore; uid: number } => {
    if (opts.store === null)
      throw new HttpError(503, 'EIO', 'database unavailable', { reason: 'server' }, BUSY_RETRY_MS);
    const auth = request.plt.auth ?? null;
    if (auth === null) throw new HttpError(401, 'EACCES', 'not logged in');
    return { store: opts.store, uid: auth.uid };
  };
  const notOptedIn = (): HttpError =>
    new HttpError(403, 'EPERM', 'telemetry sync is off for this account', { reason: 'opt-in' });

  app.get(
    '/api/telemetry/consent',
    { config: { rateClass: 'api' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, uid } = ready(request);
      const c = await store.consent(uid);
      if (c === null) throw new HttpError(401, 'EACCES', 'not logged in');
      return reply.send(c);
    },
  );

  app.put(
    '/api/telemetry/consent',
    { bodyLimit: 1 * KIB, config: { rateClass: 'api' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, uid } = ready(request);
      const body = parseInput(ConsentReq, request.body);
      return reply.send(await store.setConsent(uid, body.optIn));
    },
  );

  app.post(
    '/api/telemetry',
    { bodyLimit: 256 * KIB, config: { rateClass: 'telemetry' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, uid } = ready(request);
      const body = parseInput(Upload, request.body);
      const r = await store.insert(uid, body.events);
      if (r === null) throw notOptedIn();
      return reply.code(202).send(r);
    },
  );

  app.get(
    '/api/telemetry',
    { config: { rateClass: 'telemetry' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, uid } = ready(request);
      const q = parseInput(ListQuery, request.query);
      const r = await store.list(uid, q.after ?? null, q.limit ?? TELEMETRY_LIST_MAX);
      if (r === null) throw notOptedIn();
      return reply.send(r);
    },
  );

  app.delete(
    '/api/telemetry',
    { config: { rateClass: 'api' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, uid } = ready(request);
      await store.deleteAll(uid);
      return reply.code(204).send();
    },
  );

  return Promise.resolve();
}
