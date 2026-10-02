import ChevronUp from 'lucide-solid/icons/chevron-up';
import { createMemo, createSignal, For, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Table.module.css';

export type SortDirection = 'ascending' | 'descending';
export interface SortState {
  column: string;
  direction: SortDirection;
}

export interface TableColumn<R> {
  id: string;
  header: string;
  cell: (row: R) => JSX.Element;
  /** Enables sorting on this column. */
  sortValue?: (row: R) => string | number;
  align?: 'start' | 'end' | 'center';
  /** A CSS grid track: '1fr', 'minmax(0, 2fr)', '72px'. Defaults to minmax(0, 1fr). */
  width?: string;
  mono?: boolean;
  muted?: boolean;
  /** Visually hide the header text (it stays the column's accessible name). */
  hideHeader?: boolean;
}

export type SelectionMode = 'none' | 'single' | 'multiple';

export interface TableProps<R> {
  columns: readonly TableColumn<R>[];
  rows: readonly R[];
  rowId: (row: R) => string;
  /** Accessible name of the grid. */
  label: string;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  selectionMode?: SelectionMode;
  selected?: ReadonlySet<string>;
  onSelectionChange?: (ids: ReadonlySet<string>) => void;
  /** Enter or double-click on a row (open the file, show process details). */
  onActivate?: (row: R) => void;
  striped?: boolean;
  density?: 'regular' | 'compact';
  /** Shown instead of the body when there are no rows. */
  empty?: JSX.Element;
  class?: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Sorts a copy of `rows` by a column's sortValue; stable, numeric-aware for strings. */
export function sortRows<R>(
  rows: readonly R[],
  column: TableColumn<R> | undefined,
  direction: SortDirection,
): R[] {
  const value = column?.sortValue;
  if (value === undefined) return [...rows];
  const sign = direction === 'ascending' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => {
      const cmp =
        typeof a.key === 'number' && typeof b.key === 'number'
          ? a.key - b.key
          : collator.compare(String(a.key), String(b.key));
      return cmp === 0 ? a.index - b.index : cmp * sign;
    })
    .map((entry) => entry.row);
}

/**
 * A sortable, selectable data grid. Keyboard: Up/Down/Home/End/PageUp/PageDown move and select,
 * Shift extends (multiple), Space toggles (multiple), Ctrl+A selects all, Enter activates.
 * Mouse: click selects, Ctrl/Cmd-click toggles, Shift-click selects a range, double-click
 * activates. Rows over 2,000 need windowing by the caller (DSN-19).
 */
export function Table<R>(props: TableProps<R>): JSX.Element {
  const [local] = splitProps(props, [
    'columns',
    'rows',
    'rowId',
    'label',
    'sort',
    'onSortChange',
    'selectionMode',
    'selected',
    'onSelectionChange',
    'onActivate',
    'striped',
    'density',
    'empty',
    'class',
  ]);
  const mode = (): SelectionMode => local.selectionMode ?? 'single';
  const [focusIndex, setFocusIndex] = createSignal(0);
  const [anchorIndex, setAnchorIndex] = createSignal(0);
  const rowRefs: HTMLElement[] = [];

  const view = createMemo(() => {
    const sort = local.sort;
    if (sort === undefined) return [...local.rows];
    return sortRows(
      local.rows,
      local.columns.find((c) => c.id === sort.column),
      sort.direction,
    );
  });
  const ids = createMemo(() => view().map((row) => local.rowId(row)));
  const isSelected = (id: string): boolean => local.selected?.has(id) === true;
  const template = (): string => local.columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' ');
  const tabStop = createMemo(() => {
    const list = ids();
    const firstSelected = list.findIndex((id) => isSelected(id));
    const f = focusIndex();
    return f >= 0 && f < list.length ? f : Math.max(0, firstSelected);
  });

  const emit = (next: Set<string>): void => local.onSelectionChange?.(next);
  const range = (from: number, to: number): Set<string> => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    return new Set(ids().slice(a, b + 1));
  };

  const moveTo = (index: number, extend: boolean): void => {
    const count = ids().length;
    if (count === 0) return;
    const clamped = Math.min(count - 1, Math.max(0, index));
    setFocusIndex(clamped);
    rowRefs[clamped]?.focus();
    if (mode() === 'none') return;
    if (extend && mode() === 'multiple') emit(range(anchorIndex(), clamped));
    else {
      setAnchorIndex(clamped);
      const id = ids()[clamped];
      if (id !== undefined) emit(new Set([id]));
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const current = focusIndex();
    const extend = event.shiftKey;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(current + 1, extend);
        break;
      case 'ArrowUp':
        moveTo(current - 1, extend);
        break;
      case 'Home':
        moveTo(0, extend);
        break;
      case 'End':
        moveTo(ids().length - 1, extend);
        break;
      case 'PageDown':
        moveTo(current + 10, extend);
        break;
      case 'PageUp':
        moveTo(current - 10, extend);
        break;
      case ' ': {
        if (mode() !== 'multiple') return;
        const id = ids()[current];
        if (id === undefined) return;
        const next = new Set(local.selected ?? []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setAnchorIndex(current);
        emit(next);
        break;
      }
      case 'Enter': {
        const row = view()[current];
        if (row !== undefined) local.onActivate?.(row);
        break;
      }
      case 'a':
      case 'A':
        if (!(event.ctrlKey || event.metaKey) || mode() !== 'multiple') return;
        emit(new Set(ids()));
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onRowClick = (event: MouseEvent, index: number): void => {
    setFocusIndex(index);
    if (mode() === 'none') return;
    const id = ids()[index];
    if (id === undefined) return;
    if (mode() === 'multiple' && event.shiftKey) {
      emit(range(anchorIndex(), index));
      return;
    }
    setAnchorIndex(index);
    if (mode() === 'multiple' && (event.ctrlKey || event.metaKey)) {
      const next = new Set(local.selected ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      emit(next);
      return;
    }
    emit(new Set([id]));
  };

  const toggleSort = (column: TableColumn<R>): void => {
    const sort = local.sort;
    const direction: SortDirection =
      sort?.column === column.id && sort.direction === 'ascending' ? 'descending' : 'ascending';
    local.onSortChange?.({ column: column.id, direction });
  };

  const alignClass = (column: TableColumn<R>): string | undefined =>
    column.align === 'end' ? styles.end : column.align === 'center' ? styles.center : undefined;

  return (
    <div
      role="grid"
      aria-label={local.label}
      aria-rowcount={view().length + 1}
      aria-multiselectable={mode() === 'multiple' ? 'true' : undefined}
      class={cx(
        styles.table,
        local.striped !== false && styles.striped,
        local.density === 'compact' && styles.compact,
        local.class,
      )}
      style={{ '--pl-table-cols': template() }}
    >
      <div role="rowgroup">
        <div role="row" class={cx(styles.row, styles.header)} aria-rowindex={1}>
          <For each={local.columns}>
            {(column) => {
              const sortedHere = (): SortDirection | undefined =>
                local.sort?.column === column.id ? local.sort.direction : undefined;
              return (
                <div
                  role="columnheader"
                  class={cx(styles.headerCell, alignClass(column))}
                  aria-sort={sortedHere()}
                >
                  <Show
                    when={column.sortValue !== undefined && local.onSortChange !== undefined}
                    fallback={
                      <span class={column.hideHeader === true ? styles.hidden : undefined}>
                        {column.header}
                      </span>
                    }
                  >
                    <button
                      type="button"
                      class={cx(
                        styles.sortButton,
                        sortedHere() !== undefined && styles.sorted,
                        sortedHere() === 'descending' && styles.descending,
                      )}
                      onClick={() => toggleSort(column)}
                    >
                      <span class={column.hideHeader === true ? styles.hidden : undefined}>
                        {column.header}
                      </span>
                      <span class={styles.arrow} aria-hidden="true">
                        <ChevronUp size={12} stroke-width={2.4} />
                      </span>
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
      <Show when={view().length > 0} fallback={<div class={styles.empty}>{local.empty}</div>}>
        <div role="rowgroup" class={styles.body} onKeyDown={onKeyDown}>
          <For each={view()}>
            {(row, index) => {
              const id = (): string => local.rowId(row);
              return (
                <div
                  ref={(el) => (rowRefs[index()] = el)}
                  role="row"
                  class={styles.row}
                  aria-rowindex={index() + 2}
                  aria-selected={mode() === 'none' ? undefined : isSelected(id())}
                  tabindex={index() === tabStop() ? 0 : -1}
                  data-row-id={id()}
                  onClick={(event) => onRowClick(event, index())}
                  onDblClick={() => local.onActivate?.(row)}
                  onFocus={() => setFocusIndex(index())}
                >
                  <For each={local.columns}>
                    {(column) => (
                      <div
                        role="gridcell"
                        class={cx(
                          styles.cell,
                          alignClass(column),
                          column.mono === true && styles.mono,
                          column.muted === true && styles.muted,
                        )}
                      >
                        {column.cell(row)}
                      </div>
                    )}
                  </For>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
