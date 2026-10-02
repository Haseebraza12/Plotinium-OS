/**
 * Writes /etc/caddy/csp.caddy: the Content-Security-Policy of security-model.md §3.9 and §4.1
 * (C10's directives verbatim plus the build-time hash of every inline <script> and <style> of the
 * built index.html, and form-action 'none'). No 'unsafe-inline', no 'unsafe-eval'.
 * Spec: specs/14-devops/deployment-and-ci.md §3.2, §3.5 (OPS-19). Run in the Dockerfile build stage:
 *
 *   node ops/caddy/csp-hash.ts web/dist/index.html > csp.caddy
 *
 * The output is one Caddy `header` directive, imported inside the (isolation_headers) snippet.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const INLINE = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

export interface InlineHashes {
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
}

/** SHA-256 (base64) of every inline <script> (no src) and <style> body, in document order. */
export function inlineHashes(html: string): InlineHashes {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(INLINE)) {
    const [, tag = '', attrs = '', body = ''] = m;
    if (tag.toLowerCase() === 'script' && /\bsrc\s*=/i.test(attrs)) continue;
    const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    (tag.toLowerCase() === 'script' ? scripts : styles).push(hash);
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

const file = process.argv[2];
if (file !== undefined) {
  process.stdout.write(`header Content-Security-Policy "${cspFor(readFileSync(file, 'utf8'))}"\n`);
}
