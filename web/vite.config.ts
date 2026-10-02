/**
 * Vite 8 config for the Plotinium shell (deployment-and-ci.md; boot-and-services.md §3.2 stage 1,
 * §5.5 SVC-15; identity-and-branding.md §4.1, §5; offline-and-sync.md §3.16).
 *
 * - Build identity computed once per build and injected everywhere with `define`
 *   (`__PLT_IDENTITY__` plus name, version, sha and date), and emitted as `/version.json`.
 * - index.html gets the framework-free boot splash inlined (tokens.css + ui boot.css + the splash
 *   markup from @plotinium/ui/boot), so the first paint needs no script (BOOT-01).
 * - The boot manifest (decoded size of the kernel bundle) is inlined so progress is truthful
 *   (BOOT-02) and emitted as `/boot-manifest.json` (SVC-15).
 * - The CSP for the FINAL index.html (hashes of every inline script and style) is emitted as
 *   `csp-hashes.json` and `csp.caddy` (imported by the Caddyfile in the image), and sent by
 *   `vite preview`, so a local preview is as strict as production.
 * - The boot-critical main-thread JS (inline scripts + entry chunk + its static imports) is
 *   measured on the final output and written to `boot-budget.json`; over 60 KB gzip fails the
 *   build, over 55 KB warns (BOOT-10, C13).
 * - The Service Worker (src/sw.ts) is compiled by vite-plugin-pwa in injectManifest mode; the
 *   precache is the versioned shell, never /api, /ws, /models, /ort or the transformers chunk.
 * - Dev and preview: COOP/COEP/CORP so `crossOriginIsolated` holds locally (ARC-03), and a proxy
 *   for /api and /ws to the Docker stack (http://127.0.0.1:4717 by default; PLOTINIUM_BACKEND or
 *   its alias PLOTINIUM_API_TARGET overrides it).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Plugin, ProxyOptions } from 'vite';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import solid from 'vite-plugin-solid';

// The ai.embed worker bundle (ai/README.md "Bundling"): transformers imports onnxruntime-common
// without declaring it, and onnxruntime-web must use its extern-WASM build (/ort/<version>/).
// eslint-disable-next-line local/no-relative-import-outside-package -- build-time helper of ai/
import { ORT_EXTERN_WASM_CONDITION, onnxruntimeCommonAlias } from '../ai/scripts/vite-ort.ts';
import type { ChunkLike } from './build/budget.ts';
import { bootBudget, budgetLine } from './build/budget.ts';
import { caddySnippet, cspFor, cspHeaders, inlineHashes } from './build/csp.ts';
import { ortPublicModules } from './build/ort-dev.ts';
// Comments and whitespace out of the inlined boot CSS, keeping descendant combinators (UI-013).
import { compactCss } from './src/boot/compact-css.ts';
import { forbiddenInPrecache, NEVER_PRECACHE_GLOBS, PRECACHE_GLOBS } from './src/sw/routes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

interface BuildIdentity {
  name: 'Plotinium';
  version: string;
  build: string;
  buildDate: string;
  codename: string | null;
  abi: number;
}

function git(args: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const CODENAMES: Readonly<Record<string, string>> = {
  '0.2': 'Monoclinic',
  '0.3': 'Orthorhombic',
  '0.4': 'Tetragonal',
  '1.0': 'Cubic',
};

/**
 * identity-and-branding.md §5 computeIdentity. Outside a git checkout (the Docker build context
 * has no .git) BUILD_SHA / BUILD_VERSION / SOURCE_DATE_EPOCH from the image build args are used.
 */
function computeIdentity(): BuildIdentity {
  const pkg = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as {
    version: string;
  };
  const envSha = process.env['BUILD_SHA'];
  const sha =
    git('rev-parse --short=7 HEAD') ??
    (envSha !== undefined && /^[0-9a-f]{7,40}$/.test(envSha) ? envSha.slice(0, 7) : null);
  const inGit = git('rev-parse --is-inside-work-tree') === 'true';
  const dirty = inGit && (git('status --porcelain') ?? '') !== '';
  const build = sha === null ? '0000000' : `${sha}${dirty ? '+dirty' : ''}`;
  const tag = inGit ? git('describe --tags --exact-match --match "v*"') : null;
  let version: string;
  const envVersion = process.env['BUILD_VERSION'];
  if (tag !== null && /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(tag)) {
    version = tag.slice(1);
    if (version !== pkg.version && !version.startsWith(`${pkg.version}-rc.`)) {
      throw new Error(`identity: tag ${tag} does not match package.json version ${pkg.version}`);
    }
  } else if (
    !inGit &&
    envSha !== undefined &&
    sha === envSha.slice(0, 7) &&
    envVersion !== undefined &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(envVersion)
  ) {
    // A release image build: the pipeline passes both BUILD_SHA and BUILD_VERSION.
    version = envVersion;
  } else {
    const described = inGit ? git('describe --tags --long --match "v*"') : null;
    const commits = described === null ? null : /-(\d+)-g[0-9a-f]+$/.exec(described)?.[1];
    version = `${pkg.version}-dev.${commits ?? '0'}`;
  }
  const epochS = Number(
    process.env['SOURCE_DATE_EPOCH'] ?? (inGit ? (git('log -1 --format=%ct') ?? '') : ''),
  );
  const buildDate = new Date(Number.isFinite(epochS) && epochS > 0 ? epochS * 1_000 : Date.now())
    .toISOString()
    .slice(0, 10);
  const [major, minor] = version.split('.');
  const abiSource = readFileSync(resolve(repo, 'protocol/src/abi.ts'), 'utf8');
  const abi = Number(/export const ABI_VERSION = (\d+)/.exec(abiSource)?.[1] ?? '1');
  return {
    name: 'Plotinium',
    version,
    build,
    buildDate,
    codename: CODENAMES[`${major ?? ''}.${minor ?? ''}`] ?? null,
    abi,
  };
}

