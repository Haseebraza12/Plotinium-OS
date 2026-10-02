/**
 * Demo Day 0:08–0:18, item 5: a workload of twice the memory budget, with paging shown (spec
 * §17.1; testing §3.16.5 item 5; Appendix A MEM-06; memory-and-paging).
 *
 * alice minimises a File Explorer (its process joins the `minimised` eviction class, WMD-13),
 * reads the budget with `free`, starts `memhog --total <2 x budget> --procs 8 &`, and watches
 * `free` and `vmstat`: accounted memory never goes above the budget (reservation-based admission,
 * C13: ours is 0 ms over, the spec allows 1 s) while faults and bytes paged out rise, and the tab
 * never crashes. Restoring the minimised window ("Restoring… n / m MB") and the Task Manager
 * Memory tab need the proposed selectors (fixme until adopted).
 *
 * This item comes after the hidden semantic query (AIS-11): the workload can evict `ai.embed`.
 */
import { expect, test } from '@playwright/test';

import { budget } from '../../performance/budgets.ts';
import { openApp } from '../../support/os.ts';
import { sel, TID } from '../../support/selectors.ts';

import {
  demoDay,
  FIXME_PROPOSED,
  FIXME_UI,
  PROPOSED_TID,
  proposedSelectorsAdopted,
  SKIP_DEMO_DAY,
  uiReady,
} from './env.ts';
import { pagedOutKiBs, parseFree, parseVmstat, type FreeReport } from './parse.ts';
import { bootAs, measure, recordRehearsal, Shell, type DemoOS } from './session.ts';

/** `free -m` prints one decimal: allow the rounding of one printed value. */
const PRINT_SLACK_MIB = 0.05;

test.describe
  .serial('Demo Day 0:08–0:18 item 5: twice the memory budget with paging visible', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 5 * 60_000 });

  let alice: DemoOS;
  let shell: Shell;
  let budgetMiB = 0;
  let crashed = false;
  let chrome: string | null = null;
  recordRehearsal('sut', '5 2x memory', () => chrome);

  test.beforeAll(async () => {
    alice = await bootAs('alice');
    chrome = alice.chrome;
    alice.page.on('crash', () => {
      crashed = true;
    });
    shell = await Shell.open(alice.page);
    const files = await openApp(alice.page, 'files');
    await files.getByTestId(TID.windowMinimise).click();
    await expect(files).toBeHidden();
  });

  test.afterAll(async () => {
    await alice?.close();
  });

  test('MEM-01 free shows the default memory budget before the workload starts', async () => {
    const free = parseFree(await shell.ok('free -m'));
    expect(free, 'free printed no Mem: line').toBeDefined();
    budgetMiB = free?.budget ?? 0;
    measure('budget MiB', budgetMiB);
    expect(budgetMiB).toBe(budget('MEM-01.default-budget').threshold);
  });

  test('MEM-06 a workload of twice the budget never pushes accounted memory above the budget and the tab stays alive', async () => {
    expect(budgetMiB).toBeGreaterThan(0);
    const total = Math.round(2 * budgetMiB);
    measure('memhog', `--total ${total}M --procs 8`);
    await shell.ok(`memhog --total ${total}M --procs 8 &`);
    const samples: FreeReport[] = [];
    // Sample until paging is visibly under way (bytes out > 0) and we have at least 5 samples.
    await expect
      .poll(
        async () => {
          const f = parseFree(await shell.ok('free -m'));
          if (f !== undefined) samples.push(f);
          return samples.length >= 5 && (f?.paging?.outMiB ?? 0) > 0;
        },
        { timeout: 120_000, intervals: [1_000], message: 'no page-out seen in free within 120 s' },
      )
      .toBe(true);
    const maxAccounted = Math.max(...samples.map((s) => s.accounted));
    measure('samples', samples.length);
    measure('max accounted MiB', maxAccounted);
    measure('paged out MiB', samples[samples.length - 1]?.paging?.outMiB ?? 0);
    for (const s of samples)
      expect(
        s.accounted,
        `accounted ${s.accounted} MiB above the ${s.budget} MiB budget`,
      ).toBeLessThanOrEqual(s.budget + PRINT_SLACK_MIB);
    expect(crashed, 'the tab crashed under the 2x workload').toBe(false);
  });

  test('MEM-07 vmstat shows pages going out while memhog runs', async () => {
    const rows = parseVmstat(await shell.ok('vmstat 1 3', { timeoutMs: 30_000 }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const out = Math.max(...rows.map(pagedOutKiBs));
    measure('max page-out KiB/s', out);
    measure('max faults/s', Math.max(...rows.map((r) => r['flt/s'] ?? 0)));
    expect(out).toBeGreaterThan(0);
    expect(crashed).toBe(false);
  });

  test('WM-05 clicking the minimised window shows Restoring with real byte progress and pages it back in', async () => {
    test.fixme(!proposedSelectorsAdopted(), FIXME_PROPOSED);
    const { page } = alice;
    await sel.dockItem(page, 'files').click();
    const win = sel.windows(page, 'files').last();
    const restoring = win.getByTestId(PROPOSED_TID.windowRestoring);
    await expect(restoring).toBeVisible();
    await expect(restoring).toHaveAttribute('role', 'progressbar');
    await expect(restoring).toBeHidden({ timeout: 30_000 });
    await expect(win.getByTestId(TID.files)).toBeVisible();
  });

  test('MEM-07 the Task Manager Memory tab shows faults and bytes out per process', async () => {
    test.fixme(!proposedSelectorsAdopted(), FIXME_PROPOSED);
    const tm = await openApp(alice.page, 'task-manager');
    await tm.locator(`[data-testid="${PROPOSED_TID.taskManagerTab}"][data-tab="memory"]`).click();
    const rows = tm.getByTestId(PROPOSED_TID.memoryRow);
    await expect(rows.first()).toBeVisible();
    const bytesOut = await rows.evaluateAll((els) =>
      els.map((e) => Number(e.getAttribute('data-bytes-out') ?? '0')),
    );
    expect(Math.max(...bytesOut)).toBeGreaterThan(0);
  });
});
