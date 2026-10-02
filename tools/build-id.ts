/**
 * The build identity of an image built without git (UI-008; identity-and-branding.md §5).
 *
 * The Docker build context has no `.git`, so the web build and the server could only say
 * `0000000` / `unknown`. This script gives both tiers ONE identity:
 *
 *   BUILD_SHA          7 lower-case hex digits: `git rev-parse --short=7 HEAD` when the working
 *                      tree is a clean git checkout; otherwise (no git, or uncommitted changes) the
 *                      first 7 hex digits of a SHA-256 over the source tree (the paths and bytes of
 *                      every file the images are built from, sorted; see `sourceFiles`), so the same
 *                      source always gives the same id on any machine
 *   BUILD_VERSION      `<package.json version>-dev.<commits since the last v* tag>` (`-dev.0` without
 *                      git); exactly the tag's version when HEAD is a release tag
 *   BUILD_DATE         YYYY-MM-DD, the UTC day of SOURCE_DATE_EPOCH
 *   SOURCE_DATE_EPOCH  a given BUILD_DATE; else the commit time of a clean git checkout; else the
 *                      newest modification time of the hashed files (seconds)
 *
 * A valid value already in the environment wins (a release pipeline passes its own).
 *
 *   node tools/build-id.ts                  print the four KEY=value lines
 *   node tools/build-id.ts -- <cmd> [args]  run <cmd> with them in its environment (`pnpm start`)
 *
 * The Dockerfile's `buildid` stage runs the same script inside the build when no BUILD_SHA was
 * passed (a plain `docker compose up --build`), so every build path gets a real id.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Top-level files the images are built from. */
export const HASHED_ROOT_FILES: readonly string[] = [
  '.npmrc',
  'Caddyfile',
  'Dockerfile',
  'compose.yaml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
];

/** Top-level directories the images are built from (the workspace packages and ops/). */
export const HASHED_DIRS: readonly string[] = [
  'ai',
  'apps',
  'db',
  'dsa',
  'kernel',
  'ops',
  'protocol',
  'server',
  'services',
  'ui',
  'vfs',
  'web',
  'wm',
];

