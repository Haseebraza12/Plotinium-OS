/**
 * Static checks of the deployment files this package ships with (deployment-and-ci.md §8):
 * compose.yaml, compose.prod.yaml, .env.example, Dockerfile, Caddyfile. Line-based, so they need
 * neither Docker nor a YAML parser; `docker compose config` checks run in CI as well.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const compose = read('compose.yaml');
const prod = read('compose.prod.yaml');
const envExample = read('.env.example');
const dockerfile = read('Dockerfile');
const caddyfile = read('Caddyfile');

/** The lines of one top-level service block of a compose file. */
function service(yaml: string, name: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z]/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('OPS-03 no credential is committed (deployment-and-ci.md §3.9; SEC-08)', () => {
  it('OPS-03 compose.yaml, compose.prod.yaml and .env.example contain no password or token values', () => {
    for (const text of [compose, prod]) {
      for (const line of text
        .split('\n')
        .filter(
          (l) => /PASSWORD|TOKEN|API_KEY|SECRET/i.test(l) && !l.trimStart().startsWith('#'),
        )) {
        expect(line, line).toMatch(/_FILE:|secrets:|anthropic_api_key|llm_upstream_accept|# /);
      }
    }
    const assignments = envExample.split('\n').filter((l) => /^[A-Z_]+=/.test(l));
    expect(assignments.length).toBeGreaterThan(5);
    for (const line of assignments) expect(line, line).toMatch(/^[A-Z0-9_]+=$/);
  });
});

describe('OPS-02 only web publishes ports, and only on loopback locally', () => {
  it('OPS-02 web publishes 127.0.0.1:4717 in compose.yaml; app and db publish nothing; the db network is internal', () => {
    expect(service(compose, 'web')).toContain("- '127.0.0.1:${PLOTINIUM_PORT:-4717}:4717'");
    for (const s of ['db', 'app']) expect(service(compose, s)).not.toMatch(/^\s+ports:/m);
    expect(service(compose, 'db')).toContain('networks: [backplane]');
    expect(compose).toMatch(/backplane:\n\s+internal: true/);
    expect(service(prod, 'web')).toMatch(
      /ports: !override\n\s+- '80:80'\n\s+- '443:443'\n\s+- '443:443\/udp'/,
    );
  });
});

describe('OPS-09 the fault harness exists only on the local profile', () => {
  it('OPS-09 compose.prod.yaml resolves FAULT_INJECTION to 0 and PLOTINIUM_ENV to production', () => {
    expect(service(compose, 'app')).toContain("FAULT_INJECTION: '1'");
    expect(service(prod, 'app')).toContain("FAULT_INJECTION: '0'");
    expect(service(prod, 'app')).toMatch(/PLOTINIUM_ENV: production/);
    expect(service(prod, 'app')).toMatch(/APP_ORIGIN: https:\/\//);
  });
});

describe('OPS-04 images are pinned by digest', () => {
  it('OPS-04 every base image ARG is a digest and every FROM uses one of them or an earlier stage', () => {
    const args = [...dockerfile.matchAll(/^ARG ([A-Z_]+_IMAGE)=(\S+)$/gm)];
    expect(args.map((m) => m[1])).toEqual(['NODE_IMAGE', 'CADDY_IMAGE', 'PGVECTOR_IMAGE']);
    for (const m of args) expect(m[2], m[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
    const stages = new Set<string>();
    for (const m of dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)) {
      const from = m[1] ?? '';
      expect(
        from === '${NODE_IMAGE}' ||
          from === '${CADDY_IMAGE}' ||
          from === '${PGVECTOR_IMAGE}' ||
          stages.has(from),
        from,
      ).toBe(true);
      stages.add(m[2] ?? '');
    }
    expect([...stages]).toEqual(expect.arrayContaining(['app', 'web', 'db']));
  });
});

describe('OPS-06 Caddy owns every security header and routes only /api/* and /ws', () => {
  it('OPS-06 the Caddyfile carries the security-model §4.1 header set and proxies exactly /ws and /api/*', () => {
    for (const header of [
      'Cross-Origin-Opener-Policy "same-origin"',
      'Cross-Origin-Embedder-Policy "require-corp"',
      'Cross-Origin-Resource-Policy "same-origin"',
      `Content-Security-Policy-Report-Only "require-trusted-types-for 'script'"`,
      'X-Content-Type-Options "nosniff"',
      'Referrer-Policy "no-referrer"',
      'Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"',
      '-Server',
      'import /etc/caddy/csp.caddy',
      'import /etc/caddy/prod.d/*.caddy',
    ]) {
      expect(caddyfile, header).toContain(header);
    }
    const proxied = [...caddyfile.matchAll(/handle (\S+) \{\n\s+reverse_proxy app:3000/g)].map(
      (m) => m[1],
    );
    expect(proxied).toEqual(['/ws', '/api/*']);
    expect(read('ops/caddy/prod.d/hsts.caddy')).toContain(
      'Strict-Transport-Security "max-age=31536000"',
    );
  });
});
