/**
 * The 10-window drag trace (WM §8.2; testing §3.11.3): WM-03 without load and PROC-05 with three
 * `burn` processes. Runs in the Playwright `perf` project, nightly and per release on the lab-spec
 * runner only (a hosted run is smoke, `machine: hosted`, never gate evidence). The test writes the
 * result files; `check-budgets` compares them with budgets.json and fails the build (TST-04).
 */
import { expect, test, type Page } from '@playwright/test';

import { seedUser } from '../../fixtures/users.ts';
import { baseUrl, FIXME_UI, uiReady } from '../../support/env.ts';
import {
  bootUrl,
  launchOS,
  login,
  openApp,
  runInTerminal,
  waitForDesktop,
  type OsHandle,
} from '../../support/os.ts';
import { sel } from '../../support/selectors.ts';
import { budget } from '../budgets.ts';
import { envelope } from '../envelope.ts';
import { writePerfResult } from '../result.ts';

import { installLoafRecorder, loafEntries, nextFrame, startTrace } from './capture.ts';
import { attributeLoaf, extractFrames, frameStats, rendererPid, scriptWindow } from './parse.ts';
import { frameResults, type FrameRun } from './runs.ts';

/** WM §8.2 step 2: 4 Terminals, 3 File Explorers, 3 Editors. */
const LAYOUT = [
  ...Array.from({ length: 4 }, () => 'terminal' as const),
  ...Array.from({ length: 3 }, () => 'files' as const),
  ...Array.from({ length: 3 }, () => 'editor' as const),
];

async function openTenWindows(page: Page): Promise<void> {
  for (const app of LAYOUT) await openApp(page, app);
  await expect(sel.windows(page)).toHaveCount(LAYOUT.length);
}

/** Drags along a 300 x 200 px ellipse for about 1 s, one mouse move per animation frame. */
async function dragEllipse(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) {
    const a = (2 * Math.PI * i) / 60;
    await page.mouse.move(x + 150 * Math.sin(a), y + 100 * (1 - Math.cos(a)));
    await nextFrame(page);
  }
  await page.mouse.up();
}

async function resizeBy(page: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    const f = Math.sin((Math.PI * i) / 30);
    await page.mouse.move(x + dx * f, y + dy * f);
    await nextFrame(page);
  }
  await page.mouse.up();
}

/** WM §8.2 step 5: the 20 s script, bracketed by perf:script marks. */
async function dragScript(page: Page): Promise<void> {
  await page.evaluate(() => performance.mark('perf:script:start'));
  const count = await sel.windows(page).count();
  for (let i = 0; i < count; i++) {
    const win = sel.windows(page).nth(i);
    const bar = await win.getByTestId('window-titlebar').boundingBox();
    if (bar === null) throw new Error(`window ${i} has no title bar`);
    await dragEllipse(page, bar.x + bar.width / 2, bar.y + bar.height / 2);
    const se = await sel.resizeHandle(win, 'se').boundingBox();
    const nw = await sel.resizeHandle(win, 'nw').boundingBox();
    if (se === null || nw === null) throw new Error(`window ${i} has no resize handles`);
    await resizeBy(page, se.x + se.width / 2, se.y + se.height / 2, 200, 200);
    await resizeBy(page, nw.x + nw.width / 2, nw.y + nw.height / 2, -200, -200);
  }
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await sel.windows(page).nth(0).click();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await page.evaluate(() => performance.mark('perf:script:end'));
}

async function measureRun(os: OsHandle): Promise<FrameRun> {
  const { page } = os;
  const since = await page.evaluate(() => performance.now());
  const session = await page.context().newCDPSession(page);
  const trace = await startTrace(session);
  await dragScript(page);
  const events = await trace.stop();
  await session.detach();
  const win = scriptWindow(events);
  const origin = new URL(baseUrl()).origin;
  const pid = rendererPid(events, origin);
  if (win === undefined || pid === undefined)
    throw new Error('trace has no script window or renderer');
  const accumulators = await page.evaluate(() => {
    const acc = window.__plt?.perf?.accumulators() ?? {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(acc))
      out[k] =
        v.length === 0 ? 0 : ([...v].sort((a, b) => a - b)[Math.ceil(0.95 * v.length) - 1] ?? 0);
    return out;
  });
  return {
    stats: frameStats(extractFrames(events, win, pid)),
    loaf: attributeLoaf(await loafEntries(page, since), origin),
    accumulators,
  };
}

async function scenario(frameId: string, loafId: string, burn: boolean): Promise<void> {
  const frameBudget = budget(frameId);
  const os = await launchOS({ headless: false });
  try {
    await installLoafRecorder(os.page);
    await os.page.goto(bootUrl(baseUrl()));
    await login(os.page, seedUser('demo'));
    await waitForDesktop(os.page);
    await openTenWindows(os.page);
    if (burn) {
      await sel.windows(os.page, 'terminal').first().click();
      for (let i = 0; i < 3; i++) await runInTerminal(os.page, 'burn --ms 120000 &');
    }
    const started = Date.now();
    const runs: FrameRun[] = [];
    for (let r = 0; r < frameBudget.samples.runs; r++) runs.push(await measureRun(os));
    const vsync = runs[0]?.stats.vsyncMs;
    const env = await envelope(
      os.page,
      vsync === undefined || vsync === 0 ? {} : { refreshHz: Math.round(1000 / vsync) },
    );
    const timing = { startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
    for (const res of frameResults(frameBudget, budget(loafId), runs, env, timing))
      await writePerfResult(res);
    // The run must at least be measurable; pass or fail against the threshold is check-budgets' job.
    expect(
      runs.some((r) => r.stats.valid),
      'three invalid runs are an infrastructure failure',
    ).toBe(true);
  } finally {
    await os.close();
  }
}

test.describe('frame budgets (lab-spec runner)', () => {
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 10 * 60_000 });

  test('WM-03 dragging and resizing 10 windows records the trace-based frame p95 and LoAF attribution', async () => {
    await scenario('WM-03.drag-frame', 'WM-03.drag-loaf', false);
  });

  test('PROC-05 three burn processes and 10 windows record the trace-based frame p95 and LoAF attribution', async () => {
    await scenario('PROC-05.frame', 'PROC-05.loaf', true);
  });
});
