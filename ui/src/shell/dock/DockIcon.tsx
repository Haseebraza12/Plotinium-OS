import { createEffect, createSignal, on, onCleanup, Show, splitProps, type JSX } from 'solid-js';

import { AppIcon } from '../../icons/index.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { prefersReducedMotion } from '../../primitives/internal/motion.ts';
import { Tooltip } from '../../primitives/tooltip/Tooltip.tsx';
import { badgeText } from '../format.ts';
import type { DockItem } from '../types.ts';
import styles from './Dock.module.css';

export interface DockIconProps {
  item: DockItem;
  /** Roving tab stop: 0 for the active icon, -1 for the rest. */
  tabIndex?: number;
  onActivate: () => void;
  /** Right-click, Shift+F10 or the Menu key: the item menu (New window, Close all …). */
  onMenu?: (anchor: HTMLElement) => void;
  onFocus?: () => void;
  /** Overrides the spoken name (Trash says whether it has items). */
  spokenLabel?: string;
  /** Plays the staggered entrance (desktop mount after login). */
  animateIn?: boolean;
  staggerIndex?: number;
  /** The layout slot; the dock writes translateX here while magnifying. */
  slotRef?: (el: HTMLDivElement) => void;
  /** The icon box; the dock writes scale() here, and getIconRect() measures it. */
  iconRef?: (el: HTMLDivElement) => void;
  buttonRef?: (el: HTMLButtonElement) => void;
  class?: string;
}

type Hop = 'pl-anim-dock-bounce' | 'pl-anim-dock-attention';

/** The spoken name: "Files, running, 2 windows, 1 minimised, 3 new, needs attention". */
export function dockItemLabel(item: DockItem): string {
  const parts = [item.label];
  if (item.running === true) parts.push('running');
  const windows = item.windows ?? 0;
  if (windows > 0) parts.push(`${windows} ${windows === 1 ? 'window' : 'windows'}`);
  const minimised = Math.min(windows > 0 ? windows : Infinity, item.minimised ?? 0);
  if (minimised > 0) parts.push(`${minimised} minimised`);
  if ((item.badge ?? 0) > 0) parts.push(`${badgeText(item.badge ?? 0)} new`);
  if (item.attention === true) parts.push('needs attention');
  return parts.join(', ');
}

/**
 * One dock icon: the app's squircle, a label tooltip, a running dot, a badge, and the launch
 * bounce and attention hop (one-shot motion classes, replayed on each rising edge and skipped
 * under reduced motion, where the running dot and the badge carry the meaning). The press scale
 * is the shared pl-press class.
 */
export function DockIcon(props: DockIconProps): JSX.Element {
  const [local] = splitProps(props, [
    'item',
    'tabIndex',
    'onActivate',
    'onMenu',
    'onFocus',
    'spokenLabel',
    'animateIn',
    'staggerIndex',
    'slotRef',
    'iconRef',
    'buttonRef',
    'class',
  ]);
  const [hop, setHop] = createSignal<Hop>();
  let replay = 0;

  const play = (kind: Hop): void => {
    if (typeof document === 'undefined' || prefersReducedMotion(document)) return;
    setHop(undefined);
    cancelAnimationFrame(replay);
    // Re-adding the class on the next frame restarts the animation if it is still running.
    replay = requestAnimationFrame(() => setHop(kind));
  };
  onCleanup(() => cancelAnimationFrame(replay));

  createEffect(
    on(
      () => local.item.launching === true,
      (launching, was) => {
        if (launching && was !== true) play('pl-anim-dock-bounce');
      },
    ),
  );
  createEffect(
    on(
      () => local.item.attention === true,
      (attention, was) => {
        if (attention && was !== true) play('pl-anim-dock-attention');
      },
    ),
  );

  const badge = (): number => local.item.badge ?? 0;

  const openMenu = (anchor: HTMLElement): void => {
    local.onMenu?.(anchor);
  };

  return (
    <div
      ref={(el) => local.slotRef?.(el)}
      class={cx(styles.slot, local.animateIn === true && 'pl-anim-dock-item-in', local.class)}
      style={{ '--pl-stagger-index': String(local.staggerIndex ?? 0) }}
      data-running={local.item.running === true ? 'true' : 'false'}
    >
      <div ref={(el) => local.iconRef?.(el)} class={styles.scaler}>
        <div
          class={cx(styles.hop, hop())}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setHop(undefined);
          }}
        >
          <Tooltip content={local.item.label} prominent describe={false} delay={300}>
            <button
              ref={(el) => local.buttonRef?.(el)}
              type="button"
              class={cx(styles.button, 'pl-press')}
              tabindex={local.tabIndex ?? 0}
              aria-label={local.spokenLabel ?? dockItemLabel(local.item)}
              data-dock-id={local.item.id}
              onClick={() => local.onActivate()}
              onFocus={() => local.onFocus?.()}
              onContextMenu={(event) => {
                if (local.onMenu === undefined) return;
                event.preventDefault();
                openMenu(event.currentTarget);
              }}
              onKeyDown={(event) => {
                if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
                  if (local.onMenu === undefined) return;
                  event.preventDefault();
                  openMenu(event.currentTarget);
                }
              }}
            >
              <AppIcon app={local.item.icon} size={52} class={styles.icon} />
              <Show when={(local.item.minimised ?? 0) > 0}>
                <span class={cx(styles.minMark, 'pl-anim-pop-in')} aria-hidden="true" />
              </Show>
              <Show when={badge() > 0}>
                <span class={cx(styles.badge, 'pl-anim-pop-in')} aria-hidden="true">
                  {badgeText(badge())}
                </span>
              </Show>
            </button>
          </Tooltip>
        </div>
      </div>
      <span class={styles.dot} aria-hidden="true" />
    </div>
  );
}
