/**
 * The Service Worker route table (offline-and-sync.md §3.16.1, SYN-14, INV-S9), shared by sw.ts,
 * the injectManifest glob configuration in vite.config.ts and the tests. Plain data and pure
 * predicates: no worker or DOM globals, so Node can import it at build time.
 */

/** `/api/*` and `/ws` always reach the network untouched: never routed, never cached. */
export const NETWORK_ONLY: readonly RegExp[] = [/^\/api(?:\/|$)/, /^\/ws(?:\/|$|\?)/];

/** Navigations fall back to the precached shell, except these (NavigationRoute denylist). */
export const NAVIGATION_DENYLIST: readonly RegExp[] = [
  ...NETWORK_ONLY,
  /^\/models\//,
  /^\/ort\//,
  /\/[^/?]+\.[a-z0-9]+$/i, // a file path, not an app route
];

/**
 * Self-hosted model weights and the ONNX runtime: versioned by path (`/models/<lock-id>/…`,
 * `/ort/<ort-version>/…`), loaded only after desktop-interactive, cached at run time on first
 * use (cache-first), never precached.
 */
export const RUNTIME_CACHED: readonly RegExp[] = [/^\/models\//, /^\/ort\//];

/** Cache Storage name for the runtime-cached model and runtime files. */
export const MODEL_CACHE = 'plotinium-models-v1';

/**
 * Globs (relative to web/dist) that must never enter the precache: the model and runtime trees,
 * the transformers chunk and the embed worker that bundles it, any WebAssembly, source maps and
 * build-side files.
 */
export const NEVER_PRECACHE_GLOBS: readonly string[] = [
  'models/**',
  'ort/**',
  '**/*transformers*',
  '**/*embed.worker*', // the ai.embed worker bundles transformers.js and ORT glue
  '**/ort-*',
  '**/ort.*',
  '**/*.wasm',
  '**/*.map',
  'csp-hashes.json',
  'csp.caddy',
  'boot-budget.json',
];

/** What the precache holds: the versioned shell (OFF-01's offline set). */
export const PRECACHE_GLOBS: readonly string[] = [
  '**/*.{js,mjs,css,html,svg,png,ico,webmanifest,json,woff2}',
];

export const isNetworkOnly = (pathname: string): boolean =>
  NETWORK_ONLY.some((re) => re.test(pathname));

export const isRuntimeCached = (pathname: string): boolean =>
  RUNTIME_CACHED.some((re) => re.test(pathname));

/** A precache manifest entry URL that breaks SYN-14 (used by the build test). */
export function forbiddenInPrecache(url: string): boolean {
  const path = url.startsWith('/') ? url : `/${url}`;
  return (
    isNetworkOnly(path) ||
    isRuntimeCached(path) ||
    /transformers/i.test(path) ||
    /embed\.worker/i.test(path) ||
    /\/ort[-.]/i.test(path) ||
    /\.(?:wasm|map)$/i.test(path)
  );
}

/**
 * `/version.json` fetched with `cache: 'no-store'` is the identity check of boot §3.2.2 (and
 * the update check): it goes to the network first and falls back to the precached copy offline.
 */
export const isIdentityCheck = (pathname: string, cacheMode: string): boolean =>
  pathname === '/version.json' && cacheMode === 'no-store';

/** Messages the page may post to the Service Worker. */
export type SwRequest = { readonly type: 'SKIP_WAITING' } | { readonly type: 'GET_VERSION' };

export interface SwVersion {
  readonly version: string;
  readonly build: string;
  readonly date: string;
}

export function isSwRequest(x: unknown): x is SwRequest {
  if (typeof x !== 'object' || x === null) return false;
  const t = (x as { type?: unknown }).type;
  return t === 'SKIP_WAITING' || t === 'GET_VERSION';
}
