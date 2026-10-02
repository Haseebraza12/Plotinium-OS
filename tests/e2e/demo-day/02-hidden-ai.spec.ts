/**
 * Demo Day 0:08–0:18, items 1–3: the hidden AI prompts (spec §17.1; testing §3.16.5;
 * ai-safety-and-evaluation §3.14, AIS-11). They run first in the system-under-test segment, so
 * the 2x memory workload cannot have evicted `ai.embed` before the query is judged.
 *
 * 1. Semantic query: `semsearch "<hidden query>"` as alice gives ranked results with
 *    `path:line` citations (RAG-06); bob's identical query shows none of alice's private files
 *    (RAG-03). The same in the Files search box needs proposed selectors (fixme).
 * 2. Agent: `ai "<instruction>"` prints the plan, the dry run with its blast radius and the
 *    kernel-owned `Proceed? [y/N/e]` prompt; Enter means N and nothing changes (AGT-03); `y`
 *    commits one transaction with a txn id (AGT-05); `ai log` shows both (AGT-08). Needs a
 *    planner (PLT_DEMO_AI=1); without one, the agent must say "unavailable — nothing was run"
 *    (AIS-02 graceful absence), which is what the examiner's local stack shows.
 * 3. Pre-fetch: `predict` shows the top 3 with confidence and reason; while the user is idle a
 *    `prefetch:<app>` job runs at priority 39; the predicted app then launches faster
 *    (`predict --latency`) (PRE-06, PRE-03).
 *
 * The prompts are hidden on Demo Day: PLT_DEMO_QUERY and PLT_DEMO_INSTRUCTION replace the
 * rehearsal defaults with the examiner-style ones R4 prepares.
 */
import { expect, test } from '@playwright/test';

import { openApp } from '../../support/os.ts';
import { sel, TID } from '../../support/selectors.ts';

import {
  demoDay,
  FIXME_PLANNER,
  FIXME_PROPOSED,
  FIXME_UI,
  hiddenInstruction,
  hiddenQuery,
  plannerAvailable,
  PROPOSED_TID,
  proposedSelectorsAdopted,
  SKIP_DEMO_DAY,
  SKIP_HAS_PLANNER,
  uiReady,
} from './env.ts';
import {
  appIdOf,
  hitsInHomeOf,
  parseAgentLogOutcomes,
  parseAgentRun,
  parseChecksum,
  parseLaunchLatency,
  parsePredict,
  parseSemsearch,
  parseTop,
  scoresNonIncreasing,
  shellQuote,
} from './parse.ts';
import { bootAs, measure, recordRehearsal, Shell, type DemoOS } from './session.ts';

test.describe.serial('Demo Day 0:08–0:18 item 1: hidden semantic query', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 3 * 60_000 });

  const query = hiddenQuery();
  let alice: DemoOS;
  let bob: DemoOS;
  let chrome: string | null = null;
  recordRehearsal('sut', '1 semantic query', () => chrome);

  test.beforeAll(async () => {
    alice = await bootAs('alice');
    bob = await bootAs('bob');
    chrome = alice.chrome;
  });

  test.afterAll(async () => {
    await alice?.close();
    await bob?.close();
  });

  test('RAG-06 the hidden semantic query returns ranked results with path:line citations in the Terminal', async () => {
    const shell = await Shell.open(alice.page);
    const run = await shell.run(`semsearch ${shellQuote(query)}`, { timeoutMs: 60_000 });
    const report = parseSemsearch(run.output);
    measure('query', query);
    measure('results', report.hits.length);
    measure(
      'top',
      report.hits[0] === undefined
        ? 'none'
        : `${report.hits[0].path}:${report.hits[0].lineStart} ${report.hits[0].score}`,
    );
    if (report.notices.length > 0) measure('notices', report.notices.join(' | '));
    expect(
      run.status,
      `semsearch exited ${run.status} (0 results found, 1 none):\n${run.output}`,
    ).toBe(0);
    expect(report.hits.length).toBeGreaterThan(0);
    expect(report.hits.length).toBeLessThanOrEqual(5);
    expect(scoresNonIncreasing(report.hits), 'results are not ranked by score').toBe(true);
    for (const h of report.hits) expect(h.lineEnd).toBeGreaterThanOrEqual(h.lineStart);
  });

  test("RAG-03 bob's identical query shows none of alice's private files", async () => {
    const shell = await Shell.open(bob.page);
    const run = await shell.run(`semsearch ${shellQuote(query)}`, { timeoutMs: 60_000 });
    expect([0, 1], `semsearch failed:\n${run.output}`).toContain(run.status);
    const report = parseSemsearch(run.output);
    measure('bob results', report.hits.length);
    expect(hitsInHomeOf(report.hits, 'alice')).toEqual([]);
  });

  test('RAG-06 the same query in the Files search box shows the same citations', async () => {
    test.fixme(!proposedSelectorsAdopted(), FIXME_PROPOSED);
    const { page } = alice;
    const shell = Shell.of(page);
    const cli = parseSemsearch(
      (await shell.run(`semsearch -k 5 ${shellQuote(query)}`, { timeoutMs: 60_000 })).output,
    );
    const files = await openApp(page, 'files');
    const box = files.getByTestId(PROPOSED_TID.filesSearch);
    await box.click();
    await box.fill(query);
    await box.press('Enter');
    const results = files.getByTestId(PROPOSED_TID.filesSearchResult);
    await expect(results.first()).toBeVisible({ timeout: 30_000 });
    const firstPath = await results.first().getAttribute('data-path');
    // Files searches the current folder (scope), so its top hit must be one of the CLI's hits.
    expect(cli.hits.map((h) => h.path.replace(/^~/, `/home/${alice.user.username}`))).toContain(
      firstPath,
    );
  });
});

