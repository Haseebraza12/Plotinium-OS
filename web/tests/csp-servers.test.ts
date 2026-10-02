import { describe, expect, it } from 'vitest';

import type { HtmlResponse } from '../build/csp.ts';
import {
  CADDY_PAGE_HEADERS,
  cspFor,
  cspHeaders,
  devCspFor,
  TRUSTED_TYPES_REPORT_ONLY,
  withHtmlPolicy,
} from '../build/csp.ts';

const PAGE =
  '<!doctype html><html><head><script>window.__pltKeys=[];</script><style>:root{}</style></head><body></body></html>';

/** A Node-like response that records headers and the body. */
function response(type = 'text/html'): HtmlResponse & {
  headers: Map<string, string>;
  body: unknown;
} {
  const headers = new Map<string, string>([['content-type', type]]);
  const res = {
    headers,
    body: undefined as unknown,
    headersSent: false,
    getHeader: (n: string) => headers.get(n.toLowerCase()),
    setHeader: (n: string, v: string) => {
      headers.set(n.toLowerCase(), v);
      return res;
    },
    end: (...args: unknown[]) => {
      res.headersSent = true;
      res.body = args[0];
      return res;
    },
  };
  return res;
}

type Use = (req: unknown, res: HtmlResponse, next: () => void) => void;

describe('SEC-02 the local servers send the production CSP (CLAUDE.md decision 1)', () => {
  it('SEC-02 vite preview sends Caddy’s enforced policy, the Trusted Types line and page headers', () => {
    const uses: Use[] = [];
    const plugin = cspHeaders((path) => (path === '/w/dist/index.html' ? PAGE : null));
    plugin.configurePreviewServer({
      config: { root: '/w', build: { outDir: 'dist' } },
      middlewares: { use: (fn) => uses.push(fn) },
    });
    const res = response();
    let next = false;
    uses[0]?.({}, res, () => {
      next = true;
    });
    expect(next).toBe(true);
    expect(res.headers.get('content-security-policy')).toBe(cspFor(PAGE));
    expect(res.headers.get('content-security-policy-report-only')).toBe(TRUSTED_TYPES_REPORT_ONLY);
    for (const [k, v] of Object.entries(CADDY_PAGE_HEADERS))
      expect(res.headers.get(k.toLowerCase())).toBe(v);
    expect(cspFor(PAGE)).not.toContain('unsafe-inline');
  });

  it('SEC-02 vite dev sends a report-only policy hashed from the page it actually served', () => {
    const uses: Use[] = [];
    cspHeaders(() => null).configureServer({ middlewares: { use: (fn) => uses.push(fn) } });
    const res = response('text/html; charset=utf-8');
    uses[0]?.({}, res, () => undefined);
    res.end(PAGE);
    const policy = res.headers.get('content-security-policy-report-only') ?? '';
    expect(policy).toBe(devCspFor(PAGE));
    expect(res.headers.has('content-security-policy')).toBe(false);
    // Reports exactly what production refuses at the source: style attributes and foreign scripts.
    expect(policy).toContain("style-src-attr 'none'");
    expect(policy).toContain(cspFor(PAGE).split('; ')[1]);
    expect(policy).toContain(TRUSTED_TYPES_REPORT_ONLY);
    expect(res.body).toBe(PAGE);
  });

  it('SEC-02 the dev policy is only attached to HTML, never to modules or after headers left', () => {
    const js = response('text/javascript');
    withHtmlPolicy(js, 'Content-Security-Policy-Report-Only', devCspFor);
    js.end('export {}');
    expect(js.headers.has('content-security-policy-report-only')).toBe(false);
    const late = response();
    withHtmlPolicy(late, 'Content-Security-Policy-Report-Only', devCspFor);
    late.headersSent = true;
    late.end(Buffer.from(PAGE));
    expect(late.headers.has('content-security-policy-report-only')).toBe(false);
    const bytes = response();
    withHtmlPolicy(bytes, 'Content-Security-Policy-Report-Only', devCspFor);
    bytes.end(Buffer.from(PAGE));
    expect(bytes.headers.get('content-security-policy-report-only')).toBe(devCspFor(PAGE));
  });
});
