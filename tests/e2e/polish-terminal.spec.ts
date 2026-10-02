/**
 * Terminal polish regressions on the Docker build (the real CSP from Caddy), bug list
 * docs/design/bug-hunt/BUGS.md:
 *
 * - UI-131 typed commands run end to end: `echo hi | cat`, `cd /tmp && pwd`;
 * - UI-050 opening a Terminal, true-colour output and Edit > Select All raise no
 *   `securitypolicyviolation` (xterm's run-time styles are inert stand-ins applied through adopted
 *   sheets; its per-cell colours go through the CSSOM, ui/src/apps/terminal/csp-rows.ts);
 * - UI-020 a tab that was hidden while its shell printed keeps its grid: its prompt is intact;
 * - UI-021 closing the selected tab puts the keyboard focus into the tab that replaces it.
 *
 * Sign-in: `PLT_E2E_STATE` names a Playwright storage-state file of a signed-in session (the QA
 * copy's per-agent session files); without it the test signs in as Guest. Run against the QA copy
 * with `PLOTINIUM_PORT=4718 PLT_E2E_UI=1 PLT_E2E_STATE=… pnpm exec playwright test
 * tests/e2e/polish-terminal.spec.ts`. fixme until PLT_E2E_UI=1, like the other UI suites.
 *
 * The terminal's text is read from its `terminal` host (SELECTORS.md §1), whose DOM renderer
 * keeps one element per row, so these tests do not need the `window.__plt` test hooks.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { FIXME_UI, uiReady } from '../support/env.ts';
import { openApp, waitForDesktop } from '../support/os.ts';
import { TID } from '../support/selectors.ts';

const STATE = process.env['PLT_E2E_STATE'];
if (STATE !== undefined && STATE !== '') test.use({ storageState: STATE });

interface Violation {
  readonly directive: string;
  readonly blocked: string;
  readonly source: string;
}

declare global {
  interface Window {
    __cspViolations?: Violation[];
  }
}

/** Records every CSP violation of the page from its first script on. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations?.push({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
        source: e.sourceFile,
      });
    });
  });
}

async function violations(page: Page): Promise<Violation[]> {
  return page.evaluate(() => [...(window.__cspViolations ?? [])]);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  if (STATE === undefined || STATE === '') {
    await expect(page.getByTestId(TID.loginScreen)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(TID.loginGuest).click();
  }
  await waitForDesktop(page);
}

/** The shown tab's terminal in `win` (hidden tabs keep theirs mounted). */
function shownTerminal(win: Locator): Locator {
  return win.getByTestId(TID.terminal).locator('visible=true');
}

/** Types a line into the focused terminal. */
async function run(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** The rows of a terminal as text, bottom blank rows dropped. */
async function rows(term: Locator): Promise<string[]> {
  const text = await term.innerText();
  const lines = text.split('\n').map((l) => l.replace(/\u00a0/gu, ' ').trimEnd());
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

async function expectLine(term: Locator, pattern: RegExp): Promise<void> {
  await expect.poll(async () => (await rows(term)).some((l) => pattern.test(l))).toBe(true);
}

/** The terminal's keyboard focus: xterm's helper textarea inside the shown host. */
async function focusIsIn(term: Locator): Promise<boolean> {
  return term.evaluate((el) => el.contains(el.ownerDocument.activeElement));
}

test.describe('Terminal polish on the Docker build', () => {
  test.fixme(!uiReady(), FIXME_UI);

  test('UI-131 UI-050 typed commands run and the Terminal raises no CSP violation', async ({
    page,
  }) => {
    await recordViolations(page);
    await signIn(page);
    const before = (await violations(page)).length;

    const win = await openApp(page, 'terminal');
    const term = shownTerminal(win);
    await expectLine(term, /\$$/u);
    await term.click();
    await run(page, 'echo hi | cat');
    await expectLine(term, /^hi$/u);
    await run(page, 'cd /tmp && pwd');
    await expectLine(term, /^\/tmp$/u);
    await expectLine(term, /:\/tmp\$$/u);
    // Cells xterm colours outside its palette classes: a true-colour SGR and a selection.
    await run(page, "echo -e '\\033[38;2;255;100;0mtruecolor\\033[0m'");
    await expectLine(term, /^truecolor$/u);
    const menubar = page.getByTestId(TID.menuBar);
    await menubar
      .getByRole('menuitem', { name: 'Edit', exact: true })
      .or(menubar.getByRole('button', { name: 'Edit', exact: true }))
      .first()
      .click();
    // The menu's items are activated by a click event (the open animation keeps Playwright's
    // stability check waiting on the dev server).
    await page.getByRole('menuitem', { name: /^Select All/u }).dispatchEvent('click');

    // Everything reported after the desktop was up belongs to the Terminal.
    expect((await violations(page)).slice(before)).toEqual([]);
  });

  test('UI-020 UI-021 a hidden tab keeps its size, and closing a tab keeps the focus in the Terminal', async ({
    page,
  }) => {
    await signIn(page);
    const win = await openApp(page, 'terminal');
    const first = shownTerminal(win);
    await expectLine(first, /\$$/u);
    await first.click();
    await run(page, 'cd /tmp');
    const long = 'A'.repeat(60);
    await run(page, `sleep 2 && echo ${long}`);

    // A second tab while the first shell is still sleeping; it prints while hidden.
    await page.keyboard.press('Alt+Shift+KeyN');
    await expect(win.getByRole('tab')).toHaveCount(2);
    await page.waitForTimeout(3_000);
    await page.keyboard.press('Alt+Shift+BracketLeft');
    const back = shownTerminal(win);
    await expectLine(back, new RegExp(`^${long}$`, 'u'));
    // The prompt after the output is on one line, not wrapped at a 10-column grid.
    expect((await rows(back)).at(-1)).toMatch(/^\S+@plotinium:\/tmp\$$/u);
    expect(await focusIsIn(back)).toBe(true);

    // Close the selected tab with the Terminal's chord: the focus moves into the remaining tab.
    await page.keyboard.press('Alt+Shift+KeyW');
    await expect(win.getByRole('tab')).toHaveCount(1);
    await expect.poll(() => focusIsIn(shownTerminal(win))).toBe(true);
    await run(page, 'echo still-typing');
    await expectLine(shownTerminal(win), /^still-typing$/u);
  });
});
