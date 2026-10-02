/**
 * Bench seed CLI (DB-05, DBD-18; database.md §3.27). Runs with Node 24 type stripping:
 *
 *   node db/seed/seed.ts --profile bench10k [--seed 42] [--out seed.sql] [--manifest m.json]
 *                        [--no-vacuum]
 *
 * Prints (or writes) one SQL script; load it into a freshly migrated database, for example:
 *   node db/seed/seed.ts --profile bench10k \
 *     | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U plotinium_owner -d plotinium_bench
 * The manifest (counts, depth histogram, fixture paths, SHA-256 of the SQL) is deterministic:
 * two runs with the same profile and seed are byte-identical. After loading, record the tree
 * checksum with `SELECT plt_tree_checksum('00000000-0000-7000-8000-000000000001')` and run
 * db/probes/integrity.sql (every probe must return zero rows).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { generateBench, type BenchProfile } from './lib/generate.ts';
import { renderBenchSql } from './lib/sql.ts';

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'bench10k' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string' },
    manifest: { type: 'string' },
    'no-vacuum': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(
    'usage: node db/seed/seed.ts --profile bench10k|bench100k [--seed 42] [--out f.sql] [--manifest f.json] [--no-vacuum]\n',
  );
  process.exit(0);
}
if (values.profile !== 'bench10k' && values.profile !== 'bench100k') {
  process.stderr.write('seed: --profile must be bench10k or bench100k\n');
  process.exit(64);
}
const seed = Number(values.seed);
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
  process.stderr.write('seed: --seed must be an integer in [0, 2^32)\n');
  process.exit(64);
}

const profile: BenchProfile = values.profile;
const data = generateBench(profile, seed);
const sql = renderBenchSql(data, { vacuum: !values['no-vacuum'] });
const sqlSha256 = createHash('sha256').update(sql).digest('hex');

if (values.out === undefined) process.stdout.write(sql);
else writeFileSync(values.out, sql);
if (values.manifest !== undefined) {
  writeFileSync(values.manifest, `${JSON.stringify({ ...data.manifest, sqlSha256 }, null, 2)}\n`);
}
process.stderr.write(
  `seed: ${profile} seed ${seed}: ${data.manifest.newInodes} new inodes (${data.manifest.totalInodes} total), ` +
    `${data.manifest.directories} directories, ${data.manifest.blobs} blobs, max depth ${data.manifest.maxDepth}, sql sha256 ${sqlSha256}\n`,
);
