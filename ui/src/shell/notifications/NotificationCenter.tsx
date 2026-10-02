import BellOff from 'lucide-solid/icons/bell-off';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { EmptyState } from '../../primitives/empty-state/EmptyState.tsx';
import type { ShellNotification } from '../types.ts';
import { createLeaving } from './leaving.ts';
import { NotificationCard } from './NotificationCard.tsx';
import styles from './Notifications.module.css';

export interface NotificationCenterProps {
  /** Newest first (the centre keeps the last 50, window-manager.md §3.17). */
  notifications: readonly ShellNotification[];
  now: number;
  /** Called after the card's exit animation. */
  onDismiss: (id: string) => void;
  /** Called after every card has left. */
  onClearAll: () => void;
  onAction: (id: string, actionId: string) => void;
  onOpen?: (id: string) => void;
  /** Start with same-app groups expanded. Default false (stacked). */
  defaultExpanded?: boolean;
  class?: string;
}

interface Group {
  key: string;
  items: ShellNotification[];
}

const EXIT_MS = 220;

/** An id as a CSS attribute-selector value (quotes and backslashes escaped). */
function cssId(id: string): string {
  return id.replace(/["\\]/gu, '\\$&');
}

/** Same-app notifications form one group, ordered by their newest card. */
export function groupNotifications(list: readonly ShellNotification[]): Group[] {
  const groups = new Map<string, Group>();
  for (const n of list) {
    const key = n.app ?? n.appName ?? `§${n.id}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, items: [n] });
    else group.items.push(n);
  }
  return [...groups.values()];
}

/**
 * Notification Centre (WMD-18): the column under Control Centre. A heading with Clear all and
 * Show more/less; cards grouped by app, with a collapsed group drawn as one card over two
 * receding glass slabs (the pl-notification-stack contract) and a "+2 from Files" button that
 * expands it. Dismissed cards slide out before `onDismiss`; an empty centre says so.
 */
export function NotificationCenter(props: NotificationCenterProps): JSX.Element {
  const [local] = splitProps(props, [
    'notifications',
    'now',
    'onDismiss',
    'onClearAll',
    'onAction',
    'onOpen',
    'defaultExpanded',
    'class',
  ]);
  const uid = createUniqueId();
  const headingId = `pl-nc-${uid}`;
  const leaving = createLeaving(EXIT_MS);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [allExpanded, setAllExpanded] = createSignal(local.defaultExpanded === true);
  const [clearing, setClearing] = createSignal(false);

  const groups = createMemo(() => groupNotifications(local.notifications));
  // <For> rows are keyed by strings so cards stay mounted when the list changes.
  const groupKeys = createMemo(() => groups().map((g) => g.key));
  const groupIds = createMemo(
    () => new Map(groups().map((g) => [g.key, g.items.map((n) => n.id)] as const)),
  );
  const byId = createMemo(() => new Map(local.notifications.map((n) => [n.id, n] as const)));
  const idsOf = (key: string): readonly string[] => groupIds().get(key) ?? [];
  const stackable = (): boolean => groups().some((g) => g.items.length > 1);
  const isOpen = (key: string): boolean => allExpanded() || expanded().has(key);

  const toggleAll = (): void => {
    const next = !allExpanded();
    setAllExpanded(next);
    if (!next) setExpanded(new Set<string>());
  };
  const openGroup = (key: string): void => {
    setExpanded((prev) => new Set(prev).add(key));
  };

  let list: HTMLUListElement | undefined;
  /**
   * Dismiss a card; when it had focus, focus moves to the next card (or the previous one, or
   * "Clear all" when it was the last), so the keyboard never drops to the page (UI-082).
   */
  const dismiss = (id: string, card?: HTMLElement): void => {
    const onDismiss = local.onDismiss;
    const doc = card?.ownerDocument;
    /** The top card of a collapsed group: the group's next card, shown once this one is gone. */
    let after: string | undefined;
    if (card !== undefined && list !== undefined && card.contains(doc?.activeElement ?? null)) {
      const key = groupKeys().find((k) => idsOf(k)[0] === id && !isOpen(k));
      after = key === undefined ? undefined : idsOf(key)[1];
      if (after === undefined) {
        const cards = Array.from(list.querySelectorAll<HTMLElement>('article[tabindex="0"]'));
        const at = cards.indexOf(card);
        const next = cards[at + 1] ?? cards[at - 1];
        if (next !== undefined) next.focus();
        else clearButton?.focus();
      }
    }
    leaving.leave(id, () => {
      onDismiss(id);
      if (after === undefined) return;
      const next = list?.querySelector<HTMLElement>(`article[data-note-id="${cssId(after)}"]`);
      if (next !== null && next !== undefined) next.focus();
      else clearButton?.focus();
    });
  };
  let clearButton: HTMLButtonElement | undefined;
  const clearAll = (): void => {
    if (local.notifications.length === 0 || clearing()) return;
    setClearing(true);
    const onClearAll = local.onClearAll;
    leaving.leave('§all', () => {
      setClearing(false);
      onClearAll();
    });
  };

  const Card = (p: { id: string; index: number }): JSX.Element => (
    <Show when={byId().get(p.id)}>
      {(n) => (
        <NotificationCard
          notification={n()}
          now={local.now}
          leaving={clearing() || leaving.isLeaving(p.id)}
          class={clearing() || leaving.isLeaving(p.id) ? undefined : styles.enter}
          style={{ '--pl-stagger-index': String(p.index) }}
          onDismiss={() => {
            const card = list?.querySelector<HTMLElement>(`article[data-note-id="${cssId(p.id)}"]`);
            dismiss(p.id, card ?? undefined);
          }}
          onAction={(actionId) => local.onAction(p.id, actionId)}
          onOpen={local.onOpen === undefined ? undefined : () => local.onOpen?.(p.id)}
        />
      )}
    </Show>
  );

  return (
    <section class={cx(styles.centre, local.class)} aria-labelledby={headingId}>
      <div class={styles.head}>
        <h2 class={styles.heading} id={headingId}>
          Notifications
        </h2>
        <div class={styles.headActions}>
          <button
            ref={(el) => (clearButton = el)}
            type="button"
            class={styles.chip}
            aria-disabled={local.notifications.length === 0 ? 'true' : undefined}
            onClick={clearAll}
          >
            Clear all
          </button>
          <Show when={stackable()}>
            <button
              type="button"
              class={styles.chip}
              aria-expanded={allExpanded()}
              onClick={toggleAll}
            >
              {allExpanded() ? 'Show less' : 'Show more'}
              <span
                class={styles.chevron}
                data-open={allExpanded() ? 'true' : 'false'}
                aria-hidden="true"
              >
                <ChevronDown size={12} />
              </span>
            </button>
          </Show>
        </div>
      </div>

      <Show
        when={local.notifications.length > 0}
        fallback={
          <EmptyState
            compact
            level={3}
            icon={<BellOff size={22} />}
            title="No notifications"
            description="You're all caught up."
            class={styles.empty}
          />
        }
      >
        <ul ref={(el) => (list = el)} class={styles.list} role="list">
          <For each={groupKeys()}>
            {(key, groupIndex) => (
              <Show
                when={idsOf(key).length > 1 && !isOpen(key)}
                fallback={
                  <For each={idsOf(key)}>
                    {(id, i) => (
                      <li class={styles.item}>
                        <Card id={id} index={groupIndex() + i()} />
                      </li>
                    )}
                  </For>
                }
              >
                <li class={styles.item}>
                  <div class={cx(styles.stack, 'pl-notification-stack')} data-expanded="false">
                    <Card id={idsOf(key)[0] ?? ''} index={groupIndex()} />
                    <span class={styles.slab} data-stack="1" aria-hidden="true" />
                    <Show when={idsOf(key).length > 2}>
                      <span class={styles.slab} data-stack="2" aria-hidden="true" />
                    </Show>
                  </div>
                  <button
                    type="button"
                    class={styles.more}
                    aria-expanded="false"
                    onClick={() => openGroup(key)}
                  >
                    +{idsOf(key).length - 1} from{' '}
                    {byId().get(idsOf(key)[0] ?? '')?.appName ?? 'this app'}
                  </button>
                </li>
              </Show>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
