import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BOOT_CRITICAL_LIMIT, bootBudget, budgetLine, entryOf } from '../build/budget.ts';
import { caddySnippet, cspFor, inlineHashes, sha256Source } from '../build/csp.ts';

const sha = (s: string): string =>
  `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

const PAGE = [
  '<!doctype html><html><head>',
  '<script data-plt-keys>window.__pltKeys=[];</script>',
  '<style>:root{--pl-bg:#0B0D1F}</style>',
  '<script>window.__PLT_BOOT_MANIFEST__={"desktop":[]};</script>',
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/dep-1.js">',
  '</head><body><div id="plt-boot" data-testid="boot-screen"></div></body></html>',
].join('\n');

describe('the build-time CSP (security-model §3.9, §4.1)', () => {
  it('SEC-02 hashes every inline script and style body, and skips scripts with src', () => {
    const h = inlineHashes(PAGE);
    expect(h.scripts).toEqual([
      sha('window.__pltKeys=[];'),
      sha('window.__PLT_BOOT_MANIFEST__={"desktop":[]};'),
    ]);
    expect(h.styles).toEqual([sha(':root{--pl-bg:#0B0D1F}')]);
    expect(sha256Source('x')).toBe(sha('x'));
  });

  it("SEC-02 the policy is C10's directives plus the hashes and form-action 'none', never unsafe-inline", () => {
    const policy = cspFor(PAGE);
    const directives = policy.split('; ');
    expect(directives[0]).toBe("default-src 'self'");
    expect(directives).toContain(
      `script-src 'self' 'wasm-unsafe-eval' ${sha('window.__pltKeys=[];')} ${sha('window.__PLT_BOOT_MANIFEST__={"desktop":[]};')}`,
    );
    expect(directives).toContain(`style-src 'self' ${sha(':root{--pl-bg:#0B0D1F}')}`);
    for (const d of [
      "worker-src 'self' blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ])
      expect(directives).toContain(d);
    expect(policy).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });

  it('SEC-02 style-src appears only when the page has an inline style', () => {
    expect(cspFor('<script>a()</script>')).not.toContain('style-src');
  });

  it('OPS-19 the Caddy snippet is one header directive Caddy can import', () => {
    const snippet = caddySnippet(PAGE);
    expect(snippet).toBe(`header Content-Security-Policy "${cspFor(PAGE)}"\n`);
    expect(snippet.split('\n').filter(Boolean)).toHaveLength(1);
    // Caddy's quoted token must not be broken by the policy itself.
    expect(cspFor(PAGE)).not.toContain('"');
  });
});

describe('the boot-critical budget (C13)', () => {
  const chunks = {
    'assets/index-abc.js': {
      fileName: 'assets/index-abc.js',
      code: 'import"./dep-1.js";console.log("boot")',
      imports: ['assets/dep-1.js'],
    },
    'assets/dep-1.js': { fileName: 'assets/dep-1.js', code: 'export const x=1', imports: [] },
    'assets/desktop-lazy.js': {
      fileName: 'assets/desktop-lazy.js',
      code: 'x'.repeat(200_000),
      imports: [],
    },
  };

  it('BOOT-10 counts the entry chunk, its static imports and the inline scripts, not lazy chunks', () => {
    expect(entryOf(PAGE)).toBe('assets/index-abc.js');
    const b = bootBudget(PAGE, chunks);
    expect(b.files.map((f) => f.file)).toEqual(['assets/index-abc.js', 'assets/dep-1.js']);
    expect(b.inlineScripts.gzip).toBeGreaterThan(0);
    expect(b.inlineStyles.gzip).toBeGreaterThan(0);
    expect(b.jsGzip).toBe(b.files.reduce((n, f) => n + f.gzip, 0) + b.inlineScripts.gzip);
    expect(b.status).toBe('ok');
    expect(budgetLine(b)).toMatch(/^boot-critical main-thread JS .* gzip of 60\.00 KB \(ok\)/);
  });

  it('BOOT-10 boot-critical main-thread JS over 60 KB gzip fails and over 55 KB warns', () => {
    // Base64 of hash-chained bytes: about 6 bits of entropy per character, so the gzip size is
    // about three quarters of the input size.
    const noise = (n: number): string => {
      const parts: Buffer[] = [];
      let block = createHash('sha256').update('seed').digest();
      for (let len = 0; len < n; len += 44) {
        parts.push(block);
        block = createHash('sha256').update(block).digest();
      }
      return Buffer.concat(parts).toString('base64').slice(0, n);
    };
    const big = (bytes: number): typeof chunks => ({
      ...chunks,
      'assets/index-abc.js': { fileName: 'assets/index-abc.js', code: noise(bytes), imports: [] },
    });
    const fail = bootBudget(PAGE, big(100 * 1_024));
    expect(fail.jsGzip).toBeGreaterThan(BOOT_CRITICAL_LIMIT);
    expect(fail.status).toBe('fail');
    const warn = bootBudget(PAGE, big(77 * 1_024));
    expect(warn.jsGzip).toBeGreaterThan(55 * 1_024);
    expect(warn.jsGzip).toBeLessThanOrEqual(BOOT_CRITICAL_LIMIT);
    expect(warn.status).toBe('warn');
  });
});
