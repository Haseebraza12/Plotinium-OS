import ArrowDown from 'lucide-solid/icons/arrow-down';
import Pause from 'lucide-solid/icons/pause';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  Show,
  splitProps,
  untrack,
  type JSX,
} from 'solid-js';
import { Portal } from 'solid-js/web';

import { AppIcon, type IconId } from '../../icons/index.tsx';
import { createModalFocus } from '../../primitives/dialog/modal.ts';
import { cx } from '../../primitives/internal/cx.ts';
import { createDismissableLayer } from '../../primitives/internal/layers.ts';
import { createPresence } from '../../primitives/internal/presence.ts';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import { idPart } from '../internal/behaviour.ts';
import shared from '../internal/shared.module.css';
import styles from './AppSwitcher.module.css';

export interface SwitcherItem {
  /** The window id: the switcher lists windows in stacking order, minimised ones included. */
  id: string;
  /** Window title: `Terminal — ~`. */
  title: string;
  app: IconId;
  appName: string;
  state?: 'minimised' | 'suspended';
  /** Windows this app has open, when two or more (a small count caption). */
  count?: number;
}

export interface AppSwitcherProps {
  open: boolean;
  items: readonly SwitcherItem[];
  selectedId: string | undefined;
  /** Arrow keys, Alt+` / Alt+Shift+` while the HUD has focus, or the pointer. */
  onHighlight: (id: string) => void;
  /** Enter, a click, or releasing Alt: focus that window. */
  onCommit: (id: string) => void;
  /** Escape: close without switching. */
  onCancel: () => void;
  /** Render inside the nearest positioned ancestor instead of a full-screen portal (gallery). */
  contained?: boolean;
  class?: string;
}

const ICON = 72;
const GAP = 20;

/** The spoken option: `Terminal — ~, Terminal, 2 of 5, minimised`. */
export function spokenSwitcherItem(item: SwitcherItem, index: number, total: number): string {
  return [item.title, item.appName, `${index + 1} of ${total}`, item.state]
    .filter((part) => part !== undefined)
    .join(', ');
}

/**
 * The window switcher HUD (WM-07, window-manager §3.9): windows drawn as their app icons on
 * glass, a highlight plate that springs to the chosen one, and its title and position under the
 * row. It is a listbox announced on open ("Switch window: Terminal — ~, 2 of 5"). The WM owns
 * the Alt hold and the 120 ms threshold; the HUD handles keys while it has focus, commits when
 * Alt is released, and works with a single pointer.
 */
