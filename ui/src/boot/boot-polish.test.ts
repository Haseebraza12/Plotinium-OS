/**
 * Boot screen fixes of the polish wave (docs/design/bug-hunt/BUGS.md): UI-003 (the splash mark
 * stays whole), UI-030 (panic screen), UI-061 (no font swap, no jump), UI-062 (the verbose log
 * keeps following), UI-066 (boot menu keys from anywhere), UI-068 (recovery console layout and
 * Esc), UI-069 (the unsupported screen names the page's own address).
 */
import { fireEvent, getByRole } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import wordmarkSvgRaw from '../../../docs/identity/wordmark.svg?raw';
import { atomLogo } from '../icons/atom-logo.ts';
import bootCss from './boot.css?raw';
import { createVerboseLog } from './log.ts';
import { ORBIT_STEP_DEG, ORBIT_SWING_DEG, orbitAngle } from './logo.ts';
import { createBootMenu } from './menu.ts';
import { createPanicScreen } from './panic.ts';
import { createRecoveryConsole } from './recovery.ts';
import { createBootSplash, splashHtml } from './splash.ts';
import { createUnsupportedScreen, localAddress } from './unsupported.ts';
import { WORDMARK_PATH } from './wordmark.ts';

const ID = { version: '0.3.0', build: 'a1f93c2' } as const;
const css = bootCss.replace(/\/\*[\s\S]*?\*\//gu, '');
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

/** Parses the inlined markup the way the browser parses index.html (no HTML sink). */
const parse = (markup: string): HTMLElement =>
  new DOMParser().parseFromString(`<!doctype html><body>${markup}`, 'text/html').body;

/** Screens add document key listeners: every test destroys what it made. */
const made: { destroy(): void }[] = [];
function keep<T extends { destroy(): void }>(screen: T): T {
  made.push(screen);
  return screen;
}
afterEach(() => {
  for (const screen of made.splice(0)) screen.destroy();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------------------------
// UI-003: the geometry of the mark, read from the shared artwork (ui/src/icons/atom-logo.ts)
// ---------------------------------------------------------------------------------------------

const CENTRE = { x: 12, y: 9 } as const;
const angleOf = (x: number, y: number): number =>
  ((Math.atan2(y - CENTRE.y, x - CENTRE.x) * 180) / Math.PI + 360) % 360;
const pathOf = (cls: string): string => {
  const node = atomLogo.children.find((n) => n[1]['class'] === cls);
  return String(node?.[1]['d'] ?? '');
};
const numbers = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);

/** The shell's gap at its centre line (radius 6): between the two round ends, in degrees. */
function shellGap(): readonly [number, number] {
  // M x0 y0 A … x1 y1 A(cap) … x2 y2 A … x3 y3 A(cap) … x0 y0 Z
  const n = numbers(pathOf('pl-logo-shell'));
  const p0 = [n[0] ?? 0, n[1] ?? 0];
  const p1 = [n[7] ?? 0, n[8] ?? 0];
  const p2 = [n[14] ?? 0, n[15] ?? 0];
  const p3 = [n[21] ?? 0, n[22] ?? 0];
  const capA = [((p3[0] ?? 0) + (p0[0] ?? 0)) / 2, ((p3[1] ?? 0) + (p0[1] ?? 0)) / 2];
  const capB = [((p1[0] ?? 0) + (p2[0] ?? 0)) / 2, ((p1[1] ?? 0) + (p2[1] ?? 0)) / 2];
  const half = (Math.asin(1.5 / 6) * 180) / Math.PI;
  const from = angleOf(capB[0] ?? 0, capB[1] ?? 0) + half;
  const to = angleOf(capA[0] ?? 0, capA[1] ?? 0) - half + 360;
  return [from, to];
}

/** Where the stem (a 3-unit capsule) meets the ring band (radius 4.5 to 7.5), in degrees. */
function stemJunction(): readonly [number, number] {
  const n = numbers(pathOf('pl-logo-stem'));
  const [x0 = 0, yTop = 0] = n;
  const x1 = x0 + 3;
  const yBottom = n[2] ?? 0;
  const angles: number[] = [];
  for (let x = x0; x <= x1 + 1e-9; x += 0.05)
    for (let y = yTop - 1.5; y <= yBottom + 1.5; y += 0.05) {
      const inCapsule =
        (y >= yTop && y <= yBottom) ||
        Math.hypot(x - (x0 + 1.5), y - (y < yTop ? yTop : yBottom)) <= 1.5;
      const r = Math.hypot(x - CENTRE.x, y - CENTRE.y);
      if (inCapsule && r >= 4.5 && r <= 7.5) angles.push(angleOf(x, y));
    }
  return [Math.min(...angles), Math.max(...angles)];
}

/** True when the gap turned by `deg` overlaps the stem junction. */
function gapMeetsStem(deg: number): boolean {
  const [g0, g1] = shellGap();
  const [s0, s1] = stemJunction();
  for (let a = g0 + deg; a <= g1 + deg; a += 0.5) {
    const m = ((a % 360) + 360) % 360;
    if (m >= s0 && m <= s1) return true;
  }
  return false;
}

/** Distance from the electron, turned by `deg`, to the stem's capsule, minus its radius. */
function electronClearance(deg: number): number {
  const node = atomLogo.children.find((c) => c[1]['class'] === 'pl-logo-electron');
  const ex = Number(node?.[1]['cx']);
  const ey = Number(node?.[1]['cy']);
  const er = Number(node?.[1]['r']);
  const t = (deg * Math.PI) / 180;
  const x = CENTRE.x + (ex - CENTRE.x) * Math.cos(t) - (ey - CENTRE.y) * Math.sin(t);
  const y = CENTRE.y + (ex - CENTRE.x) * Math.sin(t) + (ey - CENTRE.y) * Math.cos(t);
  const [x0 = 0, yTop = 0, yBottom = 0] = numbers(pathOf('pl-logo-stem'));
  const cy = Math.min(Math.max(y, yTop), yBottom);
  return Math.hypot(x - (x0 + 1.5), y - cy) - 1.5 - er;
}

describe('UI-003 the boot splash mark stays a whole Bohr P', () => {
  it('UI-003 the geometry reads right: the gap is at 1:30 and the stem joins on the left', () => {
    const [g0, g1] = shellGap();
    expect((g0 + g1) / 2).toBeCloseTo(315, 0);
    const [s0, s1] = stemJunction();
    expect(s0).toBeGreaterThan(120);
    expect(s1).toBeLessThan(200);
    // The check itself catches the old full turn: tick 17 of 12° is 204°, the reported break.
    expect(gapMeetsStem(17 * 12)).toBe(true);
    expect(electronClearance(17 * 12)).toBeLessThan(0);
  });

  it('UI-003 ticks 0…40 swing within ±60° one step at a time and never reach the stem', () => {
    expect(ORBIT_STEP_DEG).toBe(12);
    expect(ORBIT_SWING_DEG).toBe(60);
    let previous = orbitAngle(0);
    expect(previous).toBe(0);
    for (let tick = 1; tick <= 40; tick++) {
      const deg = orbitAngle(tick);
      expect(Math.abs(deg), `tick ${String(tick)}`).toBeLessThanOrEqual(ORBIT_SWING_DEG);
      expect(Math.abs(deg - previous), `tick ${String(tick)}`).toBe(ORBIT_STEP_DEG);
      expect(gapMeetsStem(deg), `tick ${String(tick)} at ${String(deg)}°`).toBe(false);
      expect(electronClearance(deg), `tick ${String(tick)}`).toBeGreaterThan(1);
      previous = deg;
    }
    expect([0, 5, 10, 15, 20].map(orbitAngle)).toEqual([0, 60, 0, -60, 0]);
    expect(orbitAngle(17)).toBe(-36);
  });

  it('UI-003 the splash turns the orbit by the swing angle; reduced motion keeps it still', () => {
    const splash = keep(createBootSplash(ID));
    for (let i = 0; i < 17; i++) splash.pulse();
    expect(splash.el.style.getPropertyValue('--plb-orbit')).toBe(String(orbitAngle(17)));
    expect(rule('.plb-orbit')).toContain('rotate(calc(var(--plb-orbit, 0) * 1deg))');
    expect(rule('.plb-orbit')).not.toContain('--plb-tick');
    expect(css).toContain(":root[data-motion='reduce'] .plb-orbit {\n    transform: none;");
  });
});

describe('UI-061 the splash paints once, in its final fonts and places', () => {
  it('UI-061 boot screens use system font stacks, never the web fonts', () => {
    expect(css).not.toMatch(/var\(--pl-font-(ui|mono)\)/u);
    expect(rule('.plb')).toMatch(/--plb-font: system-ui,/u);
    expect(rule('.plb')).toContain('font-family: var(--plb-font);');
    expect(rule('.plb')).not.toMatch(/Inter|Geist|JetBrains/u);
    for (const section of css.split('font: var(--pl-type-section);').slice(1))
      expect(section.trimStart().startsWith('font-family: var(--plb-font);')).toBe(true);
  });

  it('UI-061 the name is the outlined wordmark, read as text, identical to the identity kit', () => {
    const host = parse(splashHtml(ID));
    const h1 = host.querySelector('h1');
    expect(h1?.textContent).toBe('Plotinium is starting');
    const svg = h1?.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    const identityPath = / d="([^"]+)"/u.exec(wordmarkSvgRaw)?.[1];
    expect(identityPath?.length).toBeGreaterThan(1_000);
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(identityPath);
    expect(WORDMARK_PATH).toBe(identityPath);
  });

  it('UI-061 the service count holds its line from the first paint (no ~20 px jump)', () => {
    const host = parse(splashHtml(ID));
    const count = host.querySelector<HTMLElement>('.plb-count');
    expect(count?.hidden).toBe(false);
    expect(count?.hasAttribute('data-off')).toBe(true);
    expect(rule('.plb-count[data-off]')).toContain('visibility: hidden');
    expect(rule('.plb-ver')).not.toContain('tabular-nums');
  });
});

