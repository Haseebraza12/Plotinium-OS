/**
 * The environment envelope every browser result carries (spec §3.3 `envelope()`, §3.11.1;
 * TST-06, TST-13): Chrome version and channel, machine class, commit, build, refresh rate and
 * device pixel ratio.
 */
import type { Page } from '@playwright/test';

import type { Env } from '../support/env.ts';

import {
  gitCommit,
  machineClass,
  machineInfo,
  type MachineInfo,
  type PerfResult,
} from './result.ts';

export interface Envelope {
  commit: string;
  build: string;
  machine: MachineInfo;
  chrome: NonNullable<PerfResult['chrome']>;
}

/** `Chrome/153.0.7310.12` or `HeadlessChrome/153.0.7310.12` → `153.0.7310.12`. */
export function chromeVersionFromProduct(product: string): string {
  const m = /(?:Headless)?Chrome\/(\d+(?:\.\d+){0,3})/.exec(product);
  if (m?.[1] === undefined) throw new Error(`not a Chrome product string: ${product}`);
  return m[1];
}

export function chromeChannel(env: Env = process.env): 'stable' | 'beta' {
  return env['PLT_CHROME_CHANNEL'] === 'beta' ? 'beta' : 'stable';
}

/** Build identity from the served /version.json (identity-and-branding §4.1), or 'unknown'. */
export function buildOf(versionJson: unknown): string {
  if (typeof versionJson !== 'object' || versionJson === null) return 'unknown';
  const v = 'version' in versionJson ? versionJson.version : undefined;
  const b = 'build' in versionJson ? versionJson.build : undefined;
  return typeof v === 'string' && typeof b === 'string' ? `${v}+${b}` : 'unknown';
}

export async function envelope(
  page: Page,
  extra: Partial<MachineInfo> = {},
  env: Env = process.env,
): Promise<Envelope> {
  const session = await page.context().newCDPSession(page);
  const { product } = await session.send('Browser.getVersion');
  await session.detach();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  // Fetched from the page (same origin, through the Service Worker and any test routes), so an
  // unreachable backend or a missing file gives 'unknown' instead of failing the run.
  const versionJson = await page.evaluate(async () => {
    try {
      const res = await fetch('/version.json', { cache: 'no-store' });
      return res.ok ? ((await res.json()) as unknown) : null;
    } catch {
      return null;
    }
  });
  const build = buildOf(versionJson);
  return {
    commit: gitCommit(env),
    build,
    machine: machineInfo(machineClass(env), { dpr, ...extra }),
    chrome: { version: chromeVersionFromProduct(product), channel: chromeChannel(env) },
  };
}
