/**
 * admin/: the fault-injection harness and the integrity probes (backend-api.md §3.15, §4.3;
 * database.md §3.14, §4.15, §4.16; DB-02, VFS-11, SRV-14, AGT-09). Primary owner R5, secondary
 * reviewer R2.
 *
 * /api/debug/fault exists ONLY when FAULT_INJECTION=1 and PLOTINIUM_ENV is not production (the
 * process refuses to start with that combination, config.ts); otherwise it answers 404 ENOSYS like
 * any unknown route (INV-SRV-8). Root only (a live su grant for uid 0 and X-Plotinium-Principal: 0;
 * the route-auth hook answers 403 EPERM root-only otherwise). The arm is one-shot and scoped to the
 * OS session named by X-Plotinium-OS-Session, which must belong to the session's login uid.
 *   POST   {op, target, failAtNode?, on?, delayMs?} -> 200 {armed: true, osSessionId, expiresAt}
 *   GET    -> 200 {armed: [...]} (this OS session's arm, or every arm without the header)
 *   DELETE -> 204 (disarms this OS session's arm)
 * /api/admin/probes?root=<ino> is read-only and registered in every environment (root only).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';

import { INO } from '@plotinium/protocol';

import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';
import { FAULT_OPS, type FaultArming } from './faults.ts';
import type { AdminDb } from './probes.ts';

const KIB = 1024;
const BUSY_RETRY_MS = 1_000;
const UUID = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);

export const FaultArmReq = v.pipe(
  v.strictObject({
    op: v.picklist(FAULT_OPS),
    target: v.picklist(['server', 'client', 'both']),
    failAtNode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000))),
    on: v.optional(v.picklist(['inodes', 'dentries'])),
    delayMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(30_000))),
  }),
  // failAtNode is required unless the arm is a pure delay: op 'batch' with delayMs > 0 (§3.15).
  v.check(
    (a) => a.failAtNode !== undefined || (a.op === 'batch' && (a.delayMs ?? 0) > 0),
    'failAtNode is required unless the arm is a batch delay',
  ),
);

const ProbesQuery = v.object({ root: v.optional(UUID) });

export interface AdminPluginOptions {
  /** FAULT_INJECTION=1 and not production: the harness routes are mounted. */
  readonly faultInjection: boolean;
  /** The arms (required when faultInjection is true and a database exists). */
  readonly faults: FaultArming | null;
  /** null: no database; the routes answer 503 EIO 'server'. */
  readonly db: AdminDb | null;
}

export function adminPlugin(app: FastifyInstance, opts: AdminPluginOptions): Promise<void> {
  const ready = (): { db: AdminDb } => {
    if (opts.db === null)
      throw new HttpError(503, 'EIO', 'database unavailable', { reason: 'server' }, BUSY_RETRY_MS);
    return { db: opts.db };
  };

  /** The X-Plotinium-OS-Session header, checked against the session's login uid. */
  const osSessionOf = async (
    request: FastifyRequest,
    required: boolean,
  ): Promise<string | undefined> => {
    const raw = request.headers['x-plotinium-os-session'];
    if (raw === undefined) {
      if (required)
        throw new HttpError(400, 'EINVAL', 'X-Plotinium-OS-Session is required', {
          field: 'x-plotinium-os-session',
        });
      return undefined;
    }
    if (typeof raw !== 'string' || !v.is(UUID, raw))
      throw new HttpError(400, 'EINVAL', 'bad X-Plotinium-OS-Session', {
        field: 'x-plotinium-os-session',
      });
    const { db } = ready();
    const owner = await db.osSessionOwner(raw);
    const loginUid = request.plt.auth?.uid;
    if (owner === null || owner !== loginUid)
      throw new HttpError(403, 'EACCES', 'the OS session is not yours', { reason: 'principal' });
    request.plt.osSessionId = raw;
    return raw;
  };

  if (opts.faultInjection) {
    const cfg = { config: { rateClass: 'admin' as const, auth: 'root' as const } };
    const faults = (): FaultArming => {
      if (opts.faults === null || opts.db === null)
        throw new HttpError(
          503,
          'EIO',
          'database unavailable',
          { reason: 'server' },
          BUSY_RETRY_MS,
        );
      return opts.faults;
    };

    app.post(
      '/api/debug/fault',
      { ...cfg, bodyLimit: 4 * KIB },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const arming = faults();
        const body = parseInput(FaultArmReq, request.body);
        const os = await osSessionOf(request, true);
        if (os === undefined)
          throw new HttpError(400, 'EINVAL', 'X-Plotinium-OS-Session is required');
        const rec = arming.arm(os, request.plt.auth?.uid ?? 0, {
          op: body.op,
          target: body.target,
          ...(body.failAtNode === undefined ? {} : { failAtNode: body.failAtNode }),
          ...(body.on === undefined ? {} : { on: body.on }),
          ...(body.delayMs === undefined ? {} : { delayMs: body.delayMs }),
        });
        return reply.send({ armed: true, osSessionId: rec.osSessionId, expiresAt: rec.expiresAt });
      },
    );

    app.get('/api/debug/fault', cfg, async (request: FastifyRequest, reply: FastifyReply) => {
      const arming = faults();
      const os = await osSessionOf(request, false);
      return reply.send({ armed: arming.list(os) });
    });

    app.delete('/api/debug/fault', cfg, async (request: FastifyRequest, reply: FastifyReply) => {
      const arming = faults();
      const os = await osSessionOf(request, true);
      if (os !== undefined) arming.disarm(os);
      return reply.code(204).send();
    });
  }

  app.get(
    '/api/admin/probes',
    { config: { rateClass: 'admin', auth: 'root' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { db } = ready();
      const q = parseInput(ProbesQuery, request.query);
      const root = q.root ?? INO.ROOT;
      const probes = await db.probes(root);
      if (probes === null) throw new HttpError(404, 'ENOENT', 'no such directory', { ino: root });
      const auth = request.plt.auth;
      await db.audit({
        uid: 0,
        realUid: auth?.uid ?? 0,
        osSessionId: null,
        syscall: 'admin.probe',
        outcome: 'ok',
        detail: { root, violations: probes.violations.length },
      });
      return reply.send(probes);
    },
  );

  return Promise.resolve();
}
