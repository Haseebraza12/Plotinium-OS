/**
 * Seeded accounts used by the e2e, a11y and fault suites. The uids follow db/seed (root 0, users
 * from 1000, primary group `users` = 100). Passwords are test-only values for the local and CI
 * Compose stacks, which the seed reads from the same variables; they are not secrets and never
 * work on production (the production profile does not seed these accounts).
 */
import type { Env } from '../support/env.ts';

export type SeedUsername = 'root' | 'alice' | 'bob' | 'demo' | 'guest';

export interface SeedUser {
  username: SeedUsername;
  uid: number;
  gid: number;
  kind: 'root' | 'user' | 'demo' | 'guest';
  /** Undefined for the guest tile, which needs no password. */
  password: string | undefined;
}

const USERS: ReadonlyArray<Omit<SeedUser, 'password'> & { envVar?: string; fallback?: string }> = [
  {
    username: 'root',
    uid: 0,
    gid: 0,
    kind: 'root',
    envVar: 'PLT_TEST_ROOT_PASSWORD',
    fallback: 'root-test-only',
  },
  {
    username: 'alice',
    uid: 1000,
    gid: 100,
    kind: 'user',
    envVar: 'PLT_TEST_ALICE_PASSWORD',
    fallback: 'alice-test-only',
  },
  {
    username: 'bob',
    uid: 1001,
    gid: 100,
    kind: 'user',
    envVar: 'PLT_TEST_BOB_PASSWORD',
    fallback: 'bob-test-only',
  },
  {
    username: 'demo',
    uid: 1002,
    gid: 100,
    kind: 'demo',
    envVar: 'PLT_TEST_DEMO_PASSWORD',
    fallback: 'demo-test-only',
  },
  { username: 'guest', uid: 65534, gid: 65534, kind: 'guest' },
];

export function seedUser(username: SeedUsername, env: Env = process.env): SeedUser {
  const row = USERS.find((u) => u.username === username);
  if (row === undefined) throw new RangeError(`unknown seed user ${username}`);
  const { envVar, fallback, ...user } = row;
  return { ...user, password: envVar === undefined ? undefined : (env[envVar] ?? fallback) };
}

export function allSeedUsers(env: Env = process.env): SeedUser[] {
  return USERS.map((u) => seedUser(u.username, env));
}

/** The shared file of the VFS-09 contention scenario (E5); group-writable by `users`. */
export const SHARED_PLAN = '/home/shared/plan.md';
