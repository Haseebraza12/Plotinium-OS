import {
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { cx } from '../internal/cx.ts';
import { Floating } from '../internal/Floating.tsx';
import type { Placement } from '../internal/position.ts';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  /** Tooltip text. Plain text only (DSN-09). */
  content: string;
  /** The trigger: one focusable element (button, link). */
  children: JSX.Element;
  placement?: Placement;
  /** Hover delay before the first tooltip appears (later ones in the warm window show at once). */
  delay?: number;
  /**
   * Also expose the text as the trigger's description (aria-describedby). Turn off when the
   * text repeats the trigger's accessible name (dock labels).
   */
  describe?: boolean;
  /** Larger capsule used for dock labels. */
  prominent?: boolean;
  class?: string;
}

const WARM_MS = 600;
let lastHiddenAt = Number.NEGATIVE_INFINITY;

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * A tooltip that follows WCAG 1.4.13: it appears on hover (after a delay) and on keyboard focus,
 * stays while the pointer moves onto it, and Escape dismisses it without moving focus.
 */
export function Tooltip(props: TooltipProps): JSX.Element {
  const [local] = splitProps(props, [
    'content',
    'children',
    'placement',
    'delay',
    'describe',
    'prominent',
    'class',
  ]);
  const uid = createUniqueId();
  const descriptionId = `pl-tip-${uid}`;
  const [visible, setVisible] = createSignal(false);
  const [target, setTarget] = createSignal<Element>();
  let wrapper: HTMLSpanElement | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());
  const show = (immediate: boolean): void => {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    const warm = now() - lastHiddenAt < WARM_MS;
    if (immediate || warm) setVisible(true);
    else showTimer = setTimeout(() => setVisible(true), local.delay ?? 500);
  };
  const hide = (soon: boolean): void => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    const done = (): void => {
      if (visible()) lastHiddenAt = now();
      setVisible(false);
    };
    if (soon) hideTimer = setTimeout(done, 120);
    else done();
  };

  onMount(() => {
    const trigger = wrapper?.querySelector(FOCUSABLE) ?? wrapper?.firstElementChild ?? undefined;
    setTarget(trigger);
    if (trigger !== undefined && local.describe !== false) {
      const existing = trigger.getAttribute('aria-describedby');
      trigger.setAttribute(
        'aria-describedby',
        existing === null ? descriptionId : `${existing} ${descriptionId}`,
      );
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && visible()) hide(false);
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    });
  });

  const focusVisible = (el: EventTarget | null): boolean => {
    if (!(el instanceof Element)) return false;
    try {
      return el.matches(':focus-visible');
    } catch {
      return true;
    }
  };

  return (
    <span
      ref={(el) => (wrapper = el)}
      class={styles.anchor}
      onPointerEnter={() => show(false)}
      onPointerLeave={() => hide(true)}
      onPointerDown={() => hide(false)}
      onFocusIn={(event) => {
        if (focusVisible(event.target)) show(true);
      }}
      onFocusOut={() => hide(false)}
    >
      {local.children}
      <Show when={local.describe !== false}>
        <span id={descriptionId} class={styles.hidden}>
          {local.content}
        </span>
      </Show>
      <Show when={visible()}>
        <Floating
          anchor={target()}
          placement={local.placement ?? 'top'}
          offset={8}
          layer="tooltip"
          glass={false}
          role="tooltip"
          aria-hidden="true"
          class={cx(
            styles.tooltip,
            local.prominent === true && styles.prominent,
            'pl-anim-tooltip-in',
            local.class,
          )}
          onPointerEnter={() => clearTimeout(hideTimer)}
          onPointerLeave={() => hide(true)}
        >
          {local.content}
        </Floating>
      </Show>
    </span>
  );
}
