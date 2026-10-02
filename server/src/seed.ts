/**
 * Seed CLI run by server/docker-entrypoint.sh after dbmate and before the server (C14;
 * backend-api.md §3.18.1; database.md §3.27):
 *
 *   node server/src/seed.ts --demo [--bench-profile bench10k|bench100k|none] [--examiners 3]
 *   node server/src/seed.ts --reissue-credentials
 *
 * --reissue-credentials prints NEW passwords for root and the seeded accounts (the first-start
 * block is shown once and is lost when the app container is recreated). To keep them out of any
 * shared terminal, send them to the app log:
 *   docker compose exec -T app sh -c 'node server/src/seed.ts --reissue-credentials > /proc/1/fd/1'
 *   docker compose logs app
 *
 * Connects as the OWNER role: OWNER_DATABASE_URL (no password in it) + OWNER_PASSWORD_FILE.
 * AUTH_PEPPER_FILE, when set, is mixed into the Argon2id hashes exactly as the server does.
 * The bench dataset comes from db/seed/seed.ts, run as a child process (the server does not import
 * @plotinium/db; PLOTINIUM_BENCH_SEED overrides its path). Exit codes: 0 ok, 64 usage, 78
 * configuration, 70 failure. The credentials block goes to stdout (docker compose logs app) once.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { createDatabase } from './db/client.ts';
import { reissueDemoCredentials, runDemoSeed } from './seed/demo.ts';

const EX_USAGE = 64;
const EX_SOFTWARE = 70;
const EX_CONFIG = 78;
const BENCH_PROFILES = new Set(['bench10k', 'bench100k', 'none']);
const DEFAULT_BENCH_SEED = fileURLToPath(new URL('../../db/seed/seed.ts', import.meta.url));

const run = promisify(execFile);
const log = (msg: string): void => {
  process.stderr.write(`${JSON.stringify({ level: 'info', msg, ts: new Date().toISOString() })}\n`);
};
const fail = (code: number, msg: string): never => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg, ts: new Date().toISOString() })}\n`,
  );
  process.exit(code);
};

const readSecret = (name: string): string | undefined => {
  const path = process.env[name];
  if (path === undefined || path === '') return undefined;
  try {
    return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return fail(EX_CONFIG, `${name}: cannot read the file`);
  }
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      demo: { type: 'boolean', default: false },
      'reissue-credentials': { type: 'boolean', default: false },
      'bench-profile': {
        type: 'string',
        default: process.env['PLOTINIUM_SEED_PROFILE'] ?? 'bench10k',
      },
      examiners: { type: 'string', default: process.env['PLOTINIUM_EXAMINERS'] ?? '3' },
    },
    strict: true,
  });
  const reissue = values['reissue-credentials'];
  if (values.demo === reissue)
    fail(
      EX_USAGE,
      'usage: node server/src/seed.ts --demo [--bench-profile bench10k|bench100k|none] [--examiners N]\n' +
        '       node server/src/seed.ts --reissue-credentials',
    );
  const profile = values['bench-profile'];
  if (!BENCH_PROFILES.has(profile))
    fail(EX_USAGE, '--bench-profile must be bench10k, bench100k or none');
  const examiners = Number(values.examiners);
  if (!Number.isInteger(examiners) || examiners < 0 || examiners > 20)
    fail(EX_USAGE, '--examiners must be 0..20');

  const url = process.env['OWNER_DATABASE_URL'];
  if (url === undefined || url === '') return fail(EX_CONFIG, 'OWNER_DATABASE_URL: required');
  const password = readSecret('OWNER_PASSWORD_FILE');
  const pepper = readSecret('AUTH_PEPPER_FILE');
  const benchSeed = process.env['PLOTINIUM_BENCH_SEED'] ?? DEFAULT_BENCH_SEED;

  const database = createDatabase(
    { url, password, poolMax: 2, statementTimeoutMs: 600_000, lockTimeoutMs: 10_000 },
    { applicationName: 'plotinium-seed' },
  );
  try {
    if (reissue) {
      const names = await reissueDemoCredentials({
        database,
        ...(pepper === undefined ? {} : { pepper }),
        print: (text) => process.stdout.write(text),
      });
      log(
        names.length === 0
          ? 'reissue: the demo seed has not run on this database; nothing to do'
          : `reissue: new passwords for ${names.length} accounts; their sessions were revoked`,
      );
      return;
    }
    const t0 = Date.now();
    const r = await runDemoSeed({
      database,
      examiners,
      ...(pepper === undefined ? {} : { pepper }),
      ...(profile === 'none'
        ? {}
        : {
            benchSql: async () =>
              (
                await run(process.execPath, [benchSeed, '--profile', profile, '--no-vacuum'], {
                  maxBuffer: 1024 * 1024 * 1024,
                })
              ).stdout,
          }),
      print: (text) => process.stdout.write(text),
      log,
    });
    if (r.seeded)
      log(
        `demo seed: done in ${Date.now() - t0} ms (bench ${r.benchLoaded ? profile : 'skipped'})`,
      );
  } finally {
    await database.close();
  }
}

main().catch((e: unknown) =>
  fail(EX_SOFTWARE, `seed failed: ${e instanceof Error ? e.message : String(e)}`),
);
