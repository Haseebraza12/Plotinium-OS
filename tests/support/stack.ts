/**
 * Compose stack control for the offline gate test (spec §3.3 `stack.stop` / `stack.start`, TST-12).
 *
 * The gate variant of OFF-01 stops the server containers instead of calling `setOffline`, because
 * `setOffline` leaves WebSockets open (spec §6.3). The runner is injected so the command lines are
 * unit-tested without Docker.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Env } from './env.ts';

export type ComposeService = 'db' | 'app' | 'web';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: readonly string[], cwd: string) => Promise<RunResult>;

export interface StackOptions {
  /** Compose files, first to last; `PLT_COMPOSE_FILES` (comma-separated) overrides. */
  files: readonly string[];
  /** Directory holding the compose files: the repository root. */
  cwd: string;
  runner: Runner;
  /** Longest wait for health on start, in seconds (`--wait-timeout`). */
  waitTimeoutS: number;
}

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const execRunner: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });

export function stackOptions(
  env: Env = process.env,
  overrides: Partial<StackOptions> = {},
): StackOptions {
  const files = env['PLT_COMPOSE_FILES'];
  return {
    files:
      files === undefined || files === ''
        ? ['compose.yaml']
        : files.split(',').map((f) => f.trim()),
    cwd: REPO_ROOT,
    runner: execRunner,
    waitTimeoutS: 180,
    ...overrides,
  };
}

/** `docker compose -f … <verb> …` argument vector. */
export function composeArgs(
  opts: Pick<StackOptions, 'files' | 'waitTimeoutS'>,
  action: 'stop' | 'start',
  services: readonly ComposeService[],
): string[] {
  if (services.length === 0) throw new RangeError('stack control needs at least one service');
  const files = opts.files.flatMap((f) => ['-f', f]);
  // `up --wait --no-recreate` restarts the stopped containers and waits for their health checks,
  // which a bare `docker compose start` does not do.
  const verb =
    action === 'stop'
      ? ['stop']
      : [
          'up',
          '-d',
          '--wait',
          '--no-build',
          '--no-recreate',
          '--wait-timeout',
          String(opts.waitTimeoutS),
        ];
  return ['compose', ...files, ...verb, ...services];
}

async function compose(
  opts: StackOptions,
  action: 'stop' | 'start',
  services: readonly ComposeService[],
): Promise<void> {
  const res = await opts.runner('docker', composeArgs(opts, action, services), opts.cwd);
  if (res.code !== 0) {
    throw new Error(
      `docker compose ${action} ${services.join(' ')} failed (${res.code}): ${res.stderr.trim()}`,
    );
  }
}

export interface Stack {
  stop(services: readonly ComposeService[]): Promise<void>;
  start(services: readonly ComposeService[]): Promise<void>;
}

export function stack(opts: StackOptions = stackOptions()): Stack {
  return {
    stop: (services) => compose(opts, 'stop', services),
    start: (services) => compose(opts, 'start', services),
  };
}

export type Fetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * TST-12: the offline gate test must fail if the backend still answers. Resolves when
 * `/api/readyz` is unreachable or not OK; throws when it answers OK.
 */
export async function assertBackendDown(
  baseUrl: string,
  fetchImpl: Fetch,
  timeoutMs = 3000,
): Promise<void> {
  let answered: number | null = null;
  try {
    const res = await fetchImpl(new URL('/api/readyz', baseUrl).href, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) answered = res.status;
  } catch {
    // Connection refused, reset or timed out: the backend is down, which is what we want.
    return;
  }
  if (answered !== null) {
    throw new Error(
      `backend still reachable at ${baseUrl} (readyz ${answered}): the offline gate would be void`,
    );
  }
}
