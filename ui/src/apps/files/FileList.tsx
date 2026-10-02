import ChevronUp from 'lucide-solid/icons/chevron-up';
import CloudUpload from 'lucide-solid/icons/cloud-upload';
import Lock from 'lucide-solid/icons/lock';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  untrack,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import styles from './FileList.module.css';
import { FileIcon } from './FileIcon.tsx';
import { entrySize, formatDate, kindLabel, modeString, spokenMode } from './format.ts';
import { collectionIntent } from './keys.ts';
import type { FileAction } from './menu.ts';
import { clearSelection, clickSelect, contextSelect, type Selection } from './selection.ts';
import type { FileEntry, FileSort, SortKey } from './types.ts';

/** Row height in px; matches --pl-row-h (windowing needs a number). */
export const ROW_HEIGHT = 28;
/** Lists longer than this render only the rows in view (DSN-19). */
export const VIRTUALIZE_AT = 2000;
const OVERSCAN = 12;

export interface CollectionProps {
  /** Entries in display order (the caller sorts them). */
  entries: readonly FileEntry[];
  selection: Selection;
  onSelection: (selection: Selection) => void;
  onAction: (action: FileAction, ids: readonly string[]) => void;
  /** Open the context menu for these ids at a viewport point. */
  onMenu: (ids: readonly string[], at: { x: number; y: number }) => void;
  /** Accessible name, e.g. "Documents, 42 items". */
  label: string;
  /** Clock for "Today, 09:18". */
  now: number;
  /** The row the open context menu belongs to (accent outline). */
  menuTarget?: string;
  /** The folder a drag is over: highlighted as the drop target. */
  dropTarget?: string;
  /** Rows are loading: static skeletons (no shimmer loop). */
  loading?: boolean;
  /** Shown when there are no entries. */
  empty?: JSX.Element;
  /** Element id, so the search box can point aria-controls at the list. */
  id?: string;
  class?: string;
  ref?: (el: HTMLElement) => void;
}

export interface FileListProps extends CollectionProps {
  sort: FileSort;
  onSort: (sort: FileSort) => void;
}

/**
 * The columns, in the order they give way when the list narrows (container queries in
 * FileList.module.css): Permissions first, then Kind, Size and Date Modified. Name always stays.
 */
export const FILE_COLUMNS: readonly { key: SortKey; label: string; end?: boolean }[] = [
  { key: 'name', label: 'Name' },
  { key: 'modified', label: 'Date Modified' },
  { key: 'size', label: 'Size', end: true },
  { key: 'kind', label: 'Kind' },
  { key: 'permissions', label: 'Permissions' },
];

/** A spoken summary of the badges on a row (lock, sync, access). */
export function rowStatus(entry: FileEntry): string[] {
  const out: string[] = [];
  if (entry.lock !== undefined) {
    if (entry.lock.stale === true) out.push('lock expired');
    else out.push(entry.lock.mine === true ? 'locked by you' : `locked by ${entry.lock.holder}`);
  }
  if (entry.sync === 'pending') out.push('sync pending');
  if (entry.sync === 'conflict') out.push('2 versions');
  if (entry.readable === false) out.push('no read permission');
  if (entry.cut === true) out.push('cut');
  return out;
}

/** The target is empty space in a collection (not an item, not a control inside one). */
export function isEmptySpace(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-id]') === null;
}

/**
 * The Files list view (APG grid): sortable Name, Date Modified, Size, Kind and Permissions
 * (symbolic, monospace, spelled out for screen readers); folders first; zebra rows; solid
 * accent selection while focused. One tab stop; the keyboard map is in keys.ts. Header labels
 * truncate with an ellipsis inside their column, and low-priority columns give way first when
 * the list is narrow, so labels and cells never overlap.
 */
