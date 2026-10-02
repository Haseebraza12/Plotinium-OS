# @plotinium/web

The Vite 8 root that turns the packages into the shipped shell: `index.html` (the framework-free boot splash of `@plotinium/ui/boot` and `tokens.css` inlined), `src/main.ts` (starts the boot driver and holds the assembler-owned desktop mount), `src/boot/` (the main-thread boot driver), `src/sw.ts` (hand-written Service Worker, `workbox-precaching` + `workbox-routing`, compiled by `vite-plugin-pwa` in `injectManifest` mode), `vite.config.ts` (build identity, inlining, CSP, budget, dev proxy) and `public/` (identity assets, web manifest, self-hosted `/models` and `/ort`, which are never precached).

| Field              | Value                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary owner      | R5 QA/DevOps (build, boot path, Service Worker, updates)                                                                                                                                                                                                                                                                       |
| Secondary reviewer | R3 WM/UI (boot-ui inlining, main-thread budget)                                                                                                                                                                                                                                                                                |
| Implements         | [deployment-and-ci](../specs/14-devops/deployment-and-ci.md), [boot-and-services](../specs/02-boot/boot-and-services.md), [offline-and-sync §3.16](../specs/06-sync/offline-and-sync.md), [security-model §3.9](../specs/12-security/security-model.md), [identity-and-branding](../specs/00-product/identity-and-branding.md) |
| Requirement IDs    | BOOT-01, BOOT-02, BOOT-05, BOOT-06, BOOT-08, BOOT-09, BOOT-10, BOOT-13, OFF-05, SVC-07, SVC-10, SVC-14, SVC-15, SVC-18, SYN-14, SEC-02, OPS-19                                                                                                                                                                                 |
| May import         | every client package; never `@plotinium/server` or `@plotinium/db`                                                                                                                                                                                                                                                             |

## Commands

```sh
pnpm --filter @plotinium/web dev        # Vite dev server on :5173; /api and /ws proxied to the Docker stack
pnpm --filter @plotinium/web build      # web/dist, plus csp.caddy, boot-budget.json, sw.js
pnpm --filter @plotinium/web preview    # :4173, serves web/dist with the production CSP and COOP/COEP/CORP
pnpm --filter @plotinium/web test       # vitest project `web` (web/tests)
pnpm --filter @plotinium/web typecheck  # src (browser), vite.config + build (Node), tests
```

Dev mode needs only the backend: `docker compose up -d --wait` (Caddy on `127.0.0.1:4717`), then `pnpm --filter @plotinium/web dev` and open http://localhost:5173. The proxy presents the backend's own origin on `/api` and the `/ws` upgrade (SRV-06/07) and answers `502 {"error":"backend unreachable"}` when the stack is down. Overrides: `PLOTINIUM_BACKEND` (proxy target), `PLOTINIUM_BACKEND_ORIGIN`, `PLOTINIUM_DEV_PORT`, `PLOTINIUM_PREVIEW_PORT`. The dev server stretches service timeouts (`__PLT_TIMEOUT_SCALE__ = 20`) and never registers the Service Worker.

## The boot path (`src/boot/`)

`driver.ts` drives the ui/ boot kit from real events only (BOOT-02, SVC-10): the inlined splash paints before any script (BOOT-01); POST (`probe.ts`) shows the unsupported screen on a missing required capability (SVC-14); the kernel bundle is streamed and its decoded bytes move the bar; after that only the router's `boot.target`, `svc.event` and `asset.done` events move it. `Esc` (buffered from the first inline script), `?boot=menu`, the kernel's `bootFlags.menuNextBoot` (Settings, `reboot --menu`), the local next-boot flag and two failed boots open the boot menu (`flags.ts`, SVC-07; 5 s countdown in `timers.ts`). `V` and `?boot=verbose` toggle the verbose log fed by klog batches (BOOT-05). A cycle or a failed critical service shows the kernel panic screen (BOOT-04, BOOT-08); Recovery boots end on the recovery console (`recovery-console.ts`); 15 s without a boot event shows the stall screen (SVC-18); a second tab gets the takeover screen (ARC-02). Diagnostics (`diagnostics.ts`) work on every failure screen, without IndexedDB. Both workers the router creates go through one Trusted Types policy (`trusted.ts`).

