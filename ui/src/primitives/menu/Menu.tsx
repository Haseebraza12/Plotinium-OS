import Check from 'lucide-solid/icons/check';
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { ariaKeyShortcuts, Kbd } from '../kbd/Kbd.tsx';
import { cx } from '../internal/cx.ts';
import { Floating } from '../internal/Floating.tsx';
import type { IconComponent } from '../internal/icon.ts';
import { createDismissableLayer } from '../internal/layers.ts';
import {
  createTypeahead,
  firstEnabled,
  isPrintableKey,
  lastEnabled,
  matchTypeahead,
  stepIndex,
} from '../internal/list-nav.ts';
import type { Placement, Rect } from '../internal/position.ts';
import { createPresence } from '../internal/presence.ts';
import styles from './Menu.module.css';

export interface MenuItemEntry {
  kind?: 'item';
  id: string;
  label: string;
  icon?: IconComponent;
  /** Shortcut keys shown right-aligned, e.g. ['Ctrl', 'C']. Display only. */
  shortcut?: readonly string[];
  description?: string;
  disabled?: boolean;
  /** Destructive items (Move to Trash, Kill process). */
  danger?: boolean;
  /** Makes it a menuitemcheckbox. */
  checked?: boolean;
}
export interface MenuSeparatorEntry {
  kind: 'separator';
  id?: string;
}
export interface MenuHeaderEntry {
  kind: 'header';
  label: string;
  id?: string;
}
export type MenuEntry = MenuItemEntry | MenuSeparatorEntry | MenuHeaderEntry;

export type MenuCloseReason = 'select' | 'escape' | 'outside' | 'tab';

export interface MenuProps {
  open: boolean;
  onClose: (reason: MenuCloseReason) => void;
  onSelect: (id: string) => void;
  items: readonly MenuEntry[];
  /** Accessible name, usually the menu title ("File", "Actions for os-report.md"). */
  label: string;
  /** Anchor element (menu bar title, button); focus returns to it. */
  anchor?: HTMLElement;
  /** Or a pointer position (context menus). */
  at?: { x: number; y: number };
  placement?: Placement;
  /** Which item gets focus on open: ArrowUp opens on the last. */
  initialFocus?: 'first' | 'last';
  id?: string;
  class?: string;
}

function isItem(entry: MenuEntry | undefined): entry is MenuItemEntry {
  return entry !== undefined && (entry.kind === undefined || entry.kind === 'item');
}

/**
 * A menu (WAI-ARIA APG menu pattern): arrow keys with wrap, Home/End, type-ahead, Enter/Space
 * activate, Escape closes and returns focus, Tab closes. Rows highlight on hover like macOS.
 */
