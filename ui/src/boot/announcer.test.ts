import { describe, expect, it } from 'vitest';

import { ANNOUNCE_INTERVAL_MS, createAnnouncer, Say } from './announcer.ts';

function harness(): {
  clock: { t: number };
  frames: (() => void)[];
  spoken: string[];
  a: ReturnType<typeof createAnnouncer>;
} {
  const clock = { t: 0 };
  const frames: (() => void)[] = [];
  const spoken: string[] = [];
  const a = createAnnouncer({ now: () => clock.t, defer: (fn) => frames.push(fn) });
  new MutationObserver(() => spoken.push(a.el.textContent ?? '')).observe(a.el, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  document.body.append(a.el);
  return { clock, frames, spoken, a };
}

const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe('UI-Announcer', () => {
  it('BOOT-13 the status region is a polite, atomic live region', () => {
    const { a } = harness();
    expect(a.el.getAttribute('role')).toBe('status');
    expect(a.el.getAttribute('aria-live')).toBe('polite');
    expect(a.el.getAttribute('aria-atomic')).toBe('true');
    expect(ANNOUNCE_INTERVAL_MS).toBe(750);
  });

  it('BOOT-13 the status region announces stage changes and degraded services at most once per 750 ms', async () => {
    const { clock, spoken, a } = harness();
    expect(a.say('Checking system', Say.Stage)).toBe(true);
    clock.t = 100;
    expect(a.say('Loading kernel', Say.Stage)).toBe(false);
    clock.t = 200;
    a.say('kernel: 38 of 104 KB');
    clock.t = 400;
    a.say('sync degraded: offline', Say.Stage);
    clock.t = 700;
    a.tick();
    await settle();
    expect(spoken).toEqual(['Checking system']);
    clock.t = 760;
    a.tick();
    await settle();
    // The detail never displaced a held stage change; the later stage change replaced the earlier.
    expect(spoken).toEqual(['Checking system', 'sync degraded: offline']);
    clock.t = 800;
    a.say('Starting services', Say.Stage);
    a.tick();
    await settle();
    expect(spoken).toHaveLength(2);
  });

  it('BOOT-13 a held message is delivered on a later frame after the window, without a timer', async () => {
    const { clock, frames, spoken, a } = harness();
    a.say('Checking system');
    await settle();
    clock.t = 50;
    a.say('Desktop ready', Say.Stage);
    expect(frames).toHaveLength(1);
    clock.t = 400;
    frames.shift()?.();
    expect(frames).toHaveLength(1);
    clock.t = 800;
    frames.shift()?.();
    await settle();
    expect(frames).toHaveLength(0);
    expect(spoken).toEqual(['Checking system', 'Desktop ready']);
  });
});
