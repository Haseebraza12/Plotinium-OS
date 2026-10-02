import ArrowUpDown from 'lucide-solid/icons/arrow-up-down';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import CircleX from 'lucide-solid/icons/circle-x';
import Columns3 from 'lucide-solid/icons/columns-3';
import GalleryHorizontal from 'lucide-solid/icons/gallery-horizontal';
import LayoutGrid from 'lucide-solid/icons/layout-grid';
import List from 'lucide-solid/icons/list';
import Share from 'lucide-solid/icons/share';
import Sparkles from 'lucide-solid/icons/sparkles';
import { createSignal, Show, splitProps, type JSX } from 'solid-js';

import { IconButton } from '../../primitives/icon-button/IconButton.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { Menu } from '../../primitives/menu/Menu.tsx';
import {
  SegmentedControl,
  type SegmentOption,
} from '../../primitives/segmented-control/SegmentedControl.tsx';
import styles from './Files.module.css';
import { PathBar } from './PathBar.tsx';
import type { FileSort, SearchMode, SortKey, ViewMode } from './types.ts';

export interface FilesSearchProps {
  query: string;
  onQuery: (query: string) => void;
  onSubmit?: (query: string) => void;
  mode: SearchMode;
  onMode?: (mode: SearchMode) => void;
  /** The search box gained or lost focus (ai.search.focus warms the model). */
  onFocusChange?: (focused: boolean) => void;
  /** Escape on an empty box: return focus to the list. */
  onEscape?: () => void;
  /** Id of the results list the box controls. */
  controls?: string;
  /** Semantic search is not installed (AI-off build, safe mode): no mode switch. */
  semanticAvailable?: boolean;
  placeholder?: string;
  /** Scope name for the accessible label ("notes"). */
  scope?: string;
  inputRef?: (el: HTMLInputElement) => void;
}

/**
 * The toolbar search field: the AI sparkle (it plays once when the model starts warming), the
 * query, a clear button and the Semantic/Keyword switch.
 */
export function FilesSearch(props: FilesSearchProps): JSX.Element {
  const [local] = splitProps(props, [
    'query',
    'onQuery',
    'onSubmit',
    'mode',
    'onMode',
    'onFocusChange',
    'onEscape',
    'controls',
    'semanticAvailable',
    'placeholder',
    'scope',
    'inputRef',
  ]);
  const [warm, setWarm] = createSignal(0);
  let input: HTMLInputElement | undefined;
  const semantic = (): boolean => local.semanticAvailable !== false && local.mode === 'semantic';

  return (
    <div role="search" class={cx(styles.search, semantic() && styles.searchSemantic)}>
      <Show keyed when={warm() + 1}>
        <span class={cx(styles.searchIcon, warm() > 0 && styles.sparkle)} aria-hidden="true">
          <Sparkles size={14} stroke-width={2} />
        </span>
      </Show>
      <input
        ref={(el) => {
          input = el;
          local.inputRef?.(el);
        }}
        type="search"
        class={styles.searchInput}
        aria-label={
          semantic()
            ? `Search ${local.scope ?? 'files'} by meaning`
            : `Search ${local.scope ?? 'files'} by name`
        }
        aria-controls={local.controls}
        placeholder={
          local.placeholder ?? (local.scope === undefined ? 'Search' : `Search ${local.scope}`)
        }
        value={local.query}
        autocomplete="off"
        spellcheck={false}
        onInput={(event) => local.onQuery(event.currentTarget.value)}
        onFocus={() => {
          setWarm((n) => n + 1);
          local.onFocusChange?.(true);
        }}
        onBlur={() => local.onFocusChange?.(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') local.onSubmit?.(local.query);
          else if (event.key === 'Escape') {
            event.preventDefault();
            if (local.query !== '') local.onQuery('');
            else local.onEscape?.();
          }
        }}
      />
      <Show when={local.query !== ''}>
        <button
          type="button"
          class={styles.searchClear}
          aria-label="Clear search"
          onClick={() => {
            local.onQuery('');
            input?.focus();
          }}
        >
          <CircleX size={14} aria-hidden="true" />
        </button>
      </Show>
      <Show when={local.semanticAvailable !== false && local.onMode !== undefined}>
        <button
          type="button"
          role="switch"
          class={styles.modePill}
          aria-checked={semantic()}
          aria-label="Semantic search"
          onClick={() => local.onMode?.(semantic() ? 'keyword' : 'semantic')}
        >
          {semantic() ? 'Semantic' : 'Keyword'}
        </button>
      </Show>
    </div>
  );
}

const VIEW_OPTIONS: readonly SegmentOption<ViewMode>[] = [
  { value: 'icons', label: 'Icons', icon: LayoutGrid, iconOnly: true },
  { value: 'list', label: 'List', icon: List, iconOnly: true },
  { value: 'columns', label: 'Columns', icon: Columns3, iconOnly: true },
  { value: 'gallery', label: 'Gallery', icon: GalleryHorizontal, iconOnly: true },
];

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  modified: 'Date Modified',
  size: 'Size',
  kind: 'Kind',
  permissions: 'Permissions',
};

