// @ts-check
/**
 * Vite config of the desktop shell's dev harness (wm/src/shell/dev-harness.tsx):
 *
 *   node_modules/.bin/vite --config wm/src/shell/dev/vite.config.mjs      (from the repository root)
 *
 * It serves index.html from this folder on http://localhost:4720/dev/ with Solid compiled by
 * vite-plugin-solid. Written as JavaScript so the browser-only wm tsconfig needs no Node types.
 *
 * `@plotinium/ui` areas: ui-implementation-guide.md §3.3 says the ui package root re-exports
 * every Solid area. Until ui/src/index.ts does so for shell, overlays and login, the plugin below
 * serves a virtual `@plotinium/ui` that adds them; once the root exports them it steps aside.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
/** The shell folder is the root, so index.html (here, served at /dev/) can load ../dev-harness.tsx. */
const shellDir = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const uiSrc = `${repo}ui/src`;

// vite-plugin-solid is a devDependency of ui/ and web/ (pnpm does not hoist), as in vitest.config.ts.
const solidModule = createRequire(`${repo}ui/package.json`)('vite-plugin-solid');
/** @type {(opts?: { hot?: boolean; dev?: boolean }) => import('vite').PluginOption} */
const solid = solidModule.default ?? solidModule;

const AREAS = ['shell', 'overlays', 'login'];
const VIRTUAL = '\0plt-ui-root';

/** @returns {import('vite').Plugin | null} */
function uiAreas() {
  const index = readFileSync(`${uiSrc}/index.ts`, 'utf8');
  const missing = AREAS.filter((a) => !index.includes(`./${a}/index.ts`));
  if (missing.length === 0) return null;
  return {
    name: 'plt-ui-areas',
    enforce: 'pre',
    resolveId(id) {
      return id === '@plotinium/ui' ? VIRTUAL : null;
    },
    load(id) {
      if (id !== VIRTUAL) return null;
      return [
        `export * from ${JSON.stringify(`${uiSrc}/index.ts`)};`,
        ...missing.map((a) => `export * from ${JSON.stringify(`${uiSrc}/${a}/index.ts`)};`),
      ].join('\n');
    },
  };
}

export default defineConfig({
  root: shellDir,
  plugins: [uiAreas(), solid({ hot: false })],
  resolve: {
    alias: [{ find: '@plotinium/ui/fonts.css', replacement: `${uiSrc}/tokens/fonts.css` }],
    dedupe: ['solid-js'],
    conditions: ['development', 'browser'],
  },
  server: { port: 4720, strictPort: false, open: false, fs: { allow: [repo] } },
  build: {
    target: 'es2024',
    outDir: `${here}dist`,
    emptyOutDir: true,
    rollupOptions: { input: `${here}index.html` },
  },
});
