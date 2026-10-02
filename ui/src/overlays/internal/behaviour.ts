import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';

import { createModalFocus } from '../../primitives/dialog/modal.ts';
import { createDismissableLayer } from '../../primitives/internal/layers.ts';
import { createPresence, type Presence } from '../../primitives/internal/presence.ts';

export interface ModalLayerOptions {
  open: Accessor<boolean>;
  panel: () => HTMLElement | undefined;
  /** Escape on the topmost layer. Omit to ignore Escape. */
  onEscape?: () => void;
  /** Exit animation length; the overlay stays mounted this long after `open` turns false. */
  exitMs: number;
}

/**
 * The modal lifecycle every overlay here shares: presence (mounted through the exit animation),
 * focus in on open and back to the invoker on close (APG dialog), and one slot in the
 * dismissable-layer stack so a single Escape closes only the topmost overlay (DSN-34).
 */
export function createModalLayer(options: ModalLayerOptions): Presence {
  const presence = createPresence(options.open, options.exitMs);
  createModalFocus(options.open, options.panel);
  createDismissableLayer({
    active: options.open,
    inside: () => [options.panel()],
    onEscape: () => options.onEscape?.(),
  });
  return presence;
}

/**
 * A one-shot horizontal nudge ("answer this first"). Each call flips `data-nudge` between two
 * values bound to identical keyframes, so the animation restarts without a forced reflow.
 */
export function createNudge(): { nudge: () => void; attr: Accessor<'a' | 'b' | undefined> } {
  const [attr, setAttr] = createSignal<'a' | 'b' | undefined>();
  return {
    nudge: () => setAttr((v) => (v === 'a' ? 'b' : 'a')),
    attr,
  };
}

/**
 * Follows `source` once it has been stable for `delayMs` (live-region text that must not
 * chatter while the user types; the Search palette announces "8 results" 400 ms after typing).
 */
export function createSettled<T>(source: Accessor<T>, delayMs: number): Accessor<T> {
  const [settled, setSettled] = createSignal<T>(source());
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      source,
      (value) => {
        clearTimeout(timer);
        timer = setTimeout(() => setSettled(() => value), delayMs);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return settled;
}

/**
 * Follows `source` at most once per `intervalMs` (the leading value at once, then the latest
 * value at the end of each window). Live regions for values that change several times a second
 * (shutdown progress, the frame meter) use it so a screen reader is not flooded.
 */
export function createThrottled<T>(source: Accessor<T>, intervalMs: number): Accessor<T> {
  const [value, setValue] = createSignal<T>(source());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const flush = (): void => {
    timer = undefined;
    if (!pending) return;
    pending = false;
    setValue(() => source());
    timer = setTimeout(flush, intervalMs);
  };
  createEffect(
    on(
      source,
      (next) => {
        if (timer === undefined) {
          setValue(() => next);
          timer = setTimeout(flush, intervalMs);
        } else {
          pending = true;
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return value;
}

/**
 * A message that shows for `ms` and then clears (the "Answer the confirmation first" line that
 * replaces the nudge under reduced motion).
 */
export function createTransientMessage(ms: number): {
  message: Accessor<string>;
  show: (text: string) => void;
} {
  const [message, setMessage] = createSignal('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return {
    message,
    show: (text) => {
      clearTimeout(timer);
      setMessage(text);
      timer = setTimeout(() => setMessage(''), ms);
    },
  };
}

/** True when the event target is a text-entry control (single-letter shortcuts stay off there). */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(target.type);
}

/** A DOM id fragment from an arbitrary item id. */
export function idPart(value: string): string {
  return value.replace(/[^\w-]/gu, '_');
}
