/**
 * The index engine: the logic behind /api/index/* (backend-api.md §3.12; rag-semantic-search.md
 * §3.6, §4.4, §4.5). The plugin server/src/index/routes.ts builds it once (AI=1 only).
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types.gen.ts';
import type { BlobStore } from '../../storage/blobstore.ts';
import { KyselyIndexDb } from './kysely-db.ts';
import { blobReaderFrom, IndexService } from './service.ts';

export { IndexService, blobReaderFrom, chunkContentHash } from './service.ts';
export { KyselyIndexDb } from './kysely-db.ts';
export { MemoryIndexDb } from './memory-db.ts';
export {
  CHUNKS_CONTENT_TYPE,
  decodeFrames,
  encodeFrames,
  encodePullChunks,
  putInputFromFrames,
  readBody,
  PUT_BODY_MAX_BYTES,
} from './chunks-codec.ts';
export { PullQueryString, PutQueryString, SearchBody, VerifyBody } from './schemas.ts';
export * from './types.ts';

export function createIndexEngine(o: {
  readonly db: Kysely<DB>;
  readonly blobs: BlobStore;
}): IndexService {
  return new IndexService({ db: new KyselyIndexDb(o.db), blobs: blobReaderFrom(o.blobs) });
}
