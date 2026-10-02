/**
 * The Content-Security-Policy of security-model.md §3.9 and §4.1 for a built index.html: C10's
 * directives plus the SHA-256 of every inline `<script>` (without src) and `<style>`, so the
 * inlined boot splash, key buffer and boot manifest run with no 'unsafe-inline'.
 *
 * Same policy and hashing as ops/caddy/csp-hash.ts (which writes the Caddy snippet in the image
 * build); `vite preview` sends it too, so a local preview fails exactly like production would.
 * Runs on Node at build time only.
 */
import { createHash } from 'node:crypto';

const INLINE = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

export interface InlineHashes {
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
}

export const sha256Source = (body: string): string =>
  `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/** SHA-256 (base64) sources of every inline script (no src) and style body, in document order. */
export function inlineHashes(html: string): InlineHashes {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(INLINE)) {
    const [, tag = '', attrs = '', body = ''] = m;
    if (tag.toLowerCase() === 'script' && /\bsrc\s*=/i.test(attrs)) continue;
    (tag.toLowerCase() === 'script' ? scripts : styles).push(sha256Source(body));
  }
  return { scripts, styles };
}

export function cspFor(html: string): string {
  const h = inlineHashes(html);
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...h.scripts].join(' '),
    ...(h.styles.length > 0 ? [["style-src 'self'", ...h.styles].join(' ')] : []),
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The Caddy directive ops/caddy/csp-hash.ts writes to /etc/caddy/csp.caddy. */
export const caddySnippet = (html: string): string =>
  `header Content-Security-Policy "${cspFor(html)}"\n`;

// ---------------------------------------------------------------------------------------------
// The same policy on the local servers (CLAUDE.md standing decision 1)
// ---------------------------------------------------------------------------------------------

/** Caddy's Trusted Types line, report-only in every environment (security-model.md §3.9). */
export const TRUSTED_TYPES_REPORT_ONLY = "require-trusted-types-for 'script'";

/** The rest of Caddy's (isolation_headers) set that a page's behaviour depends on. */
export const CADDY_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * The dev server's REPORT-ONLY policy for a served index.html. `pnpm dev` injects every CSS module
 * as a runtime `<style>` element (production uses `<link>`), so the element rule is relaxed and
 * reports only what the Docker build would really refuse: inline `style="…"` ATTRIBUTES (a static
 * `style={{…}}` in JSX) and inline scripts that are not the page's own. Nothing is blocked.
 */
export function devCspFor(html: string): string {
  const h = inlineHashes(html);
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...h.scripts].join(' '),
    "style-src-elem 'self' 'unsafe-inline'",
    "style-src-attr 'none'",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    TRUSTED_TYPES_REPORT_ONLY,
  ].join('; ');
}

/** Minimal Node response surface the dev middleware wraps. */
export interface HtmlResponse {
  headersSent: boolean;
  getHeader(name: string): number | string | readonly string[] | undefined;
  setHeader(name: string, value: string): unknown;
  end(...args: unknown[]): unknown;
}

/**
 * Wrap `res.end` so an HTML body leaves with a policy computed from that exact body (Vite's dev
 * index is transformed per request, so its inline hashes are only known at the end).
 */
export function withHtmlPolicy(
  res: HtmlResponse,
  header: string,
  policyOf: (html: string) => string,
): void {
  const end = res.end.bind(res);
  res.end = (...args: unknown[]): unknown => {
    const [chunk] = args;
    const type = String(res.getHeader('Content-Type') ?? '');
    if (!res.headersSent && type.includes('text/html')) {
      const html =
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString('utf8')
            : null;
      if (html !== null) res.setHeader(header, policyOf(html));
    }
    return end(...args);
  };
}

/** The Vite plugin shape these servers need (kept structural: build/ does not import vite). */
export interface CspServerPlugin {
  readonly name: string;
  configurePreviewServer(server: {
    readonly config: { readonly root: string; readonly build: { readonly outDir: string } };
    readonly middlewares: {
      use(fn: (req: unknown, res: HtmlResponse, next: () => void) => void): void;
    };
  }): void;
  configureServer(server: {
    readonly middlewares: {
      use(fn: (req: unknown, res: HtmlResponse, next: () => void) => void): void;
    };
  }): void;
}

/**
 * `vite preview` sends exactly what Caddy sends for the built page (the enforced policy with the
 * build's hashes, Trusted Types report-only, and the page headers), so a local preview fails
 * exactly like production. `vite dev` sends `devCspFor` as Content-Security-Policy-Report-Only.
 */
export function cspHeaders(readPage: (path: string) => string | null): CspServerPlugin {
  return {
    name: 'plotinium-csp-headers',
    configurePreviewServer(server) {
      const page = `${server.config.root}/${server.config.build.outDir}/index.html`;
      const html = readPage(page);
      const policy = html === null ? null : cspFor(html);
      server.middlewares.use((_req, res, next) => {
        if (policy !== null) res.setHeader('Content-Security-Policy', policy);
        res.setHeader('Content-Security-Policy-Report-Only', TRUSTED_TYPES_REPORT_ONLY);
        for (const [k, v] of Object.entries(CADDY_PAGE_HEADERS)) res.setHeader(k, v);
        next();
      });
    },
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(CADDY_PAGE_HEADERS)) res.setHeader(k, v);
        withHtmlPolicy(res, 'Content-Security-Policy-Report-Only', devCspFor);
        next();
      });
    },
  };
}
