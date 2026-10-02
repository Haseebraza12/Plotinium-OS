import { createEffect, on, type Accessor } from 'solid-js';

import { focusInitial, rememberFocus } from '../internal/focus.ts';

/**
 * Focus lifecycle shared by Dialog and Sheet (APG dialog pattern): remember the invoker on
 * open, move focus to the initial element once the panel exists, give focus back on close.
 */
export function createModalFocus(
  open: Accessor<boolean>,
  panel: () => HTMLElement | undefined,
): void {
  let restore: (() => void) | undefined;
  createEffect(
    on(open, (isOpen, wasOpen) => {
      if (isOpen) {
        restore = rememberFocus(document);
        queueMicrotask(() => {
          const el = panel();
          if (el !== undefined) focusInitial(el);
        });
      } else if (wasOpen === true) {
        restore?.();
        restore = undefined;
      }
    }),
  );
}
