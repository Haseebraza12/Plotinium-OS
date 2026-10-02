/**
 * UI-005: the app builds its rate limiter from the deployment profile. In the `local` profile a
 * fourth guest sign-in from one IP within the hour is allowed (production keeps 3 per hour; see
 * ratelimit.test.ts for the class table of each profile).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MemoryAuthStore } from '../../tests/memory-auth-store.ts';
import { buildApp, type PlotiniumApp } from '../app.ts';
import { parseConfig } from '../config.ts';
import { createMetrics } from '../obs/metrics.ts';

const SAME = { 'sec-fetch-site': 'same-origin' };
let blobDir: string;
const apps: PlotiniumApp[] = [];

beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'plt-guest-profile-'));
});
afterAll(async () => {
  await rm(blobDir, { recursive: true, force: true });
});
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.app.close();
});

describe('UI-005 guest sign-ins per IP follow the profile', () => {
  it('UI-005 the local profile lets one IP start more than 3 guest sessions in an hour', async () => {
    const config = parseConfig({ BLOB_DIR: blobDir, LOG_LEVEL: 'silent' }, () => '');
    expect(config.env).toBe('local');
    const built = await buildApp(config, {
      database: null,
      authStore: new MemoryAuthStore(),
      metrics: createMetrics({ defaultMetrics: false }),
      expectedMigration: null,
      now: () => Date.UTC(2026, 9, 1, 8),
    });
    apps.push(built);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await built.app.inject({ method: 'POST', url: '/api/auth/guest', headers: SAME });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([201, 201, 201, 201, 201]);
  });
});
