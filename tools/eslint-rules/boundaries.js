// @ts-check
/**
 * Package boundaries as ESLint flat-config objects (architecture.md §3.7, ARC-01; SYS-01 for apps).
 *
 *   protocol/            imports nothing but valibot
 *   dsa/                 imports only @plotinium/protocol types
 *   tests and benchmarks of protocol/ and dsa/ may also import vitest, fast-check and node:
 *                        built-ins, and may use Node globals (memory benchmarks need --expose-gc)
 *   vfs/src/{path,perm}  isomorphic: sibling modules and @plotinium/protocol types only, no DOM/Node
 *   kernel/src/core      uses no self, document, Worker or indexedDB (host bindings live in host/)
 *   wm/                  @plotinium/protocol, @plotinium/dsa, @plotinium/kernel/sys and @plotinium/ui;
 *                        never apps/ (web composes the apps registry into the wm/shell desktop)
 *   wm compositor/boot-ui framework-free: no Solid, lucide, xterm or CodeMirror
 *   ui/                  presentational Solid components: @plotinium/protocol types only; no storage,
 *                        worker or network globals (views get data from apps/ and wm/)
 *   apps/*               @plotinium/protocol, @plotinium/kernel/sys and @plotinium/ui ONLY; no storage, worker or
 *                        network globals
 *   ai/*                 @plotinium/protocol, @plotinium/dsa, @plotinium/kernel/hooks
 *   server/              @plotinium/protocol, @plotinium/dsa, @plotinium/vfs/path, @plotinium/vfs/perm,
 *                        and database types
 *   docs/evidence/pilot  imported by nothing (local/no-relative-import-outside-package)
 *
 * ESLint does not merge the options of one rule across config objects: the LAST matching object
 * wins. So every object below carries the complete pattern list for its files, and the narrower
 * scopes (kernel/src/core, vfs isomorphic files, wm framework-free folders) come after their
 * package and repeat the package patterns.
 *
 * Every restriction has a failing fixture in ./fixtures, exercised by boundaries.test.ts.
 */
import tseslint from 'typescript-eslint';

const TS_FILES = '{ts,tsx,mts,cts}';

/** @param {string} dir */
const filesIn = (dir) => [`${dir}/**/*.${TS_FILES}`];

/** Test, benchmark and measurement files: they may use test tooling and Node. */
export const TEST_FILES = [
  `**/*.{test,spec,bench}.${TS_FILES}`,
  '**/*.mem.ts',
  `**/tests/**/*.${TS_FILES}`,
  `**/bench/**/*.${TS_FILES}`,
  '**/_shared/mem.ts',
];

/** Files imported by BOTH the kernel worker and the Node server. */
export const ISOMORPHIC_FILES = ['vfs/src/path.ts', 'vfs/src/perm.ts'];

/**
 * @typedef {{ regex: string, message: string, allowTypeImports?: boolean }} Pattern
 * @typedef {{ name: string, message: string }} RestrictedGlobal
 * @typedef {{ object: string, property: string, message: string }} RestrictedProperty
 */

/**
 * @param {string[]} names
 * @param {string} message
 * @returns {Pattern}
 */
function forbidPackages(names, message) {
  return { regex: `^@plotinium/(${names.join('|')})(/|$)`, message };
}

/**
 * @param {string[]} names
 * @param {string} message
 * @returns {RestrictedGlobal[]}
 */
function globalsList(names, message) {
  return names.map((name) => ({ name, message }));
}

// ---------------------------------------------------------------------------------------------
// Import patterns
// ---------------------------------------------------------------------------------------------

/** @type {Pattern} */
const PROTOCOL_TYPES_ONLY = {
  regex: '^@plotinium/protocol(/|$)',
  allowTypeImports: true,
  message: 'Only `import type` from @plotinium/protocol is allowed here (architecture.md §3.7).',
};

/** @type {Pattern[]} */
const PROTOCOL_IMPORTS = [
  {
    regex: '^(?!valibot(/|$))(?!\\.{1,2}/)',
    message:
      'protocol/ is pure: it may import valibot and its own modules only (architecture.md §3.7).',
  },
];

/** @type {Pattern[]} */
const DSA_IMPORTS = [
  {
    regex: '^(?!@plotinium/protocol(/|$))(?!\\.{1,2}/)',
    message:
      'dsa/ is written from first principles and may import only @plotinium/protocol types (spec §10.2, C16).',
  },
  PROTOCOL_TYPES_ONLY,
];

/** @type {Pattern[]} */
const PROTOCOL_TEST_IMPORTS = [
  {
    regex: '^(?!valibot(/|$)|vitest(/|$)|fast-check$|node:)(?!\\.{1,2}/)',
    message:
      'protocol/ tests may import protocol modules, valibot, vitest, fast-check and node: built-ins only.',
  },
];

/** @type {Pattern[]} */
const DSA_TEST_IMPORTS = [
  {
    regex: '^(?!@plotinium/protocol(/|$)|vitest(/|$)|fast-check$|node:)(?!\\.{1,2}/)',
    message:
      'dsa/ tests and benchmarks may import dsa modules, @plotinium/protocol, vitest, fast-check and node: built-ins only: no package may stand in for a structure, not even as a test oracle (spec §10.2).',
  },
];

