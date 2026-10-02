import { fireEvent, getByRole } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnnouncer } from './announcer.ts';
import { createBootSplash, splashHtml } from './splash.ts';

const ID = { version: '0.3.0', build: 'a1f93c2' } as const;

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mount(): ReturnType<typeof createBootSplash> {
  const splash = createBootSplash({ ...ID, announcer: createAnnouncer({ defer: null }) });
  document.body.append(splash.el, splash.announcer.el);
  return splash;
}

describe('UI-BootSplash', () => {
  it('BOOT-01 the splash shows the logo, the name Plotinium, and the version and build', () => {
    const { el } = mount();
    expect(getByRole(el, 'img', { name: 'Plotinium logo' }).tagName.toLowerCase()).toBe('svg');
    expect(getByRole(el, 'heading', { level: 1 }).textContent).toBe('Plotinium is starting');
    expect(el.querySelector('.plb-ver')?.textContent).toBe('version 0.3.0 · build a1f93c2');
    expect(getByRole(el, 'main').getAttribute('aria-labelledby')).toBe(getByRole(el, 'heading').id);
  });

  /** Parses the inlined markup the way the browser parses index.html. */
  const parse = (html: string): HTMLElement =>
    new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html').body;

  it('BOOT-01 splashHtml paints the logo, name, version and build as static markup, with no script', () => {
    const html = splashHtml(ID);
    const host = parse(html);
    expect(host.querySelector('svg[role="img"][aria-label="Plotinium logo"]')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toContain('Plotinium');
    expect(host.textContent).toContain('version 0.3.0 · build a1f93c2');
    expect(host.querySelector('script')).toBeNull();
    expect(html).not.toMatch(/\son[a-z]+=/u);
  });

  it('BOOT-01 createBootSplash adopts the inlined first-paint markup instead of rebuilding it', () => {
    const host = document.createElement('div');
    host.append(...document.adoptNode(parse(splashHtml({ ...ID, id: 'first-' }))).childNodes);
    const inlined = host.firstElementChild;
    document.body.append(host);
    const splash = createBootSplash({ ...ID, root: host });
    expect(splash.el).toBe(inlined);
    splash.setProgress(0.5, 'Loading kernel');
    expect(getByRole(host, 'progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('BOOT-01 a development build is marked with the text prefix "dev build"', () => {
    const splash = createBootSplash({ version: '0.3.0-dev.14', build: 'a1f93c2' });
    expect(splash.el.querySelector('.plb-ver')?.textContent).toBe(
      'dev build version 0.3.0-dev.14 · build a1f93c2',
    );
  });

  it('BOOT-02 the bar moves only through setProgress: 60 s of fake time with no events leaves it unchanged', () => {
    vi.useFakeTimers();
    const splash = mount();
    const bar = getByRole(splash.el, 'progressbar');
    splash.setProgress(0.38, 'Loading kernel · 38 of 104 KB');
    const before = [bar.getAttribute('aria-valuenow'), splash.el.style.getPropertyValue('--plb-p')];
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect([
      bar.getAttribute('aria-valuenow'),
      splash.el.style.getPropertyValue('--plb-p'),
    ]).toEqual(before);
    expect(before).toEqual(['38', '0.38']);
  });

  it('BOOT-02 the splash starts at P = 0 with an empty track, and P is clamped to [0, 1]', () => {
    const splash = mount();
    const bar = getByRole(splash.el, 'progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(splash.el.hasAttribute('data-empty')).toBe(true);
    splash.setProgress(1.7);
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(splash.el.hasAttribute('data-empty')).toBe(false);
    splash.setProgress(Number.NaN);
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
  });

  it('BOOT-13 the progressbar exposes live values and a text value naming the current service', () => {
    const splash = mount();
    const bar = getByRole(splash.el, 'progressbar', { name: 'Boot progress' });
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    splash.setProgress(0.624, 'Starting vfs, 7 of 9');
    expect(bar.getAttribute('aria-valuenow')).toBe('62');
    expect(bar.getAttribute('aria-valuetext')).toBe('Starting vfs, 7 of 9');
    splash.setStep('vfs: mounting / (12,408 inodes)');
    const describedBy = bar.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.querySelector('[data-on]')?.textContent).toBe(
      'vfs: mounting / (12,408 inodes)',
    );
  });

  it('UI-BootSplash step, count, stage and pulse update only when called', () => {
    const splash = mount();
    const count = splash.el.querySelector<HTMLElement>('.plb-count');
    // UI-061: the line holds its place from the first paint but is not shown or read until counted.
    expect(count?.hidden).toBe(false);
    expect(count?.hasAttribute('data-off')).toBe(true);
    expect(count?.getAttribute('aria-hidden')).toBe('true');
    splash.setCount(7, 9);
    expect(count?.hasAttribute('data-off')).toBe(false);
    expect(count?.hasAttribute('aria-hidden')).toBe(false);
    expect(count?.textContent).toBe('Service start · 7 of 9');
    splash.setStage(4);
    splash.pulse();
    splash.pulse();
    expect(splash.el.style.getPropertyValue('--plb-stage')).toBe('4');
    expect(splash.el.style.getPropertyValue('--plb-tick')).toBe('2');
    expect(splash.el.style.getPropertyValue('--plb-orbit')).toBe('24');
    splash.setStep('sched: priority heap + RR');
    splash.setStep('storage: opened plotinium v7');
    const visible = splash.el.querySelectorAll('.plb-step > [data-on]');
    expect(visible).toHaveLength(1);
    expect(visible[0]?.textContent).toBe('storage: opened plotinium v7');
  });

  it('BOOT-05 V shows the verbose log; the chip is a toggle button and the change is announced', () => {
    const splash = mount();
    const v = getByRole(splash.el, 'button', { name: /verbose log/iu });
    expect(v.getAttribute('aria-keyshortcuts')).toBe('V');
    expect(v.getAttribute('aria-pressed')).toBe('false');
    const panel = splash.el.querySelector('.plb-vpanel');
    expect(panel?.hasAttribute('inert')).toBe(true);
    fireEvent.click(v);
    expect(v.getAttribute('aria-pressed')).toBe('true');
    expect(panel?.hasAttribute('inert')).toBe(false);
    expect(splash.el.hasAttribute('data-verbose')).toBe(true);
    expect(splash.announcer.el.textContent).toBe('Boot log shown');
  });

  it('BOOT-06 the Esc chip opens the boot menu until the stage-2 decision, then it is disabled', () => {
    const onBootMenu = vi.fn();
    const splash = createBootSplash({ ...ID, onBootMenu });
    document.body.append(splash.el);
    const escChip = getByRole(splash.el, 'button', { name: /boot menu/iu });
    expect(escChip.getAttribute('aria-keyshortcuts')).toBe('Escape');
    fireEvent.click(escChip);
    expect(onBootMenu).toHaveBeenCalledTimes(1);
    splash.setMenuAvailable(false);
    expect(escChip.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(escChip);
    expect(onBootMenu).toHaveBeenCalledTimes(1);
  });
});
