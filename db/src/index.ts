/**
 * @plotinium/db: the schema's companion code (database.md). The migrations, db/schema.sql, the
 * probes and the Q1-Q5 statements are SQL files in this package; this entry point exports the
 * deterministic bench-seed generator so tools and the server's seed runner can reuse it.
 * Primary owner R2, secondary reviewer R5.
 */
export {
  fixtureUsersFor,
  generateBench,
  HOME_INO,
  ROOT_INO,
  SYSTEM_INODES,
  totalInodesFor,
  type BenchData,
  type BenchManifest,
  type BenchProfile,
  type SeedBlob,
  type SeedDentry,
  type SeedInode,
  type SeedUser,
} from '../seed/lib/generate.ts';
export { mulberry32, zipfSampler, type Rng } from '../seed/lib/rng.ts';
export { renderBenchSql } from '../seed/lib/sql.ts';
export { seededUuidv7 } from '../seed/lib/uuid.ts';

export const PACKAGE_NAME = '@plotinium/db';
