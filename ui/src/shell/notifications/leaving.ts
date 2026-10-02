import { createSignal, onCleanup } from 'solid-js';

import { prefersReducedMotion } from '../../primitives/internal/motion.ts';

export interface Leaving {
  /** True while the item plays its exit animation. */
  isLeaving: (id: string) => boolean;
  /**
   * Plays the exit animation, then calls `done` (which normally removes the item upstream).
   * Under reduced motion `done` runs at once. A second call while leaving is ignored.
   */
  leave: (id: string, done: () => void) => void;
}

/**
 * Exit bookkeeping for list items (notification cards and banners). A timer, not animationend,
 * ends the exit, so a missing or reduced animation never strands an item (as createPresence).
 */
export function createLeaving(exitMs: number): Leaving {
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const leave = (id: string, done: () => void): void => {
    if (timers.has(id)) return;
    if (typeof document === 'undefined' || prefersReducedMotion(document) || exitMs <= 0) {
      done();
      return;
    }
    setLeaving((prev) => new Set(prev).add(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        done();
        setLeaving((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, exitMs),
    );
  };

  onCleanup(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });

  return { isLeaving: (id) => leaving().has(id), leave };
}
