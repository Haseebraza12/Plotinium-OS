/**
 * The @plotinium/ui gallery: a Vite app that previews every component in both themes.
 *   pnpm --filter @plotinium/ui gallery         dev server on http://localhost:4718
 *   pnpm --filter @plotinium/ui gallery:build   static build in ui/gallery/dist
 */
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite';

// The repository path contains a space, so decode the file URL rather than using its raw pathname.
const galleryRoot = decodeURIComponent(new URL('.', import.meta.url).pathname);

export default defineConfig({
  root: galleryRoot,
  base: './',
  plugins: [solid()],
  server: { port: 4718, strictPort: false },
  preview: { port: 4719 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2024',
    chunkSizeWarningLimit: 2048,
  },
});
