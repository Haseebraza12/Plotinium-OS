/**
 * Docker Compose for the 0:00–0:05 clean bring-up (spec §17.1; deployment-and-ci §3.6; OPS-05)
 * and for reading the first-start credentials the way the examiner does, from
 * `docker compose logs app` (C10). Passwords are held in memory only; the harness never writes
 * them to a file, a log line or the rehearsal record.
 *
 * Argument vectors are built by pure functions (compose.test.ts); the runner is injected.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';

import { seedUser, type SeedUser, type SeedUsername } from '../../fixtures/users.ts';
import { baseUrl, type Env } from '../../support/env.ts';
import { REPO_ROOT, type RunResult } from '../../support/stack.ts';

import { isLocalStack } from './env.ts';
import {
  parseComposeProjects,
  parseComposeVersion,
  parseCredentials,
  versionAtLeast,
} from './parse.ts';

/** README prerequisite: Docker Compose 2.24 or newer. */
export const MIN_COMPOSE: readonly [number, number, number] = [2, 24, 0];

export interface RunOptions {
  cwd: string;
  env: Env;
  timeoutMs?: number;
}

export type EnvRunner = (
  cmd: string,
  args: readonly string[],
  opts: RunOptions,
) => Promise<RunResult>;

export const envRunner: EnvRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd,
        env: { ...opts.env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 0,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });

/** Environment for every compose call: the caller's, plus the isolated project name if asked. */
export function composeEnv(env: Env = process.env): Env {
  const project = env['PLT_DEMO_PROJECT'];
  return project === undefined || project === ''
    ? { ...env }
    : { ...env, COMPOSE_PROJECT_NAME: project };
}

/** The Compose project the rehearsal uses: `PLT_DEMO_PROJECT`, else compose.yaml's `name:`. */
export function projectName(env: Env = process.env): string {
  const project = env['PLT_DEMO_PROJECT'];
  return project === undefined || project === '' ? 'plotinium' : project;
}

export interface BringupPlan {
  /** What the examiner types, in order (README "Bring-up (three commands)"). */
  commands: string[];
  /** `git clone` argument vector, or null when the working tree is used (not a clean clone). */
  clone: string[] | null;
  /** Directory the compose file is in. */
  cwd: string;
  up: string[];
  /** True only for the scored path: a fresh clone and published images (no `--build`). */
  scored: boolean;
  notes: string[];
}

/**
 * The bring-up for this run. `PLT_BRINGUP_REPO` (+ `PLT_BRINGUP_REF`) makes it a clean clone into
 * `workDir`; without it the working tree is used, which times `up --wait` only.
 * `PLT_BRINGUP_BUILD=1` adds `--build` (images built locally: a developer smoke, never scored).
 */
export function bringupPlan(env: Env, workDir: string): BringupPlan {
  const repo = env['PLT_BRINGUP_REPO'];
  const ref = env['PLT_BRINGUP_REF'];
  const build = env['PLT_BRINGUP_BUILD'] === '1';
  const hasRepo = repo !== undefined && repo !== '';
  const dir = hasRepo ? join(workDir, 'plotinium') : REPO_ROOT;
  const up = ['compose', 'up', '-d', '--wait', ...(build ? ['--build'] : [])];
  const notes: string[] = [];
  if (!hasRepo) notes.push('PLT_BRINGUP_REPO unset: working tree, not a clean clone');
  if (build) notes.push('PLT_BRINGUP_BUILD=1: images built locally, not the scored path');
  return {
    commands: [
      hasRepo ? `git clone ${repo}` : '(working tree)',
      'cd plotinium',
      `docker ${up.join(' ')}`,
    ],
    clone: hasRepo
      ? [
          'clone',
          '--depth',
          '1',
          ...(ref === undefined || ref === '' ? [] : ['--branch', ref]),
          repo,
          dir,
        ]
      : null,
    cwd: dir,
    up,
    scored: hasRepo && !build,
    notes,
  };
}

export interface Compose {
  version(): Promise<[number, number, number] | undefined>;
  projects(): Promise<string[]>;
  /** Volumes labelled with the project: data left over from an earlier run. */
  volumes(): Promise<string[]>;
  up(args: readonly string[], timeoutMs: number): Promise<RunResult>;
  logs(service: 'app' | 'web' | 'db'): Promise<string>;
  down(): Promise<RunResult>;
}

export function compose(
  cwd: string = REPO_ROOT,
  env: Env = process.env,
  runner: EnvRunner = envRunner,
): Compose {
  const opts = (timeoutMs?: number): RunOptions => ({
    cwd,
    env: composeEnv(env),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return {
    version: async () => {
      const r = await runner('docker', ['compose', 'version'], opts(30_000));
      return r.code === 0 ? parseComposeVersion(r.stdout) : undefined;
    },
    projects: async () => {
      const r = await runner(
        'docker',
        ['compose', 'ls', '--all', '--format', 'json'],
        opts(30_000),
      );
      if (r.code !== 0) throw new Error(`docker compose ls failed (${r.code}): ${r.stderr.trim()}`);
      return parseComposeProjects(r.stdout);
    },
    volumes: async () => {
      const r = await runner(
        'docker',
        ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName(env)}`],
        opts(30_000),
      );
      if (r.code !== 0) throw new Error(`docker volume ls failed (${r.code}): ${r.stderr.trim()}`);
      return r.stdout.split('\n').filter((l) => l.trim() !== '');
    },
    up: (args, timeoutMs) => runner('docker', args, opts(timeoutMs)),
    logs: async (service) => {
      const r = await runner('docker', ['compose', 'logs', '--no-color', service], opts(60_000));
      if (r.code !== 0)
        throw new Error(`docker compose logs ${service} failed (${r.code}): ${r.stderr.trim()}`);
      return r.stdout;
    },
    down: () => runner('docker', ['compose', 'down', '-v'], opts(180_000)),
  };
}

export function composeRecentEnough(v: readonly [number, number, number] | undefined): boolean {
  return v !== undefined && versionAtLeast(v, MIN_COMPOSE);
}

/**
 * A seeded account with the password the examiner would use: `PLT_TEST_<USER>_PASSWORD` when set;
 * else, on the local stack, the FIRST-START CREDENTIALS block of `docker compose logs app`; else
 * the CI test-stack value from fixtures/users.ts.
 */
export async function resolveUser(
  name: SeedUsername,
  env: Env,
  readLogs: () => Promise<string>,
): Promise<SeedUser> {
  const user = seedUser(name, env);
  const fromEnv = env[`PLT_TEST_${name.toUpperCase()}_PASSWORD`];
  if (fromEnv !== undefined && fromEnv !== '') return user;
  if (user.kind === 'guest' || !isLocalStack(baseUrl(env))) return user;
  try {
    const password = parseCredentials(await readLogs()).get(name);
    return password === undefined ? user : { ...user, password };
  } catch {
    return user;
  }
}

let logsOnce: Promise<string> | undefined;

/** `docker compose logs app`, read once per worker process. */
export function appLogsOnce(env: Env = process.env): Promise<string> {
  logsOnce ??= compose(REPO_ROOT, env).logs('app');
  return logsOnce;
}

/** Credentials change only when the stack is recreated; the bring-up test calls this after `up`. */
export function forgetLogs(): void {
  logsOnce = undefined;
}

export function demoUser(name: SeedUsername, env: Env = process.env): Promise<SeedUser> {
  return resolveUser(name, env, () => appLogsOnce(env));
}

/** Non-loopback IPv4 addresses of this machine, for OPS-02 (the stack must not answer on them). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