describe('UI-062 the verbose log keeps following a burst', () => {
  it('UI-062 our own jump to the end is not mistaken for the reader scrolling up', () => {
    const frames: (() => void)[] = [];
    const log = keep(createVerboseLog({ schedule: (fn) => frames.push(fn) }));
    document.body.append(log.el);
    const scroller = getByRole(log.el, 'log');
    const jump = log.el.querySelector<HTMLButtonElement>('.plb-jump');
    const lines = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        t: (from + i) / 1000,
        sub: 'svc',
        msg: `l${from + i}`,
      }));
    log.append(...lines(100, 0));
    frames.shift()?.();
    const endAfterFirst = scroller.scrollTop;
    expect(endAfterFirst).toBeGreaterThan(0);
    // A burst arrives before the browser delivers the scroll event of that jump.
    log.append(...lines(479, 100));
    fireEvent.scroll(scroller);
    frames.shift()?.();
    expect(jump?.hidden).toBe(true);
    expect(scroller.scrollTop).toBeGreaterThan(endAfterFirst);
    expect(rule('.plb-scroll')).toContain('overflow-anchor: none');
  });
});

describe('UI-066 boot menu keys work wherever focus is', () => {
  it('UI-066 after a click outside the list, arrows and Enter still drive the menu', () => {
    const onChoose = vi.fn();
    const onInteract = vi.fn();
    const menu = keep(createBootMenu({ ...ID, onChoose, onInteract }));
    document.body.append(menu.el);
    menu.focus();
    fireEvent.pointerDown(menu.el.querySelector('.plb-help') ?? menu.el);
    expect(onInteract).toHaveBeenCalledTimes(1);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(menu.selected).toBe('safe');
    expect(document.activeElement).toBe(menu.el.querySelector('[role="listbox"]'));
    document.body.focus();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledWith('safe');
  });

  it('UI-066 a held Esc (repeats) never closes the menu from the body; one press does', () => {
    const onClose = vi.fn();
    const menu = keep(createBootMenu({ ...ID, onChoose: () => undefined, onClose }));
    document.body.append(menu.el);
    fireEvent.keyDown(document.body, { key: 'Escape', repeat: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    menu.destroy();
    made.splice(made.indexOf(menu), 1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('UI-030 the panic screen of a failed critical service (BOOT-08)', () => {
  function critical() {
    const onAction = vi.fn();
    const screen = keep(
      createPanicScreen({
        ...ID,
        title: 'Plotinium could not start',
        reason: 'sched failed: timeout 500 ms',
        retry: true,
        explanation: 'A critical system service failed to start, so the boot stopped.',
        lines: Array.from({ length: 40 }, (_, i) => ({ t: i / 10, sub: 'proc', msg: `line ${i}` })),
        time: '2026-09-27 09:25:50 · 3.217 s after start',
        onAction,
      }),
    );
    document.body.append(screen.el);
    screen.focus();
    return { screen, onAction };
  }

  it('UI-030 it names what failed under the title and offers T Retry, R, S and D', () => {
    const { screen, onAction } = critical();
    const dialog = getByRole(screen.el, 'alertdialog');
    expect(getByRole(dialog, 'heading', { level: 1 }).textContent).toBe(
      'Plotinium could not start',
    );
    const why = dialog.querySelector('.plb-why');
    expect(why?.textContent).toBe('sched failed: timeout 500 ms');
    expect(dialog.getAttribute('aria-describedby')?.split(' ')[0]).toBe(why?.id);
    const buttons = [...dialog.querySelectorAll('.plb-btn')].map((b) => b.textContent);
    expect(buttons).toEqual(['TRetry', 'RRecovery console', 'SSafe mode', 'DDiagnostics']);
    expect(document.activeElement?.textContent).toBe('TRetry');
    expect(dialog.querySelector('.plb-hint')?.textContent).toContain('Use T, R, S or D');
    fireEvent.keyDown(document.body, { key: 't' });
    expect(onAction).toHaveBeenLastCalledWith('retry');
  });

  it('UI-030 the log opens at its end, the medal keeps its size and no boot id says "pending"', () => {
    const { screen } = critical();
    const code = screen.el.querySelector<HTMLElement>('.plb-code');
    expect(code?.scrollTop).toBe(code?.scrollHeight);
    expect(screen.el.querySelector('.plb-foot')?.textContent).not.toContain('pending');
    expect(rule('.plb-medal')).toContain('flex: none;');
    expect(rule('.plb-code')).toMatch(/max-height: calc\(/u);
    expect(rule('.plb-code')).toContain('overflow: auto;');
  });

  it('UI-030 a cycle panic keeps its title and R, S and D only', () => {
    const screen = keep(
      createPanicScreen({
        ...ID,
        cycle: ['auth', 'sync', 'lockd', 'auth'],
        lines: [],
        onAction: () => undefined,
      }),
    );
    document.body.append(screen.el);
    expect(getByRole(screen.el, 'heading', { level: 1 }).textContent).toBe(
      'Plotinium Kernel panic',
    );
    expect([...screen.el.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'R',
      'S',
      'D',
    ]);
  });
});

describe('UI-068 recovery console layout', () => {
  it('UI-068 no traffic lights (D-19); short list labels; full names for assistive tech', () => {
    const rc = keep(createRecoveryConsole({ ...ID, onAction: () => undefined }));
    document.body.append(rc.el);
    expect(rc.el.querySelector('.plb-lights')).toBeNull();
    expect(css).not.toContain('.plb-lights');
    const clear = getByRole(rc.el, 'option', { name: 'Clear local cache and re-sync' });
    expect(clear.querySelector('.plb-ot')?.textContent).toBe('Clear local cache');
    expect(clear.querySelector('.plb-od')?.textContent).toBe('Exports the outbox, then re-syncs');
    const manifests = getByRole(rc.el, 'option', { name: 'Restore default service manifests' });
    expect(manifests.querySelector('.plb-ot')?.textContent).toBe('Restore default manifests');
    expect(rule('.plb-win')).toContain('grid-template-rows: minmax(0, 1fr);');
  });

  it('UI-068 Esc cancels a confirmation even after focus left it', () => {
    const onAction = vi.fn();
    const rc = keep(createRecoveryConsole({ ...ID, onAction }));
    document.body.append(rc.el);
    fireEvent.keyDown(document.body, { key: 'y' });
    const confirm = getByRole(rc.el, 'alertdialog');
    expect(confirm.hidden).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(confirm.hidden).toBe(true);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('UI-069 the unsupported screen names this page’s address', () => {
  it('UI-069 a LAN IP over http is sent to the same port on localhost; local and https stay', () => {
    const at = (href: string): string => localAddress(new URL(href));
    expect(at('http://192.168.1.20:4718/')).toBe('http://localhost:4718');
    expect(at('http://10.0.0.5/')).toBe('http://localhost');
    expect(at('http://localhost:4717/?boot=menu')).toBe('http://localhost:4717');
    expect(at('http://127.0.0.1:5301/')).toBe('http://127.0.0.1:5301');
    expect(at('https://os.example.edu/')).toBe('https://os.example.edu');
  });

  it('UI-069 the fatal explanation uses the address it is given, never a fixed port', () => {
    const screen = keep(
      createUnsupportedScreen({
        ...ID,
        address: 'http://localhost:4718',
        capabilities: [{ name: 'Secure context', status: 'missing', required: true }],
      }),
    );
    expect(screen.el.textContent).toContain('at http://localhost:4718, not a LAN IP');
    expect(screen.el.textContent).not.toContain('4717');
    const fromPage = keep(
      createUnsupportedScreen({
        ...ID,
        capabilities: [{ name: 'IndexedDB', status: 'missing', required: true }],
      }),
    );
    expect(fromPage.el.textContent).toContain(`at ${localAddress(window.location)},`);
  });
});
