/**
 * `pnpm dev` only: serve the vendored ONNX Runtime glue (`/ort/<version>/*.mjs`, in public/) as it
 * is. The ai.embed worker imports it at run time from its same-origin URL (ai/README.md "CSP"),
 * and Vite's dev transform refuses any JavaScript request for a file in public/ ("should not be
 * imported from source code"), which raised a full-page error overlay that blocked every click.
 * The build and Caddy already serve the file untouched, so this only makes dev match them.
 * Runs on Node in the dev server only; kept structural like csp.ts (build/ does not import vite).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `/ort/<version>/<file>.mjs`, one safe path segment each (no `..`, no slashes, no encoding). */
const ORT_MODULE = /^\/ort\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*\.mjs)$/;

/** The public/ path of an ORT module request, or null for anything else. */
export function ortModulePath(url: string | undefined): readonly [string, string] | null {
  if (url === undefined) return null;
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const m = ORT_MODULE.exec(path);
  if (m?.[1] === undefined || m[2] === undefined || m[1].includes('..') || m[2].includes('..'))
    return null;
  return [m[1], m[2]];
}

/** Minimal Node request and response surfaces the middleware uses. */
export interface OrtRequest {
  readonly url?: string;
  readonly method?: string;
}
export interface OrtResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string | Uint8Array): unknown;
}

export interface OrtDevPlugin {
  readonly name: string;
  readonly apply: 'serve';
  configureServer(server: {
    readonly middlewares: {
      use(fn: (req: OrtRequest, res: OrtResponse, next: () => void) => void): void;
    };
  }): void;
}

/**
 * The dev-server plugin. Its middleware is registered directly in `configureServer`, so it runs
 * before Vite's transform. `headers` are the dev server's isolation headers (COOP, COEP, CORP),
 * which a module under COEP require-corp needs.
 */
export function ortPublicModules(
  publicDir: string,
  headers: Readonly<Record<string, string>>,
  read: (file: string) => Uint8Array | null = (file) =>
    existsSync(file) ? readFileSync(file) : null,
): OrtDevPlugin {
  return {
    name: 'plotinium-ort-public-modules',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const found = req.method === 'GET' || req.method === 'HEAD' ? ortModulePath(req.url) : null;
        if (found === null) {
          next();
          return;
        }
        const body = read(join(publicDir, 'ort', found[0], found[1]));
        if (body === null) {
          next();
          return;
        }
        res.statusCode = 200;
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    },
  };
}