test.describe
  .serial('Demo Day 0:08–0:18 item 2: agent instruction with a destructive confirmation', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  test.fixme(!plannerAvailable(), FIXME_PLANNER);
  test.describe.configure({ timeout: 4 * 60_000 });

  const custom = hiddenInstruction();
  /** Rehearsal default: a destructive plan (delete) over a folder the script prepares. */
  const instruction = custom ?? 'delete every .log file in ~/demo-agent';
  /** Subtree whose checksum proves "nothing changed" after a decline. */
  const scope = custom === undefined ? '~/demo-agent' : '~';
  let alice: DemoOS;
  let shell: Shell;
  let before = '';
  let chrome: string | null = null;
  recordRehearsal('sut', '2 agent', () => chrome);

  test.beforeAll(async () => {
    alice = await bootAs('alice');
    chrome = alice.chrome;
    shell = await Shell.open(alice.page);
    if (custom === undefined) {
      await shell.ok('rm -rf ~/demo-agent');
      await shell.ok('mkdir -p ~/demo-agent');
      await shell.ok('touch ~/demo-agent/build.log ~/demo-agent/test.log ~/demo-agent/keep.txt');
    }
    before = parseChecksum(await shell.ok(`fsck --checksum ${scope}`))?.sha256 ?? '';
  });

  test.afterAll(async () => {
    await alice?.close();
  });

  test('AGT-03 the plan shows a dry run and a kernel-owned [y/N/e] prompt, and Enter declines with nothing changed', async () => {
    measure('instruction', instruction);
    const run = await shell.run(`ai ${shellQuote(instruction)}`, {
      timeoutMs: 120_000,
      interact: async (page) => {
        await expect(page.getByTestId(TID.agentConfirm)).toBeVisible({ timeout: 90_000 });
        await page.keyboard.press('Enter');
      },
    });
    const agent = parseAgentRun(run.output);
    measure('blast radius', agent.blastRadius ?? 'none');
    expect(agent.planned, `no plan printed:\n${run.output}`).toBe(true);
    expect(agent.blastRadius).not.toBeNull();
    expect(agent.prompted).toBe(true);
    expect(agent.committed).toBeNull();
    expect(run.status, 'ai exits 1 when declined').toBe(1);
    expect(before).not.toBe('');
    expect(parseChecksum(await shell.ok(`fsck --checksum ${scope}`))?.sha256).toBe(before);
  });

  test('AGT-05 answering y commits the plan as one transaction with a txn id', async () => {
    const run = await shell.run(`ai ${shellQuote(instruction)}`, {
      timeoutMs: 120_000,
      interact: async (page) => {
        await expect(page.getByTestId(TID.agentConfirm)).toBeVisible({ timeout: 90_000 });
        await page.keyboard.type('y');
        await page.keyboard.press('Enter');
      },
    });
    const agent = parseAgentRun(run.output);
    expect(agent.committed, `not committed:\n${run.output}`).not.toBeNull();
    measure('txn', agent.committed?.txn ?? '');
    measure('commit ms', agent.committed?.ms ?? '');
    expect(run.status).toBe(0);
    if (custom === undefined) {
      const left = await shell.ok('ls ~/demo-agent');
      expect(left).toContain('keep.txt');
      expect(left).not.toMatch(/\.log\b/);
    }
  });

  test('AGT-08 ai log shows the declined and the committed request with their outcomes', async () => {
    const outcomes = parseAgentLogOutcomes(await shell.ok('ai log -n 2'));
    measure('outcomes', outcomes.join(','));
    expect(outcomes).toEqual(expect.arrayContaining(['declined', 'committed']));
  });
});

