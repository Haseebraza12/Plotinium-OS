/**
 * BootSplash (BOOT-01, BOOT-02, BOOT-13; ui-design-system.md §3.8.1). The logo, the name, the
 * version and build, the true progress bar, the current step, the service count and the Esc/V
 * hint chips. `splashHtml()` renders the same markup as a string, so the build can inline it in
 * index.html and the first paint needs no script; `createBootSplash({ root })` then adopts it.
 *
 * Nothing here moves on its own. The bar changes only in setProgress(), which the boot driver
 * calls from real events (bytes received, services done); the orbits tick, the nucleus flashes
 * and the sheen sweeps only in response to those calls. If the boot stalls, the screen is still.
 */
import { createAnnouncer, Say, type Announcer } from './announcer.ts';
import { docOf, h, html, q, render, replay, swapBox, swapText, uid, type VNode } from './dom.ts';
import { createVerboseLog, type VerboseLog } from './log.ts';
import { backdrop, logoSvg, orbitAngle } from './logo.ts';
import type { BootIdentity, BootScreen, ScreenBase } from './types.ts';
import { wordmarkSvg } from './wordmark.ts';

export interface SplashMarkupOptions extends BootIdentity {
  /** Id prefix for the aria references (the page has one splash; the gallery shows two). */
  readonly id?: string;
}

export interface BootSplashOptions extends SplashMarkupOptions, ScreenBase {
  /** An element holding splashHtml() output (the inlined first paint): adopted, not rebuilt. */
  readonly root?: HTMLElement;
  /** The Esc chip was pressed (the driver also listens for the key itself). */
  readonly onBootMenu?: () => void;
  /** The V chip was pressed. Without a handler the chip toggles the log itself. */
  readonly onToggleVerbose?: () => void;
  /** A shared status region; the splash makes its own when none is given. */
  readonly announcer?: Announcer;
}

export interface BootSplash extends BootScreen {
  /** The verbose log shown by setVerbose(true). */
  readonly log: VerboseLog;
  readonly announcer: Announcer;
  /**
   * Shows the true boot progress P in [0, 1] (BOOT-02). The only way the bar moves: call it
   * from a real boot event, never from a timer.
   */
  setProgress(p: number, valueText?: string): void;
  /** Line 5: `checking system`, `Loading kernel · 38 of 104 KB`, `vfs: mounting / (12,408 inodes)`. */
  setStep(text: string): void;
  /** Line 6: `Service start · done of total` over the desktop's ancestor set. */
  setCount(done: number, total: number): void;
  /** Boot stage 1–6: the backdrop light steps to the stage's position. */
  setStage(stage: number): void;
  /**
   * Any real boot event: the shell and electron take one step of their swing (logo.ts
   * orbitAngle) and a held announcement is delivered.
   */
  pulse(): void;
  /** A service reached done: the nucleus flashes once. */
  serviceDone(): void;
  setVerbose(on: boolean): void;
  /** After the stage-2 decision Esc is ignored (boot spec §3.7): the chip dims. */
  setMenuAvailable(on: boolean): void;
  /** Mirrors a held Esc or V key on its chip. */
  setKeyDown(key: 'Escape' | 'v', down: boolean): void;
  /** Starts the hand-over: fade to the boot menu, or zoom through to login and the desktop. */
  exit(to: 'menu' | 'desktop'): void;
}

const isDev = (version: string): boolean => version.includes('-');

/** The splash as an element tree. */
export function splashTree(opts: SplashMarkupOptions): VNode {
  const id = opts.id ?? 'plb-s-';
  return h(
    'div',
    { class: 'plb plb-splash', 'data-empty': true },
    backdrop(),
    h(
      'main',
      { class: 'plb-col', 'aria-labelledby': `${id}t` },
      logoSvg({ size: 96, id, label: 'Plotinium logo', cls: 'plb-mark' }),
      // The name as outlined artwork (D-05: no web font on the boot path); read as text.
      h(
        'h1',
        { class: 'plb-word', id: `${id}t` },
        wordmarkSvg(),
        h('span', { class: 'plb-sr' }, 'Plotinium is starting'),
      ),
      h(
        'p',
        { class: 'plb-ver' },
        isDev(opts.version) && [h('b', { class: 'plb-dev' }, 'dev build'), ' '],
        `version ${opts.version} · build ${opts.build}`,
      ),
      h(
        'div',
        {
          class: 'plb-bar',
          role: 'progressbar',
          'aria-label': 'Boot progress',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': 0,
          'aria-valuetext': 'Checking system',
          'aria-describedby': `${id}s`,
        },
        h(
          'i',
          { class: 'plb-clip' },
          h('i', { class: 'plb-fill' }),
          h('i', { class: 'plb-sheen' }),
        ),
        h('i', { class: 'plb-tip' }),
      ),
      swapBox('plb-step', 'checking system', { id: `${id}s` }),
      // Reserved from the first paint (invisible until the first count) so the centred column
      // does not jump when the count appears (UI-061).
      h(
        'p',
        { class: 'plb-count', 'data-off': true, 'aria-hidden': 'true' },
        'Service start · ',
        h('span', { class: 'plb-n' }, '0'),
        ' of ',
        h('span', { class: 'plb-of' }, '0'),
      ),
    ),
    h(
      'section',
      { class: 'plb-vpanel', 'aria-label': 'Verbose boot log', inert: true },
      h('p', { class: 'plb-vtag' }, 'verbose boot'),
    ),
    h(
      'footer',
      { class: 'plb-hints', 'aria-label': 'Start-up keys' },
      h(
        'button',
        { type: 'button', class: 'plb-chip', 'data-k': 'Escape', 'aria-keyshortcuts': 'Escape' },
        h('kbd', null, 'Esc'),
        h('span', null, 'Boot menu'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'plb-chip',
          'data-k': 'v',
          'aria-keyshortcuts': 'V',
          'aria-pressed': 'false',
        },
        h('kbd', null, 'V'),
        swapBox('plb-vl', 'Verbose log'),
      ),
    ),
  );
}