/** @type {Pattern[]} */
const KERNEL_IMPORTS = [
  forbidPackages(
    ['wm', 'apps', 'ai', 'server', 'db', 'web'],
    'The kernel may import protocol, dsa, vfs and services only. AI reaches the kernel through the no-op hooks in @plotinium/kernel/hooks, so the litmus build still works (C12).',
  ),
];

/** @type {Pattern[]} */
const KERNEL_CORE_IMPORTS = [
  ...KERNEL_IMPORTS,
  {
    regex: '^(\\.\\./)+host(/|$)',
    message:
      'kernel/src/core must not import host bindings; the host injects them (architecture.md §3.7).',
  },
];

/** @type {Pattern[]} */
const VFS_IMPORTS = [
  forbidPackages(
    ['kernel', 'services', 'wm', 'apps', 'ai', 'server', 'db', 'web'],
    'vfs/ may import protocol, dsa and idb only; the kernel imports the VFS, not the other way round.',
  ),
];

const isomorphicSiblings = ISOMORPHIC_FILES.map((file) => file.split('/').pop() ?? '')
  .map((base) => base.replace('.', '\\.'))
  .join('|');

/** @type {Pattern[]} */
const ISOMORPHIC_IMPORTS = [
  {
    regex: `^(?!@plotinium/protocol(/|$))(?!\\./(${isomorphicSiblings})$)`,
    message:
      'vfs/src/path.ts and vfs/src/perm.ts run in the kernel AND on the server: they may import only each other and @plotinium/protocol types (boundary B3).',
  },
  PROTOCOL_TYPES_ONLY,
];

/** @type {Pattern[]} */
const SERVICES_IMPORTS = [
  forbidPackages(
    ['kernel', 'vfs', 'wm', 'apps', 'ai', 'server', 'db', 'web'],
    'services/ may import protocol and dsa only (the kernel imports the service manager).',
  ),
];

/** @type {Pattern[]} */
const WM_IMPORTS = [
  forbidPackages(
    ['vfs', 'services', 'apps', 'ai', 'server', 'db', 'web'],
    'wm/ may import protocol, dsa, @plotinium/ui and the sys client only; web composes the apps registry into the desktop (ARC-01).',
  ),
  {
    regex: '^@plotinium/kernel(?!/sys$)(/|$)',
    message: 'wm/ may use the kernel only through @plotinium/kernel/sys.',
  },
];

/** @type {Pattern[]} */
const FRAMEWORK_FREE_IMPORTS = [
  ...WM_IMPORTS,
  {
    regex: '^(solid-js|lucide-solid)(/|$)|^@(xterm|codemirror)/',
    message:
      'wm/src/compositor and wm/src/boot-ui are framework-free: the compositor is the sole writer of geometry and boot-ui is inlined before any framework loads (C11).',
  },
];

/** @type {Pattern[]} */
const APPS_IMPORTS = [
  {
    regex: '^@plotinium/(?!protocol(/|$)|kernel/sys$|ui(/|$))',
    message:
      'Apps reach the OS only through system calls: they may import @plotinium/protocol, @plotinium/kernel/sys and the presentational @plotinium/ui, nothing else from Plotinium (SYS-01).',
  },
];

/** @type {Pattern[]} */
const UI_IMPORTS = [
  {
    regex: '^@plotinium/(?!protocol(/|$))',
    message:
      'ui/ is a presentational component library: it may import @plotinium/protocol types only and receives all data through props (SYS-01).',
  },
  PROTOCOL_TYPES_ONLY,
];

/** @type {Pattern[]} */
const AI_IMPORTS = [
  {
    regex: '^@plotinium/(?!protocol(/|$)|dsa(/|$)|kernel/hooks$)',
    message:
      'ai/ may import protocol, dsa and @plotinium/kernel/hooks only; it acts on the OS through typed system calls (C12).',
  },
];

/** @type {Pattern[]} */
const SERVER_IMPORTS = [
  {
    regex: '^@plotinium/(?!protocol(/|$)|dsa(/|$)|vfs/(path|perm)$|db(/|$))',
    message:
      'server/ may import protocol, dsa, @plotinium/vfs/path, @plotinium/vfs/perm and db types only (architecture.md §3.7).',
  },
];

/** @type {Pattern[]} */
const DB_IMPORTS = [
  forbidPackages(
    ['kernel', 'vfs', 'services', 'wm', 'apps', 'ai', 'web'],
    'db/ is server-side: it must not import client packages.',
  ),
];

/** @type {Pattern[]} */
const WEB_IMPORTS = [
  forbidPackages(
    ['server', 'db'],
    'The client bundle must never include server or database code (and the LLM key lives only on the server).',
  ),
];

// ---------------------------------------------------------------------------------------------
// Globals and properties
// ---------------------------------------------------------------------------------------------

