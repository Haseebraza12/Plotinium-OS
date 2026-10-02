/**
 * Demo Day 0:00–0:05, clean bring-up (spec §17.1; deployment-and-ci §3.6; testing §3.16.3).
 *
 * The examiner clones the repository, runs the documented commands (at most three, within five
 * minutes) and opens the URL; this is scored before we speak. The script times exactly that:
 * `git clone` → `docker compose up -d --wait` → log in as `demo` with the password printed once
 * in `docker compose logs app` (C10) → `desktop-interactive`. CI fails a release above 240 s
 * (`OPS-05.bringup` in budgets.json; the spec limit is 300 s).
 *
 * DOCKER gate: runs only with PLT_DEMO_BRINGUP=1. It never deletes an existing stack: if the
 * project already has containers or volumes it stops and says how to clear them, because
 * `docker compose down -v` destroys local data. It leaves the new stack running for the other
 * rehearsal scripts unless PLT_BRINGUP_TEARDOWN=1.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { budget, miss } from '../../performance/budgets.ts';
import { baseUrl } from '../../support/env.ts';
import { REPO_ROOT } from '../../support/stack.ts';

import {
  bringupPlan,
  compose,
  composeRecentEnough,
  envRunner,
  forgetLogs,
  lanAddresses,
  projectName,
  type BringupPlan,
} from './compose.ts';
import {
  bringupAllowed,
  demoDay,
  expectedVersion,
  FIXME_BRINGUP,
  FIXME_PRODUCTION,
  FIXME_UI,
  productionUrl,
  SKIP_DEMO_DAY,
  uiReady,
} from './env.ts';
import { parseCredentials, parseVersionJson } from './parse.ts';
import { bootAs, measure, recordRehearsal, type DemoOS } from './session.ts';

test.describe.serial('Demo Day 0:00–0:05 clean bring-up', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!bringupAllowed(), FIXME_BRINGUP);
  test.describe.configure({ timeout: 15 * 60_000 });

  let workDir = '';
  let plan: BringupPlan;
  let t0 = 0;
  let t2 = 0;
  let created = false;
  let os: DemoOS | undefined;
  let chrome: string | null = null;
  recordRehearsal('bringup', 'clean bring-up', () => chrome);

  test.beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'plt-bringup-'));
    plan = bringupPlan(process.env, workDir);
  });

  test.afterAll(async () => {
    await os?.close();
    if (created && process.env['PLT_BRINGUP_TEARDOWN'] === '1') await compose(plan.cwd).down();
    if (workDir !== '') await rm(workDir, { recursive: true, force: true });
  });

  test('OPS-05 the documented bring-up is at most three commands on Compose 2.24 or newer, starting from nothing', async () => {
    measure('commands', plan.commands.join(' ; '));
    if (plan.notes.length > 0) measure('path', plan.notes.join('; '));
    expect(plan.commands.length).toBeLessThanOrEqual(3);
    const local = compose(REPO_ROOT);
    const version = await local.version();
    measure('compose', version?.join('.') ?? 'missing');
    expect(
      composeRecentEnough(version),
      `docker compose ${version?.join('.') ?? 'missing'}; README asks for 2.24+`,
    ).toBe(true);
    const name = projectName();
    expect(
      await local.projects(),
      `a "${name}" stack already exists: stop it and delete its data with "docker compose down -v" (destroys local data), or set PLT_DEMO_PROJECT to another name`,
    ).not.toContain(name);
    expect(
      await local.volumes(),
      `volumes of "${name}" are left from an earlier run, so the seed would not run again: "docker compose down -v", or set PLT_DEMO_PROJECT`,
    ).toEqual([]);
  });

  test('OPS-05 git clone and docker compose up --wait bring a healthy stack that prints the first-start credentials once', async () => {
    t0 = Date.now();
    if (plan.clone !== null) {
      const cloned = await envRunner('git', plan.clone, {
        cwd: workDir,
        env: process.env,
        timeoutMs: 300_000,
      });
      expect(cloned.code, `git clone failed:\n${cloned.stderr}`).toBe(0);
      measure('clone s', ((Date.now() - t0) / 1000).toFixed(1));
    }
    const stack = compose(plan.cwd);
    created = true;
    const up = await stack.up(plan.up, 600_000);
    const t1 = Date.now();
    measure('up --wait s', ((t1 - t0) / 1000).toFixed(1));
    expect(
      up.code,
      `docker ${plan.up.join(' ')} failed (see "docker compose logs app"):\n${up.stderr}`,
    ).toBe(0);

    forgetLogs();
    const logs = await stack.logs('app');
    const accounts = [...parseCredentials(logs).keys()];
    measure('accounts', accounts.join(','));
    expect(accounts).toEqual(expect.arrayContaining(['root', 'demo', 'alice', 'bob']));
    expect(
      logs.split('FIRST-START CREDENTIALS').length - 1,
      'C10: the block is printed exactly once',
    ).toBe(1);

    const ready = await fetch(new URL('/api/readyz', baseUrl()));
    expect(ready.ok, `readyz ${ready.status}`).toBe(true);
  });

  test('OPS-05 the examiner reaches desktop-interactive as demo with the password from docker compose logs app', async () => {
    test.fixme(!uiReady(), FIXME_UI);
    os = await bootAs('demo', { requireHooks: false });
    t2 = Date.now();
    chrome = os.chrome;
    measure('clone to desktop s', ((t2 - t0) / 1000).toFixed(1));
    await expect(os.page).toHaveTitle(/Plotinium/);
  });

  test('OPS-05 clean clone to desktop-interactive takes at most 240 seconds on this machine', () => {
    test.fixme(!uiReady(), FIXME_UI);
    test.fixme(
      !plan.scored,
      `not the scored path (${plan.notes.join('; ')}); the time is only recorded`,
    );
    expect(t2, 'the login test did not reach the desktop').toBeGreaterThan(t0);
    const limit = budget('OPS-05.bringup');
    const seconds = (t2 - t0) / 1000;
    expect(miss(limit, seconds)).toBeUndefined();
  });

  test('OPS-02 the local stack answers on 127.0.0.1 and not on the LAN address of this machine', async () => {
    const url = new URL(baseUrl());
    const ready = await fetch(new URL('/api/readyz', url));
    expect(ready.ok).toBe(true);
    const port = url.port === '' ? '80' : url.port;
    for (const ip of lanAddresses()) {
      const reached = await fetch(`http://${ip}:${port}/api/readyz`, {
        signal: AbortSignal.timeout(3_000),
      }).then(
        () => true,
        () => false,
      );
      expect(
        reached,
        `the stack answered on the LAN address ${ip}:${port} (SEC-20: loopback only)`,
      ).toBe(false);
    }
  });

  test('PLT-DEL-02 the production URL is ready and /version.json names Plotinium and the release', async () => {
    const prod = productionUrl();
    test.fixme(prod === undefined, FIXME_PRODUCTION);
    if (prod === undefined) return;
    const ready = await fetch(new URL('/api/readyz', prod));
    expect(ready.ok, `production readyz ${ready.status}`).toBe(true);
    const info = parseVersionJson(await (await fetch(new URL('/version.json', prod))).json());
    expect(info?.name).toBe('Plotinium');
    measure('production version', `${info?.version ?? '?'}+${info?.build ?? '?'}`);
    const want = expectedVersion();
    if (want !== undefined) expect(info?.version).toBe(want);
    else expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
