/**
 * The harness's browser-side helpers against real Google Chrome and small fake pages: the progress,
 * announcement and LoAF recorders, the test-hook readers, the login and desktop waits, axe in a
 * forced theme, the result envelope, and the frame parser on a real Chrome trace (TST-05 needs the
 * parser to hold on the Chrome actually installed, not only on the synthetic fixture).
 *
 * Skipped when Chrome stable cannot be launched (`pnpm exec playwright install chrome`).
 */
import type { BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { announcements, installAnnouncementRecorder, tooFrequent } from '../a11y/announce.ts';
import { scan } from '../a11y/axe.ts';
import { seedUser } from '../fixtures/users.ts';
import { envelope } from '../performance/envelope.ts';
import {
  installLoafRecorder,
  loafEntries,
  nextFrame,
  startTrace,
} from '../performance/frame/capture.ts';
import {
  attributeLoaf,
  extractFrames,
  frameStats,
  rendererPid,
  scriptWindow,
} from '../performance/frame/parse.ts';

import { bootRecord, clientSnapshot, layout, sessionId } from './hooks.ts';
import {
  launchOS,
  login,
  openApp,
  runInTerminal,
  terminalText,
  waitForDesktop,
  type OsHandle,
} from './os.ts';
import { installProgressRecorder, isNonDecreasing, progressSamples } from './progress.ts';
import { sel, TID } from './selectors.ts';

const ORIGIN = 'http://plotinium.test';

let os: OsHandle | undefined;
let skipReason = '';

/** Serves `html` for every navigation to the fake origin, plus a /version.json. */
async function serve(context: BrowserContext, html: string): Promise<void> {
  await context.unrouteAll();
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/version.json') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ version: '0.2.0', build: 'a1f93c2' }),
      });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
}

async function fresh(html: string): Promise<Page> {
  if (os === undefined) throw new Error(skipReason);
  await serve(os.context, html);
  await os.page.goto(`${ORIGIN}/`);
  return os.page;
}

