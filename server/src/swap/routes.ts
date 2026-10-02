/**
 * swap/: remote swap, tier 2 (backend-api.md §3.11; memory-and-paging.md §4.5; MEM-03, MEM-04,
 * MEM-05, SRV-11). Primary owner R1, secondary reviewer R2. The logic is the swap engine
 * (../engine/swap); these routes parse the transport and ALWAYS authorise by the session uid
 * (request.plt.auth.uid), never by an su principal: process memory is private to its owner, and
 * even root cannot read another user's swap (403 EACCES).
 *
 * PUT    /api/swap/{osSession}/{pid}/{pageId}[?gen=]   raw body (compressed page), streamed
 * GET    /api/swap/{osSession}/{pid}/{pageId}[?gen=]   the stored (gzip) bytes + checksum headers
 * GET    /api/swap?osSession=&pid=&after=&limit=       the owner's pages, newest session first
 * DELETE /api/swap/{osSession}[/{pid}[/{pageId}]]       204 (rows first, files after COMMIT)
 */
import type { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';

import type { SwapService } from '../engine/swap/index.ts';
import { parseSwapPutHeaders, swapGetHeaders } from '../engine/swap/index.ts';
import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';
import type { Metrics } from '../obs/metrics.ts';

const BUSY_RETRY_MS = 1_000;
const UUID = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
const Int = (min: number, max: number) =>
  v.pipe(
    v.string(),
    v.regex(/^\d{1,10}$/),
    v.transform(Number),
    v.integer(),
    v.minValue(min),
    v.maxValue(max),
  );
const Pid = Int(1, 2_147_483_647);
const PageId = Int(0, 65_535);

const SessionParams = v.object({ osSession: UUID });
const PidParams = v.object({ osSession: UUID, pid: Pid });
const PageParams = v.object({ osSession: UUID, pid: Pid, pageId: PageId });
const GenQuery = v.object({ gen: v.optional(v.pipe(v.string(), v.regex(/^\d{0,16}$/))) });
const ListQuery = v.object({
  osSession: v.optional(UUID),
  pid: v.optional(Pid),
  after: v.optional(v.pipe(v.string(), v.maxLength(512))),
  limit: v.optional(Int(1, 1000)),
});

export interface SwapPluginOptions {
  /** null: no database; every route answers 503 EIO 'server'. */
  readonly swap: SwapService | null;
  readonly metrics?: Metrics;
}

export function swapPlugin(app: FastifyInstance, opts: SwapPluginOptions): Promise<void> {
  const route = { config: { rateClass: 'swap' as const } };

  const ready = (request: FastifyRequest): { swap: SwapService; owner: number } => {
    if (opts.swap === null)
      throw new HttpError(
        503,
        'EIO',
        'swap store unavailable',
        { reason: 'server' },
        BUSY_RETRY_MS,
      );
    const auth = request.plt.auth ?? null;
    if (auth === null) throw new HttpError(401, 'EACCES', 'not logged in');
    return { swap: opts.swap, owner: auth.uid };
  };

  app.put(
    '/api/swap/:osSession/:pid/:pageId',
    route,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { swap, owner } = ready(request);
      const p = parseInput(PageParams, request.params);
      const q = parseInput(GenQuery, request.query);
      const h = parseSwapPutHeaders(request.headers, q.gen === undefined ? {} : { gen: q.gen });
      const body = request.body as Readable | undefined;
      if (body === undefined || typeof (body as { pipe?: unknown }).pipe !== 'function')
        throw new HttpError(415, 'EINVAL', 'swap pages are application/octet-stream');
      request.plt.osSessionId = p.osSession;
      const r = await swap.put({
        ownerUid: owner,
        osSessionId: p.osSession,
        pid: p.pid,
        pageId: p.pageId,
        gen: h.gen,
        body,
        contentLength: h.contentLength,
        checksum: h.checksum,
        rawSize: h.rawSize,
        encoding: h.encoding,
      });
      if (r.unchanged) body.resume();
      else opts.metrics?.swapBytes.inc({ dir: 'out' }, r.storedSize);
      return reply.code(200).send(r);
    },
  );

  app.get(
    '/api/swap/:osSession/:pid/:pageId',
    route,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { swap, owner } = ready(request);
      const p = parseInput(PageParams, request.params);
      const q = parseInput(GenQuery, request.query);
      const gen = q.gen === undefined || q.gen === '' ? null : Number(q.gen);
      request.plt.osSessionId = p.osSession;
      const g = await swap.get(
        { ownerUid: owner, osSessionId: p.osSession, pid: p.pid, pageId: p.pageId },
        gen,
      );
      opts.metrics?.swapBytes.inc({ dir: 'in' }, g.page.storedSize);
      return reply.headers(swapGetHeaders(g.page)).send(g.stream);
    },
  );

  app.get('/api/swap', route, async (request: FastifyRequest, reply: FastifyReply) => {
    const { swap, owner } = ready(request);
    const q = parseInput(ListQuery, request.query);
    const filter = {
      ...(q.osSession === undefined ? {} : { osSessionId: q.osSession }),
      ...(q.pid === undefined ? {} : { pid: q.pid }),
    };
    return reply.send(await swap.list(owner, filter, q.after ?? null, q.limit ?? 1000));
  });

  app.delete('/api/swap/:osSession', route, async (request, reply) => {
    const { swap, owner } = ready(request);
    const p = parseInput(SessionParams, request.params);
    await swap.delete(owner, p.osSession);
    return reply.code(204).send();
  });
  app.delete('/api/swap/:osSession/:pid', route, async (request, reply) => {
    const { swap, owner } = ready(request);
    const p = parseInput(PidParams, request.params);
    await swap.delete(owner, p.osSession, p.pid);
    return reply.code(204).send();
  });
  app.delete('/api/swap/:osSession/:pid/:pageId', route, async (request, reply) => {
    const { swap, owner } = ready(request);
    const p = parseInput(PageParams, request.params);
    await swap.delete(owner, p.osSession, p.pid, p.pageId);
    return reply.code(204).send();
  });

  return Promise.resolve();
}