async function splashMarkup(identity: BuildIdentity): Promise<string> {
  const mod = (await import(pathToFileURL(resolve(repo, 'ui/src/boot/splash.ts')).href)) as {
    splashHtml: (o: { version: string; build: string }) => string;
  };
  return mod.splashHtml({ version: identity.version, build: identity.build });
}

interface BootAsset {
  readonly url: string;
  readonly bytes: number;
}

/** Inlines the boot-ui into index.html and emits the build-side files (SVC-15, OPS-19). */
function shellPlugin(identity: BuildIdentity): Plugin[] {
  let bootManifest: { desktop: BootAsset[]; recovery: BootAsset[] } = {
    desktop: [],
    recovery: [],
  };
  const inline: Plugin = {
    name: 'plotinium-shell',
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const css = ['ui/src/tokens/tokens.css', 'ui/src/boot/boot.css']
          .map((f) => compactCss(readFileSync(resolve(repo, f), 'utf8')))
          .join('\n');
        const kernel: BootAsset[] = [];
        for (const [file, out] of Object.entries(ctx.bundle ?? {})) {
          if (!file.includes('kernel.worker') || !file.endsWith('.js')) continue;
          kernel.push({
            url: `/${file}`,
            bytes: Buffer.byteLength(out.type === 'chunk' ? out.code : out.source),
          });
        }
        // Only assets whose completion the router actually reports count (P reaches exactly 1).
        bootManifest = { desktop: kernel, recovery: kernel };
        const manifestScript = `window.__PLT_BOOT_MANIFEST__=${JSON.stringify(bootManifest)};`;
        return html
          .replace('<!--plt:boot-style-->', `<style>${css}</style>`)
          .replace('<!--plt:boot-manifest-->', `<script>${manifestScript}</script>`)
          .replace('<!--plt:boot-splash-->', await splashMarkup(identity));
      },
    },
  };
  const emit: Plugin = {
    name: 'plotinium-shell-emit',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (page?.type !== 'asset') return;
      const html =
        typeof page.source === 'string' ? page.source : Buffer.from(page.source).toString('utf8');
      const h = inlineHashes(html);
      const chunks: Record<string, ChunkLike> = {};
      for (const out of Object.values(bundle))
        if (out.type === 'chunk')
          chunks[out.fileName] = { fileName: out.fileName, code: out.code, imports: out.imports };
      const budget = bootBudget(html, chunks);
      // BOOT-10: a hard gate at 60 KB gzip, a warning from 55 KB (C13).
      if (budget.status === 'fail') this.error(budgetLine(budget));
      if (budget.status === 'warn') this.warn(budgetLine(budget));
      else this.info(budgetLine(budget));
      const files: Record<string, string> = {
        'version.json': `${JSON.stringify(identity)}\n`,
        'boot-manifest.json': `${JSON.stringify(bootManifest, null, 2)}\n`,
        'csp-hashes.json': `${JSON.stringify({ scripts: h.scripts, styles: h.styles, inline: [...h.styles, ...h.scripts], policy: cspFor(html) }, null, 2)}\n`,
        'csp.caddy': caddySnippet(html),
        'boot-budget.json': `${JSON.stringify(budget, null, 2)}\n`,
      };
      for (const [fileName, source] of Object.entries(files))
        this.emitFile({ type: 'asset', fileName, source });
    },
  };
  return [inline, emit];
}

const identity = computeIdentity();
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * The Docker stack (Caddy) that serves /api and /ws; the dev and preview servers proxy to it.
 * PLOTINIUM_API_TARGET is an alias of PLOTINIUM_BACKEND (which wins when both are set), e.g.
 * `PLOTINIUM_API_TARGET=http://127.0.0.1:4718` for a second compose project on port 4718.
 */
