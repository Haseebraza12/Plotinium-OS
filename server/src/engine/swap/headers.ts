/**
 * Transport helpers for /api/swap (backend-api.md §3.11, §4.3 SwapPutHeaders; memory-and-paging.md
 * §4.5). The two specs name the upload headers differently; both dialects are accepted and both
 * are sent on GET, so the pager and the server agree whichever the pager implements:
 *
 *   backend-api.md          memory-and-paging.md   meaning
 *   X-Plotinium-Checksum    Plt-Sha256             hex SHA-256 of the UNCOMPRESSED page (MEM-03)
 *   X-Plotinium-Raw-Size    Plt-Size               uncompressed bytes
 *   X-Plotinium-Encoding    (always gzip)          gzip | identity
 *   ?gen= (query)           ?gen= (query)          page generation (optional)
 */
import { HttpError } from '../../http/errors.ts';
import type { SwapPage } from './types.ts';

export type HeaderBag = Readonly<Record<string, string | string[] | undefined>>;

export interface SwapPutHeaders {
  readonly contentLength: number;
  readonly checksum: string;
  readonly rawSize: number;
  readonly encoding: 'gzip' | 'identity';
  readonly gen: number | null;
}

function one(h: HeaderBag, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = h[n];
    const s = Array.isArray(v) ? v[0] : v;
    if (s !== undefined && s !== '') return s.trim();
  }
  return undefined;
}

const DEC = /^\d{1,16}$/;

/** Parses the upload headers and `?gen=`; 411 without Content-Length, 400 for anything malformed. */
export function parseSwapPutHeaders(
  headers: HeaderBag,
  query: { readonly gen?: string | undefined } = {},
): SwapPutHeaders {
  const cl = one(headers, 'content-length');
  if (cl === undefined)
    throw new HttpError(411, 'EINVAL', 'Content-Length required', { field: 'content-length' });
  if (!DEC.test(cl))
    throw new HttpError(400, 'EINVAL', 'bad Content-Length', { field: 'content-length' });
  const checksum = one(headers, 'x-plotinium-checksum', 'plt-sha256')?.toLowerCase();
  if (checksum === undefined || !/^[0-9a-f]{64}$/.test(checksum)) {
    throw new HttpError(400, 'EINVAL', 'X-Plotinium-Checksum must be hex SHA-256', {
      field: 'x-plotinium-checksum',
    });
  }
  const raw = one(headers, 'x-plotinium-raw-size', 'plt-size');
  if (raw === undefined || !DEC.test(raw)) {
    throw new HttpError(400, 'EINVAL', 'X-Plotinium-Raw-Size required', {
      field: 'x-plotinium-raw-size',
    });
  }
  const enc = (one(headers, 'x-plotinium-encoding') ?? 'gzip').toLowerCase();
  if (enc !== 'gzip' && enc !== 'identity') {
    throw new HttpError(400, 'EINVAL', 'X-Plotinium-Encoding must be gzip or identity', {
      field: 'x-plotinium-encoding',
    });
  }
  let gen: number | null = null;
  if (query.gen !== undefined && query.gen !== '') {
    if (!DEC.test(query.gen))
      throw new HttpError(400, 'EINVAL', 'bad generation', { field: 'gen' });
    gen = Number(query.gen);
  }
  return { contentLength: Number(cl), checksum, rawSize: Number(raw), encoding: enc, gen };
}

/** GET response headers, in both dialects. */
export function swapGetHeaders(page: SwapPage): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'content-length': String(page.storedSize),
    'cache-control': 'no-store',
    'x-plotinium-checksum': page.checksum,
    'x-plotinium-raw-size': String(page.size),
    'x-plotinium-encoding': 'gzip',
    'x-plotinium-gen': String(page.gen),
    'plt-sha256': page.checksum,
    'plt-size': String(page.size),
  };
}
