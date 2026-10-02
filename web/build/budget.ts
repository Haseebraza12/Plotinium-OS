/**
 * The boot-critical budget (C13, BOOT-10; boot-and-services.md §7, ui-implementation-guide.md
 * §3.8.6): main-thread JavaScript needed before desktop-interactive is at most 60 KB gzip, with a
 * warning from 55 KB. Measured on the FINAL index.html and bundle at build time:
 *
 *   - every inline `<script>` of index.html (the key buffer and the boot manifest);
 *   - the entry chunk that index.html loads as `<script type="module" src>`;
 *   - that chunk's static imports, transitively (dynamic imports are lazy by construction: the
 *     desktop shell, the recovery console and every app view load after the boot decision).
 *
 * The inlined boot CSS is reported next to it (DSN-10 tracks the inline set) but is not JS.
 * Worker bundles (kernel, executor) run off the main thread and have their own budget.
 * Runs on Node at build time only.
 */
import { gzipSync } from 'node:zlib';

export const KIB = 1_024;
/** BOOT-10 hard gate. */
export const BOOT_CRITICAL_LIMIT = 60 * KIB;
/** Risk-register warning threshold (implementation-plan R4). */
export const BOOT_CRITICAL_WARN = 55 * KIB;

/** The part of a Rollup output chunk the budget reads. */
export interface ChunkLike {
  readonly fileName: string;
  readonly code: string;
  readonly imports: readonly string[];
}

export interface BudgetFile {
  readonly file: string;
  readonly bytes: number;
  readonly gzip: number;
}

export interface BootBudget {
  /** Main-thread JS files counted, entry first. */
  readonly files: readonly BudgetFile[];
  /** All inline scripts of index.html, gzipped together. */
  readonly inlineScripts: BudgetFile;
  /** All inline styles of index.html, gzipped together (reported, not counted as JS). */
  readonly inlineStyles: BudgetFile;
  /** Σ gzip of `files` plus `inlineScripts`. */
  readonly jsGzip: number;
  /** The whole index.html gzipped (what the first request costs). */
  readonly htmlGzip: number;
  readonly limit: number;
  readonly warn: number;
  readonly status: 'ok' | 'warn' | 'fail';
}

const gz = (s: string): number => gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).byteLength;

const INLINE = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const ENTRY =
  /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']\/?([^"']+)["'][^>]*>/i;

/** The module script index.html loads (`assets/index-<hash>.js`), or null. */
export function entryOf(html: string): string | null {
  return ENTRY.exec(html)?.[1] ?? null;
}

/** Measure the boot-critical main-thread JS of a build. */
export function bootBudget(html: string, chunks: Readonly<Record<string, ChunkLike>>): BootBudget {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(INLINE)) {
    const [, tag = '', attrs = '', body = ''] = m;
    if (tag.toLowerCase() === 'style') styles.push(body);
    else if (!/\bsrc\s*=/i.test(attrs)) scripts.push(body);
  }
  const files: BudgetFile[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = chunks[name];
    if (chunk === undefined) return;
    files.push({
      file: chunk.fileName,
      bytes: Buffer.byteLength(chunk.code),
      gzip: gz(chunk.code),
    });
    for (const dep of chunk.imports) visit(dep);
  };
  const entry = entryOf(html);
  if (entry !== null) visit(entry);
  const inlineJs = scripts.join('\n');
  const inlineCss = styles.join('\n');
  const inlineScripts: BudgetFile = {
    file: 'index.html <script>',
    bytes: Buffer.byteLength(inlineJs),
    gzip: inlineJs === '' ? 0 : gz(inlineJs),
  };
  const inlineStyles: BudgetFile = {
    file: 'index.html <style>',
    bytes: Buffer.byteLength(inlineCss),
    gzip: inlineCss === '' ? 0 : gz(inlineCss),
  };
  const jsGzip = files.reduce((n, f) => n + f.gzip, 0) + inlineScripts.gzip;
  return {
    files,
    inlineScripts,
    inlineStyles,
    jsGzip,
    htmlGzip: gz(html),
    limit: BOOT_CRITICAL_LIMIT,
    warn: BOOT_CRITICAL_WARN,
    status: jsGzip > BOOT_CRITICAL_LIMIT ? 'fail' : jsGzip > BOOT_CRITICAL_WARN ? 'warn' : 'ok',
  };
}

const kb = (n: number): string => `${(n / KIB).toFixed(2)} KB`;

/** One line for the build log. */
export function budgetLine(b: BootBudget): string {
  const parts = [
    ...b.files.map((f) => `${f.file} ${kb(f.gzip)}`),
    `inline ${kb(b.inlineScripts.gzip)}`,
  ];
  return `boot-critical main-thread JS ${kb(b.jsGzip)} gzip of ${kb(b.limit)} (${b.status}): ${parts.join(' + ')}; inline CSS ${kb(b.inlineStyles.gzip)}; index.html ${kb(b.htmlGzip)} gzip`;
}