const backend =
  process.env['PLOTINIUM_BACKEND'] ??
  process.env['PLOTINIUM_API_TARGET'] ??
  'http://127.0.0.1:4717';
/** The origin the server trusts (APP_ORIGIN, http://localhost:<PLOTINIUM_PORT> locally). */
const backendOrigin =
  process.env['PLOTINIUM_BACKEND_ORIGIN'] ??
  `http://localhost:${new URL(backend).port || process.env['PLOTINIUM_PORT'] || '4717'}`;
const devPort = Number(process.env['PLOTINIUM_DEV_PORT'] ?? 5173);
const previewPort = Number(process.env['PLOTINIUM_PREVIEW_PORT'] ?? 4173);

/**
 * The browser talks to the dev server's origin; the backend checks Origin on the WebSocket
 * upgrade and on state-changing requests without Sec-Fetch-Site (SRV-06/07). The proxy presents
 * the backend's own origin. Local development only: both servers listen on loopback.
 */
function presentBackendOrigin(req: ClientRequest): void {
  if (req.getHeader('origin') !== undefined) req.setHeader('origin', backendOrigin);
}

const proxy: Record<string, ProxyOptions> = {
  '/api': {
    target: backend,
    configure: (p) => {
      p.on('proxyReq', presentBackendOrigin);
      p.on('error', (err: Error, _req: IncomingMessage, res: unknown) => {
        const out = res as ServerResponse;
        if (typeof out.writeHead === 'function' && !out.headersSent) {
          out.writeHead(502, { 'content-type': 'application/json' });
          out.end(
            JSON.stringify({ error: 'backend unreachable', target: backend, detail: err.message }),
          );
        }
      });
    },
  },
  '/ws': {
    target: backend,
    ws: true,
    configure: (p) => {
      p.on('proxyReqWs', presentBackendOrigin);
    },
  },
};

/**
 * `vite preview` sends Caddy's headers for the built index.html (the enforced CSP with the build's
 * hashes); `vite dev` sends the policy as Content-Security-Policy-Report-Only (build/csp.ts).
 */
const cspServers = cspHeaders((page) => (existsSync(page) ? readFileSync(page, 'utf8') : null));

export default defineConfig(({ command }) => ({
  root: here,
  resolve: {
    alias: [onnxruntimeCommonAlias()],
    conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions],
  },
  plugins: [
    solid(),
    ...shellPlugin(identity),
    cspServers,
    // Dev only: the ai.embed worker's run-time import of /ort/<version>/*.mjs from public/.
    ortPublicModules(resolve(here, 'public'), isolationHeaders),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      registerType: 'prompt',
      // The static public/manifest.webmanifest (docs/identity) is the manifest.
      manifest: false,
      injectManifest: {
        globPatterns: [...PRECACHE_GLOBS],
        globIgnores: [...NEVER_PRECACHE_GLOBS],
        // SYN-14 as a build check: a precache entry for /api, /ws, /models, /ort, the transformers
        // chunk, WebAssembly or a source map fails the build instead of shipping.
        manifestTransforms: [
          (entries) => {
            const bad = entries.filter((e) => forbiddenInPrecache(e.url)).map((e) => e.url);
            if (bad.length > 0)
              throw new Error(`SYN-14: never precache ${bad.join(', ')} (src/sw/routes.ts)`);
            return { manifest: entries, warnings: [] };
          },
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        rollupFormat: 'iife',
        minify: true,
        sourcemap: false,
      },
      devOptions: { enabled: false },
    }),
  ],
  define: {
    __PLT_IDENTITY__: JSON.stringify(identity),
    __PLT_NAME__: JSON.stringify(identity.name),
    __PLT_VERSION__: JSON.stringify(identity.version),
    __PLT_SHA__: JSON.stringify(identity.build),
    __PLT_DATE__: JSON.stringify(identity.buildDate),
    __AI__: JSON.stringify(process.env['PLT_AI'] !== '0'),
    __TEST_FLAGS__: JSON.stringify(process.env['PLT_TEST_BUILD'] === '1'),
    // The dev server transforms every module on first request (the executor's protocol graph
    // alone takes seconds), so service budgets are stretched there; release builds keep them.
    __PLT_TIMEOUT_SCALE__: JSON.stringify(command === 'serve' ? 20 : 1),
  },
  // Worker bundles (kernel, executor) have their own plugin pipeline. The program registry they
  // compose (@plotinium/apps) references the app views lazily, so Solid's JSX transform must run
  // there too; worker code never loads a view chunk.
  worker: { format: 'es' as const, plugins: () => [solid()] },
  server: {
    port: devPort,
    strictPort: true,
    headers: isolationHeaders,
    proxy,
  },
  preview: {
    port: previewPort,
    strictPort: true,
    headers: isolationHeaders,
    proxy,
  },
  build: { target: 'es2024', outDir: 'dist', emptyOutDir: true, sourcemap: true },
}));
