/**
 * Environment switches shared by every cross-package suite (spec §3.3, §4.6).
 *
 * Suites that need something the scaffold cannot provide yet are gated on an explicit switch, so a
 * plain `pnpm e2e` on a fresh clone reports them as `fixme`/skipped instead of failing (T-3:
 * skipped is never counted as verified).
 */
export type Env = Readonly<Record<string, string | undefined>>;

/** Base URL of the system under test, same rule as the root playwright.config.ts. */
export function baseUrl(env: Env = process.env): string {
  const port = env['PLOTINIUM_PORT'] ?? '4717';
  return env['PLOTINIUM_BASE_URL'] ?? `http://localhost:${port}`;
}

/** True once the boot-ui, login and desktop honour tests/e2e/SELECTORS.md (set by CI on main). */
export function uiReady(env: Env = process.env): boolean {
  return env['PLT_E2E_UI'] === '1';
}

/** True when the test may stop and start Compose services (E2, TST-12). */
export function stackControl(env: Env = process.env): boolean {
  return env['PLT_E2E_STACK'] === '1';
}

/** PostgreSQL URL for the integration and server fault-injection projects, or undefined. */
export function databaseUrl(env: Env = process.env): string | undefined {
  const url = env['DATABASE_URL'];
  return url === undefined || url === '' ? undefined : url;
}

/** URL of the ui/ component gallery for visual regression, or undefined when not served. */
export function galleryUrl(env: Env = process.env): string | undefined {
  const url = env['PLOTINIUM_GALLERY_URL'];
  return url === undefined || url === '' ? undefined : url;
}

export const FIXME_UI =
  'UI not landed yet: set PLT_E2E_UI=1 once boot-ui, login and desktop implement tests/e2e/SELECTORS.md';
export const FIXME_STACK =
  'needs Compose control: set PLT_E2E_STACK=1 (the test stops and starts services)';
