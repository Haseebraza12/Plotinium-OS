import SearchX from 'lucide-solid/icons/search-x';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { Avatar } from '../../primitives/avatar/Avatar.tsx';
import { Badge } from '../../primitives/badge/Badge.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { stepIndex } from '../../primitives/internal/list-nav.ts';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import { SearchField } from '../../primitives/search-field/SearchField.tsx';
import type { SettingsSectionId, SettingsUser } from './models.ts';
import { searchSections, SECTIONS, type SectionMeta } from './sections.ts';
import styles from './SettingsSidebar.module.css';

export interface SettingsSidebarProps {
  selected: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
  user: SettingsUser;
  query: string;
  onQuery: (query: string) => void;
  /** Count badges per section (Updates: 1). */
  badges?: Partial<Record<SettingsSectionId, number>>;
  /** Label overrides (the AI-off build reads "Privacy"). */
  labels?: Partial<Record<SettingsSectionId, string>>;
  searchRef?: (el: HTMLInputElement) => void;
}

/**
 * The Settings source list: search (Ctrl+F), the user card, and the sections in four groups
 * with colour tiles. One selection pill moves between rows with a spring (FLIP translateY),
 * instead of each row fading its own background. Up/Down/Home/End move focus.
 */
export function SettingsSidebar(props: SettingsSidebarProps): JSX.Element {
  const [local] = splitProps(props, [
    'selected',
    'onSelect',
    'user',
    'query',
    'onQuery',
    'badges',
    'labels',
    'searchRef',
  ]);
  const refs = new Map<SettingsSectionId, HTMLButtonElement>();
  let list: HTMLDivElement | undefined;
  const [pill, setPill] = createSignal<{ y: number; h: number } | undefined>();
  const [ready, setReady] = createSignal(false);

  const labelOf = (s: SectionMeta): string => local.labels?.[s.id] ?? s.label;
  const visible = createMemo(() =>
    searchSections(
      local.query,
      SECTIONS.map((s) => ({ ...s, label: labelOf(s) })),
    ),
  );
  const groups = createMemo(() => {
    const out: SectionMeta[][] = [];
    for (const s of visible()) (out[s.group] ??= []).push(s);
    return out.filter((g) => g.length > 0);
  });
  const tabStop = (): SettingsSectionId | undefined =>
    visible().some((s) => s.id === local.selected) ? local.selected : visible()[0]?.id;

  // The shared highlight: read the selected row's box once per change (no per-frame reads).
  const measure = (): void => {
    const el = refs.get(local.selected);
    if (
      el === undefined ||
      list === undefined ||
      !el.isConnected ||
      !visible().some((s) => s.id === local.selected)
    ) {
      setPill(undefined);
      return;
    }
    setPill({ y: el.offsetTop, h: el.offsetHeight });
  };
  createEffect(on([() => local.selected, visible], measure));
  onMount(() => {
    measure();
    requestAnimationFrame(() => setReady(true));
    // Fonts and wrapping can move rows after mount: re-measure when the list's box changes.
    if (list !== undefined && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => measure());
      observer.observe(list);
      onCleanup(() => observer.disconnect());
    }
  });

  const onKeyDown = (event: KeyboardEvent, id: SettingsSectionId): void => {
    const items = visible();
    const index = items.findIndex((s) => s.id === id);
    const none = (): boolean => false;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = stepIndex(index, 1, items.length, none, false);
        break;
      case 'ArrowUp':
        next = stepIndex(index, -1, items.length, none, false);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = items[next];
    if (target !== undefined) refs.get(target.id)?.focus();
  };

  return (
    <div class={styles.sidebar}>
      <div class={styles.dragArea} data-pl-drag-region />
      <SearchField
        class={styles.search}
        label="Search settings"
        placeholder="Search"
        value={local.query}
        onInput={(q) => local.onQuery(q)}
        onSubmit={() => {
          const first = visible()[0];
          if (first !== undefined) local.onSelect(first.id);
        }}
        inputRef={(el) => local.searchRef?.(el)}
        trailing={
          <Show when={local.query === ''}>
            <Kbd keys={['Ctrl', 'F']} decorative />
          </Show>
        }
      />
      <button
        type="button"
        class={cx(styles.userCard, local.selected === 'users' && styles.userCardActive)}
        aria-label={
          local.user.guest === true
            ? 'Guest, not signed in'
            : `${local.user.name}, Plotinium Account, uid ${local.user.uid}`
        }
        onClick={() => local.onSelect('users')}
      >
        <Avatar name={local.user.guest === true ? 'Guest' : local.user.name} size="lg" decorative />
        <span class={styles.userText} aria-hidden="true">
          <span class={styles.userName}>
            {local.user.guest === true ? 'Guest' : local.user.name}
          </span>
          <span class={styles.userSub}>
            {local.user.guest === true
              ? 'Guest · not signed in'
              : local.user.offline === true
                ? 'Account offline · changes will sync later'
                : `Plotinium Account · uid ${local.user.uid}`}
          </span>
        </span>
      </button>

      <nav aria-label="Settings sections" class={styles.nav}>
        <div class={styles.list} ref={(el) => (list = el)}>
          <Show when={pill()}>
            {(box) => (
              <span
                class={cx(styles.pill, ready() && styles.pillMoving)}
                style={{ '--pl-pill-y': `${box().y}px`, '--pl-pill-h': `${box().h}px` }}
                aria-hidden="true"
              />
            )}
          </Show>
          <For each={groups()}>
            {(group) => (
              <ul class={styles.group}>
                <For each={group}>
                  {(section) => (
                    <li>
                      <button
                        ref={(el) => refs.set(section.id, el)}
                        type="button"
                        class={styles.item}
                        aria-current={local.selected === section.id ? 'page' : undefined}
                        tabindex={tabStop() === section.id ? 0 : -1}
                        onClick={() => local.onSelect(section.id)}
                        onKeyDown={(event) => onKeyDown(event, section.id)}
                      >
                        <span
                          class={cx(styles.tile, styles[`tint-${section.tint}`])}
                          aria-hidden="true"
                        >
                          <Dynamic component={section.icon} size={13} stroke-width={2.2} />
                        </span>
                        <span class={styles.label}>{section.label}</span>
                        <Show when={(local.badges?.[section.id] ?? 0) > 0}>
                          <Badge
                            class={styles.badge}
                            count={local.badges?.[section.id] ?? 0}
                            label={`${local.badges?.[section.id] ?? 0} update available`}
                          />
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </For>
        </div>
        <p class={styles.hidden} role="status" aria-live="polite">
          {local.query === ''
            ? ''
            : visible().length === 1
              ? '1 setting matches'
              : `${visible().length} settings match`}
        </p>
        <Show when={visible().length === 0}>
          <div class={styles.empty}>
            <SearchX size={20} aria-hidden="true" />
            <p>No settings match “{local.query}”</p>
            <button type="button" class={styles.clear} onClick={() => local.onQuery('')}>
              Show all settings
            </button>
          </div>
        </Show>
      </nav>
    </div>
  );
}
