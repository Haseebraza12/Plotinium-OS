import {
  createMemo,
  createUniqueId,
  For,
  Match,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../internal/cx.ts';
import type { IconComponent } from '../internal/icon.ts';
import {
  createTypeahead,
  isPrintableKey,
  matchTypeahead,
  stepIndex,
} from '../internal/list-nav.ts';
import styles from './Sidebar.module.css';

export type Tint =
  'indigo' | 'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'gray';

export interface SidebarItem {
  id: string;
  label: string;
  icon?: IconComponent;
  /** Colour of the icon tile (tile style) or the tag dot. Decorative: the label names it. */
  tint?: Tint;
  /** Tag rows (Finder tags) show a coloured dot instead of an icon. */
  dot?: boolean;
  /** Trailing count or short text. */
  badge?: string | number;
  disabled?: boolean;
}

export interface SidebarSection {
  id: string;
  title?: string;
  items: readonly SidebarItem[];
}

export interface SidebarListProps {
  sections: readonly SidebarSection[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  /** Accessible name of the navigation landmark ("Settings", "Places"). */
  label: string;
  /** glyph: accent line icons (Files). tile: white glyphs on colour tiles (Settings). */
  iconStyle?: 'glyph' | 'tile';
  /** Keep the selection accent even when the sidebar is not focused. */
  accentSelection?: boolean;
  /** Floating inset card (Liquid Glass sidebar) instead of full height. */
  inset?: boolean;
  header?: JSX.Element;
  footer?: JSX.Element;
  class?: string;
}

/**
 * A source-list sidebar: sections of navigation rows, one tab stop, Up/Down/Home/End and
 * type-ahead move focus, Enter/Space or click selects (aria-current="page").
 */
export function SidebarList(props: SidebarListProps): JSX.Element {
  const [local] = splitProps(props, [
    'sections',
    'selected',
    'onSelect',
    'label',
    'iconStyle',
    'accentSelection',
    'inset',
    'header',
    'footer',
    'class',
  ]);
  const uid = createUniqueId();
  const flat = createMemo(() => local.sections.flatMap((s) => s.items));
  const refs = new Map<string, HTMLButtonElement>();
  const typeahead = createTypeahead();
  const isDisabled = (i: number): boolean => flat()[i]?.disabled === true;
  const tabStop = createMemo(() => {
    const items = flat();
    const selected = items.find((i) => i.id === local.selected && i.disabled !== true);
    return selected?.id ?? items.find((i) => i.disabled !== true)?.id;
  });

  const focusIndex = (index: number): void => {
    const item = flat()[index];
    if (item !== undefined) refs.get(item.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent, id: string): void => {
    const items = flat();
    const current = items.findIndex((i) => i.id === id);
    switch (event.key) {
      case 'ArrowDown':
        focusIndex(stepIndex(current, 1, items.length, isDisabled, false));
        break;
      case 'ArrowUp':
        focusIndex(stepIndex(current, -1, items.length, isDisabled, false));
        break;
      case 'Home':
        focusIndex(stepIndex(-1, 1, items.length, isDisabled, false));
        break;
      case 'End':
        focusIndex(stepIndex(items.length, -1, items.length, isDisabled, false));
        break;
      default: {
        if (!isPrintableKey(event)) return;
        const match = matchTypeahead(
          items.map((i) => i.label),
          typeahead(event.key, event.timeStamp),
          current,
          isDisabled,
        );
        if (match >= 0) focusIndex(match);
      }
    }
    event.preventDefault();
  };

  return (
    <nav
      aria-label={local.label}
      class={cx(
        styles.sidebar,
        local.inset === true && styles.inset,
        local.accentSelection === true && styles.accentSelection,
        local.class,
      )}
    >
      <Show when={local.header}>
        <div class={styles.header}>{local.header}</div>
      </Show>
      <For each={local.sections}>
        {(section) => (
          <div class={styles.section}>
            <Show when={section.title}>
              <h3 class={styles.sectionTitle} id={`pl-sb-${uid}-${section.id}`}>
                {section.title}
              </h3>
            </Show>
            <ul
              class={styles.list}
              aria-labelledby={
                section.title === undefined ? undefined : `pl-sb-${uid}-${section.id}`
              }
            >
              <For each={section.items}>
                {(item) => (
                  <li>
                    <button
                      ref={(el) => refs.set(item.id, el)}
                      type="button"
                      class={styles.item}
                      style={
                        item.tint === undefined
                          ? undefined
                          : { '--pl-tile-tint': `var(--pl-tint-${item.tint})` }
                      }
                      tabindex={tabStop() === item.id ? 0 : -1}
                      aria-current={local.selected === item.id ? 'page' : undefined}
                      aria-disabled={item.disabled === true ? 'true' : undefined}
                      onClick={() => {
                        if (item.disabled !== true) local.onSelect(item.id);
                      }}
                      onKeyDown={(event) => onKeyDown(event, item.id)}
                    >
                      <Switch>
                        <Match when={item.dot === true}>
                          <span class={styles.dot} aria-hidden="true" />
                        </Match>
                        <Match when={item.icon}>
                          {(icon) => (
                            <span
                              class={local.iconStyle === 'tile' ? styles.tile : styles.glyph}
                              aria-hidden="true"
                            >
                              <Dynamic
                                component={icon()}
                                size={local.iconStyle === 'tile' ? 14 : 16}
                              />
                            </span>
                          )}
                        </Match>
                      </Switch>
                      <span class={styles.label}>{item.label}</span>
                      <Show when={item.badge !== undefined}>
                        <span class={styles.badge}>{item.badge}</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </For>
      <Show when={local.footer}>
        <div class={styles.footer}>{local.footer}</div>
      </Show>
    </nav>
  );
}