/** Directories never hashed at any depth: installed or generated, never source. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.vite',
  'blob-report',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

/** Files never hashed: logs, local secrets, editor and compiler droppings. */
function skippedFile(name: string): boolean {
  return (
    name.startsWith('.env') ||
    name === '.DS_Store' ||
    name.endsWith('.log') ||
    name.endsWith('.tsbuildinfo')
  );
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
/** `YYYY-MM-DD`, or a full ISO 8601 UTC time (the release pipeline passes one). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)?$/;
const EPOCH_RE = /^\d{1,12}$/;

/** Every hashed file under `root`, as sorted POSIX paths relative to it. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        if (!SKIPPED_DIRS.has(ent.name)) walk(path);
      } else if (ent.isFile() && !skippedFile(ent.name)) out.push(path);
      // Symbolic links and special files are not part of the source.
    }
  };
  for (const f of HASHED_ROOT_FILES) {
    try {
      if (lstatSync(join(root, f)).isFile()) out.push(f);
    } catch {
      // A missing top-level file is simply not hashed.
    }
  }
  for (const d of HASHED_DIRS) {
    try {
      if (lstatSync(join(root, d)).isDirectory()) walk(d);
    } catch {
      // A missing package directory is simply not hashed.
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** SHA-256 (hex) over `path NUL size NUL bytes NUL` of each file, in the given order. */
export function contentHash(root: string, files: readonly string[]): string {
  const h = createHash('sha256');
  for (const f of files) {
    const bytes = readFileSync(join(root, f));
    h.update(`${f}\0${String(bytes.length)}\0`);
    h.update(bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

/** The newest modification time of `files`, in whole seconds (0 for none). */
export function newestMtime(root: string, files: readonly string[]): number {
  let newest = 0;
  for (const f of files) newest = Math.max(newest, lstatSync(join(root, f)).mtimeMs);
  return Math.floor(newest / 1_000);
}

export interface GitFacts {
  /** `git rev-parse --short=7 HEAD`. */
  readonly sha: string;
  /** Uncommitted changes in the working tree. */
  readonly dirty: boolean;
  /** Commit time of HEAD (seconds). */
  readonly epoch: number;
  /** `git describe --tags --long --match "v*"`, or null without a tag. */
  readonly describe: string | null;
}

function git(root: string, args: readonly string[]): string | null {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.error === undefined && r.status === 0 ? r.stdout.trim() : null;
}

/** What git says about `root`, or null when it is not a git checkout (or git is missing). */
export function gitFacts(root: string): GitFacts | null {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const sha = git(root, ['rev-parse', '--short=7', 'HEAD']);
  if (sha === null || !SHA_RE.test(sha)) return null;
  return {
    sha,
    dirty: (git(root, ['status', '--porcelain']) ?? '') !== '',
    epoch: Number(git(root, ['log', '-1', '--format=%ct']) ?? '0'),
    describe: git(root, ['describe', '--tags', '--long', '--match', 'v*']),
  };
}

export interface BuildId {
  readonly BUILD_SHA: string;
  readonly BUILD_VERSION: string;
  readonly BUILD_DATE: string;
  readonly SOURCE_DATE_EPOCH: string;
}

export interface Inputs {
  /** package.json `version`. */
  readonly pkgVersion: string;
  readonly git: GitFacts | null;
  /** The source-tree hash (hex) and its newest mtime (seconds), computed only when needed. */
  readonly tree: () => { readonly hash: string; readonly newest: number };
  /** The environment: valid values win. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The version a build of this tree carries (see the module comment). */
export function versionOf(pkgVersion: string, g: GitFacts | null): string {
  const described = g?.describe ?? null;
  const m = described === null ? null : /^v(.+)-(\d+)-g[0-9a-f]+$/.exec(described);
  const tagged = m?.[1];
  const since = m?.[2] ?? '0';
  if (since === '0' && g?.dirty === false && tagged !== undefined && VERSION_RE.test(tagged))
    return tagged;
  return `${pkgVersion}-dev.${since}`;
}

export function resolveBuildId(i: Inputs): BuildId {
  const envSha = i.env['BUILD_SHA']?.toLowerCase();
  const envVersion = i.env['BUILD_VERSION'];
  const envEpoch = i.env['SOURCE_DATE_EPOCH'];
  const envDate = i.env['BUILD_DATE'];
  let tree: { hash: string; newest: number } | null = null;
  const treeOnce = (): { hash: string; newest: number } => (tree ??= i.tree());

  const sha =
    envSha !== undefined && SHA_RE.test(envSha)
      ? envSha.slice(0, 7)
      : i.git !== null && !i.git.dirty
        ? i.git.sha
        : treeOnce().hash.slice(0, 7);
  const version =
    envVersion !== undefined && VERSION_RE.test(envVersion)
      ? envVersion
      : versionOf(i.pkgVersion, i.git);
  // One instant for both tiers: the date is always the UTC day of the epoch.
  const givenDate = envDate !== undefined && DATE_RE.test(envDate) ? Date.parse(envDate) : NaN;
  const epoch =
    envEpoch !== undefined && EPOCH_RE.test(envEpoch)
      ? Number(envEpoch)
      : Number.isFinite(givenDate)
        ? Math.floor(givenDate / 1_000)
        : i.git !== null && !i.git.dirty && i.git.epoch > 0
          ? i.git.epoch
          : treeOnce().newest;
  const date = new Date(epoch * 1_000).toISOString().slice(0, 10);
  return {
    BUILD_SHA: sha,
    BUILD_VERSION: version,
    BUILD_DATE: date,
    SOURCE_DATE_EPOCH: String(epoch),
  };
}

/** The `KEY=value` lines (values are hex, semver, dates and digits: safe for `sh .`). */
export function envLines(id: BuildId): string {
  return `${Object.entries(id)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
}

export function buildIdOf(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): BuildId {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  return resolveBuildId({
    pkgVersion: pkg.version,
    git: gitFacts(root),
    env,
    tree: () => {
      const files = sourceFiles(root);
      return { hash: contentHash(root, files), newest: newestMtime(root, files) };
    },
  });
}

function main(argv: readonly string[]): number {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const id = buildIdOf(root, process.env);
  const sep = argv.indexOf('--');
  if (sep === -1) {
    process.stdout.write(envLines(id));
    return 0;
  }
  const [cmd, ...args] = argv.slice(sep + 1);
  if (cmd === undefined) {
    process.stderr.write('build-id: no command after --\n');
    return 2;
  }
  process.stderr.write(
    `build-id: ${id.BUILD_VERSION} · build ${id.BUILD_SHA} · ${id.BUILD_DATE}\n`,
  );
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...id } });
  if (r.error !== undefined) {
    process.stderr.write(`build-id: cannot run ${cmd}: ${r.error.message}\n`);
    return 127;
  }
  return r.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
