import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  splitProps,
  untrack,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { FileIcon } from './FileIcon.tsx';
import styles from './FileList.module.css';
import { entrySize, kindLabel } from './format.ts';
import { collectionIntent } from './keys.ts';
import { isEmptySpace, rowStatus, type CollectionProps } from './FileList.tsx';
import { clearSelection, clickSelect, contextSelect } from './selection.ts';

/**
 * The Files icon view: a multi-select listbox laid out as a grid. Arrow keys move in two
 * dimensions (the column count follows the width), with the same selection and action keys
 * as the list view.
 */
export function FileGrid(props: CollectionProps): JSX.Element {
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
    'id',
    'class',
    'ref',
  ]);
  const refs = new Map<string, HTMLElement>();
  const [columns, setColumns] = createSignal(6);
  let grid: HTMLDivElement | undefined;

  const ids = createMemo(() => local.entries.map((e) => e.id));
  const tabStop = createMemo(() => {
    const focus = local.selection.focus;
    if (focus !== undefined && ids().includes(focus)) return focus;
    return ids().find((id) => local.selection.selected.has(id)) ?? ids()[0];
  });

  const measure = (): void => {
    const first = grid?.firstElementChild;
    if (grid === undefined || !(first instanceof HTMLElement) || first.offsetWidth === 0) return;
    const top = first.offsetTop;
    let count = 0;
    for (const child of grid.children) {
      if (child instanceof HTMLElement && child.offsetTop === top) count += 1;
    }
    if (count > 0) setColumns(count);
  };
  // The grid element can appear after mount (after loading), so observe it when it attaches.
  let observer: ResizeObserver | undefined;
  onCleanup(() => observer?.disconnect());
  const attach = (el: HTMLDivElement): void => {
    grid = el;
    local.ref?.(el);
    if (typeof ResizeObserver !== 'undefined') {
      observer ??= new ResizeObserver(measure);
      observer.observe(el);
    }
    queueMicrotask(measure);
  };

  // Keyed on a memo, so an unchanged focus id never moves focus again.
  const focusId = createMemo(() => local.selection.focus);
  createEffect(
    on(
      focusId,
      (focus) => {
        if (focus !== undefined && grid?.contains(document.activeElement) === true)
          refs.get(focus)?.focus();
      },
      { defer: true },
    ),
  );

  const selectedIds = (): string[] => ids().filter((id) => local.selection.selected.has(id));

  /** A focused tile that goes away hands the focus to the new tab stop, never to the page. */
  const keepFocus = (): void => {
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && active.isConnected) return;
      // A microtask is not a tracked scope: read the tab stop without subscribing.
      const next = untrack(tabStop);
      const el = next === undefined ? undefined : refs.get(next);
      if (el !== undefined) el.focus();
      else grid?.focus({ preventScroll: true });
    });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const intent = collectionIntent(event, local.selection, ids(), { columns: columns(), page: 3 });
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
          { x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2, y: rect?.bottom ?? 0 },
        );
        break;
      }
    }
  };

  return (
    <Show
      when={local.loading !== true && local.entries.length > 0}
      fallback={
        <div
          ref={(el) => (grid = el)}
          id={local.id}
          class={cx(styles.grid, local.class)}
          role="listbox"
          tabindex={-1}
          data-autofocus=""
          aria-label={local.label}
          aria-busy={local.loading === true ? 'true' : undefined}
        >
          <Show when={local.loading !== true}>
            <div class={styles.empty}>{local.empty}</div>
          </Show>
        </div>
      }
    >
      <div
        ref={(el) => attach(el)}
        id={local.id}
        role="listbox"
        tabindex={-1}
        aria-label={local.label}
        aria-multiselectable="true"
        aria-orientation="horizontal"
        class={cx(styles.grid, local.class)}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          // Empty space between the tiles: nothing stays selected (Finder).
          if (!isEmptySpace(event.target) || event.shiftKey || event.ctrlKey || event.metaKey)
            return;
          if (local.selection.selected.size > 0) local.onSelection(clearSelection(local.selection));
        }}
        onContextMenu={(event) => {
          if (isEmptySpace(event.target) && local.selection.selected.size > 0)
            local.onSelection(clearSelection(local.selection));
        }}
      >
        <For each={local.entries}>
          {(entry) => {
            const selected = (): boolean => local.selection.selected.has(entry.id);
            let tileEl: HTMLDivElement | undefined;
            onCleanup(() => {
              if (refs.get(entry.id) === tileEl) refs.delete(entry.id);
              if (tileEl?.contains(document.activeElement) === true) keepFocus();
            });
            return (
              <div
                ref={(el) => {
                  tileEl = el;
                  refs.set(entry.id, el);
                }}
                role="option"
                aria-selected={selected()}
                aria-label={[entry.name, kindLabel(entry), entrySize(entry), ...rowStatus(entry)]
                  .filter((part) => part !== '--')
                  .join(', ')}
                tabindex={tabStop() === entry.id ? 0 : -1}
                data-autofocus={tabStop() === entry.id ? '' : undefined}
                data-id={entry.id}
                class={cx(
                  styles.tile,
                  local.menuTarget === entry.id && styles.menuTarget,
                  local.dropTarget === entry.id && styles.dropTarget,
                  entry.cut === true && styles.cut,
                )}
                title={entry.name}
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
                <span class={styles.tileIcon}>
                  <FileIcon entry={entry} size={40} />
                </span>
                <span class={styles.tileName}>{entry.name}</span>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
