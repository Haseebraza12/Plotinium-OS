import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';

import { prefersReducedMotion } from './motion.ts';

export type PresenceState = 'open' | 'closing' | 'closed';

export interface Presence {
  /** True while the element should be in the DOM (open, or playing its exit animation). */
  mounted: Accessor<boolean>;
  state: Accessor<PresenceState>;
}

/**
 * Keeps an overlay mounted for the length of its exit animation, then unmounts it. The exit
 * animation is a CSS class keyed off `state() === 'closing'`; a timer (not animationend) ends
 * it, so a missing or reduced animation can never leave an invisible overlay behind.
 */
export function createPresence(open: Accessor<boolean>, exitMs: number): Presence {
  const [state, setState] = createSignal<PresenceState>(open() ? 'open' : 'closed');
  let timer: ReturnType<typeof setTimeout> | undefined;

  createEffect(
    on(open, (isOpen) => {
      clearTimeout(timer);
      if (isOpen) {
        setState('open');
        return;
      }
      if (state() === 'closed') return;
      const instant = typeof document === 'undefined' || prefersReducedMotion(document);
      if (instant || exitMs <= 0) {
        setState('closed');
        return;
      }
      setState('closing');
      timer = setTimeout(() => setState('closed'), exitMs);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  return { mounted: () => state() !== 'closed', state };
}