### Shell hooks (`ShellHooks`, implemented in `main.ts`'s desktop-mount section)

| Hook                             | When                                     | Contract                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attachCompositor(port, ctx)`    | stage 2, before any service starts       | `port` is the compositor's end of the wm channel; the kernel has the other end, and the `wm` service is done once it is attached. Create the compositor here.               |
| `mountLogin(root, ctx)` optional | the `login` service entered `starting`   | show the login view in `#plt-desktop`; call `ctx.userWait('begin')` when input-ready (hands the screen over, pauses the stall watchdog) and `ctx.userWait('end')` on submit |
| `mountDesktop(root, ctx)`        | the `desktop` service entered `starting` | mount the shell into `#plt-desktop`, then resolve; the driver marks `desktop-interactive` on the next input-ready frame and fades the splash                                |

`BootContext` gives the shell: `identity`, `profile()`, `services` (a feed of every service and its state, for the tray's degraded badges and the Task Manager), `progress`, `update` (Service Worker state for the `offline-ready` and `restart-to-update` tray badges), `kernel.post` / `kernel.onMessage` (system messages such as `login.*`), `userWait`, `handOver`, `reboot(next)` (SKIP_WAITING, then reload), `setMenuNextBoot` / `menuNextBoot` (local fallback of `boot.menuNextBoot`) and `testHooks` (`window.__plt` sources, test builds only).

### Program registry (switch on once `@plotinium/apps` builds)

`src/kernel.worker.ts` currently boots the kernel with its defaults (no programs, the kernel's own executor bundle). The composed form, verified to compile against the current kernel API but blocked by the half-wired app views (`@plotinium/ui/apps/*` not exported yet):

```ts
// web/src/kernel.worker.ts
import { AI_MANIFESTS } from '@plotinium/ai/programs';
import { programManifests } from '@plotinium/apps';
import { startKernelWorker } from '@plotinium/kernel/host/worker';
declare const __AI__: boolean;
startKernelWorker({
  programs: [...programManifests({ ai: __AI__ }), ...(__AI__ ? AI_MANIFESTS : [])],
  executorFactory: (index) =>
    new Worker(new URL('./executor.worker.ts', import.meta.url), {
      type: 'module',
      name: `executor-${String(index)}`,
    }),
});

// web/src/executor.worker.ts
import { AI_PROGRAM_LOADERS } from '@plotinium/ai/programs';
import { programModules } from '@plotinium/apps';
import type { ProgramLoaders } from '@plotinium/kernel/sys';
import { startExecutor } from '@plotinium/kernel/runtime/executor-entry';
declare const __AI__: boolean;
const loaders: ProgramLoaders = {
  ...programModules({ ai: __AI__ }),
  ...(__AI__ ? AI_PROGRAM_LOADERS : {}),
};
startExecutor({ loaders });
```

`vite.config.ts` already runs vite-plugin-solid in the worker pipeline, because the registry references the app views lazily.

## Build outputs besides the bundle

- `version.json`: the build identity (identity-and-branding.md §4.2); `boot-manifest.json` and the inlined `window.__PLT_BOOT_MANIFEST__`: decoded sizes of the boot assets (SVC-15).
- `csp.caddy`: the single `header Content-Security-Policy "…"` line with the SHA-256 of every inline `<script>` and `<style>` of the FINAL `index.html` (SEC-02). The Dockerfile moves it to `/etc/caddy/csp.caddy`, which the Caddyfile imports; `vite preview` sends the same policy. `csp-hashes.json` lists the same sources.
- `boot-budget.json`: boot-critical main-thread JS (inline scripts + entry chunk + its static imports) in gzip bytes. Over 60 KB fails the build, over 55 KB warns (BOOT-10, C13).
- `sw.js`: precaches the versioned shell only (never `/api`, `/ws`, `/models`, `/ort`, the transformers chunk, `.wasm` or source maps; SYN-14); `/models` and `/ort` are cache-first at run time; registered after `desktop-interactive` plus idle; a new version waits and activates at reboot (SKIP_WAITING, OFF-05); offline reloads boot from the precache (BOOT-09).

## Identity

`public/` holds copies of `docs/identity` (favicon, app and maskable icons, PNG icons, `manifest.webmanifest`, wallpapers); `index.html` links the favicon, the manifest and the light/dark `theme-color`.
