/**
 * Demo Day 0:08–0:18, item 4: a CPU-bound process while windows are dragged, with the frame
 * meter visible (spec §17.1; testing §3.16.5 item 4; Appendix A PROC-05 and WM-03).
 *
 * `burn --ms 120000 &` three times, `top` shows them, `framemeter on`, then every one of 10
 * windows (3 File Explorers, 3 Editors, 4 Terminals) is dragged along an ellipse and resized
 * under a Chrome trace. The judgement uses the gate method of testing §3.11.3, not the in-OS
 * meter: the nearest-rank p95 of vsync-quantised PipelineReporter frame durations must be within
 * `PROC-05.frame` and no long animation frame over 50 ms may be attributed to our origin
 * (`PROC-05.loaf`). One run on the rehearsal machine is a rehearsal check; gate evidence is the
 * three-run median on the lab-spec runner (tests/performance/frame/drag.spec.ts).
 *
 * Headed by default (PLT_DEMO_HEADLESS=1 for a smoke run): headless Chrome does not produce
 * frames the way the examiner's screen does. On a machine without a display use xvfb-run.
 */
import { expect, test } from '@playwright/test';

import { budget, miss } from '../../performance/budgets.ts';
import { framePasses } from '../../performance/frame/parse.ts';
import type { AppId } from '../../support/selectors.ts';

import {
  demoDay,
  FIXME_PROPOSED,
  FIXME_UI,
  headless,
  PROPOSED_TID,
  proposedSelectorsAdopted,
  SKIP_DEMO_DAY,
  uiReady,
} from './env.ts';
import { parseTop } from './parse.ts';
import {
  bootAs,
  measure,
  openWindows,
  recordLoaf,
  recordRehearsal,
  Shell,
  traceDrag,
  type DemoOS,
} from './session.ts';

/** WM §8.2's ten windows, Terminals last so the one we type into is on top. */
const LAYOUT: readonly AppId[] = [
  'files',
  'files',
  'files',
  'editor',
  'editor',
  'editor',
  'terminal',
  'terminal',
  'terminal',
  'terminal',
];

/** Three CPU-bound processes, as in the PROC-05 budget (`params.burn`). */
const BURNS = Number(budget('PROC-05.frame').params?.['burn'] ?? 3);

test.describe.serial('Demo Day 0:08–0:18 item 4: CPU load while 10 windows are dragged', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 6 * 60_000 });

  let demo: DemoOS;
  let shell: Shell;
  let chrome: string | null = null;
  recordRehearsal('sut', '4 CPU load + drag', () => chrome);

  test.beforeAll(async () => {
    demo = await bootAs('demo', { headless: headless(), beforeGoto: recordLoaf });
    chrome = demo.chrome;
    await openWindows(demo.page, LAYOUT);
    shell = Shell.of(demo.page, 'last');
  });

  test.afterAll(async () => {
    await demo?.close();
  });

  test('PROC-05 three burn processes run in the background and top shows them', async () => {
    for (let i = 0; i < BURNS; i++) await shell.ok('burn --ms 120000 &');
    const top = parseTop(await shell.ok('top -b -n 1'));
    const burns = top.processes.filter((p) => p.command.startsWith('burn'));
    measure('burn processes', burns.map((p) => `${p.pid}:${p.state}:PRI ${p.pri}`).join(' '));
    expect(burns.length).toBeGreaterThanOrEqual(BURNS);
  });

  test('WM-03 framemeter on turns the frame meter on before the drag', async () => {
    await shell.ok('framemeter on');
    expect(await shell.ok('framemeter status')).toMatch(/\bon\b/i);
  });

  test('PROC-05 with three burn processes, dragging and resizing 10 windows keeps the trace frame p95 within budget and no LoAF over 50 ms is ours', async () => {
    const frameBudget = budget('PROC-05.frame');
    const loafBudget = budget('PROC-05.loaf');
    const { stats, loaf, windows } = await traceDrag(demo.page);
    measure('windows', windows);
    measure('vsync ms', stats.vsyncMs.toFixed(2));
    measure('frame p95 ms', stats.p95Ms.toFixed(2));
    measure('dropped %', stats.droppedPct.toFixed(2));
    measure('on-time %', stats.onTimePct.toFixed(1));
    measure('LoAF>50 ours', loaf.over50Ours);
    measure('LoAF>50 unattributed', loaf.over50Unattributed);
    expect(windows).toBeGreaterThanOrEqual(
      Number(frameBudget.params?.['windows'] ?? LAYOUT.length),
    );
    expect(stats.valid, stats.invalidReason ?? '').toBe(true);
    expect(
      framePasses(stats, frameBudget.threshold),
      `frame p95 ${stats.p95Ms.toFixed(2)} ms (vsync ${stats.vsyncMs.toFixed(2)} ms, ${stats.onTimePct.toFixed(1)}% on time) misses ${frameBudget.threshold} ms`,
    ).toBe(true);
    expect(
      miss(loafBudget, loaf.over50Ours),
      `our LoAF sources: ${loaf.sources.join(', ')}`,
    ).toBeUndefined();
  });

  test('WMD-19 the frame meter overlay shows its p95 and our LoAF count while windows move', async () => {
    test.fixme(!proposedSelectorsAdopted(), FIXME_PROPOSED);
    const meter = demo.page.getByTestId(PROPOSED_TID.frameMeter);
    await expect(meter).toBeVisible();
    const p95 = Number(await meter.getAttribute('data-p95-ms'));
    const ours = Number(await meter.getAttribute('data-loaf-ours'));
    measure('meter p95 ms', p95);
    expect(Number.isFinite(p95) && p95 > 0).toBe(true);
    expect(Number.isInteger(ours)).toBe(true);
  });
});
