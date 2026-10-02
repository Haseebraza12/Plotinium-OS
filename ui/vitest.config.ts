/**
 * Package-local Vitest config for @plotinium/ui. The root vitest.config.ts declares the `ui`
 * project inline without vite-plugin-solid, so Solid JSX cannot compile there. Until the root
 * lists this file as the ui project (TODO(R5)), run: pnpm exec vitest run --config ui/vitest.config.ts
 */
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ['development', 'browser'] },
  test: {
    name: 'ui',
    root: import.meta.dirname,
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    environment: 'happy-dom',
    passWithNoTests: true,
    setupFiles: ['./src/primitives/internal/test-setup.ts'],
    // Let `?raw` CSS imports through (the token tests read tokens.css and every *.module.css).
    css: { include: [/\.css\?raw$/] },
    // lucide-solid resolves to raw .jsx under the `solid` condition; compile it with the tests.
    server: { deps: { inline: [/lucide-solid/] } },
  },
});
