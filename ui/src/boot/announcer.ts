/**
 * The boot status region (BOOT-13): a visually hidden polite live region that speaks at most
 * once per 750 ms. Throttling compares event times, never a timer: a message that arrives
 * inside the window is held (a higher-priority one replaces it) and is spoken on the next boot
 * event, or on the next animation frame after the window closes when `defer` is available.
 */
import { docOf, h, render } from './dom.ts';
import type { ScreenBase } from './types.ts';

/** Priority of a held message: a stage change or failure is never replaced by a detail. */
export const Say = { Detail: 0, Stage: 1, Failure: 2 } as const;
export type Say = (typeof Say)[keyof typeof Say];

export interface AnnouncerOptions extends ScreenBase {
  /** Minimum gap between two announcements (BOOT-13: 750 ms). */
  readonly intervalMs?: number;
  /** Clock in ms; defaults to performance.now. */
  readonly now?: () => number;
  /**
   * Re-checks a held message later. Defaults to requestAnimationFrame, which runs only while a
   * message is held. Pass null for purely event-driven delivery (tick()).
   */
  readonly defer?: ((fn: () => void) => void) | null;
}

export interface Announcer {
  /** The live region; mount it once, anywhere in the boot screen. */
  readonly el: HTMLElement;
  /** Speaks now if the window allows, else holds it. Returns true when spoken now. */
  say(text: string, priority?: Say): boolean;
  /** Delivers a held message once the window has passed. Call it on every boot event. */
  tick(): void;
}

export const ANNOUNCE_INTERVAL_MS = 750;

export function createAnnouncer(opts: AnnouncerOptions = {}): Announcer {
  const doc = docOf(opts.doc);
  const interval = opts.intervalMs ?? ANNOUNCE_INTERVAL_MS;
  const now = opts.now ?? (() => performance.now());
  const raf = doc.defaultView?.requestAnimationFrame.bind(doc.defaultView);
  const defer =
    opts.defer === undefined
      ? raf === undefined
        ? null
        : (fn: () => void) => void raf(fn)
      : opts.defer;
  const region = render(
    h('div', { class: 'plb-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }),
    doc,
  );
  let last = Number.NEGATIVE_INFINITY;
  let held: { text: string; priority: Say } | null = null;
  let waiting = false;

  const speak = (text: string): void => {
    region.textContent = text;
    last = now();
  };

  const tick = (): void => {
    if (held !== null && now() - last >= interval) {
      speak(held.text);
      held = null;
    }
    if (held !== null && !waiting && defer !== null) {
      waiting = true;
      defer(() => {
        waiting = false;
        tick();
      });
    }
  };

  return {
    el: region,
    say(text, priority = Say.Detail) {
      if (held === null && now() - last >= interval) {
        speak(text);
        return true;
      }
      if (held === null || priority >= held.priority) held = { text, priority };
      tick();
      return false;
    },
    tick,
  };
}
