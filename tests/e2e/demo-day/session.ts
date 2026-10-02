/**
 * Driving the OS the way the examiner does on Demo Day (spec §17.1; testing §3.16.4–§3.16.5):
 * log in as a seeded account, type commands into a real Terminal, answer the secure prompt, cut
 * the network, crash a renderer, drag windows under a Chrome trace. Selectors come only from
 * tests/e2e/SELECTORS.md (plus the proposed ids of env.ts, behind their own gate); every wait is
 * on an OS event, a hook or a visible test id, never a fixed sleep (testing §3.14).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import type { SeedUser, SeedUsername } from '../../fixtures/users.ts';
import {
  installLoafRecorder,
  loafEntries,
  nextFrame,
  startTrace,
} from '../../performance/frame/capture.ts';
import {
  attributeLoaf,
  extractFrames,
  frameStats,
  rendererPid,
  scriptWindow,
  type FrameStats,
  type LoafSummary,
} from '../../performance/frame/parse.ts';
import { baseUrl } from '../../support/env.ts';
import {
  BOOT_TIMEOUT_MS,
  bootUrl,
  launchOS,
  login,
  openApp,
  runInTerminal,
  terminalText,
  waitForDesktop,
  type OsHandle,
  type OsOptions,
} from '../../support/os.ts';
import { sel, TID, type AppId } from '../../support/selectors.ts';

import { demoUser } from './compose.ts';
import { networkLabel, rehearsalLabel } from './env.ts';
import { shellQuote, splitRun, STATUS_COMMAND, type CommandRun } from './parse.ts';
import {
  appendEntry,
  machineSummary,
  MEASURE_PREFIX,
  measurementsFrom,
  requirementOf,
  type SegmentId,
} from './protocol.ts';

// ---------------------------------------------------------------------------------------------
// Boot and login
// ---------------------------------------------------------------------------------------------

export interface DemoOS extends OsHandle {
  user: SeedUser;
  /** Chrome version from the user agent, for the rehearsal record. */
  chrome: string | null;
}

export interface DemoBootOptions extends OsOptions {
  /** Runs after Chrome starts and before the first navigation (init scripts, CDP). */
  beforeGoto?: (os: OsHandle) => Promise<void>;
  /** The scripts read the Terminal through `window.__plt`; only the bring-up can do without. */
  requireHooks?: boolean;
}

export const HOOKS_MISSING =
  'window.__plt is missing: the rehearsal scripts need a test build (PLT_TEST_BUILD=1 docker compose up -d --wait --build); only the bring-up runs against the release build';

export async function assertTestHooks(page: Page): Promise<void> {
  const present = await page.evaluate(() => window.__plt !== undefined);
  if (!present) throw new Error(HOOKS_MISSING);
}

export async function chromeVersion(page: Page): Promise<string | null> {
  const ua = await page.evaluate(() => navigator.userAgent);
  return /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? null;
}

/** Fresh persistent profile, boot, log in as `name` with the examiner's password, desktop. */
export async function bootAs(name: SeedUsername, opts: DemoBootOptions = {}): Promise<DemoOS> {
  const user = await demoUser(name);
  const os = await launchOS(opts);
  try {
    if (opts.beforeGoto !== undefined) await opts.beforeGoto(os);
    await os.page.goto(bootUrl(opts.baseURL ?? baseUrl(), opts));
    await login(os.page, user);
    await waitForDesktop(os.page);
    if (opts.requireHooks !== false) await assertTestHooks(os.page);
    return { ...os, user, chrome: await chromeVersion(os.page) };
  } catch (err) {
    await os.close();
    throw err;
  }
}

/**
 * After `reboot` has navigated: a cached session boots straight to the desktop; otherwise the
 * login screen appears (offline: with the offline-verifier notice, OFF-03) and we log in again.
 */
export async function desktopAfterReboot(
  page: Page,
  user: SeedUser,
  offline: boolean,
): Promise<void> {
  const loginScreen = page.getByTestId(TID.loginScreen);
  const desktop = page.getByTestId(TID.desktop);
  await expect(loginScreen.or(desktop).first()).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  if (await loginScreen.isVisible()) {
    if (offline) await expect(page.getByTestId(TID.loginOfflineNotice)).toBeVisible();
    await login(page, user);
  }
  await waitForDesktop(page);
}