const PURE_GLOBALS = globalsList(
  [
    'window',
    'self',
    'document',
    'navigator',
    'location',
    'indexedDB',
    'caches',
    'localStorage',
    'sessionStorage',
    'Worker',
    'SharedWorker',
    'importScripts',
    'postMessage',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'process',
    'Buffer',
    'setImmediate',
    'require',
    'module',
    '__dirname',
    '__filename',
    'global',
  ],
  'This module must run unchanged in the browser, in workers and on Node: no DOM, worker or Node globals.',
);

const KERNEL_CORE_GLOBALS = globalsList(
  [
    'self',
    'window',
    'document',
    'navigator',
    'location',
    'Worker',
    'SharedWorker',
    'indexedDB',
    'caches',
    'localStorage',
    'sessionStorage',
    'importScripts',
    'postMessage',
  ],
  'kernel/src/core is host-independent: platform objects are injected by kernel/src/host (architecture.md §3.7).',
);

const APPS_GLOBALS = globalsList(
  [
    'indexedDB',
    'caches',
    'localStorage',
    'sessionStorage',
    'Worker',
    'SharedWorker',
    'importScripts',
    'BroadcastChannel',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
  ],
  'Apps may not touch storage, workers or the network directly; use a system call (SYS-01). The executor runtime shadows these at run time as well.',
);

/** @type {RestrictedProperty[]} */
const APPS_PROPERTIES = [
  ...['storage', 'locks', 'serviceWorker'].map((property) => ({
    object: 'navigator',
    property,
    message: `Apps may not use navigator.${property}; use a system call (SYS-01).`,
  })),
  ...['window', 'self', 'globalThis'].flatMap((object) =>
    ['indexedDB', 'caches', 'localStorage', 'sessionStorage', 'Worker', 'fetch'].map(
      (property) => ({
        object,
        property,
        message: `Apps may not use ${object}.${property}; use a system call (SYS-01).`,
      }),
    ),
  ),
];

// ---------------------------------------------------------------------------------------------
// Config objects (order matters: narrower scopes last)
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {string[]} files
 * @param {Pattern[]} patterns
 * @param {{ globals?: RestrictedGlobal[], properties?: RestrictedProperty[], ignores?: string[] }} [extra]
 * @returns {import('eslint').Linter.Config}
 */
function scope(name, files, patterns, extra = {}) {
  /** @type {import('eslint').Linter.RulesRecord} */
  const rules = {
    '@typescript-eslint/no-restricted-imports': ['error', { patterns }],
  };
  if (extra.globals) rules['no-restricted-globals'] = ['error', ...extra.globals];
  if (extra.properties) rules['no-restricted-properties'] = ['error', ...extra.properties];
  return {
    name: `plotinium/boundaries/${name}`,
    files,
    ...(extra.ignores ? { ignores: extra.ignores } : {}),
    plugins: { '@typescript-eslint': /** @type {any} */ (tseslint.plugin) },
    rules,
  };
}

/** @type {import('eslint').Linter.Config[]} */
export const boundaryConfigs = [
  scope('protocol', filesIn('protocol'), PROTOCOL_IMPORTS, {
    globals: PURE_GLOBALS,
    ignores: TEST_FILES,
  }),
  scope(
    'protocol-tests',
    TEST_FILES.map((glob) => `protocol/${glob}`),
    PROTOCOL_TEST_IMPORTS,
  ),
  scope('dsa', filesIn('dsa'), DSA_IMPORTS, { globals: PURE_GLOBALS, ignores: TEST_FILES }),
  scope(
    'dsa-tests',
    TEST_FILES.map((glob) => `dsa/${glob}`),
    DSA_TEST_IMPORTS,
  ),
  scope('kernel', filesIn('kernel'), KERNEL_IMPORTS),
  scope('kernel-core', filesIn('kernel/src/core'), KERNEL_CORE_IMPORTS, {
    globals: KERNEL_CORE_GLOBALS,
  }),
  scope('vfs', filesIn('vfs'), VFS_IMPORTS),
  scope('vfs-isomorphic', ISOMORPHIC_FILES, ISOMORPHIC_IMPORTS, { globals: PURE_GLOBALS }),
  scope('services', filesIn('services'), SERVICES_IMPORTS),
  scope('wm', filesIn('wm'), WM_IMPORTS),
  scope(
    'wm-framework-free',
    [...filesIn('wm/src/compositor'), ...filesIn('wm/src/boot-ui')],
    FRAMEWORK_FREE_IMPORTS,
  ),
  scope('apps', filesIn('apps'), APPS_IMPORTS, {
    globals: APPS_GLOBALS,
    properties: APPS_PROPERTIES,
  }),
  scope('ui', filesIn('ui'), UI_IMPORTS, {
    globals: APPS_GLOBALS,
    properties: APPS_PROPERTIES,
    ignores: TEST_FILES,
  }),
  scope('ai', filesIn('ai'), AI_IMPORTS),
  scope('server', filesIn('server'), SERVER_IMPORTS),
  scope('db', filesIn('db'), DB_IMPORTS),
  scope('web', filesIn('web'), WEB_IMPORTS),
];