export function FileList(props: FileListProps): JSX.Element {
  const [local] = splitProps(props, [
    'entries',
    'selection',
    'onSelection',
    'onAction',
    'onMenu',
    'label',
    'now',
    'menuTarget',
    'dropTarget',
    'loading',
    'empty',
    'sort',
    'onSort',
    'id',
    'class',
    'ref',
  ]);
  const refs = new Map<string, HTMLElement>();
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(ROW_HEIGHT * 30);
  let body: HTMLDivElement | undefined;

  const ids = createMemo(() => local.entries.map((e) => e.id));
  const indexOf = createMemo(() => new Map(ids().map((id, i) => [id, i] as const)));
  const virtual = (): boolean => local.entries.length > VIRTUALIZE_AT;
  const range = createMemo((): readonly [number, number] => {
    const count = local.entries.length;
    if (!virtual()) return [0, count];
    const start = Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(count, Math.ceil((scrollTop() + viewport()) / ROW_HEIGHT) + OVERSCAN);
    return [start, end];
  });
  const visible = createMemo(() => local.entries.slice(range()[0], range()[1]));
  const tabStop = createMemo(() => {
    const focus = local.selection.focus;
    if (focus !== undefined && indexOf().has(focus)) return focus;
    return ids().find((id) => local.selection.selected.has(id)) ?? ids()[0];
  });
  const empty = (): boolean => local.loading !== true && local.entries.length === 0;

  onMount(() => {
    if (body === undefined || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewport(body?.clientHeight ?? viewport()));
    observer.observe(body);
    onCleanup(() => observer.disconnect());
  });

  /** Focus the row for `id`, scrolling a windowed list to it first. */
  const focusRow = (id: string | undefined): void => {
    if (id === undefined) return;
    const el = refs.get(id);
    if (el !== undefined) {
      el.focus();
      return;
    }
    const index = indexOf().get(id);
    if (index === undefined || body === undefined) return;
    const top = Math.max(0, index * ROW_HEIGHT - viewport() / 2);
    body.scrollTop = top;
    setScrollTop(top);
    queueMicrotask(() => refs.get(id)?.focus());
  };

  // Keyboard moves update the model; focus follows it. Keyed on a memo: the props of a view
  // host can notify with an unchanged value, and that must not pull focus back to a row.
  const focusId = createMemo(() => local.selection.focus);
  createEffect(
    on(
      focusId,
      (focus) => {
        if (body?.contains(document.activeElement) === true) focusRow(focus);
      },
      { defer: true },
    ),
  );

  /**
   * A focused row that goes away (moved to the Trash, renamed, filtered out) hands the focus to
   * the list's new tab stop, or to the list itself when it is empty, never to the page.
   */
  const keepFocus = (): void => {
    // A microtask is not a tracked scope: read the tab stop and the rows without subscribing.
    queueMicrotask(() =>
      untrack(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body && active.isConnected) return;
        const next = tabStop();
        if (next !== undefined && refs.has(next)) focusRow(next);
        else body?.focus({ preventScroll: true });
      }),
    );
  };

  const selectedIds = (): string[] => ids().filter((id) => local.selection.selected.has(id));

  const onKeyDown = (event: KeyboardEvent): void => {
    const intent = collectionIntent(event, local.selection, ids(), {
      page: Math.max(1, Math.floor(viewport() / ROW_HEIGHT) - 1),
    });
    if (intent === undefined) return;
    event.preventDefault();
    switch (intent.type) {
      case 'select':
        local.onSelection(intent.selection);
        break;
      case 'action': {
        const targets = selectedIds();
        if (targets.length > 0) local.onAction(intent.action, targets);
        break;
      }
      case 'menu': {
        const focus = local.selection.focus ?? tabStop();
        if (focus === undefined) return;
        const next = contextSelect(local.selection, focus);
        local.onSelection(next);
        const rect = refs.get(focus)?.getBoundingClientRect();
        local.onMenu(
          ids().filter((id) => next.selected.has(id)),
          { x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0 },
        );
        break;
      }
    }
  };

  const toggleSort = (key: SortKey): void => {
    const direction =
      local.sort.key === key && local.sort.direction === 'ascending' ? 'descending' : 'ascending';
    local.onSort({ key, direction });
  };

  return (
    <div
      ref={(el) => local.ref?.(el)}
      id={local.id}
      role="grid"
      aria-label={local.label}
      aria-multiselectable="true"
      aria-rowcount={empty() ? 2 : local.entries.length + 1}
      aria-busy={local.loading === true ? 'true' : undefined}
      class={cx(styles.list, local.class)}
    >
      <div role="rowgroup" class={styles.head}>
        <div role="row" aria-rowindex={1} class={cx(styles.row, styles.headRow)}>
          <For each={FILE_COLUMNS}>
            {(column) => {
              const sorted = (): FileSort['direction'] | undefined =>
                local.sort.key === column.key ? local.sort.direction : undefined;
              return (
                <div
                  role="columnheader"
                  aria-sort={sorted() ?? 'none'}
                  data-col={column.key}
                  class={cx(styles.headCell, column.end === true && styles.end)}
                >
                  <button
                    type="button"
                    class={cx(
                      styles.sortButton,
                      sorted() !== undefined && styles.sorted,
                      sorted() === 'descending' && styles.descending,
                    )}
                    title={column.label}
                    onClick={() => toggleSort(column.key)}
                  >
                    <span class={styles.sortLabel}>{column.label}</span>
                    <span class={styles.chevron} aria-hidden="true">
                      <ChevronUp size={12} stroke-width={2.4} />
                    </span>
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </div>
      <div
        ref={(el) => (body = el)}
        role="rowgroup"
        tabindex={-1}
        data-autofocus={local.entries.length === 0 ? '' : undefined}
        aria-busy={local.loading === true ? 'true' : undefined}
        class={styles.body}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          // Empty space below the rows: nothing stays selected (Finder); focus stays here.
          if (!isEmptySpace(event.target) || event.shiftKey || event.ctrlKey || event.metaKey)
            return;
          if (local.selection.selected.size > 0) local.onSelection(clearSelection(local.selection));
        }}
        onContextMenu={(event) => {
          // The folder's own menu (the app opens it) acts on the folder, not on a selection.
          if (isEmptySpace(event.target) && local.selection.selected.size > 0)
            local.onSelection(clearSelection(local.selection));
        }}
        onScroll={(event) => {
          if (virtual()) setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        <Show when={local.loading === true}>
          <Index each={Array.from({ length: 8 })}>
            {() => (
              <div role="row" class={cx(styles.row, styles.skeletonRow)} aria-hidden="true">
                <span class={styles.skeleton} data-col="name" />
                <span class={styles.skeleton} data-col="modified" />
                <span class={styles.skeleton} data-col="size" />
                <span class={styles.skeleton} data-col="kind" />
                <span class={styles.skeleton} data-col="permissions" />
              </div>
            )}
          </Index>
        </Show>
        <Show when={empty()}>
          {/* A grid holds rows only (axe aria-required-children): the empty state is one
              full-width cell. */}
          <div role="row" aria-rowindex={2} class={styles.emptyRow}>
            <div role="gridcell" aria-colspan={FILE_COLUMNS.length} class={styles.empty}>
              {local.empty}
            </div>
          </div>
        </Show>
        <Show when={local.loading !== true && local.entries.length > 0}>
          <Show when={virtual() && range()[0] > 0}>
            <div aria-hidden="true" style={{ height: `${range()[0] * ROW_HEIGHT}px` }} />
          </Show>
          <For each={visible()}>
            {(entry) => {
              const index = (): number => indexOf().get(entry.id) ?? 0;
              const selected = (): boolean => local.selection.selected.has(entry.id);
              const status = (): string[] => rowStatus(entry);
              let rowEl: HTMLDivElement | undefined;
              onCleanup(() => {
                if (refs.get(entry.id) === rowEl) refs.delete(entry.id);
                if (rowEl?.contains(document.activeElement) === true) keepFocus();
              });
              return (
                <div
                  ref={(el) => {
                    rowEl = el;
                    refs.set(entry.id, el);
                  }}
                  role="row"
                  aria-rowindex={index() + 2}
                  aria-selected={selected()}
                  tabindex={tabStop() === entry.id ? 0 : -1}
                  data-autofocus={tabStop() === entry.id ? '' : undefined}
                  data-id={entry.id}
                  class={cx(
                    styles.row,
                    index() % 2 === 1 && styles.zebra,
                    local.menuTarget === entry.id && styles.menuTarget,
                    local.dropTarget === entry.id && styles.dropTarget,
                    entry.cut === true && styles.cut,
                    entry.readable === false && styles.unreadable,
                  )}
                  onClick={(event) =>
                    local.onSelection(
                      clickSelect(local.selection, ids(), entry.id, {
                        shift: event.shiftKey,
                        toggle: event.ctrlKey || event.metaKey,
                      }),
                    )
                  }
                  onDblClick={() => local.onAction('open', [entry.id])}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const next = contextSelect(local.selection, entry.id);
                    local.onSelection(next);
                    local.onMenu(
                      ids().filter((id) => next.selected.has(id)),
                      { x: event.clientX, y: event.clientY },
                    );
                  }}
                >
                  <div role="gridcell" data-col="name" class={cx(styles.cell, styles.nameCell)}>
                    <FileIcon entry={entry} />
                    <span class={styles.name}>{entry.name}</span>
                    <Show when={entry.type === 'symlink' && entry.target}>
                      {(target) => <span class={styles.target}>→ {target()}</span>}
                    </Show>
                    <Show when={entry.lock}>
                      {(lock) => (
                        <span
                          class={cx(styles.badge, lock().mine === true && styles.badgeMine)}
                          title={
                            lock().mine === true ? 'Locked by you' : `Locked by ${lock().holder}`
                          }
                          aria-hidden="true"
                        >
                          <Lock size={11} stroke-width={2.4} />
                        </span>
                      )}
                    </Show>
                    <Show when={entry.sync === 'pending'}>
                      <span class={styles.pending} aria-hidden="true">
                        <CloudUpload size={12} stroke-width={2.2} />
                        pending
                      </span>
                    </Show>
                    <Show when={entry.sync === 'conflict'}>
                      <span class={styles.versions} aria-hidden="true">
                        2 versions
                      </span>
                    </Show>
                    <Show when={status().length > 0}>
                      <span class={styles.hidden}>, {status().join(', ')}</span>
                    </Show>
                  </div>
                  <div role="gridcell" data-col="modified" class={cx(styles.cell, styles.muted)}>
                    {formatDate(entry.mtime, local.now)}
                  </div>
                  <div
                    role="gridcell"
                    data-col="size"
                    class={cx(styles.cell, styles.muted, styles.end)}
                  >
                    {entrySize(entry)}
                  </div>
                  <div role="gridcell" data-col="kind" class={cx(styles.cell, styles.muted)}>
                    {kindLabel(entry)}
                  </div>
                  <div role="gridcell" data-col="permissions" class={cx(styles.cell, styles.mono)}>
                    <span aria-hidden="true">{modeString(entry.type, entry.mode)}</span>
                    <span class={styles.hidden}>{spokenMode(entry.mode)}</span>
                  </div>
                </div>
              );
            }}
          </For>
          <Show when={virtual() && range()[1] < local.entries.length}>
            <div
              aria-hidden="true"
              style={{ height: `${(local.entries.length - range()[1]) * ROW_HEIGHT}px` }}
            />
          </Show>
        </Show>
      </div>
    </div>
  );
}
