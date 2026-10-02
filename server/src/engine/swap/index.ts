/**
 * The swap engine: the logic behind /api/swap/* (backend-api.md §3.11; memory-and-paging.md §3.11,
 * §4.5). The plugin server/src/swap/routes.ts builds it once.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types.gen.ts';
import type { BlobStore } from '../../storage/blobstore.ts';
import { KyselySwapDb } from './kysely-db.ts';
import { SwapService } from './service.ts';

export { SwapService, LIST_LIMIT_MAX, RETENTION_DAYS, maxStoredBytes } from './service.ts';
export type { SwapGetResult, SwapPutArgs, SwapPutResult } from './service.ts';
export { KyselySwapDb } from './kysely-db.ts';
export { MemorySwapDb } from './memory-db.ts';
export { parseSwapPutHeaders, swapGetHeaders } from './headers.ts';
export type * from './types.ts';

export function createSwapEngine(o: {
  readonly db: Kysely<DB>;
  readonly blobs: BlobStore;
  /** PLOTINIUM_SWAP_MAX_BYTES */
  readonly quotaBytes: number;
  /** SWAP_PAGE_MAX_RAW_BYTES */
  readonly maxRawBytes: number;
}): SwapService {
  return new SwapService({
    db: new KyselySwapDb(o.db),
    blobs: o.blobs,
    quotaBytes: o.quotaBytes,
    maxRawBytes: o.maxRawBytes,
  });
}
