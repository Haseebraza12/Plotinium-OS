/**
 * `pnpm dev`: the backend (db and app) in Docker plus the web Vite dev server with its proxy.
 *
 *   1. Starts the backend: `docker compose -f compose.yaml -f tools/compose.dev.yaml
 *      up -d --wait --build db app`. The override publishes the app's port 3000 on
 *      127.0.0.1:$PLOTINIUM_API_PORT (default 4780) for the proxy. The `web` (Caddy) container is
 *      neither needed nor touched: if `pnpm start` left it running, http://localhost:4717 keeps
 *      serving the last built shell next to the dev server.
 *   2. Runs `pnpm --filter @plotinium/web dev` (Vite on http://localhost:$PLOTINIUM_DEV_PORT,
 *      default 5173) with the variables web/vite.config.ts reads:
 *        PLOTINIUM_BACKEND         http://127.0.0.1:<api port>, the target of /api and /ws (ws: true)
 *        PLOTINIUM_BACKEND_ORIGIN  http://localhost:<PLOTINIUM_PORT, default 4717>, the APP_ORIGIN the
 *                                  server checks (SRV-07); the proxy presents it as Origin
 *        PLOTINIUM_DEV_PORT        the dev server's port
 *
 * The app container prints the generated passwords once, on the first start of a fresh database,
 * and Docker drops a container's log when the container is replaced (step 1 replaces it when the
 * image or the port mapping changed, for example after `pnpm start`). So before step 1 this
 * script prints any credentials block still in the current app log.
 *
 * Ctrl-C stops Vite and leaves the backend running: `pnpm logs` follows it, `pnpm stop` stops it.
 *
 *   pnpm dev                    everything above
 *   pnpm dev --skip-backend     only step 2 (the backend is already up)
 *   pnpm dev --no-build         step 1 without --build (reuse the images you have)
 *   PLOTINIUM_PROJECT=name      another Compose project (default: compose.yaml's `name`)
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readCredentials } from './creds.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const OVERRIDE = 'tools/compose.dev.yaml';

type Env = Readonly<Record<string, string | undefined>>;

export interface DevOptions {
  readonly skipBackend: boolean;
  readonly build: boolean;
  /** Loopback port the app is published on (PLOTINIUM_API_PORT, default 4780). */
  readonly apiPort: number;
  /** The Vite dev server's port (PLOTINIUM_DEV_PORT, default 5173). */
  readonly devPort: number;
  /** PLOTINIUM_PORT (default 4717): the server's APP_ORIGIN port and Caddy's published port. */
  readonly appPort: number;
  /** PLOTINIUM_PROJECT: a Compose project name, or undefined for compose.yaml's `name`. */
  readonly project: string | undefined;
}

/** Parse argv and the environment; throws on an unknown flag, a bad port or a port clash. */
export function parseDevOptions(argv: readonly string[], env: Env): DevOptions {
  const known = new Set(['--skip-backend', '--no-build']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(' ')}`);
  const port = (name: string, fallback: number): number => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`${name} must be a TCP port, got ${String(raw)}`);
    }
    return value;
  };
  const project = env['PLOTINIUM_PROJECT'];
  const options: DevOptions = {
    skipBackend: argv.includes('--skip-backend'),
    build: !argv.includes('--no-build'),
    apiPort: port('PLOTINIUM_API_PORT', 4780),
    devPort: port('PLOTINIUM_DEV_PORT', 5173),
    appPort: port('PLOTINIUM_PORT', 4717),
    project: project === undefined || project === '' ? undefined : project,
  };
  const ports: [string, number][] = [
    ['PLOTINIUM_API_PORT', options.apiPort],
    ['PLOTINIUM_DEV_PORT', options.devPort],
    ['PLOTINIUM_PORT', options.appPort],
  ];
  for (const [i, [a, x]] of ports.entries()) {
    for (const [b, y] of ports.slice(i + 1)) {
      if (x === y) throw new Error(`${a} and ${b} must differ (both ${x})`);
    }
  }
  return options;
}

/** The `docker` argv that starts the backend (step 1). */
export function backendCommand(options: DevOptions): string[] {
  return [
    'compose',
    ...(options.project === undefined ? [] : ['--project-name', options.project]),
    '-f',
    'compose.yaml',
    '-f',
    OVERRIDE,
    'up',
    '-d',
    '--wait',
    ...(options.build ? ['--build'] : []),
    'db',
    'app',
  ];
}

/** The environment of the Vite dev server (step 2): the caller's plus what vite.config.ts reads. */
export function viteEnv(options: DevOptions, env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  out['PLOTINIUM_BACKEND'] = `http://127.0.0.1:${options.apiPort}`;
  out['PLOTINIUM_BACKEND_ORIGIN'] = `http://localhost:${options.appPort}`;
  out['PLOTINIUM_DEV_PORT'] = String(options.devPort);
  return out;
}

function main(): Promise<number> {
  let options: DevOptions;
  try {
    options = parseDevOptions(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`pnpm dev: ${(error as Error).message}\n`);
    return Promise.resolve(64);
  }

  if (!options.skipBackend) {
    // Save the one-time passwords before `up` can replace the container that logged them.
    const creds = readCredentials(repoRoot, options.project);
    if (creds.ok && creds.block !== null) {
      process.stdout.write(
        `${creds.block}\n(from the current app container's log; \`pnpm dev\` may replace it)\n`,
      );
    }
    const args = backendCommand(options);
    process.stdout.write(`\n$ docker ${args.join(' ')}\n`);
    const result = spawnSync('docker', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, PLOTINIUM_API_PORT: String(options.apiPort) },
    });
    if (result.error !== undefined) {
      process.stderr.write(`pnpm dev: cannot run docker: ${result.error.message}\n`);
      return Promise.resolve(1);
    }
    if (result.status !== 0) {
      process.stderr.write(
        `pnpm dev: the backend did not become healthy (exit ${String(result.status)}); see \`pnpm logs\`\n`,
      );
      return Promise.resolve(1);
    }
  }

  process.stdout.write(
    `\nBackend: http://127.0.0.1:${options.apiPort} (proxied as /api and /ws, Origin http://localhost:${options.appPort})\n` +
      `Shell:   http://localhost:${options.devPort} (Vite dev server)\n` +
      'Ctrl-C stops Vite; the backend keeps running (`pnpm stop` stops it, `pnpm creds` prints the first-start passwords).\n\n',
  );

  return new Promise((resolve) => {
    // Its own process group, so a signal reaches pnpm AND the Vite process pnpm starts: killing
    // only pnpm would leave Vite holding the port.
    const vite = spawn('pnpm', ['--filter', '@plotinium/web', 'dev'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: viteEnv(options, process.env),
      detached: true,
    });
    let stopping = false;
    const forward = (signal: NodeJS.Signals): void => {
      stopping = true;
      try {
        if (vite.pid !== undefined) process.kill(-vite.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    process.on('SIGHUP', forward);
    vite.on('error', (error) => {
      process.stderr.write(`pnpm dev: cannot start Vite: ${error.message}\n`);
      resolve(1);
    });
    vite.on('exit', (code) => {
      resolve(stopping ? 0 : (code ?? 1));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