/** The splash markup, escaped, for inlining into index.html at build time (BOOT-01 first paint). */
export const splashHtml = (opts: SplashMarkupOptions): string => html(splashTree(opts));

export function createBootSplash(opts: BootSplashOptions): BootSplash {
  const doc = docOf(opts.doc);
  const adopted = opts.root?.querySelector<HTMLElement>('.plb-splash') ?? null;
  const root = adopted ?? render(splashTree({ ...opts, id: opts.id ?? uid('plb-s') }), doc);
  const bar = q(root, '.plb-bar');
  const step = q(root, '.plb-step');
  const count = q(root, '.plb-count');
  const num = q(root, '.plb-n');
  const of = q(root, '.plb-of');
  const logo = q<SVGSVGElement>(root, '.plb-mark');
  const panel = q(root, '.plb-vpanel');
  const escChip = q<HTMLButtonElement>(root, '[data-k="Escape"]');
  const vChip = q<HTMLButtonElement>(root, '[data-k="v"]');
  const log = createVerboseLog({ doc });
  const announcer = opts.announcer ?? createAnnouncer({ doc });
  panel.append(log.el);
  if (opts.announcer === undefined) root.append(announcer.el);

  let tick = 0;
  let verbose = false;

  const api: BootSplash = {
    el: root,
    log,
    announcer,
    setProgress(p, valueText) {
      const v = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
      const pct = Math.round(v * 100);
      root.style.setProperty('--plb-p', String(v));
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuetext', valueText ?? `${pct} percent`);
      root.toggleAttribute('data-empty', v === 0);
      if (v > 0) replay(root, 'data-sweep');
      announcer.tick();
    },
    setStep(text) {
      swapText(step, text);
    },
    setCount(done, total) {
      count.removeAttribute('data-off');
      count.removeAttribute('aria-hidden');
      of.textContent = String(total);
      if (num.textContent !== String(done)) {
        num.textContent = String(done);
        replay(num, 'data-pre');
      }
    },
    setStage(stage) {
      root.style.setProperty('--plb-stage', String(stage));
    },
    pulse() {
      root.style.setProperty('--plb-tick', String(++tick));
      root.style.setProperty('--plb-orbit', String(orbitAngle(tick)));
      announcer.tick();
    },
    serviceDone() {
      replay(logo, 'data-flash');
    },
    setVerbose(on) {
      if (on === verbose) return;
      verbose = on;
      root.toggleAttribute('data-verbose', on);
      panel.toggleAttribute('inert', !on);
      vChip.setAttribute('aria-pressed', String(on));
      swapText(q(vChip, '.plb-vl'), on ? 'Hide log' : 'Verbose log');
      if (on) log.scrollToEnd();
      announcer.say(on ? 'Boot log shown' : 'Boot log hidden', Say.Stage);
    },
    setMenuAvailable(on) {
      if (on) {
        escChip.removeAttribute('aria-disabled');
        escChip.removeAttribute('title');
      } else {
        escChip.setAttribute('aria-disabled', 'true');
        escChip.title = 'Boot menu: run reboot --menu';
      }
    },
    setKeyDown(key, down) {
      (key === 'Escape' ? escChip : vChip).toggleAttribute('data-down', down);
    },
    exit(to) {
      root.dataset.exit = to;
    },
    focus() {
      vChip.focus();
    },
    destroy() {
      log.destroy();
      root.remove();
    },
  };

  escChip.addEventListener('click', () => {
    if (escChip.getAttribute('aria-disabled') !== 'true') opts.onBootMenu?.();
  });
  vChip.addEventListener('click', () => {
    if (opts.onToggleVerbose === undefined) api.setVerbose(!verbose);
    else opts.onToggleVerbose();
  });
  return api;
}