beforeAll(async () => {
  try {
    os = await launchOS({ baseURL: ORIGIN });
  } catch (err) {
    skipReason = `Chrome stable is not available: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }
}, 60_000);

afterAll(async () => {
  await os?.close();
});

describe('TST-13 harness helpers in real Chrome', () => {
  it('BOOT-02 the progress recorder sees every aria-valuenow change from the first byte', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    await installProgressRecorder(os.context);
    const page =
      await fresh(`<div role="progressbar" aria-label="Boot progress" aria-valuenow="0"></div>
      <script>
        const bar = document.querySelector('[role=progressbar]');
        let v = 0;
        const step = () => { v += 20; bar.setAttribute('aria-valuenow', String(v)); if (v < 100) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      </script>`);
    await page.waitForFunction(
      () => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '100',
    );
    const samples = await progressSamples(page);
    expect(samples.map((s) => s.v)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(isNonDecreasing(samples)).toBe(true);
  });

  it('BOOT-13 the announcement recorder records status-region text changes with their times', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    await installAnnouncementRecorder(os.context);
    const page = await fresh(`<p role="status" id="s"></p>
      <script>
        const s = document.getElementById('s');
        s.textContent = 'Loading kernel · 10 of 104 KB';
        setTimeout(() => { s.textContent = 'Loading kernel · 90 of 104 KB'; }, 50);
        setTimeout(() => { s.firstChild.data = 'Stage 4 · Service start'; }, 100);
      </script>`);
    await page.waitForFunction(() => (window.__pltAnnouncements ?? []).length >= 3);
    const list = await announcements(page);
    expect(list.map((a) => a.text)).toEqual([
      'Loading kernel · 10 of 104 KB',
      'Loading kernel · 90 of 104 KB',
      'Stage 4 · Service start',
    ]);
    expect(tooFrequent(list)).toHaveLength(1);
  });

  it('TST-05 a real Chrome trace of an animated page yields valid vsync-quantised frames', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    const page =
      await fresh(`<div id="box" style="width:80px;height:80px;background:#5856d6;will-change:transform"></div>
      <script>
        const box = document.getElementById('box');
        const t0 = performance.now();
        const tick = (t) => { box.style.transform = 'translateX(' + ((t - t0) / 4) % 400 + 'px)'; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      </script>`);
    const session = await os.context.newCDPSession(page);
    const trace = await startTrace(session);
    await page.evaluate(() => performance.mark('perf:script:start'));
    for (let i = 0; i < 60; i++) await nextFrame(page);
    await page.evaluate(() => performance.mark('perf:script:end'));
    const events = await trace.stop();
    await session.detach();
    const win = scriptWindow(events);
    const pid = rendererPid(events, ORIGIN);
    expect(win, 'the perf:script marks must appear as user-timing trace events').toBeDefined();
    expect(pid, 'the trace must contain PipelineReporter frames').toBeDefined();
    const frames = extractFrames(events, win as { start: number; end: number }, pid as number);
    expect(frames.length).toBeGreaterThan(10);
    const stats = frameStats(frames);
    expect(stats.vsyncMs).toBeGreaterThan(4);
    expect(stats.vsyncMs).toBeLessThan(50);
    expect(stats.frames).toBeGreaterThan(5);
  }, 60_000);

  it('TST-05 the LoAF recorder attributes a long frame to the page origin', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    await installLoafRecorder(os.page);
    const page = await fresh(`<button id="b">busy</button>
      <script>
        document.getElementById('b').addEventListener('click', () => { const end = performance.now() + 120; while (performance.now() < end) {} });
      </script>`);
    await page.click('#b');
    await nextFrame(page);
    await page.waitForFunction(
      () => (window.__pltLoaf ?? []).some((e) => e.duration > 50),
      undefined,
      { timeout: 5000 },
    );
    const summary = attributeLoaf(await loafEntries(page), ORIGIN);
    expect(summary.over50Ours).toBeGreaterThanOrEqual(1);
    expect(summary.worstOursMs).toBeGreaterThan(50);
  });

  it('WM-07 axe finds a contrast failure that appears only when the dark theme is forced', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    const page = await fresh(`<!doctype html><html lang="en"><head><title>t</title>
      <style>:root { color-scheme: light; } :root[data-theme="dark"] main { background: #111; color: #222; } main { background: #fff; color: #111; }</style>
      </head><body><main><h1>Plotinium</h1><p>Readable in light only.</p></main></body></html>`);
    const light = await scan(page, { name: 'light', colorScheme: 'light', forced: null });
    expect(light.blocking).toEqual([]);
    const forced = await scan(page, {
      name: 'light system, dark forced',
      colorScheme: 'light',
      forced: 'dark',
    });
    expect(forced.blocking.map((v) => v.id)).toContain('color-contrast');
    const scoped = await scan(page, { name: 'light', colorScheme: 'light', forced: null }, 'h1');
    expect(scoped.blocking).toEqual([]);
  }, 60_000);

  it('TST-13 the result envelope carries the Chrome version, the build and the device pixel ratio', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    const page = await fresh('<p>envelope</p>');
    const env = await envelope(
      page,
      { refreshHz: 60 },
      { PLT_MACHINE_CLASS: 'hosted', GITHUB_SHA: 'a1f93c2' },
    );
    expect(env.chrome.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(env.chrome.channel).toBe('stable');
    expect(env.build).toBe('0.2.0+a1f93c2');
    expect(env.commit).toBe('a1f93c2');
    expect(env.machine).toMatchObject({ class: 'hosted', refreshHz: 60, dpr: 1 });
  });

  it('WM-06 login, desktop, window and Terminal helpers drive a page that honours SELECTORS.md', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    const page = await fresh(`<div id="app"></div>
      <script>
        const app = document.getElementById('app');
        let text = '';
        window.__plt = {
          bootlog: async () => ({ bootId: 'b1', seq: 3, profile: 'normal', kind: 'warm', flags: [], userWaitMs: 0, interactiveAt: 0.7, bootMs: 700, outcome: 'interactive', build: { version: '0.2.0', build: 'a1f93c2' }, env: { chromeMajor: 153, hwc: 8, isolated: true, swActive: true }, assets: { bytesTotal: 1, bytesDone: 1 } }),
          sessionId: () => 's-1',
          layout: () => [...document.querySelectorAll('[data-testid=window]')].map((w, i) => ({ wid: i + 1, app: w.dataset.app, x: 0, y: 0, w: 640, h: 400, z: i, state: 'normal' })),
          terminal: { text: () => text, idle: () => true },
          oracle: { snapshot: async (p) => ({ checksum: p, orphans: [], parentless: [], quota: {}, refcountMismatches: [], nlinkMismatches: [], outboxLen: 0, undoLen: 0, fsckClean: true }) },
        };
        app.innerHTML = '<div data-testid="login-screen"><button data-testid="login-user-tile" data-user="alice">alice</button><input data-testid="login-password" type="password"><button data-testid="login-submit">Sign in</button><button data-testid="login-guest">Guest</button></div>';
        const toDesktop = () => {
          app.innerHTML = '<main data-testid="desktop" style="min-height:400px"><nav data-testid="dock"><button data-testid="dock-item" data-app="terminal">T</button></nav></main>';
          document.querySelector('[data-testid=dock-item]').onclick = () => {
            const w = document.createElement('section');
            w.dataset.testid = 'window'; w.dataset.app = 'terminal'; w.setAttribute('role', 'dialog');
            w.innerHTML = '<div data-testid="window-titlebar">Terminal</div><div data-testid="terminal" tabindex="0" style="height:120px">$ </div>';
            document.querySelector('main').append(w);
          };
          document.addEventListener('keydown', (e) => { if (e.key === 'Enter') text += '\\n$ '; else if (e.key.length === 1) text += e.key; });
          requestAnimationFrame(() => performance.mark('desktop-interactive'));
        };
        document.addEventListener('click', (e) => {
          if (e.target.dataset.testid === 'login-submit' && document.querySelector('[data-testid=login-password]').value === 'alice-test-only') toDesktop();
          if (e.target.dataset.testid === 'login-guest') toDesktop();
        });
      </script>`);
    await login(page, seedUser('alice', {}));
    await waitForDesktop(page);
    const win = await openApp(page, 'terminal');
    await win.getByTestId(TID.terminal).click();
    await runInTerminal(page, 'echo hi');
    expect(await terminalText(page)).toContain('echo hi');
    expect(await sessionId(page)).toBe('s-1');
    expect(await layout(page)).toEqual([
      { wid: 1, app: 'terminal', x: 0, y: 0, w: 640, h: 400, z: 0, state: 'normal' },
    ]);
    expect((await bootRecord(page)).bootMs).toBe(700);
    expect((await clientSnapshot(page, '/home/alice')).checksum).toBe('/home/alice');
    await expect(sel.windows(page, 'terminal').count()).resolves.toBe(1);
    await expect(sel.resizeHandle(sel.windows(page).first(), 'se').count()).resolves.toBe(0);
  }, 60_000);

  it('BOOT-14 the guest tile signs in without a password and a missing test hook is reported', async (ctx) => {
    if (os === undefined) return ctx.skip(skipReason);
    const page =
      await fresh(`<div data-testid="login-screen"><button data-testid="login-guest">Guest</button></div>
      <script>
        document.querySelector('[data-testid=login-guest]').onclick = () => {
          document.body.innerHTML = '<main data-testid="desktop">Desktop</main>';
          performance.mark('desktop-interactive');
        };
      </script>`);
    await login(page, seedUser('guest', {}));
    await waitForDesktop(page);
    await expect(sessionId(page)).rejects.toThrow(/window.__plt is missing/);
    await expect(bootRecord(page)).rejects.toThrow(/window.__plt is missing/);
    await expect(layout(page)).rejects.toThrow(/window.__plt is missing/);
    await expect(clientSnapshot(page, '/')).rejects.toThrow(/window.__plt is missing/);
    await expect(terminalText(page)).rejects.toThrow(/window.__plt is missing/);
  }, 60_000);
});
