/**
 * Vitest 5 configuration for the whole monorepo (C14, spec §15.3).
 *
 * Projects: one project per workspace package, `property` for the cross-package fast-check
 * suites in tests/property, and `tools` for the repository tooling. The `browser` (real Chrome
 * channel), `integration` (Compose Postgres, also running tests/fault-injection), `bench` and
 * `ai-eval` projects from C14 are added by the PR that lands their first suite; until then the
 * harness, integration and fault-injection suites run from tests/vitest.config.ts. See
 * specs/13-quality/testing-and-performance.md.
 *
 *   pnpm test                     every project
 *   pnpm test:coverage            every project with v8 coverage and the gates below
 *   pnpm --filter @plotinium/vfs test    one package (runs `vitest run --root .. --project vfs`)
 *   pnpm exec vitest run --project dsa --coverage    one package WITH its coverage (see below)
 *   pnpm bench                    `*.bench.ts` micro-benchmarks
 *
 * Test titles MUST begin with the requirement ID (C18); `pnpm traceability` reads them.
 *
 * WHY EVERY PROJECT IS ROOTED AT THE REPOSITORY (the "0/0 files" coverage bug, blocker (e)).
 * Coverage matches `coverage.include` against paths relative to the coverage roots. Vitest 5
 * uses the config root for a full run, but when `--project` narrows the run it switches to the
 * ROOTS OF THE SELECTED PROJECTS. With a project rooted at `dsa/`, `dsa/src/heap/index.ts`
 * became `src/heap/index.ts`, no `dsa/src/**` glob matched it, and every `--project … --coverage`
 * run reported `Unknown% (0/0)`. (The space in "Plotinium OS" is not the cause: Vitest decodes the
 * file URLs before matching.) So every project keeps the repository as its `root` and points
 * `dir` at its package instead: test discovery is per package, coverage paths are always
 * repository-relative, and the include globs and per-package thresholds below mean the same
 * thing in a full run and in a filtered one.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { PluginOption } from 'vite';
import { defineConfig } from 'vitest/config';
import type { TestProjectInlineConfiguration } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('./', import.meta.url));

/** Workspace packages with a project, in the order Vitest lists them. */
const PACKAGES = [
  'protocol',
  'dsa',
  'kernel',
  'vfs',
  'services',
  'wm',
  'apps',
  'ai',
  'server',
  'db',
  'ui',
  'web',
] as const;
type PackageName = (typeof PACKAGES)[number];

/**
 * Packages that contain Solid components (.tsx). Their projects compile JSX with
 * vite-plugin-solid, and uncovered .tsx files are remapped through them for the coverage report.
 */
const SOLID_PACKAGES: readonly PackageName[] = ['wm', 'apps', 'ui', 'web'];

const TEST_FILES = ['**/*.{test,spec}.{ts,tsx}'];
const NEVER = ['**/node_modules/**', '**/dist/**', '**/coverage/**'];

// ---------------------------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------------------------

const env = process.env;

/**
 * Default per-test timeout. Vitest's 5 s default is sized for one package on an idle machine; a
 * full `pnpm test:coverage` runs about 260 files on every core with v8 instrumentation on, and
 * the heavier tests then pass 5 s without failing an assertion. The slowest outside the property
 * projects is apps/shell SHL-04 (a fixed 10,000-run fast-check property, so PLT_PROP_RUNS does not
 * scale it): 10.8 s in a full parallel `pnpm test` and 22.2 s in a full `pnpm test:coverage` on the
 * shared dev machine (2026-09-26). 60 s keeps about 2.7x headroom where 30 s had 1.35x. Hooks
 * keep 30 s: no hook has timed out. A timeout only bounds a hang; tests still must not wait on
 * wall-clock time (testing-and-performance.md §3.13).
 */
const TEST_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 30_000;

/**
 * fast-check runs per property: dsa/ uses PLT_PROP_RUNS (1,000 on pull requests, 10,000 nightly;
 * dsa/tests/helpers.ts), tests/property uses PLT_FC_PROFILE=deep for 10,000 nightly.
 */
const PROPERTY_RUNS = Math.max(
  Number(env['PLT_PROP_RUNS'] ?? 1_000) || 1_000,
  env['PLT_FC_PROFILE'] === 'deep' ? 10_000 : 0,
);

/**
 * Property suites scale with their run count: 30 ms per run, never below 60 s, so 60 s on pull
 * requests and 300 s nightly. Measured on the dev machine (12 threads, shared with other build
 * agents; re-measure on the lab machine), the slowest dsa properties (lru, heap, trie, zorder)
 * take 1.4-2.7 s at 1,000 runs alone, 4-6 s when the dsa project runs in parallel (so Vitest's
 * 5 s default failed them), 6-14.4 s inside a full `pnpm test` run (lru 14.4 s, ringbuffer 8.8 s,
 * heap 8.5 s, trie 7.3 s), 7.8-16.1 s inside a full `pnpm test:coverage` run (lru 16.1 s, heap
 * 10.5 s, ringbuffer 9.2 s, trie 9.0 s, zorder 8.0 s, tree 7.8 s; 2026-09-26), and 26-44 s at
 * 10,000 runs in parallel: at least 3.7x headroom at 1,000 runs and 2x at 10,000.
 * dsa/tests/helpers.ts exports the same value as PROP_TIMEOUT_MS for a per-test override.
 *
 * An explicit per-test timeout beats this one. Three dsa suites set their own, lower ones:
 * tree.prop (max(5 s, 20 ms/run): 20 s at 1,000 runs, 2.6x over 7.8 s), lru.prop (max(30 s,
 * 20 ms/run): 30 s, 1.9x over 16.1 s) and ringbuffer.prop (10 s + 30 ms/run: 40 s, 4.3x). They
 * should pass PROP_TIMEOUT_MS from the helpers instead.
 */
