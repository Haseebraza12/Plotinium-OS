import { Match, Show, splitProps, Switch, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { ProgressBar, type ProgressTone } from '../../primitives/progress/ProgressBar.tsx';
import styles from './Files.module.css';
import { formatSize, quotaLevel, quotaText } from './format.ts';
import type { Quota } from './types.ts';

export interface SearchStatus {
  results: number;
  indexedFiles: number;
  indexer?: { pid: number; priority?: number };
  /** Indexing in progress (determinate). */
  indexing?: { done: number; total: number };
  /** The indexer yields while the search box has focus. */
  paused?: boolean;
}

export interface FilesStatusBarProps {
  items: number;
  selected?: number;
  /** Bytes in the selection. */
  selectedSize?: number;
  quota?: Quota;
  user: string;
  path: string;
  /** Semantic mode shows the index facts instead of the item count. */
  search?: SearchStatus;
  class?: string;
}

const TONE: Record<ReturnType<typeof quotaLevel>, ProgressTone> = {
  normal: 'accent',
  warning: 'warning',
  danger: 'danger',
};

const count = (n: number): string => n.toLocaleString('en-GB');

/** `42 items`, or `1 of 42 selected, 1.8 MB`. */
export function itemsText(items: number, selected = 0, selectedSize?: number): string {
  if (selected <= 0) return `${count(items)} ${items === 1 ? 'item' : 'items'}`;
  const size = selectedSize === undefined ? '' : `, ${formatSize(selectedSize)}`;
  return `${count(selected)} of ${count(items)} selected${size}`;
}

/** `4 results · indexed 1,284 files · ai.indexer pid 23 (PRI 32)`. */
export function searchText(search: SearchStatus): string {
  const parts = [
    `${count(search.results)} ${search.results === 1 ? 'result' : 'results'}`,
    `indexed ${count(search.indexedFiles)} files`,
  ];
  if (search.indexer !== undefined) {
    const pri = search.indexer.priority === undefined ? '' : ` (PRI ${search.indexer.priority})`;
    parts.push(`ai.indexer pid ${search.indexer.pid}${pri}`);
  }
  return parts.join(' · ');
}

/** `Quota nearly full` at 80 %, `Free up space` at 95 % (words beside the bar colour). */
export function quotaWarning(quota: Quota): string | undefined {
  switch (quotaLevel(quota)) {
    case 'normal':
      return undefined;
    case 'warning':
      return 'Quota nearly full';
    case 'danger':
      return 'Free up space';
  }
}

/**
 * The window's status bar: item or result counts, the quota as a determinate bar with its
 * value in words, indexing progress, and `user · path` on the right. Counts and warnings are
 * a polite live region.
 */
export function FilesStatusBar(props: FilesStatusBarProps): JSX.Element {
  const [local] = splitProps(props, [
    'items',
    'selected',
    'selectedSize',
    'quota',
    'user',
    'path',
    'search',
    'class',
  ]);
  return (
    <footer class={cx(styles.status, local.class)}>
      <div class={styles.statusStart} role="status" aria-live="polite">
        <Switch>
          <Match when={local.search}>
            {(search) => (
              <>
                <span>{searchText(search())}</span>
                <Show when={search().indexing}>
                  {(indexing) => (
                    <span class={styles.statusMeter}>
                      <ProgressBar
                        size="sm"
                        hideLabel
                        label="Indexing"
                        value={indexing().done}
                        max={indexing().total}
                        valueText={`Indexing ${indexing().done} of ${indexing().total} files`}
                      />
                      <span>
                        Indexing {indexing().done} of {indexing().total} files
                      </span>
                    </span>
                  )}
                </Show>
                <Show when={search().paused === true}>
                  <span class={styles.statusMuted}>Indexing paused while you search</span>
                </Show>
              </>
            )}
          </Match>
          <Match when={local.search === undefined}>
            <span>{itemsText(local.items, local.selected, local.selectedSize)}</span>
            <Show when={local.quota}>
              {(quota) => (
                <>
                  <span class={cx(styles.statusSep, styles.statusQuotaSep)} aria-hidden="true">
                    {' · '}
                  </span>
                  <span class={styles.statusQuota}>{quotaText(quota())} quota used</span>
                  <span class={styles.statusMeter}>
                    <ProgressBar
                      size="sm"
                      hideLabel
                      label="Quota"
                      value={quota().used}
                      max={quota().total}
                      valueText={`${quotaText(quota())} used`}
                      tone={TONE[quotaLevel(quota())]}
                    />
                  </span>
                  <Show when={quotaWarning(quota())}>
                    {(warning) => <strong class={styles.statusWarning}>{warning()}</strong>}
                  </Show>
                </>
              )}
            </Show>
          </Match>
        </Switch>
      </div>
      <div class={styles.statusEnd} title={`${local.user} · ${local.path}`}>
        {local.user} · {local.path}
      </div>
    </footer>
  );
}
