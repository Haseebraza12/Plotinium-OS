/**
 * index/: the semantic-search index API (backend-api.md §3.12; rag-semantic-search.md §4.4, §4.5;
 * RAG-02, RAG-03, RAG-05, SRV-12). Primary owner R2, secondary reviewer R4. Registered only when
 * AI=1 (SRV-18: otherwise 404 ENOSYS). The logic is the index engine (../engine/index), whose
 * readable-set CTE is the single source of `may_r`/`may_x` visibility; these routes parse the
 * transport and take the requester from the request's principal (never from the body).
 *
 * POST /api/index/put      application/vnd.plotinium.chunks (<= 4 MiB, 413 EINVAL); an EMPTY body
 *                          clears the file's set and names it in ?ino=&inodeVersion=&modelKey=
 * GET  /api/index/pull     chunk frames; X-Next-After and X-Manifest-Files headers
 * POST /api/index/search   {modelKey, vector[384], k, scope?} -> {results}
 * POST /api/index/verify   {modelKey, items[<=50]} -> {items}
 */
import type { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  CHUNKS_CONTENT_TYPE,
  decodeFrames,
  encodePullChunks,
  PullQueryString,
  putInputFromFrames,
  PutQueryString,
  readBody,
  SearchBody,
  VerifyBody,
  type IndexService,
  type Requester,
} from '../engine/index/index.ts';
import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';

const MIB = 1024 * 1024;
const KIB = 1024;
const BUSY_RETRY_MS = 1_000;
const MAX_FRAMES = 4096;

export interface IndexPluginOptions {
  /** null: no database; every route answers 503 EIO 'server'. */
  readonly index: IndexService | null;
}

export function indexPlugin(app: FastifyInstance, opts: IndexPluginOptions): Promise<void> {
  const ready = (request: FastifyRequest): { index: IndexService; req: Requester } => {
    if (opts.index === null)
      throw new HttpError(503, 'EIO', 'index unavailable', { reason: 'server' }, BUSY_RETRY_MS);
    const p = request.plt.principal;
    if (p === undefined) throw new HttpError(401, 'EACCES', 'not logged in');
    return { index: opts.index, req: { uid: p.uid, gids: p.gids } };
  };

  app.post(
    '/api/index/put',
    { bodyLimit: 4 * MIB, config: { rateClass: 'index' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { index, req } = ready(request);
      const type = String(request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim();
      if (type !== CHUNKS_CONTENT_TYPE)
        throw new HttpError(415, 'EINVAL', `index puts are ${CHUNKS_CONTENT_TYPE}`);
      const body = request.body as Readable | undefined;
      const buf =
        body === undefined || typeof (body as { pipe?: unknown }).pipe !== 'function'
          ? Buffer.alloc(0)
          : await readBody(body as AsyncIterable<Buffer>);
      const frames = decodeFrames(buf, { maxFrames: MAX_FRAMES });
      let ids: { ino: string; inodeVersion: number; modelKey: string } | undefined;
      if (frames.length === 0) {
        const q = parseInput(PutQueryString, request.query);
        if (q.ino === undefined || q.inodeVersion === undefined || q.modelKey === undefined)
          throw new HttpError(400, 'EINVAL', 'an empty put names ino, inodeVersion and modelKey', {
            field: 'ino',
          });
        ids = { ino: q.ino, inodeVersion: q.inodeVersion, modelKey: q.modelKey };
      }
      return reply.send(await index.put(req, putInputFromFrames(frames, ids)));
    },
  );

  app.get(
    '/api/index/pull',
    { config: { rateClass: 'index' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { index, req } = ready(request);
      const q = parseInput(PullQueryString, request.query);
      const page = await index.pull(req, { modelKey: q.modelKey, after: q.after, limit: q.limit });
      return reply
        .header('content-type', CHUNKS_CONTENT_TYPE)
        .header('x-next-after', String(page.nextAfter))
        .header('x-manifest-files', String(page.manifestFiles))
        .header('x-complete', page.complete ? '1' : '0')
        .send(encodePullChunks(page.chunks));
    },
  );

  app.post(
    '/api/index/search',
    { bodyLimit: 16 * KIB, config: { rateClass: 'index' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { index, req } = ready(request);
      const body = parseInput(SearchBody, request.body);
      const results = await index.search(req, {
        modelKey: body.modelKey,
        vector: Float32Array.from(body.vector),
        k: body.k,
        scopeIno: body.scope ?? null,
      });
      return reply.send({ results });
    },
  );

  app.post(
    '/api/index/verify',
    { bodyLimit: 16 * KIB, config: { rateClass: 'verify' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { index, req } = ready(request);
      const body = parseInput(VerifyBody, request.body);
      return reply.send({ items: await index.verify(req, body.modelKey, body.items) });
    },
  );

  return Promise.resolve();
}