export function Menu(props: MenuProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'onSelect',
    'items',
    'label',
    'anchor',
    'at',
    'placement',
    'initialFocus',
    'id',
    'class',
  ]);
  const uid = createUniqueId();
  const presence = createPresence(() => local.open, 100);
  const [active, setActive] = createSignal(-1);
  const refs: (HTMLElement | undefined)[] = [];
  const typeahead = createTypeahead();
  let surface: HTMLDivElement | undefined;

  const isDisabled = (i: number): boolean => {
    const entry = local.items[i];
    return !isItem(entry) || entry.disabled === true;
  };
  const hasChecks = (): boolean => local.items.some((e) => isItem(e) && e.checked !== undefined);
  const anchorRect = (): HTMLElement | Rect | undefined =>
    local.at === undefined ? local.anchor : { x: local.at.x, y: local.at.y, width: 0, height: 0 };

  const close = (reason: MenuCloseReason): void => {
    local.onClose(reason);
    if (reason !== 'outside') local.anchor?.focus();
  };

  createDismissableLayer({
    active: () => local.open,
    inside: () => [surface, local.at === undefined ? local.anchor : undefined],
    onEscape: () => close('escape'),
    onOutside: () => close('outside'),
  });

  // Focus the first (or last) enabled item whenever the menu opens.
  createEffect(
    on(
      () => local.open,
      (open) => {
        if (!open) return;
        const count = local.items.length;
        setActive(
          local.initialFocus === 'last'
            ? lastEnabled(count, isDisabled)
            : firstEnabled(count, isDisabled),
        );
      },
    ),
  );
  // Rows mount with the presence, so on an open after mount this effect can run before the new
  // rows exist, and on a re-open `refs` still holds the previous (detached) rows. Focus only a
  // connected row, and retry once the update has settled.
  const focusRow = (index: number): boolean => {
    const row = refs[index];
    if (row === undefined || !row.isConnected) return false;
    row.focus();
    return true;
  };
  createEffect(() => {
    const index = active();
    const mounted = presence.mounted();
    if (!local.open || index < 0 || !mounted) return;
    if (focusRow(index)) return;
    queueMicrotask(() => {
      if (local.open && active() === index) focusRow(index);
    });
  });
  createEffect(
    on(presence.mounted, (mounted) => {
      if (!mounted) refs.length = 0;
    }),
  );

  const activate = (index: number): void => {
    const entry = local.items[index];
    if (!isItem(entry) || entry.disabled === true) return;
    local.onSelect(entry.id);
    close('select');
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const count = local.items.length;
    switch (event.key) {
      case 'ArrowDown':
        setActive(stepIndex(active(), 1, count, isDisabled, true));
        break;
      case 'ArrowUp':
        setActive(stepIndex(active() < 0 ? count : active(), -1, count, isDisabled, true));
        break;
      case 'Home':
      case 'PageUp':
        setActive(firstEnabled(count, isDisabled));
        break;
      case 'End':
      case 'PageDown':
        setActive(lastEnabled(count, isDisabled));
        break;
      case 'Enter':
      case ' ':
        activate(active());
        break;
      case 'Tab':
        local.onClose('tab');
        return;
      default: {
        if (!isPrintableKey(event)) return;
        const labels = local.items.map((e) => (isItem(e) ? e.label : ''));
        const match = matchTypeahead(
          labels,
          typeahead(event.key, event.timeStamp),
          active(),
          isDisabled,
        );
        if (match >= 0) setActive(match);
      }
    }
    event.preventDefault();
  };

  return (
    <Show when={presence.mounted()}>
      <Floating
        anchor={anchorRect()}
        placement={local.placement ?? 'bottom-start'}
        role="menu"
        aria-label={local.label}
        id={local.id ?? `pl-menu-${uid}`}
        tabindex={-1}
        data-state={presence.state()}
        class={cx(
          styles.menu,
          hasChecks() && styles.withChecks,
          presence.state() === 'closing' ? 'pl-anim-menu-out' : 'pl-anim-menu-in',
          local.class,
        )}
        floatingRef={(el) => (surface = el)}
        onKeyDown={onKeyDown}
      >
        <For each={local.items}>
          {(entry, index) => (
            <Switch>
              <Match when={entry.kind === 'separator'}>
                <div role="separator" class={styles.separator} />
              </Match>
              <Match when={entry.kind === 'header' ? entry : undefined}>
                {(header) => (
                  <div role="presentation" class={styles.header}>
                    {header().label}
                  </div>
                )}
              </Match>
              <Match when={isItem(entry) ? entry : undefined}>
                {(item) => (
                  <div
                    ref={(el) => (refs[index()] = el)}
                    role={item().checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                    aria-checked={item().checked}
                    aria-keyshortcuts={
                      item().shortcut === undefined
                        ? undefined
                        : ariaKeyShortcuts(item().shortcut ?? [])
                    }
                    aria-disabled={item().disabled === true ? 'true' : undefined}
                    tabindex={-1}
                    data-active={active() === index()}
                    class={cx(styles.item, item().danger === true && styles.danger)}
                    onPointerMove={() => {
                      if (!isDisabled(index()) && active() !== index()) setActive(index());
                    }}
                    onClick={() => activate(index())}
                  >
                    <Show when={hasChecks()}>
                      <span class={styles.check} aria-hidden="true">
                        <Show when={item().checked === true}>
                          <Check size={13} stroke-width={2.6} />
                        </Show>
                      </span>
                    </Show>
                    <Show when={item().icon} fallback={<span />}>
                      {(icon) => (
                        <span class={styles.icon} aria-hidden="true">
                          <Dynamic component={icon()} size={15} />
                        </span>
                      )}
                    </Show>
                    <span class={styles.labelCell}>
                      <span class={styles.label}>{item().label}</span>
                      <Show when={item().description}>
                        <span class={styles.description}>{item().description}</span>
                      </Show>
                    </span>
                    <Show when={item().shortcut}>
                      {(keys) => (
                        <Kbd keys={keys()} variant="plain" decorative class={styles.shortcut} />
                      )}
                    </Show>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </Floating>
    </Show>
  );
}

export interface ContextMenuProps {
  items: readonly MenuEntry[];
  onSelect: (id: string) => void;
  label: string;
  /** Called before opening, e.g. to select the row under the pointer. */
  onOpen?: () => void;
  children: JSX.Element;
  class?: string;
}

/**
 * Wraps content that has a context menu: right-click opens it at the pointer; Shift+F10 or the
 * Menu key opens it at the focused element (keyboard access, WCAG 2.1.1).
 */
export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const [local] = splitProps(props, ['items', 'onSelect', 'label', 'onOpen', 'children', 'class']);
  const [at, setAt] = createSignal<{ x: number; y: number }>();
  let restore: HTMLElement | undefined;

  const openAt = (point: { x: number; y: number }): void => {
    const active = document.activeElement;
    restore = active instanceof HTMLElement ? active : undefined;
    local.onOpen?.();
    setAt(point);
  };

  return (
    <div
      class={cx(styles.target, local.class)}
      onContextMenu={(event) => {
        event.preventDefault();
        openAt({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
          event.preventDefault();
          const target =
            event.target instanceof Element ? event.target.getBoundingClientRect() : undefined;
          openAt({ x: target?.left ?? 0, y: target?.bottom ?? 0 });
        }
      }}
    >
      {local.children}
      <Menu
        open={at() !== undefined}
        at={at()}
        items={local.items}
        label={local.label}
        onSelect={(id) => local.onSelect(id)}
        onClose={(reason) => {
          setAt(undefined);
          if (reason !== 'outside') restore?.focus();
        }}
      />
    </div>
  );
}
