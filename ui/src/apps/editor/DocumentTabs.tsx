import Bell from 'lucide-solid/icons/bell';
import Plus from 'lucide-solid/icons/plus';
import X from 'lucide-solid/icons/x';
import {
  createEffect,
  createMemo,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
  splitProps,
  untrack,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import styles from './DocumentTabs.module.css';

export type DocumentTabState = 'clean' | 'dirty' | 'conflict';
export type DocumentTabActivity = 'none' | 'output' | 'bell';

export interface DocumentTab {
  id: string;
  label: string;
  /** Short type badge before the label ("MD", "TS"). Decorative: the label has the extension. */
  badge?: string;
  /** Editor save state: a dot for unsaved edits, an amber dot for a sync conflict. */
  state?: DocumentTabState;
  /** Terminal background activity: output arrived, or the program rang the bell (BEL). */
  activity?: DocumentTabActivity;
  /** Full path or title, shown as the native tooltip. */
  title?: string;
  /** Tabs are closable unless this is false. */
  closable?: boolean;
}

export interface DocumentTabsProps {
  tabs: readonly DocumentTab[];
  selected: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
  /** Disables "+" with a reason, e.g. "Tab limit reached" (16 terminal tabs). */
  newDisabledReason?: string;
  /** Accessible name of the tab list ("Open files", "Terminal tabs"). */
  label: string;
  /** Id of the tabpanel the tabs control. */
  panelId?: string;
  /** editor: flat tabs with an accent rule. terminal: rounded capsules. */
  variant?: 'editor' | 'terminal';
  class?: string;
}

/** Accessible name of a tab: its label plus any state carried by a dot or glyph (DSN-08). */
export function tabAccessibleName(tab: DocumentTab): string {
  const parts = [tab.label];
  if (tab.state === 'dirty') parts.push('unsaved changes');
  if (tab.state === 'conflict') parts.push('has conflict');
  if (tab.activity === 'output') parts.push('new output');
  // A BEL in the output, not necessarily a failure (UI-116).
  if (tab.activity === 'bell') parts.push('bell');
  return parts.join(', ');
}

/**
 * The document tab strip of the Editor and the Terminal (APG tabs, automatic activation):
 * Left/Right/Home/End move and select, Delete closes the focused tab, and the "+" button opens
 * a new one. The close glyph is a pointer target; keyboard users close with Delete
 * (aria-keyshortcuts), since a button inside a tab would be nested interactive content.
 */
export function DocumentTabs(props: DocumentTabsProps): JSX.Element {
  const [local] = splitProps(props, [
    'tabs',
    'selected',
    'onSelect',
    'onClose',
    'onNew',
    'newDisabledReason',
    'label',
    'panelId',
    'variant',
    'class',
  ]);
  const uid = createUniqueId();
  const refs = new Map<string, HTMLDivElement>();
  const ids = createMemo(() => local.tabs.map((t) => t.id));
  const byId = createMemo(() => new Map(local.tabs.map((t) => [t.id, t] as const)));
  let addButton: HTMLButtonElement | undefined;

  let list: HTMLDivElement | undefined;

  /**
   * Scrolls the strip (and only the strip: never the window or the desktop behind it) so the
   * tab is wholly in view, by as little as needed. Layout offsets, not client rects: a new tab
   * slides in with a transform that a client rect would include.
   */
  const revealTab = (id: string): void => {
    const el = refs.get(id);
    if (el === undefined || list === undefined) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  };

  // The selected tab is always in view, however it was chosen (keys, a click elsewhere, a new
  // tab at the end of a long strip, UI-116). A new tab's element is created after this effect
  // runs, so the strip is measured once the update has settled; and again whenever the strip
  // or a tab changes size (a label that changes, a lock chip that takes room beside the strip).
  createEffect(
    on(
      () => [local.selected, ids().length] as const,
      ([selected]) => queueMicrotask(() => revealTab(selected)),
    ),
  );
  const resized =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => revealTab(untrack(() => local.selected)));
  onCleanup(() => resized?.disconnect());

  const focusTab = (id: string | undefined): void => {
    if (id === undefined) return;
    local.onSelect(id);
    refs.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent, tab: DocumentTab): void => {
    const list = ids();
    const index = list.indexOf(tab.id);
    switch (event.key) {
      case 'ArrowRight':
        focusTab(list[(index + 1) % list.length]);
        break;
      case 'ArrowLeft':
        focusTab(list[(index - 1 + list.length) % list.length]);
        break;
      case 'Home':
        focusTab(list[0]);
        break;
      case 'End':
        focusTab(list[list.length - 1]);
        break;
      case 'Delete': {
        if (tab.closable === false || local.onClose === undefined) return;
        // Keep keyboard focus in the strip: move it to the neighbour once the tab is gone.
        const neighbour = list[index + 1] ?? list[index - 1];
        local.onClose(tab.id);
        if (neighbour !== undefined) queueMicrotask(() => refs.get(neighbour)?.focus());
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      class={cx(
        styles.strip,
        local.variant === 'terminal' ? styles.terminal : styles.editor,
        local.class,
      )}
    >
      <div
        ref={(el) => {
          list = el;
          resized?.observe(el);
        }}
        role="tablist"
        aria-label={local.label}
        class={styles.list}
      >
        <For each={ids()}>
          {(id) => {
            const tab = (): DocumentTab => byId().get(id) ?? { id, label: id };
            const selected = (): boolean => id === local.selected;
            const closable = (): boolean => tab().closable !== false && local.onClose !== undefined;
            onCleanup(() => {
              const el = refs.get(id);
              if (el !== undefined) resized?.unobserve(el);
              refs.delete(id);
            });
            return (
              <div
                ref={(el) => {
                  refs.set(id, el);
                  resized?.observe(el);
                }}
                role="tab"
                id={`pl-doc-tab-${uid}-${id}`}
                aria-selected={selected()}
                aria-controls={local.panelId}
                aria-label={tabAccessibleName(tab())}
                aria-keyshortcuts={closable() ? 'Delete' : undefined}
                title={tab().title}
                tabindex={selected() ? 0 : -1}
                class={cx(styles.tab, selected() && styles.selected)}
                data-state={tab().state ?? 'clean'}
                onClick={() => local.onSelect(id)}
                onAuxClick={(event) => {
                  if (event.button === 1 && closable()) local.onClose?.(id);
                }}
                onKeyDown={(event) => onKeyDown(event, tab())}
              >
                <Show when={tab().badge}>
                  <span class={styles.badge} aria-hidden="true">
                    {tab().badge}
                  </span>
                </Show>
                <Show when={local.variant === 'terminal' && tab().activity !== 'bell'}>
                  <span
                    class={cx(styles.activity, tab().activity === 'output' && styles.activityOn)}
                    aria-hidden="true"
                  />
                </Show>
                <Show when={tab().activity === 'bell'}>
                  <span class={styles.bell} aria-hidden="true">
                    <Bell size={11} stroke-width={2.2} />
                  </span>
                </Show>
                <span class={styles.label}>{tab().label}</span>
                <span class={styles.trail}>
                  <Show when={tab().state === 'conflict' || tab().state === 'dirty'}>
                    <span
                      class={cx(styles.dot, tab().state === 'conflict' && styles.conflictDot)}
                      aria-hidden="true"
                    />
                  </Show>
                  <Show when={closable()}>
                    {/* Pointer affordance only: a button inside role="tab" would be nested
                        interactive content. Keyboard users close with Delete. */}
                    <span
                      class={styles.close}
                      aria-hidden="true"
                      title={`Close ${tab().label}`}
                      data-close={id}
                      onClick={(event) => {
                        event.stopPropagation();
                        local.onClose?.(id);
                      }}
                    >
                      <X size={12} stroke-width={2.2} />
                    </span>
                  </Show>
                </span>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={local.onNew}>
        <button
          ref={(el) => (addButton = el)}
          type="button"
          class={styles.add}
          aria-label="New tab"
          title={local.newDisabledReason ?? 'New tab'}
          aria-disabled={local.newDisabledReason === undefined ? undefined : 'true'}
          onClick={() => {
            if (local.newDisabledReason !== undefined) return;
            local.onNew?.();
            // Focus goes to the new tab unless the host moved it already (the Editor focuses
            // the new document): it never stays on "+", where Space would open another (UI-103).
            queueMicrotask(() => {
              if (document.activeElement === addButton) refs.get(local.selected)?.focus();
            });
          }}
        >
          <Plus size={14} stroke-width={2} aria-hidden="true" />
        </button>
      </Show>
    </div>
  );
}
