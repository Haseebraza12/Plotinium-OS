/**
 * Bundle budgets (C13; engineering_process.md §5). STUB: it measures, it does not gate yet.
 *
 * Budgets, both hard gates from Week 5:
 *   - boot-critical main-thread JavaScript ≤ 60 KB gzip (BOOT-10);
 *   - kernel worker bundle ≤ 100 KB gzip (re-baselined at W7 with a decision record).
 *
 * Today this script gzips every JavaScript file under web/dist and prints the sizes. It exits 0
 * when there is no build yet. The owner (R5) finishes it when web/ produces its first build:
 *   TODO(R5, W5): read web/dist/.vite/manifest.json, classify chunks (boot-critical main thread:
 *   the entry chunk plus its static imports; kernel worker: kernel.worker.ts and its static
 *   imports), sum each class and exit 1 when a class exceeds its budget. Then call it from ci.yml.
 *
 * Usage: pnpm bundle-budget [--dist web/dist]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIB = 1024;

export const BUDGETS_GZIP_BYTES = {
  bootCriticalMainThread: 60 * KIB,
  kernelWorker: 100 * KIB,
} as const;

function jsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main(): void {
  const { values } = parseArgs({ options: { dist: { type: 'string', default: 'web/dist' } } });
  const dist = path.resolve(REPO_ROOT, values.dist);
  if (!existsSync(dist)) {
    process.stdout.write(
      `bundle-budget: ${path.relative(REPO_ROOT, dist)} does not exist yet; nothing to measure.\n`,
    );
    return;
  }
  const rows = jsFiles(dist)
    .map((file) => ({
      file: path.relative(dist, file),
      gzip: gzipSync(readFileSync(file), { level: 9 }).byteLength,
    }))
    .sort((a, b) => b.gzip - a.gzip);
  let total = 0;
  for (const row of rows) {
    total += row.gzip;
    process.stdout.write(`${(row.gzip / KIB).toFixed(1).padStart(8)} KB gz  ${row.file}\n`);
  }
  process.stdout.write(
    `${(total / KIB).toFixed(1).padStart(8)} KB gz  total (${rows.length} files)\n`,
  );
  process.stdout.write(
    `Budgets: boot-critical main thread ≤ ${BUDGETS_GZIP_BYTES.bootCriticalMainThread / KIB} KB gz, ` +
      `kernel worker ≤ ${BUDGETS_GZIP_BYTES.kernelWorker / KIB} KB gz (not enforced yet; see TODO).\n`,
  );
}

main();
