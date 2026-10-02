import { createMemo, createUniqueId, For, Show, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../internal/cx.ts';
import type { IconComponent } from '../internal/icon.ts';
import { firstEnabled, lastEnabled, stepIndex } from '../internal/list-nav.ts';
import styles from './Tabs.module.css';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: IconComponent;
  /** Count shown after the label ("Processes 42"). */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  selected: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** segmented: capsule with a sliding highlight. underline: text tabs with an accent rule. */
  variant?: 'segmented' | 'underline';
  /** Renders the selected tab's panel. */
  children: (id: T) => JSX.Element;
  /** Extra content at the end of the tab row (e.g. a search field). */
  end?: JSX.Element;
  class?: string;
  panelClass?: string;
}

/**
 * Tabs (APG tabs, automatic activation): one tab stop, Left/Right/Home/End move and select,
 * the panel is labelled by its tab.
 */
export function Tabs<T extends string>(props: TabsProps<T>): JSX.Element {
  const [local] = splitProps(props, [
    'tabs',
    'selected',
    'onChange',
    'label',
    'variant',
    'children',
    'end',
    'class',
    'panelClass',
  ]);
  const uid = createUniqueId();
  const refs: HTMLButtonElement[] = [];
  const selectedIndex = createMemo(() =>
    Math.max(
      0,
      local.tabs.findIndex((t) => t.id === local.selected),
    ),
  );
  const isDisabled = (i: number): boolean => local.tabs[i]?.disabled === true;
  const tabId = (id: string): string => `pl-tabs-${uid}-tab-${id}`;
  const panelId = (): string => `pl-tabs-${uid}-panel`;
  const segmented = (): boolean => local.variant !== 'underline';

  const select = (index: number): void => {
    const tab = local.tabs[index];
    if (tab === undefined || tab.disabled === true) return;
    refs[index]?.focus();
    if (tab.id !== local.selected) local.onChange(tab.id);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const count = local.tabs.length;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = stepIndex(selectedIndex(), 1, count, isDisabled, true);
        break;
      case 'ArrowLeft':
        next = stepIndex(selectedIndex(), -1, count, isDisabled, true);
        break;
      case 'Home':
        next = firstEnabled(count, isDisabled);
        break;
      case 'End':
        next = lastEnabled(count, isDisabled);
        break;
      default:
        return;
    }
    event.preventDefault();
    select(next);
  };

  return (
    <div class={cx(styles.root, local.class)}>
      <div class={styles.bar}>
        <div
          role="tablist"
          aria-label={local.label}
          class={cx(styles.list, segmented() ? styles.segmented : styles.underline)}
          style={{
            '--pl-tab-count': String(local.tabs.length),
            '--pl-tab-index': String(selectedIndex()),
          }}
          onKeyDown={onKeyDown}
        >
          <Show when={segmented()}>
            <span class={styles.thumb} aria-hidden="true" />
          </Show>
          <For each={local.tabs}>
            {(tab, index) => (
              <button
                ref={(el) => (refs[index()] = el)}
                type="button"
                role="tab"
                id={tabId(tab.id)}
                class={styles.tab}
                aria-selected={tab.id === local.selected}
                aria-controls={panelId()}
                tabindex={index() === selectedIndex() ? 0 : -1}
                disabled={tab.disabled}
                onClick={() => select(index())}
              >
                <Show when={tab.icon}>
                  {(icon) => (
                    <span class={styles.icon} aria-hidden="true">
                      <Dynamic component={icon()} size={14} />
                    </span>
                  )}
                </Show>
                {tab.label}
                <Show when={tab.count !== undefined}>
                  <span class={styles.count}>{tab.count}</span>
                </Show>
                <Show when={!segmented()}>
                  <span class={styles.indicator} aria-hidden="true" />
                </Show>
              </button>
            )}
          </For>
        </div>
        {local.end}
      </div>
      <div
        role="tabpanel"
        id={panelId()}
        aria-labelledby={tabId(local.selected)}
        tabindex={0}
        class={cx(styles.panel, local.panelClass)}
      >
        {local.children(local.selected)}
      </div>
    </div>
  );
}
