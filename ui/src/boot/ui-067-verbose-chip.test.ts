/**
 * UI-067: the "V Verbose log" chip and the V key share one state. The splash hands a chip click
 * to its owner (`onToggleVerbose`, the boot driver) instead of flipping its own copy, so the next
 * V press never has to undo a change the owner did not know about.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnnouncer } from './announcer.ts';
import { createBootSplash } from './splash.ts';

const ID = { version: '0.3.0', build: 'a1f93c2' } as const;

afterEach(() => {
  document.body.replaceChildren();
});

describe('UI-067 the verbose chip and the V key stay in step', () => {
  it('UI-067 with an owner, a chip click asks the owner and does not toggle on its own', () => {
    const onToggleVerbose = vi.fn();
    const splash = createBootSplash({
      ...ID,
      announcer: createAnnouncer({ defer: null }),
      onToggleVerbose,
    });
    document.body.append(splash.el);
    const chip = splash.el.querySelector<HTMLButtonElement>('[data-k="v"]');
    chip?.click();
    expect(onToggleVerbose).toHaveBeenCalledTimes(1);
    expect(splash.el.hasAttribute('data-verbose')).toBe(false);
    expect(chip?.getAttribute('aria-pressed')).not.toBe('true');
  });

  it('UI-067 chip, V, V, chip: every press flips the one state, and the chip shows it', () => {
    // The driver's wiring: one `verbose` flag, set from the chip and from the V key.
    let verbose = false;
    const setVerbose = (on: boolean): void => {
      verbose = on;
      splash.setVerbose(on);
    };
    const splash = createBootSplash({
      ...ID,
      announcer: createAnnouncer({ defer: null }),
      onToggleVerbose: () => {
        setVerbose(!verbose);
      },
    });
    document.body.append(splash.el);
    const chip = splash.el.querySelector<HTMLButtonElement>('[data-k="v"]');
    const vKey = (): void => {
      setVerbose(!verbose);
    };
    const seen: [boolean, string | null | undefined][] = [];
    const look = (): void => {
      seen.push([splash.el.hasAttribute('data-verbose'), chip?.getAttribute('aria-pressed')]);
    };
    chip?.click();
    look();
    vKey();
    look();
    vKey();
    look();
    chip?.click();
    look();
    expect(seen).toEqual([
      [true, 'true'],
      [false, 'false'],
      [true, 'true'],
      [false, 'false'],
    ]);
  });

  it('UI-067 without an owner the chip still toggles the splash by itself', () => {
    const splash = createBootSplash({ ...ID, announcer: createAnnouncer({ defer: null }) });
    document.body.append(splash.el);
    splash.el.querySelector<HTMLButtonElement>('[data-k="v"]')?.click();
    expect(splash.el.hasAttribute('data-verbose')).toBe(true);
  });
});
