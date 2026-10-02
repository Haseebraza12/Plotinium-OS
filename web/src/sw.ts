/**
 * Plotinium's Service Worker (offline-and-sync.md §3.16, OFF-05, BOOT-09; C11, SYN-14).
 * Hand-written, using only workbox-precaching and workbox-routing, compiled by vite-plugin-pwa in
 * injectManifest mode.
 *
 * - Versioned precache of the shell: `precacheAndRoute(self.__WB_MANIFEST)`; every entry carries a
 *   revision (or a hashed file name), so a new build installs only what changed, and
 *   `cleanupOutdatedCaches()` removes the previous version's caches on activate.
 * - Precache entries are the full network responses, so COOP, COEP, CORP and CSP survive an
 *   offline boot; nothing here builds `new Response(body)`.
 * - `/api/*` and `/ws` are never routed (network-only; a Service Worker never sees WebSocket
 *   traffic). `/models/*` and `/ort/*` are cached at run time on first use, never precached.
 * - No skipWaiting on install and no clients.claim: a new version waits and activates only when
 *   the router posts SKIP_WAITING at reboot ("Restart to update").
 */
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  matchPrecache,
  precacheAndRoute,
} from 'workbox-precaching';
import type { PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

import type { SwVersion } from './sw/routes.ts';
import {
  isIdentityCheck,
  isNetworkOnly,
  isRuntimeCached,
  isSwRequest,
  MODEL_CACHE,
  NAVIGATION_DENYLIST,
} from './sw/routes.ts';

declare const __PLT_VERSION__: string;
declare const __PLT_SHA__: string;
declare const __PLT_DATE__: string;

interface SwScope {
  readonly location: Location;
  readonly caches: CacheStorage;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'message', fn: (ev: ExtendableMessageEvent) => void): void;
}

const sw = self as unknown as SwScope;

const VERSION: SwVersion = {
  version: __PLT_VERSION__,
  build: __PLT_SHA__,
  date: __PLT_DATE__,
};

// 1. The identity check (boot §3.2.2): network first, precached copy when offline.
registerRoute(
  ({ url, request }) =>
    url.origin === sw.location.origin && isIdentityCheck(url.pathname, request.cache),
  async ({ request }) => {
    try {
      return await fetch(request);
    } catch (e) {
      const cached = await matchPrecache('/version.json');
      if (cached !== undefined) return cached;
      throw e;
    }
  },
);

// 2. The versioned shell. The literal `self.__WB_MANIFEST` is the injection point.
precacheAndRoute((self as unknown as { __WB_MANIFEST: (PrecacheEntry | string)[] }).__WB_MANIFEST);
cleanupOutdatedCaches();

// 3. App navigations → the precached index.html (never for /api, /ws, /models, /ort or files).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [...NAVIGATION_DENYLIST],
  }),
);

// 4. Models and the ONNX runtime: cache-first on first use (paths are versioned).
registerRoute(
  ({ url, request }) =>
    url.origin === sw.location.origin &&
    request.method === 'GET' &&
    !isNetworkOnly(url.pathname) &&
    isRuntimeCached(url.pathname),
  async ({ request }) => {
    const cache = await sw.caches.open(MODEL_CACHE);
    const hit = await cache.match(request);
    if (hit !== undefined) return hit;
    const res = await fetch(request);
    // Only complete, same-origin 200s are stored: never a 206 range reply or an error.
    if (res.status === 200 && res.type === 'basic') await cache.put(request, res.clone());
    return res;
  },
);

// 5. Router messages: GET_VERSION (the waiting worker's identity) and SKIP_WAITING (at reboot).
sw.addEventListener('message', (event) => {
  const msg: unknown = event.data;
  if (!isSwRequest(msg)) return;
  if (msg.type === 'SKIP_WAITING') {
    event.waitUntil(sw.skipWaiting());
    return;
  }
  const port = event.ports[0];
  if (port !== undefined) port.postMessage(VERSION);
});