/** "End A's renderer in Chrome's Task Manager" (testing §3.16.5 item 7): a real renderer crash. */
export async function crashRenderer(page: Page): Promise<void> {
  const crashed = page.waitForEvent('crash');
  const session = await page.context().newCDPSession(page);
  // The call never answers: the target dies with it.
  void session.send('Page.crash').catch(() => undefined);
  await crashed;
}

// ---------------------------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------------------------

export async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

export async function waitIdle(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => window.__plt?.terminal.idle() === true, undefined, { timeout });
}

export interface RunOptions {
  timeoutMs?: number;
  /** For commands that stop at a prompt (`su`, `ai`): answer it, then the run waits for idle. */
  interact?: (page: Page) => Promise<void>;
}

/** The compositor-owned secure prompt of `su` (C10, C12): the password never reaches the TTY. */
export function answerSecurePrompt(password: string | undefined): (page: Page) => Promise<void> {
  return async (page) => {
    if (password === undefined)
      throw new Error('no root password: set PLT_TEST_ROOT_PASSWORD or use the local stack');
    const prompt = page.getByTestId(TID.securePrompt);
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    const field = prompt.locator('input[type="password"]');
    await field.fill(password);
    await field.press('Enter');
    await expect(prompt).toBeHidden({ timeout: 15_000 });
  };
}

/** A Terminal window and its xterm host, driven through the keyboard like the examiner. */
export class Shell {
  readonly page: Page;
  readonly host: Locator;

  constructor(page: Page, host: Locator) {
    this.page = page;
    this.host = host;
  }

  /** Opens a new Terminal from the dock. */
  static async open(page: Page): Promise<Shell> {
    const win = await openApp(page, 'terminal');
    const shell = new Shell(page, win.getByTestId(TID.terminal));
    await shell.focus();
    return shell;
  }

  /** An already open Terminal. */
  static of(page: Page, which: 'first' | 'last' = 'last'): Shell {
    const wins = sel.windows(page, 'terminal');
    return new Shell(
      page,
      (which === 'first' ? wins.first() : wins.last()).getByTestId(TID.terminal),
    );
  }

  async focus(): Promise<void> {
    await this.host.click();
  }

  /**
   * `clear`, the command, then `echo "rc=$?"`: returns what the command printed and its status.
   * `clear` keeps the buffer to this command only, so parsing never sees an earlier run.
   */
  async run(command: string, opts: RunOptions = {}): Promise<CommandRun> {
    const timeout = opts.timeoutMs ?? 30_000;
    await this.focus();
    await runInTerminal(this.page, 'clear');
    if (opts.interact === undefined) {
      await runInTerminal(this.page, command, timeout);
    } else {
      await typeLine(this.page, command);
      await opts.interact(this.page);
      await waitIdle(this.page, timeout);
      await this.focus();
    }
    await runInTerminal(this.page, STATUS_COMMAND);
    return splitRun(await terminalText(this.page), command);
  }

  /** Runs a command that must succeed and returns its output. */
  async ok(command: string, opts: RunOptions = {}): Promise<string> {
    const r = await this.run(command, opts);
    expect(r.status, `${command} exited ${r.status}:\n${r.output}`).toBe(0);
    return r.output;
  }

  /** `su -c '<command>'` (quoted by {@link shellQuote}) with the root password typed into the secure prompt. */
  async asRoot(
    command: string,
    rootPassword: string | undefined,
    opts: RunOptions = {},
  ): Promise<CommandRun> {
    return this.run(`su -c ${shellQuote(command)}`, {
      ...opts,
      interact: answerSecurePrompt(rootPassword),
    });
  }

  /**
   * Starts a full-screen live command (`top`), waits until its screen matches `until`, quits with
   * `quitKey`, and returns the matching screen. Nothing is typed while it waits, so the OS sees
   * the user as idle (pre-fetch starts only after 2 s of idle, PRE-04).
   */
  async watch(command: string, until: RegExp, timeoutMs: number, quitKey = 'q'): Promise<string> {
    await this.focus();
    await runInTerminal(this.page, 'clear');
    await typeLine(this.page, command);
    let screen = '';
    await expect
      .poll(
        async () => {
          screen = await terminalText(this.page);
          return until.test(screen);
        },
        { timeout: timeoutMs, message: `${command} never showed ${String(until)}` },
      )
      .toBe(true);
    await this.page.keyboard.press(quitKey);
    await waitIdle(this.page, 15_000);
    return screen;
  }
}

