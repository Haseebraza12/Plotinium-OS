/**
 * The SRV-04 error model on the wire (backend-api.md §3.5).
 *
 * Every error response is JSON {errno, reason?, msg, reqId, retryAfterMs?, detail?}; errno is one
 * of the C3 set; 429 and 503 carry retryAfterMs and a Retry-After header (seconds, rounded up).
 * The body's errno is authoritative; the status agrees with the client fallback mapping.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { defaultStatusFor, ErrnoError, type ApiError, type Errno } from '../errno.ts';

/** An errno with an explicit HTTP status, message and optional retry hint. */
export class HttpError extends ErrnoError {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    errno: Errno,
    msg: string,
    detail: Record<string, unknown> = {},
    retryAfterMs?: number,
  ) {
    super(errno, detail, msg);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  errno: Errno,
  msg: string,
  detail: Record<string, unknown> = {},
  retryAfterMs?: number,
): FastifyReply {
  const { reason, ...rest } = detail;
  const body: ApiError = {
    errno,
    ...(typeof reason === 'string' ? { reason } : {}),
    msg,
    reqId: String(request.id),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
  };
  if (retryAfterMs !== undefined)
    void reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
  request.plt.errno = errno;
  if (typeof reason === 'string') request.plt.reason = reason;
  return reply.code(status).send(body);
}

/** Maps Fastify's own errors (parsers, limits) and our errors to SRV-04 bodies. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof HttpError) {
      return sendError(
        request,
        reply,
        error.status,
        error.errno,
        error.message,
        { ...error.detail },
        error.retryAfterMs,
      );
    }
    if (error instanceof ErrnoError) {
      return sendError(request, reply, defaultStatusFor(error.errno), error.errno, error.message, {
        ...error.detail,
      });
    }
    const status = (error as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = (error as FastifyError).code;
      if (status === 413) return sendError(request, reply, 413, 'EINVAL', 'request body too large');
      if (status === 415)
        return sendError(request, reply, 415, 'EINVAL', 'unsupported content type');
      if (status === 404) return sendError(request, reply, 404, 'ENOENT', 'not found');
      return sendError(
        request,
        reply,
        400,
        'EINVAL',
        'malformed request',
        code === undefined ? {} : { code },
      );
    }
    request.log.error({ err: error }, 'unhandled error');
    return sendError(request, reply, 500, 'EIO', 'internal error', { reason: 'server' });
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(request, reply, 404, 'ENOSYS', 'no such route', { route: request.url.split('?')[0] }),
  );
}

/**
 * The handler of a route whose plugin exists but whose behaviour is not implemented yet:
 * 501 ENOSYS naming the requirement IDs and the spec section that define it.
 */
export function notImplemented(requirements: readonly string[], spec: string) {
  return (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    sendError(request, reply, 501, 'ENOSYS', `not implemented yet: ${spec}`, {
      requirements: [...requirements],
      spec,
    });
}
