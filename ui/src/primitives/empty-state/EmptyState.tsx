import { Show, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../internal/cx.ts';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  title: string;
  description?: JSX.Element;
  /** Decorative icon, typically a lucide icon at 40 px. */
  icon?: JSX.Element;
  /** Buttons (e.g. "New Folder", "Clear filters"). */
  actions?: JSX.Element;
  /** Heading level of the title, to fit the page outline. */
  level?: 2 | 3 | 4;
  compact?: boolean;
  /** Announce the state when it appears (e.g. "No results"). */
  live?: boolean;
  class?: string;
}

/** A calm placeholder for empty folders, no search results and offline panes. */
export function EmptyState(props: EmptyStateProps): JSX.Element {
  const [local] = splitProps(props, [
    'title',
    'description',
    'icon',
    'actions',
    'level',
    'compact',
    'live',
    'class',
  ]);
  return (
    <div
      class={cx(styles.root, local.compact === true && styles.compact, local.class)}
      role={local.live === true ? 'status' : undefined}
    >
      <Show when={local.icon}>
        <div class={styles.icon} aria-hidden="true">
          {local.icon}
        </div>
      </Show>
      <Dynamic component={`h${local.level ?? 3}`} class={styles.title}>
        {local.title}
      </Dynamic>
      <Show when={local.description}>
        <p class={styles.description}>{local.description}</p>
      </Show>
      <Show when={local.actions}>
        <div class={styles.actions}>{local.actions}</div>
      </Show>
    </div>
  );
}
