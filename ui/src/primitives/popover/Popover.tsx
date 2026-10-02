import { createEffect, on, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import { Floating } from '../internal/Floating.tsx';
import { focusableIn, focusInitial } from '../internal/focus.ts';
import { createDismissableLayer } from '../internal/layers.ts';
import type { Placement } from '../internal/position.ts';
import { createPresence } from '../internal/presence.ts';
import styles from './Popover.module.css';

export type PopoverCloseReason = 'escape' | 'outside';

export interface PopoverProps {
  open: boolean;
  onClose: (reason: PopoverCloseReason) => void;
  /** The element the popover points at (focus returns to it on Escape). */
  anchor: HTMLElement | undefined;
  /** Accessible name of the popover dialog. */
  label: string;
  placement?: Placement;
  children: JSX.Element;
  /** Move focus inside on open (first [data-autofocus] or tabbable). Default true. */
  autoFocus?: boolean;
  /** No inner padding (lists, grids that run edge to edge). */
  flush?: boolean;
  class?: string;
  id?: string;
}

/**
 * Focuses the first control after `anchor` in document order, outside `surface`, that really
 * takes focus (hidden ones are skipped by trying them). Returns whether one did.
 */
function focusAfter(anchor: HTMLElement, surface: HTMLElement): boolean {
  const doc = anchor.ownerDocument;
  const candidates = focusableIn(doc.body).filter(
    (el) =>
      !surface.contains(el) &&
      !anchor.contains(el) &&
      (anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  for (const el of candidates.slice(0, 16)) {
    el.focus();
    if (doc.activeElement === el) return true;
  }
  return false;
}

/**
 * A non-modal glass popover (Control Centre modules, the AI chip, colour pickers). Escape and a
 * click outside close it; Escape returns focus to the anchor. It animates in with a spring
 * fade-scale from its anchor side and fades out.
 *
 * The surface is portalled to <body>, so Tab past its last control (or Shift+Tab before its
 * first) would land on <body>. Instead focus goes where it would if the popover sat right after
 * its anchor: forward to the next control after the anchor, back to the anchor, and the popover
 * closes as focus leaves it (UI-140, WCAG 2.4.3).
 */
export function Popover(props: PopoverProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'anchor',
    'label',
    'placement',
    'children',
    'autoFocus',
    'flush',
    'class',
    'id',
  ]);
  const presence = createPresence(() => local.open, 120);
  let surface: HTMLDivElement | undefined;

  createDismissableLayer({
    active: () => local.open,
    inside: () => [surface, local.anchor],
    onEscape: () => {
      local.onClose('escape');
      local.anchor?.focus();
    },
    onOutside: () => local.onClose('outside'),
  });

  createEffect(
    on(
      () => local.open,
      (open, wasOpen) => {
        if (
          !open &&
          wasOpen === true &&
          surface?.contains(surface.ownerDocument.activeElement) === true
        ) {
          local.anchor?.focus();
        }
      },
    ),
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    const anchor = local.anchor;
    if (event.key !== 'Tab' || event.defaultPrevented || surface === undefined) return;
    if (anchor === undefined) return;
    const items = focusableIn(surface);
    const active = surface.ownerDocument.activeElement;
    const leaving = event.shiftKey
      ? items.length === 0 || active === items[0] || active === surface
      : items.length === 0 || active === items[items.length - 1];
    if (!leaving) return;
    event.preventDefault();
    // Focus moves first, so closing does not pull it back to the anchor.
    if (event.shiftKey || !focusAfter(anchor, surface)) anchor.focus();
    local.onClose('outside');
  };

  return (
    <Show when={presence.mounted()}>
      <Floating
        anchor={local.anchor}
        placement={local.placement ?? 'bottom-start'}
        role="dialog"
        aria-label={local.label}
        id={local.id}
        tabindex={-1}
        data-state={presence.state()}
        onKeyDown={onKeyDown}
        class={cx(
          styles.popover,
          local.flush === true && styles.flush,
          presence.state() === 'closing' ? 'pl-anim-popover-out' : 'pl-anim-popover-in',
          local.class,
        )}
        floatingRef={(el) => {
          surface = el;
          if (local.autoFocus !== false) queueMicrotask(() => focusInitial(el));
        }}
      >
        {local.children}
      </Floating>
    </Show>
  );
}