export interface FilesToolbarProps {
  /**
   * Folder title ("Documents"), drawn as plain text: the window frame owns the heading that
   * names the window (UI-113). It gives way on a narrow toolbar, where the path bar's current
   * crumb names the folder.
   */
  title: string;
  titleId?: string;
  path: string;
  onNavigate: (path: string) => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  /**
   * The views this build implements, in switcher order (default Icons and List). A view that
   * does not exist is not drawn at all (UI-111): a permanently disabled segment explains
   * nothing.
   */
  views?: readonly ViewMode[];
  /** Of `views`, those allowed right now (search results are a list); the others show disabled. */
  availableViews?: readonly ViewMode[];
  sort?: FileSort;
  onSort?: (sort: FileSort) => void;
  /** Share needs a selection. */
  canShare?: boolean;
  onShare?: () => void;
  search: FilesSearchProps;
  /** Leave room for the traffic lights when there is no sidebar. */
  titlebarInset?: boolean;
  class?: string;
}

/**
 * The unified toolbar: Back/Forward, the folder title, the path bar, the view switcher, Sort
 * and Share, and the search field. Left/Right arrows move between the toolbar's buttons.
 */
export function FilesToolbar(props: FilesToolbarProps): JSX.Element {
  const [local] = splitProps(props, [
    'title',
    'titleId',
    'path',
    'onNavigate',
    'canBack',
    'canForward',
    'onBack',
    'onForward',
    'view',
    'onView',
    'views',
    'availableViews',
    'sort',
    'onSort',
    'canShare',
    'onShare',
    'search',
    'titlebarInset',
    'class',
  ]);
  const [sortOpen, setSortOpen] = createSignal(false);
  // A signal: the menu must follow the button element that is actually on screen.
  const [sortButton, setSortButton] = createSignal<HTMLButtonElement>();
  let bar: HTMLDivElement | undefined;

  const views = (): readonly ViewMode[] => local.views ?? ['icons', 'list'];
  const available = (): readonly ViewMode[] => local.availableViews ?? views();
  const options = (): SegmentOption<ViewMode>[] =>
    VIEW_OPTIONS.filter((o) => views().includes(o.value)).map((o) => ({
      ...o,
      disabled: !available().includes(o.value),
    }));

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // Alt+←/→ are the window's Back and Forward, not a move along the toolbar.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.closest('[role="radiogroup"]') !== null)
      return;
    const buttons = [
      ...(bar?.querySelectorAll<HTMLButtonElement>('button:not([role="radio"])') ?? []),
    ].filter((b) => b.offsetParent !== null || b === target);
    const index = buttons.indexOf(target);
    const next = buttons[index + (event.key === 'ArrowRight' ? 1 : -1)];
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <div
      ref={(el) => (bar = el)}
      role="toolbar"
      aria-label="Files toolbar"
      data-pl-drag-region
      class={cx(styles.toolbar, local.titlebarInset === true && styles.toolbarInset, local.class)}
      onKeyDown={onKeyDown}
    >
      <div class={styles.navButtons}>
        <IconButton
          label="Back"
          icon={<ChevronLeft size={18} stroke-width={2} />}
          disabled={!local.canBack}
          onClick={() => local.onBack()}
        />
        <IconButton
          label="Forward"
          icon={<ChevronRight size={18} stroke-width={2} />}
          disabled={!local.canForward}
          onClick={() => local.onForward()}
        />
      </div>
      <div id={local.titleId} class={styles.title} title={local.title}>
        {local.title}
      </div>
      <PathBar path={local.path} onNavigate={(path) => local.onNavigate(path)} />
      <SegmentedControl
        label="View"
        size="sm"
        class={styles.viewSwitch}
        options={options()}
        value={local.view}
        onChange={(view) => local.onView(view)}
      />
      <Show when={local.onSort}>
        <IconButton
          ref={(el: HTMLButtonElement) => setSortButton(el)}
          class={styles.sortToggle}
          label="Sort"
          icon={<ArrowUpDown size={16} stroke-width={2} />}
          aria-haspopup="menu"
          aria-expanded={sortOpen()}
          onClick={() => setSortOpen(!sortOpen())}
        />
        <Menu
          open={sortOpen()}
          anchor={sortButton()}
          label="Sort by"
          items={[
            ...(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
              id: key,
              label: SORT_LABELS[key],
              checked: local.sort?.key === key,
            })),
            { kind: 'separator' as const, id: 'sep' },
            {
              id: 'ascending',
              label: 'Ascending',
              checked: local.sort?.direction !== 'descending',
            },
            {
              id: 'descending',
              label: 'Descending',
              checked: local.sort?.direction === 'descending',
            },
          ]}
          onSelect={(id) => {
            const current = local.sort ?? { key: 'name', direction: 'ascending' };
            if (id === 'ascending' || id === 'descending')
              local.onSort?.({ ...current, direction: id });
            else local.onSort?.({ ...current, key: id as SortKey });
          }}
          onClose={() => setSortOpen(false)}
        />
      </Show>
      <Show when={local.onShare}>
        <IconButton
          label="Share"
          icon={<Share size={16} stroke-width={2} />}
          disabled={local.canShare !== true}
          onClick={() => local.onShare?.()}
        />
      </Show>
      <FilesSearch {...local.search} />
    </div>
  );
}