const PROPERTY_TIMEOUT_MS = Math.max(60_000, 30 * PROPERTY_RUNS);

/** Projects whose tests are mostly fast-check properties get the scaled timeout. */
const PROPERTY_HEAVY: readonly PackageName[] = ['dsa'];

// ---------------------------------------------------------------------------------------------
// Solid (JSX) support
// ---------------------------------------------------------------------------------------------

/** The part of vite-plugin-solid's factory these projects use. */
type SolidPluginFactory = (options?: {
  dev?: boolean;
  hot?: boolean;
  ssr?: boolean;
}) => PluginOption;

/**
 * vite-plugin-solid is a devDependency of ui/ and web/, not of the root, and pnpm does not hoist
 * (`hoist: false`), so it is resolved from ui/ exactly as ui/vitest.config.ts resolves it.
 * TODO(R5): add `vite-plugin-solid: catalog:` to the root devDependencies and import it directly.
 */
const solid = createRequire(`${repoRoot}ui/package.json`)(
  'vite-plugin-solid',
) as SolidPluginFactory;

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

function packageProject(name: PackageName): TestProjectInlineConfiguration {
  const base = {
    name,
    // The repository stays the root (see the header); `dir` scopes test discovery to the package.
    root: repoRoot,
    dir: `${repoRoot}${name}`,
    include: TEST_FILES,
    exclude: NEVER,
    environment: 'node',
    ...(PROPERTY_HEAVY.includes(name) ? { testTimeout: PROPERTY_TIMEOUT_MS } : {}),
  } as const;

  if (!SOLID_PACKAGES.includes(name)) return { extends: true, test: base };

  return {
    extends: true,
    // No HMR in tests: solid-refresh's virtual module would import solid-js from the repository
    // root, where pnpm (hoist: false) does not install it.
    plugins: [solid({ hot: false })],
    // happy-dom tests resolve solid-js to its browser build (Vite's client environment).
    resolve: { conditions: ['development', 'browser'] },
    test: {
      ...base,
      // lucide-solid ships raw .jsx under the `solid` condition; compile it with the tests.
      server: { deps: { inline: [/lucide-solid/] } },
      ...(name === 'ui'
        ? {
            // ui/ holds presentational Solid components, tested in a DOM. These three settings
            // mirror ui/vitest.config.ts, the package-local config the ui team runs.
            environment: 'happy-dom',
            setupFiles: [`${repoRoot}ui/src/primitives/internal/test-setup.ts`],
            // Let `?raw` CSS imports through (the token tests read tokens.css and *.module.css).
            css: { include: [/\.css\?raw$/] },
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

/**
 * Source globs per package (testing-and-performance.md §3.5, TST-03). Coverage counts every file
 * these match, loaded by a test or not, so the percentages are over all source files.
 * ui/gallery (the dev-only component gallery) and tests/ helpers are not product code.
 */
const SOURCES: Readonly<Record<PackageName, readonly string[]>> = {
  protocol: ['protocol/src/**/*.ts'],
  dsa: ['dsa/src/**/*.ts'],
  kernel: ['kernel/src/**/*.ts'],
  vfs: ['vfs/src/**/*.ts'],
  services: ['services/src/**/*.ts'],
  wm: ['wm/src/**/*.{ts,tsx}'],
  apps: ['apps/**/*.{ts,tsx}'],
  ai: ['ai/src/**/*.ts'],
  server: ['server/src/**/*.ts'],
  db: ['db/src/**/*.ts', 'db/seed/**/*.ts'],
  ui: ['ui/src/**/*.{ts,tsx}'],
  web: ['web/src/**/*.{ts,tsx}'],
};

/**
 * The `--project` filters of this run (`--project dsa`, `--project=dsa`, wildcards and `!name`
 * as Vitest accepts them). A filtered run measures only the selected packages, so that
 * `vitest run --project dsa --coverage` reports dsa/ alone and the overall gate is not failed by
 * the packages it did not run.
 */
function selectedPackages(argv: readonly string[]): readonly PackageName[] {
  const filters: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === '--project') filters.push(argv[index + 1] ?? '');
    else if (arg.startsWith('--project=')) filters.push(arg.slice('--project='.length));
  });
  if (filters.length === 0) return PACKAGES;
  const toRegExp = (glob: string): RegExp =>
    new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const positive = filters.filter((f) => !f.startsWith('!')).map(toRegExp);
  const negative = filters.filter((f) => f.startsWith('!')).map((f) => toRegExp(f.slice(1)));
  const selected = PACKAGES.filter(
    (name) =>
      (positive.length === 0 || positive.some((re) => re.test(name))) &&
      !negative.some((re) => re.test(name)),
  );
  // Only `property` or `tools` selected: they measure no package of their own, so keep all.
  return selected.length > 0 ? selected : PACKAGES;
}

const MEASURED = selectedPackages(process.argv);

/**
 * Coverage gates (spec §15.3; engineering_process.md §9):
 *   - at least 70% of lines overall;
 *   - at least 85% of lines on dsa/, vfs/ and kernel/.
 *
 * The gates are switched on by a one-way RATCHET (TST-03):
 *   1. The PR that merges a package's first real code adds that package to GATED_PACKAGES.
 *      From then on its own gate applies (85% for dsa, vfs and kernel; 70% for the others).
 *      The gate is never removed again ("no tests later").
 *   2. The overall 70% gate switches on automatically as soon as GATED_PACKAGES is non-empty. It
 *      counts every included file, gated or not.
 *   3. dsa/ joined when its structures flipped IMPLEMENTED to true (C16).
 *
 * Lines measured by `pnpm test:coverage` on the dev machine on 2026-09-26 (third pass of the W5
 * integration wave), without DATABASE_URL as in CI (so the database-backed `*.int.test.ts` server
 * suites were skipped); overall 85.1% (41,297 / 48,508 lines), 3,401 tests passing:
 *
 *   gated      protocol 99.7, dsa 96.7, vfs 96.8, db 91.0, ui 90.3, apps 88.5, ai 84.9,
 *              wm 83.7, services 78.3, server 75.7
 *   not yet    kernel 78.2 (gate 85): proc/system (45%), window/service (32%), io/index and
 *                io/complete, the net and proc syscall tables, and the executor and worker entry
 *                points are under-tested
 *              web 33.9: boot flags, probe and timers and the SW routes are tested; the boot
 *                driver, main.ts and the desktop mount are not
 *
 * apps/ is measured without seven half-wired files (the views of about, editor, files, settings,
 * taskmgr and terminal, and terminal/confirm.ts) that no project can transform until
 * @plotinium/ui exports `./apps/*`: Vitest prints "Failed to parse … Excluding it from coverage"
 * for each. Counted as fully uncovered they would still leave apps above 75%.
 *
 * kernel/ and web/ join GATED_PACKAGES in the PR whose tests lift them over their gates. server/,
 * ai/, services/ and wm/ joined in this wave (earlier the same day they measured 69.8, 59.3, 54.0
 * and 24.2): from now on new code there needs its tests in the same PR, and new server routes
 * need tests that run without DATABASE_URL. Nothing gated on main has been removed.
 */
const GATED_PACKAGES: readonly PackageName[] = [
  'protocol',
  'dsa',
  'vfs',
  'apps',
  'db',
  'ui',
  'server',
  'ai',
  'services',
  'wm',
];
const CORE_PACKAGES: readonly PackageName[] = ['dsa', 'vfs', 'kernel'];
const OVERALL_LINES = 70;
const CORE_LINES = 85;
const PACKAGE_LINES = 70;

const packageThresholds = Object.fromEntries(
  GATED_PACKAGES.filter((name) => MEASURED.includes(name)).map((name) => [
    `${name}/**`,
    { lines: CORE_PACKAGES.includes(name) ? CORE_LINES : PACKAGE_LINES },
  ]),
);

export default defineConfig({
  test: {
    // Empty projects (for example a package with no tests yet) must not fail the run.
    passWithNoTests: true,
    environment: 'node',
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    projects: [
      ...PACKAGES.map(packageProject),
      {
        // Cross-package fast-check suites (spec §15.3 property-based row). Pure, so they run on
        // every pull request with the package projects.
        extends: true,
        test: {
          name: 'property',
          root: repoRoot,
          dir: `${repoRoot}tests/property`,
          include: TEST_FILES,
          exclude: NEVER,
          environment: 'node',
          testTimeout: PROPERTY_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: 'tools',
          root: repoRoot,
          dir: `${repoRoot}tools`,
          include: TEST_FILES,
          exclude: [...NEVER, 'eslint-rules/fixtures/**'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // Print the numbers even when a test fails (the run still fails): otherwise one red test
      // hides every package's coverage, and the ratchet below cannot be checked.
      reportOnFailure: true,
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      include: MEASURED.flatMap((name) => SOURCES[name]),
      exclude: [
        ...NEVER,
        '**/*.{test,spec,bench}.{ts,tsx}',
        '**/tests/**',
        '**/*.d.ts',
        '**/*.gen.ts',
        '**/fixtures/**',
        '**/vite.config.ts',
        '**/vitest.config.ts',
        'ai/eval/**',
        'db/migrations/**',
        'docs/**',
      ],
      thresholds: {
        ...(GATED_PACKAGES.length > 0 ? { lines: OVERALL_LINES } : {}),
        ...packageThresholds,
      },
    },
  },
});