test.describe('Demo Day 0:08–0:18 item 2 without a planner: honest degradation', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.skip(plannerAvailable(), SKIP_HAS_PLANNER);
  test.fixme(!uiReady(), FIXME_UI);
  let chrome: string | null = null;
  recordRehearsal('sut', '2 agent (no planner)', () => chrome);

  test('AIS-02 without a planner the agent prints the unavailable notice, nothing was run, and ai log still works', async () => {
    const alice = await bootAs('alice');
    try {
      chrome = alice.chrome;
      const shell = await Shell.open(alice.page);
      const before = parseChecksum(await shell.ok('fsck --checksum ~'))?.sha256;
      const run = await shell.run(
        `ai ${shellQuote(hiddenInstruction() ?? 'delete every .log file in my home')}`,
        {
          timeoutMs: 60_000,
        },
      );
      const agent = parseAgentRun(run.output);
      expect(agent.unavailable, `expected the unavailable notice:\n${run.output}`).toBe(true);
      expect(agent.committed).toBeNull();
      expect(run.status).not.toBe(0);
      expect(parseChecksum(await shell.ok('fsck --checksum ~'))?.sha256).toBe(before);
      await shell.ok('ai log -n 1');
    } finally {
      await alice.close();
    }
  });
});

test.describe.serial('Demo Day 0:08–0:18 item 3: pre-fetch demonstration', () => {
  test.skip(!demoDay(), SKIP_DEMO_DAY);
  test.fixme(!uiReady(), FIXME_UI);
  test.describe.configure({ timeout: 3 * 60_000 });

  let demo: DemoOS;
  let shell: Shell;
  let top1: string | undefined;
  let chrome: string | null = null;
  recordRehearsal('sut', '3 pre-fetch', () => chrome);

  test.beforeAll(async () => {
    // The demo account carries the opted-in recorded trace, so a fresh browser has a trained model.
    demo = await bootAs('demo');
    chrome = demo.chrome;
    shell = await Shell.open(demo.page);
  });

  test.afterAll(async () => {
    await demo?.close();
  });

  test('PRE-06 predict shows up to three apps with confidence and reason from the trained model', async () => {
    const report = parsePredict(await shell.ok('predict'));
    measure('model', report.model ?? 'none');
    measure('top 3', report.predictions.map((p) => `${p.app} ${p.confidence}`).join(', '));
    expect(report.model, 'no model line').not.toBeNull();
    expect(report.predictions.length).toBeGreaterThan(0);
    expect(report.predictions.length).toBeLessThanOrEqual(3);
    expect(report.predictions.map((p) => p.rank)).toEqual(report.predictions.map((_, i) => i + 1));
    for (let i = 0; i < report.predictions.length; i++) {
      const p = report.predictions[i];
      expect(p?.confidence).toBeGreaterThanOrEqual(0);
      expect(p?.confidence).toBeLessThanOrEqual(1);
      expect(p?.reason).not.toBe('');
      if (i > 0)
        expect(p?.confidence).toBeLessThanOrEqual(report.predictions[i - 1]?.confidence ?? 1);
    }
    top1 = report.predictions[0]?.app;
  });

  test('PRE-06 while the user is idle a prefetch job for a predicted app runs at priority 39', async () => {
    // Nothing is typed while top refreshes, so the idle condition of PRE-04 can hold.
    const screen = await shell.watch('top -d 0.5', /prefetch:[\w-]+/, 60_000);
    const job = parseTop(screen).processes.find((p) => p.command.startsWith('prefetch:'));
    expect(job, `no prefetch job in:\n${screen}`).toBeDefined();
    measure(
      'prefetch job',
      job === undefined ? 'none' : `${job.command} pid ${job.pid} PRI ${job.pri}`,
    );
    expect(job?.pri).toBe(39);
  });

  test('PRE-03 launching the predicted app hits the pre-fetch and predict --latency shows a shorter launch', async () => {
    const app = top1 === undefined ? undefined : appIdOf(top1);
    expect(app, `predict's top app "${top1 ?? ''}" has no dock item`).toBeDefined();
    if (app === undefined) return;
    const { page } = demo;
    const before = await sel.windows(page, app).count();
    await sel.dockItem(page, app).click();
    await expect(sel.windows(page, app)).toHaveCount(before + 1);
    // Close it again so the Terminal is on top for the next command.
    await sel.windows(page, app).last().getByTestId(TID.windowClose).click();
    const latency = parseLaunchLatency(await shell.ok('predict --latency'));
    measure('launch with prefetch ms', latency.withPrefetchMs ?? 'n/a');
    measure('launch without prefetch ms', latency.withoutPrefetchMs ?? 'n/a');
    expect(latency.withPrefetchMs).not.toBeNull();
    expect(latency.withoutPrefetchMs).not.toBeNull();
    expect(latency.withPrefetchMs ?? Infinity).toBeLessThan(latency.withoutPrefetchMs ?? 0);
  });

  test('PRE-06 the Task Manager Predictions tab shows the same top prediction', async () => {
    test.fixme(!proposedSelectorsAdopted(), FIXME_PROPOSED);
    const { page } = demo;
    const tm = await openApp(page, 'task-manager');
    await tm
      .locator(`[data-testid="${PROPOSED_TID.taskManagerTab}"][data-tab="predictions"]`)
      .click();
    const rows = tm.getByTestId(PROPOSED_TID.predictionRow);
    await expect(rows.first()).toBeVisible();
    expect(await rows.first().getAttribute('data-app')).toBe(
      top1 === undefined ? null : (appIdOf(top1) ?? null),
    );
  });
});
