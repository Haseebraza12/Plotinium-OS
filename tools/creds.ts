/**
 * `pnpm creds`: print the first-start credentials from the app container's log.
 *
 * The seed generates every user password at the first start of a fresh database and prints them
 * ONCE, to stdout, in the FIRST-START CREDENTIALS block (server/src/seed/demo.ts, SRV-20). They
 * are stored nowhere else (OPS-03), so this script only reads `docker compose logs app` and
 * prints that block. The app's JSON log lines (stderr) can interleave with the block; they are
 * dropped.
 *
 * Docker keeps a container's log only as long as the container exists. `pnpm start` (`up --build`)
 * and `pnpm dev` replace the app container when its image or configuration changed, and the seed
 * does not print again for an existing database, so the block can be gone. The script then says
 * so and exits 1; the login screen's Guest session needs no password.
 *
 *   pnpm creds                     node tools/creds.ts
 *   PLOTINIUM_PROJECT=name pnpm creds    another Compose project (default: compose.yaml's `name`)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TITLE = 'FIRST-START CREDENTIALS';

/** A rule line of the block: `=` repeated (78 wide today; any width of 20 or more counts). */
const RULE = /^={20,}\s*$/;

/**
 * The LAST credentials block in `log` (a later block belongs to a newer database), without the
 * interleaved JSON log lines, or null when the log has none. The block is:
 * rule, title, note, rule, one line per user, rule.
 */
export function extractCredentialsBlock(log: string): string | null {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    // JSON log records from the seed and the server (pino, stderr) are not part of the block.
    .filter((line) => !line.trimStart().startsWith('{'));
  const titleAt = lines.findLastIndex((line) => line.includes(TITLE));
  if (titleAt < 1 || !RULE.test(lines[titleAt - 1] ?? '')) return null;
  // The rule under the note, then the rule that closes the user lines.
  const header = lines.findIndex((line, i) => i > titleAt && RULE.test(line));
  if (header === -1) return null;
  const footer = lines.findIndex((line, i) => i > header && RULE.test(line));
  if (footer === -1 || footer === header + 1) return null;
  return lines.slice(titleAt - 1, footer + 1).join('\n');
}

export const NOT_FOUND = [
  `No ${TITLE} block in the app container's log.`,
  '',
  'The seed prints the generated passwords once, when the app starts on a fresh database, and',
  'Docker drops a container log when the container is replaced (for example by `pnpm start`',
  'after a rebuild, or by `pnpm dev`). The accounts and passwords still exist in the database.',
  '',
  '  - Use Guest on the login screen: it needs no password.',
  '  - To generate new passwords, reset the stack. This DELETES every file and account:',
  '      docker compose down -v && pnpm start && pnpm creds',
].join('\n');

/** The `docker` argv that prints the app container's log (without colours or name prefixes). */
export function logsCommand(project: string | undefined): string[] {
  return [
    'compose',
    ...(project === undefined || project === '' ? [] : ['--project-name', project]),
    'logs',
    '--no-color',
    '--no-log-prefix',
    'app',
  ];
}

export type CredentialsRead =
  | { readonly ok: true; readonly block: string | null }
  | { readonly ok: false; readonly error: string };

/** Read the app container's log and extract the credentials block (tools/dev.ts uses it too). */
export function readCredentials(repoRoot: string, project: string | undefined): CredentialsRead {
  const args = logsCommand(project);
  const result = spawnSync('docker', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return { ok: false, error: `cannot run docker: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `\`docker ${args.join(' ')}\` failed (is the stack up? try \`pnpm start\`)\n${result.stderr}`,
    };
  }
  return { ok: true, block: extractCredentialsBlock(result.stdout) };
}

function main(): number {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const read = readCredentials(repoRoot, process.env['PLOTINIUM_PROJECT']);
  if (!read.ok) {
    process.stderr.write(`pnpm creds: ${read.error}\n`);
    return 2;
  }
  if (read.block === null) {
    process.stderr.write(`${NOT_FOUND}\n`);
    return 1;
  }
  const port = process.env['PLOTINIUM_PORT'] ?? '4717';
  process.stdout.write(`${read.block}\nSign in at http://localhost:${port}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