export function AppSwitcher(props: AppSwitcherProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'items',
    'selectedId',
    'onHighlight',
    'onCommit',
    'onCancel',
    'contained',
    'class',
  ]);
  const uid = createUniqueId();
  const optionId = (id: string): string => `pl-switch-${uid}-${idPart(id)}`;
  let listbox: HTMLDivElement | undefined;
  const presence = createPresence(() => local.open, 120);
  createModalFocus(
    () => local.open,
    () => listbox,
  );
  createDismissableLayer({
    active: () => local.open,
    inside: () => [listbox],
    onEscape: () => local.onCancel(),
    onOutside: () => local.onCancel(),
  });

  const index = createMemo(() => local.items.findIndex((item) => item.id === local.selectedId));
  const selected = (): SwitcherItem | undefined => local.items[index()];
  // A wrap-around (last to first) cross-fades the plate instead of sliding across the HUD.
  const [jump, setJump] = createSignal(false);
  createEffect(
    on(index, (next, previous) => {
      setJump(previous !== undefined && previous >= 0 && Math.abs(next - previous) > 1);
    }),
  );

  // Announced once when the HUD opens (the listbox then announces each highlighted option).
  const [announcement, setAnnouncement] = createSignal('');
  createEffect(
    on(
      () => local.open,
      (open) => {
        const item = untrack(selected);
        setAnnouncement(
          open && item !== undefined
            ? `Switch window: ${item.title}, ${untrack(index) + 1} of ${untrack(() => local.items.length)}`
            : '',
        );
      },
    ),
  );

  const step = (delta: 1 | -1): void => {
    const count = local.items.length;
    if (count === 0) return;
    const current = index() < 0 ? (delta === 1 ? -1 : 0) : index();
    const next = local.items[(current + delta + count) % count];
    if (next !== undefined) local.onHighlight(next.id);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        return;
      case '`':
      case '~':
      case 'j':
      case 'k':
        if (!event.altKey) return;
        event.preventDefault();
        step(event.shiftKey || event.key === 'k' || event.key === '~' ? -1 : 1);
        return;
      case 'Tab':
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
        return;
      case 'Home':
        event.preventDefault();
        if (local.items[0] !== undefined) local.onHighlight(local.items[0].id);
        return;
      case 'End': {
        event.preventDefault();
        const last = local.items[local.items.length - 1];
        if (last !== undefined) local.onHighlight(last.id);
        return;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const item = selected();
        if (item !== undefined) local.onCommit(item.id);
        return;
      }
      default:
        return;
    }
  };

  const layer = (): JSX.Element => (
    <div
      class={cx(styles.layer, local.contained === true && styles.contained, local.class)}
      data-state={presence.state()}
    >
      <div class={cx(styles.hudWrap, presence.state() === 'closing' ? styles.out : styles.in)}>
        <div
          ref={(el) => (listbox = el)}
          class={styles.hud}
          role="listbox"
          aria-label="Switch window"
          aria-orientation="horizontal"
          aria-activedescendant={
            selected() === undefined ? undefined : optionId(selected()?.id ?? '')
          }
          tabindex={-1}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (event.key !== 'Alt') return;
            const item = selected();
            if (item !== undefined) local.onCommit(item.id);
          }}
        >
          <div class={styles.row} style={{ '--pl-switch-index': String(Math.max(0, index())) }}>
            <span
              class={styles.plate}
              data-visible={index() >= 0 ? 'true' : undefined}
              data-jump={jump() ? 'true' : undefined}
              aria-hidden="true"
            />
            <For each={local.items}>
              {(item, i) => (
                <div
                  id={optionId(item.id)}
                  role="option"
                  aria-selected={item.id === local.selectedId ? 'true' : 'false'}
                  aria-label={spokenSwitcherItem(item, i(), local.items.length)}
                  class={styles.item}
                  data-selected={item.id === local.selectedId ? 'true' : undefined}
                  data-state={item.state}
                  style={{ '--pl-stagger-index': String(i()) }}
                  onPointerEnter={() => local.onHighlight(item.id)}
                  onClick={() => local.onCommit(item.id)}
                >
                  <span class={styles.icon}>
                    <AppIcon app={item.app} size={ICON} />
                  </span>
                  <Show when={item.state === 'minimised'}>
                    <span class={styles.stateBadge} aria-hidden="true">
                      <ArrowDown size={11} stroke-width={3} />
                    </span>
                  </Show>
                  <Show when={item.state === 'suspended'}>
                    <span class={styles.stateBadge} aria-hidden="true">
                      <Pause size={10} stroke-width={3} />
                    </span>
                  </Show>
                  <Show when={item.count !== undefined && item.count > 1}>
                    <span class={styles.count} aria-hidden="true">
                      {item.count}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <Show keyed when={selected()}>
            {(item) => (
              <p class={styles.caption} aria-hidden="true">
                <span class={styles.captionTitle}>{item.appName}</span>
                <span class={styles.captionMeta}>
                  {item.title.startsWith(`${item.appName} — `)
                    ? item.title.slice(item.appName.length + 3)
                    : item.title}
                  <Show when={item.state}>{(state) => <> · {state()}</>}</Show> · {index() + 1} of{' '}
                  {local.items.length}
                </span>
              </p>
            )}
          </Show>
        </div>
        <p class={styles.hints}>
          <Kbd keys={['Alt', '`']} /> next <span aria-hidden="true">·</span>{' '}
          <Kbd keys={['Alt', '⇧', '`']} /> previous <span aria-hidden="true">·</span>{' '}
          <Kbd keys={['Esc']} /> cancel
        </p>
      </div>
      <p class={shared.srOnly} role="status">
        {announcement()}
      </p>
    </div>
  );

  return (
    <Show when={presence.mounted()}>
      <Show when={local.contained === true} fallback={<Portal>{layer()}</Portal>}>
        {layer()}
      </Show>
    </Show>
  );
}

export const SWITCHER_METRICS = { icon: ICON, gap: GAP } as const;
