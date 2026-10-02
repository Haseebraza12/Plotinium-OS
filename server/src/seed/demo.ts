/**
 * The first-start demo seed (database.md §3.27 "Demo seed"; backend-api.md §3.18.3; SRV-20, C10).
 *
 * Run by the app entrypoint on EVERY start, after dbmate and before the server, as the owner role
 * (VACUUM needs table ownership). Idempotent: the `demo` account is its marker, so a second start
 * changes nothing and prints nothing.
 *
 * On a fresh database it
 *   1. optionally loads the deterministic bench dataset (bench10k by default, so DB-05's live
 *      query runs against >= 10,000 records on the examiner's clean bring-up);
 *   2. in ONE transaction: groups team (200) and examiners (300); a generated password for root
 *      (reached only through su); accounts demo (1000), alice and bob (1100, 1101; group team) and
 *      examiner1..N (1200.., group examiners), each with /home/<user> 0700 (C5: server-minted);
 *   3. VACUUM (ANALYZE) (DBD-10);
 *   4. prints the generated passwords ONCE, in a block titled FIRST-START CREDENTIALS (shown once).
 * Passwords are 20 random base32 characters, stored only as Argon2id PHC strings (OFF-03); they
 * appear nowhere else: not in the repository, compose.yaml, .env.example or the README.
 * Uids avoid the bench seed's block 1001-1059 (security-model.md §3.6.1).
 * TODO(R2, W8): /home/shared/plan.md, fixtures/tree1000, the evaluation corpus with precomputed
 * vectors and the demo telemetry trace (database.md §3.27) need the blob store and db/seed/vectors.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';

import type { Database } from '../db/client.ts';
import type { DB } from '../db/types.gen.ts';
import { hashPassword } from '../gateway/argon2.ts';
import { createHome } from '../gateway/homes.ts';
import { generatePassword } from '../gateway/tokens.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
export const USERS_GID = 100;
export const TEAM_GID = 200;
export const EXAMINERS_GID = 300;
export const DEMO_MARKER = 'demo';
/** The bench seed's first uid: its users 1001-1059 mark a loaded bench dataset. */
const BENCH_FIRST_UID = 1001;

type SeedKind = 'user' | 'demo' | 'examiner';

export interface SeedAccount {
  readonly uid: number;
  readonly username: string;
  readonly kind: SeedKind;
  readonly quotaBytes: number;
  readonly quotaInodes: number;
  readonly groups: readonly number[];
}

/** The accounts of a fresh stack (provisional quotas until the VFS spec fixes defaults). */
export function demoAccounts(examiners: number): SeedAccount[] {
  const user = (uid: number, username: string, kind: SeedKind, groups: number[]): SeedAccount => ({
    uid,
    username,
    kind,
    quotaBytes: kind === 'demo' ? 256 * MIB : GIB,
    quotaInodes: kind === 'demo' ? 20_000 : 100_000,
    groups,
  });
  return [
    user(1000, DEMO_MARKER, 'demo', []),
    user(1100, 'alice', 'user', [TEAM_GID]),
    user(1101, 'bob', 'user', [TEAM_GID]),
    ...Array.from({ length: examiners }, (_, i) =>
      user(1200 + i, `examiner${i + 1}`, 'examiner', [EXAMINERS_GID]),
    ),
  ];
}

export interface DemoSeedOptions {
  readonly database: Database;
  readonly examiners?: number;
  readonly pepper?: string;
  /** Produces the bench SQL (db/seed/seed.ts --no-vacuum) or null to skip it. */
  readonly benchSql?: () => Promise<string | null>;
  /** Receives the credentials block (the app log). */
  readonly print: (text: string) => void;
  readonly log?: (msg: string) => void;
}

export interface DemoSeedResult {
  readonly seeded: boolean;
  readonly benchLoaded: boolean;
  readonly accounts: readonly string[];
}

export async function runDemoSeed(o: DemoSeedOptions): Promise<DemoSeedResult> {
  const db = o.database.db;
  const log = o.log ?? (() => undefined);
  if (await exists(db, sql`SELECT 1 FROM users WHERE username = ${DEMO_MARKER}`)) {
    log('demo seed: already applied, nothing to do');
    return { seeded: false, benchLoaded: false, accounts: [] };
  }

  let benchLoaded = false;
  if (
    o.benchSql !== undefined &&
    !(await exists(db, sql`SELECT 1 FROM users WHERE uid = ${BENCH_FIRST_UID}`))
  ) {
    const text = await o.benchSql();
    if (text !== null) {
      log('demo seed: loading the bench dataset');
      await o.database.pool.query(text); // one multi-statement script with its own BEGIN/COMMIT
      benchLoaded = true;
    }
  }

  const accounts = demoAccounts(o.examiners ?? 3);
  const hashOpts = o.pepper === undefined ? {} : { pepper: o.pepper };
  const passwords = new Map<string, string>();
  const hashes = new Map<string, string>();
  for (const name of ['root', ...accounts.map((a) => a.username)]) {
    const pw = generatePassword();
    passwords.set(name, pw);
    hashes.set(name, await hashPassword(pw, hashOpts)); // hashed before the transaction opens
  }

  await db.transaction().execute(async (tx) => {
    await sql`INSERT INTO groups (gid, name) VALUES (${TEAM_GID}, 'team'), (${EXAMINERS_GID}, 'examiners')
              ON CONFLICT (gid) DO NOTHING`.execute(tx);
    await sql`UPDATE users SET password_hash = ${hashes.get('root') ?? '!'} WHERE uid = 0`.execute(
      tx,
    );
    for (const a of accounts) await createAccount(tx, a, hashes.get(a.username) ?? '!');
  });
  await o.database.pool.query('VACUUM (ANALYZE)');

  o.print(credentialsBlock(['root', ...accounts.map((a) => a.username)], passwords));
  return { seeded: true, benchLoaded, accounts: accounts.map((a) => a.username) };
}

