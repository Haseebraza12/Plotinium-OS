/**
 * `pnpm dev` serves the vendored ONNX Runtime glue from public/ untouched, so the ai.embed worker's
 * run-time import no longer raises Vite's "file is in /public" error overlay (web/build/ort-dev.ts).
 */
import { describe, expect, it } from 'vitest';

import type { OrtRequest, OrtResponse } from '../build/ort-dev.ts';
import { ortModulePath, ortPublicModules } from '../build/ort-dev.ts';

const HEADERS = { 'Cross-Origin-Embedder-Policy': 'require-corp' };
const GLUE = 'export default 1;\n';

function serve(url: string, method = 'GET') {
  const uses: ((req: OrtRequest, res: OrtResponse, next: () => void) => void)[] = [];
  const reads: string[] = [];
  const plugin = ortPublicModules('/w/public', HEADERS, (file) => {
    reads.push(file);
    return file === '/w/public/ort/1.31.0-dev.2/ort-wasm-simd-threaded.asyncify.mjs'
      ? new TextEncoder().encode(GLUE)
      : null;
  });
  plugin.configureServer({ middlewares: { use: (fn) => uses.push(fn) } });
  const headers = new Map<string, string>();
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
    end: (b?: string | Uint8Array) => {
      res.body = b;
    },
  };
  let passed = false;
  uses[0]?.({ url, method }, res, () => {
    passed = true;
  });
  return { plugin, res, headers, passed, reads };
}

describe('RAG-06 the dev server serves /ort/*.mjs from public/ as is', () => {
  it('RAG-06 an ORT module request gets the file, JavaScript type and the isolation headers', () => {
    const r = serve('/ort/1.31.0-dev.2/ort-wasm-simd-threaded.asyncify.mjs?import');
    expect(r.plugin.apply).toBe('serve');
    expect(r.passed).toBe(false);
    expect(r.res.statusCode).toBe(200);
    expect(new TextDecoder().decode(r.res.body as Uint8Array)).toBe(GLUE);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  });

  it('RAG-06 other requests, missing files and unsafe paths go on to Vite untouched', () => {
    expect(serve('/src/main.ts').passed).toBe(true);
    expect(serve('/ort/1.31.0-dev.2/missing.mjs').passed).toBe(true);
    expect(serve('/ort/1.31.0-dev.2/ort-wasm-simd-threaded.asyncify.mjs', 'POST').passed).toBe(
      true,
    );
    for (const bad of [
      '/ort/../secrets/x.mjs',
      '/ort/%2e%2e/x.mjs',
      '/ort/a/b/c.mjs',
      '/ort/a/..mjs',
      '/ort/a/x.wasm',
    ]) {
      expect(ortModulePath(bad), bad).toBeNull();
      expect(serve(bad).reads, bad).toEqual([]);
    }
  });
});