// ---------------------------------------------------------------------------------------------
// Ten windows, dragged under a Chrome trace (PROC-05, WM-03; testing §3.11.3)
// ---------------------------------------------------------------------------------------------

/** WM §8.2 step 2: 4 Terminals, 3 File Explorers, 3 Editors. */
export const TEN_WINDOWS: readonly AppId[] = [
  'terminal',
  'terminal',
  'terminal',
  'terminal',
  'files',
  'files',
  'files',
  'editor',
  'editor',
  'editor',
];

export async function openWindows(
  page: Page,
  layout: readonly AppId[] = TEN_WINDOWS,
): Promise<void> {
  const before = await sel.windows(page).count();
  for (const app of layout) await openApp(page, app);
  await expect(sel.windows(page)).toHaveCount(before + layout.length);
}

/** About one second along a 300 x 200 px ellipse, one mouse move per animation frame. */
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

async function resizeOut(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    const f = Math.sin((Math.PI * i) / 30);
    await page.mouse.move(x + 160 * f, y + 120 * f);
    await nextFrame(page);
  }
  await page.mouse.up();
}

/** Drags and resizes every open window, bracketed by the `perf:script` marks (SELECTORS.md §4). */
export async function dragAndResizeAll(page: Page): Promise<number> {
  await page.evaluate(() => performance.mark('perf:script:start'));
  const count = await sel.windows(page).count();
  for (let i = 0; i < count; i++) {
    const win = sel.windows(page).nth(i);
    const bar = await win.getByTestId(TID.windowTitleBar).boundingBox();
    if (bar === null) throw new Error(`window ${i} has no title bar`);
    await dragEllipse(page, bar.x + bar.width / 2, bar.y + bar.height / 2);
    const se = await sel.resizeHandle(win, 'se').boundingBox();
    if (se === null) throw new Error(`window ${i} has no se resize handle`);
    await resizeOut(page, se.x + se.width / 2, se.y + se.height / 2);
  }
  await page.evaluate(() => performance.mark('perf:script:end'));
  return count;
}

export interface FrameMeasurement {
  stats: FrameStats;
  loaf: LoafSummary;
  windows: number;
}

/** Call before the first navigation: records long animation frames for LoAF attribution. */
export async function recordLoaf(os: OsHandle): Promise<void> {
  await installLoafRecorder(os.page);
}

/** One traced drag run: the trace-based frame statistics and our share of LoAF over 50 ms. */
export async function traceDrag(page: Page): Promise<FrameMeasurement> {
  const since = await page.evaluate(() => performance.now());
  const session = await page.context().newCDPSession(page);
  const trace = await startTrace(session);
  let windows: number;
  try {
    windows = await dragAndResizeAll(page);
  } catch (err) {
    // End the trace anyway, or the next CDP session on this page cannot start one.
    await trace.stop().catch(() => undefined);
    await session.detach().catch(() => undefined);
    throw err;
  }
  const events = await trace.stop();
  await session.detach();
  const origin = new URL(baseUrl()).origin;
  const win = scriptWindow(events);
  const pid = rendererPid(events, origin);
  if (win === undefined || pid === undefined)
    throw new Error('the trace has no perf:script window or no renderer for our origin');
  return {
    stats: frameStats(extractFrames(events, win, pid)),
    loaf: attributeLoaf(await loafEntries(page, since), origin),
    windows,
  };
}

// ---------------------------------------------------------------------------------------------
// Rehearsal record (TST-18)
// ---------------------------------------------------------------------------------------------

/** Adds a number or fact to the current test's rehearsal record entry and HTML report. */
export function measure(name: string, value: string | number | boolean): void {
  test.info().annotations.push({ type: `${MEASURE_PREFIX}${name}`, description: String(value) });
}

/**
 * Registers an afterEach hook that appends each executed test of the enclosing describe block to
 * the rehearsal record (protocol.ts `recordFile`). Call inside `test.describe`.
 */
export function recordRehearsal(seg: SegmentId, item: string, chrome: () => string | null): void {
  test.afterEach(async () => {
    const info = test.info();
    await appendEntry({
      run: rehearsalLabel(),
      network: networkLabel(),
      machine: machineSummary(),
      chrome: chrome(),
      segment: seg,
      item,
      title: info.title,
      req: requirementOf(info.title),
      status: info.status ?? 'interrupted',
      startedAt: new Date(Date.now() - info.duration).toISOString(),
      durationMs: info.duration,
      measurements: measurementsFrom(info.annotations),
    });
  });
}