/** The seed's own accounts (root, demo, alice, bob, examiner1..20), by username. */
const SEEDED_NAMES: readonly string[] = ['root', ...demoAccounts(20).map((a) => a.username)];

export interface ReissueOptions {
  readonly database: Database;
  readonly pepper?: string;
  /** Receives the credentials block (write it to the app log, never to a shared terminal). */
  readonly print: (text: string) => void;
}

/**
 * `seed.ts --reissue-credentials`: new generated passwords for root and the seeded accounts that
 * exist, printed as a fresh credentials block. The first-start block is printed ONCE and lives
 * only in the log of the container that ran the seed, so it is gone after the app container is
 * recreated (every `docker compose up --build`); this is the only way back in. Opt-in and explicit:
 * it invalidates any password saved from the earlier block, bumps password_version and revokes
 * every open auth session of those accounts (like a password change, backend-api.md §3.6.1).
 * Returns the re-issued usernames; none when the demo seed never ran.
 */
export async function reissueDemoCredentials(o: ReissueOptions): Promise<readonly string[]> {
  const db = o.database.db;
  if (!(await exists(db, sql`SELECT 1 FROM users WHERE username = ${DEMO_MARKER}`))) return [];
  const rows = await sql<{ uid: number; username: string }>`
    SELECT uid, username FROM users WHERE username = ANY(${SEEDED_NAMES}::text[]) ORDER BY uid`.execute(
    db,
  );
  const hashOpts = o.pepper === undefined ? {} : { pepper: o.pepper };
  const passwords = new Map<string, string>();
  const hashes = new Map<number, string>();
  for (const r of rows.rows) {
    const pw = generatePassword();
    passwords.set(r.username, pw);
    hashes.set(r.uid, await hashPassword(pw, hashOpts)); // hashed before the transaction opens
  }
  const uids = rows.rows.map((r) => r.uid);
  await db.transaction().execute(async (tx) => {
    for (const [uid, phc] of hashes) {
      await sql`UPDATE users SET password_hash = ${phc}, password_version = password_version + 1
                WHERE uid = ${uid}`.execute(tx);
    }
    await sql`UPDATE auth_sessions SET revoked_at = now()
              WHERE uid = ANY(${uids}::int[]) AND revoked_at IS NULL`.execute(tx);
  });
  const names = rows.rows.map((r) => r.username);
  o.print(
    credentialsBlock(names, passwords, 'RE-ISSUED CREDENTIALS (the earlier ones no longer work)'),
  );
  return names;
}

async function createAccount(tx: Kysely<DB>, a: SeedAccount, phc: string): Promise<void> {
  await sql`
    INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
    VALUES (${a.uid}, ${a.username}, ${a.kind}, ${phc}, ${USERS_GID}, ${a.quotaBytes}, ${a.quotaInodes})`.execute(
    tx,
  );
  for (const gid of a.groups) {
    await sql`INSERT INTO user_groups (uid, gid) VALUES (${a.uid}, ${gid})`.execute(tx);
  }
  await createHome(tx, { uid: a.uid, username: a.username, gid: USERS_GID });
}

async function exists(db: Kysely<DB>, query: RawBuilder<unknown>): Promise<boolean> {
  return (await query.execute(db)).rows.length > 0;
}

export function credentialsBlock(
  names: readonly string[],
  passwords: ReadonlyMap<string, string>,
  title = 'FIRST-START CREDENTIALS (shown once)',
): string {
  const width = Math.max(...names.map((n) => n.length));
  const rule = '='.repeat(78);
  const lines = names.map(
    (n) =>
      `  ${n.padEnd(width)}  ${passwords.get(n) ?? ''}${n === 'root' ? '   (su only: root has no greeter login)' : ''}`,
  );
  return [
    rule,
    `  ${title}`,
    '  Generated for this stack only; stored as Argon2id hashes; printed nowhere else.',
    rule,
    ...lines,
    rule,
    '',
  ].join('\n');
}
