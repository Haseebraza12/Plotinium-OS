import { createSignal, onCleanup, onMount, splitProps, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

import { cx } from './cx.ts';
import styles from './Floating.module.css';
import {
  computePosition,
  originFor,
  rectOf,
  viewportOf,
  type Placement,
  type Position,
  type Rect,
} from './position.ts';

export interface FloatingProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, 'style'> {
  /** An element, or a point/rect in viewport coordinates (context menus). */
  anchor: Element | Rect | undefined;
  placement: Placement;
  offset?: number;
  layer?: 'popover' | 'tooltip';
  /** Popover material (glass). Tooltips and custom surfaces pass false. */
  glass?: boolean;
  /** At least as wide as the anchor (pop-up buttons). */
  matchAnchorWidth?: boolean;
  floatingRef?: (el: HTMLDivElement) => void;
  onPositioned?: (position: Position) => void;
}

/**
 * A surface portalled to <body> and placed with position: fixed next to its anchor, so window
 * containment (contain: paint) never clips a menu. Placement is computed once on mount and on
 * resize; the entrance animation (a motion.css class on the same element) uses transform only.
 */
export function Floating(props: FloatingProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'anchor',
    'placement',
    'offset',
    'layer',
    'glass',
    'matchAnchorWidth',
    'floatingRef',
    'onPositioned',
    'class',
    'children',
  ]);
  const [position, setPosition] = createSignal<Position>();
  let el: HTMLDivElement | undefined;

  const update = (): void => {
    const anchor = local.anchor;
    if (el === undefined || anchor === undefined) return;
    const rect = anchor instanceof Element ? rectOf(anchor) : anchor;
    if (local.matchAnchorWidth === true) el.style.minWidth = `${rect.width}px`;
    const next = computePosition(
      rect,
      { width: el.offsetWidth, height: el.offsetHeight },
      local.placement,
      viewportOf(el.ownerDocument),
      local.offset ?? 6,
    );
    setPosition(next);
    local.onPositioned?.(next);
  };

  onMount(() => {
    update();
    const view = el?.ownerDocument.defaultView;
    view?.addEventListener('resize', update);
    onCleanup(() => view?.removeEventListener('resize', update));
  });

  return (
    <Portal>
      <div
        ref={(node) => {
          el = node;
          local.floatingRef?.(node);
        }}
        class={cx(
          styles.floating,
          local.layer === 'tooltip' && styles.tooltipLayer,
          local.glass !== false && styles.glass,
          local.class,
        )}
        style={{
          left: `${position()?.x ?? 0}px`,
          top: `${position()?.y ?? 0}px`,
          'transform-origin':
            position() === undefined ? undefined : originFor(position() as Position),
        }}
        data-side={position()?.side}
        {...rest}
      >
        {local.children}
      </div>
    </Portal>
  );
}
