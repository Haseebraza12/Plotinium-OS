import FolderLock from 'lucide-solid/icons/folder-lock';
import FolderOpen from 'lucide-solid/icons/folder-open';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';

import { Button } from '../../primitives/button/Button.tsx';
import { EmptyState } from '../../primitives/empty-state/EmptyState.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { Menu } from '../../primitives/menu/Menu.tsx';
import { FileGrid } from './FileGrid.tsx';
import { FileList } from './FileList.tsx';
import styles from './Files.module.css';
import { FilesSidebar } from './FilesSidebar.tsx';
import { FilesStatusBar, type SearchStatus } from './FilesStatusBar.tsx';
import { FilesToolbar } from './FilesToolbar.tsx';
import { Inspector, type InspectorAction } from './Inspector.tsx';
import {
  fileMenuItems,
  menuLabel,
  openWithItems,
  type FileAction,
  type OpenWithTarget,
} from './menu.ts';
import { SemanticResults, type SearchError } from './SemanticResults.tsx';
import { EMPTY_SELECTION, pruneSelection, type Selection } from './selection.ts';
import type {
  FileEntry,
  FileSort,
  FileTag,
  Place,
  Quota,
  SearchMode,
  SearchNotice,
  SemanticHit,
  ViewMode,
  Viewer,
} from './types.ts';

/** Everything the view can ask the app to do with files. */
export type FilesIntent = FileAction | `open-with:${OpenWithTarget}`;

export interface FilesResults {
  mode: SearchMode;
  hits: readonly SemanticHit[];
  elapsedMs?: number;
  notices?: readonly SearchNotice[];
  loading?: boolean;
  error?: SearchError;
  /** Index facts for the status bar. */
  status?: SearchStatus;
}

export interface FilesViewProps {
  /** Folder title ("Documents"), shown in the toolbar (the window frame owns the heading). */
  title: string;
  /** Id of the toolbar title, for an aria-labelledby that wants the folder name. */
  titleId?: string;
  path: string;
  onNavigate: (path: string) => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;

  favourites: readonly Place[];
  locations: readonly Place[];
  tags: readonly FileTag[];
  selectedPlace?: string;
  onPlace: (id: string) => void;
  activeTags?: ReadonlySet<string>;
  onToggleTag?: (id: string) => void;
  quota?: Quota;

  entries: readonly FileEntry[];
  loading?: boolean;
  /** The folder could not be listed (EACCES, EIO). */
  error?: SearchError;
  onRetry?: () => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  sort: FileSort;
  onSort: (sort: FileSort) => void;
  /** Controlled selection; omit to let the view keep its own. */
  selection?: Selection;
  onSelection?: (selection: Selection) => void;
  viewer: Viewer;
  /** The viewer has `w` on this folder (rename and trash). */
  folderWritable: boolean;
  /** The folder is the Trash: its menu offers Put Back and Delete Immediately. */
  inTrash?: boolean;
  /** Id of the folder row a drag is over (drop-target highlight). */
  dropTarget?: string;
  /** Clock for relative dates. */
  now: number;
  /** Show ⌘ shortcuts. */
  mac?: boolean;
  onAction: (intent: FilesIntent, entries: readonly FileEntry[]) => void;

  query: string;
  onQuery: (query: string) => void;
  onSubmit?: (query: string) => void;
  searchMode: SearchMode;
  onSearchMode?: (mode: SearchMode) => void;
  onSearchFocus?: (focused: boolean) => void;
  semanticAvailable?: boolean;
  /** When set, results replace the listing. */
  results?: FilesResults;
  selectedHit?: string;
  onSelectHit?: (id: string) => void;
  onOpenHit: (hit: SemanticHit) => void;
  onSearchAll?: () => void;
  /** Entries for hits, so the inspector can describe the selected result. */
  hitEntries?: Readonly<Record<string, FileEntry>>;

  showInspector?: boolean;
  onInspectorAction?: (action: InspectorAction, entry: FileEntry | undefined) => void;
  /** The inspector actions the host can carry out (default: all). */
  inspectorActions?: readonly InspectorAction[];
  onShare?: (entries: readonly FileEntry[]) => void;
  user: string;
  /** Leave room for the window's traffic lights at the top of the sidebar. */
  titlebarInset?: boolean;
  class?: string;
}

interface MenuState {
  ids: readonly string[];
  at: { x: number; y: number };
  openWith?: boolean;
}

/**
 * The Files window content (files-light, files-semantic-search): sidebar, unified toolbar,
 * the list or icon view (or semantic results), the inspector and the status bar. The view
 * holds only presentation state (selection, the open menu); every change to files is an
 * intent for the app (SYS-01). Ctrl/Cmd+F focuses search; Escape in an empty search box
 * returns to the list.
 */
export function FilesView(props: FilesViewProps): JSX.Element {
  const [local] = splitProps(props, [
    'title',
    'titleId',
    'path',
    'onNavigate',
    'canBack',
    'canForward',
    'onBack',
    'onForward',
    'favourites',
    'locations',
    'tags',
    'selectedPlace',
    'onPlace',
    'activeTags',
    'onToggleTag',
    'quota',
    'entries',
    'loading',
    'error',
    'onRetry',
    'view',
    'onView',
    'sort',
    'onSort',
    'selection',
    'onSelection',
    'viewer',
    'folderWritable',
    'inTrash',
    'dropTarget',
    'now',
    'mac',
    'onAction',
    'query',
    'onQuery',
    'onSubmit',
    'searchMode',
    'onSearchMode',
    'onSearchFocus',
    'semanticAvailable',
    'results',
    'selectedHit',
    'onSelectHit',
    'onOpenHit',
    'onSearchAll',
    'hitEntries',
    'showInspector',
    'onInspectorAction',
    'inspectorActions',
    'onShare',
    'user',
    'titlebarInset',
    'class',
  ]);
  const uid = createUniqueId();
  const titleId = (): string => local.titleId ?? `pl-files-title-${uid}`;
  const listId = `pl-files-list-${uid}`;
  const [ownSelection, setOwnSelection] = createSignal<Selection>(EMPTY_SELECTION);
  const [ownHit, setOwnHit] = createSignal<string>();
  const [menu, setMenu] = createSignal<MenuState>();
  let root: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let collection: HTMLElement | undefined;

  const selection = (): Selection => local.selection ?? ownSelection();
  const setSelection = (next: Selection): void => {
    if (local.onSelection !== undefined) local.onSelection(next);
    if (local.selection === undefined) setOwnSelection(next);
  };
  const selectedHit = (): string | undefined => local.selectedHit ?? ownHit();
  const byId = createMemo(() => new Map(local.entries.map((e) => [e.id, e] as const)));
  const entriesFor = (ids: readonly string[]): FileEntry[] =>
    ids.map((id) => byId().get(id)).filter((e): e is FileEntry => e !== undefined);
  const selectedEntries = createMemo(() =>
    local.entries.filter((e) => selection().selected.has(e.id)),
  );
  const inspected = createMemo((): readonly FileEntry[] => {
    if (local.results === undefined) return selectedEntries();
    const hit = selectedHit();
    const entry = hit === undefined ? undefined : local.hitEntries?.[hit];
    return entry === undefined ? [] : [entry];
  });
  const menuTargets = createMemo(() => entriesFor(menu()?.ids ?? []));
  let restoreFocus: HTMLElement | undefined;
  const openMenu = (ids: readonly string[], at: { x: number; y: number }): void => {
    const active = document.activeElement;
    restoreFocus = active instanceof HTMLElement ? active : undefined;
    setMenu({ ids, at });
  };
  /** Closes the menus; keyboard and item choices return focus to where the menu opened. */
  const closeMenu = (refocus: boolean): void => {
    setMenu(undefined);
    if (refocus) restoreFocus?.focus();
    restoreFocus = undefined;
  };

  // Keep the selection valid when the listing changes (keyed on a memo: a host's props can
  // notify without a new listing).
  const entries = createMemo(() => local.entries);
  createEffect(
    on(
      entries,
      (entries) => {
        const pruned = pruneSelection(
          selection(),
          entries.map((e) => e.id),
        );
        if (pruned.selected.size !== selection().selected.size) setSelection(pruned);
      },
      { defer: true },
    ),
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    }
  };
  onMount(() => {
    root?.addEventListener('keydown', onKeyDown);
    onCleanup(() => root?.removeEventListener('keydown', onKeyDown));
  });

  const act = (intent: FilesIntent, ids: readonly string[]): void => {
    const targets = entriesFor(ids);
    if (targets.length > 0) local.onAction(intent, targets);
  };

  /** The element the search box controls exists only when a list or result set is shown. */
  const listRendered = (): boolean => {
    const results = local.results;
    if (results === undefined) return local.error === undefined;
    return results.hits.length > 0 && results.loading !== true && results.error === undefined;
  };

  const collectionLabel = (): string =>
    `${local.title}, ${local.entries.length} ${local.entries.length === 1 ? 'item' : 'items'}`;

  const emptyFolder = (): JSX.Element => (
    <EmptyState
      compact
      icon={<FolderOpen size={40} stroke-width={1.4} />}
      title="This folder is empty"
      description={`Drop files here or press ${local.mac === true ? '⇧⌘N' : 'Ctrl+Shift+N'} for a new folder`}
    />
  );

  const collectionProps = () => ({
    entries: local.entries,
    selection: selection(),
    onSelection: setSelection,
    onAction: (action: FileAction, ids: readonly string[]) => act(action, ids),
    onMenu: openMenu,
    label: collectionLabel(),
    now: local.now,
    menuTarget: menu()?.ids.length === 1 ? menu()?.ids[0] : undefined,
    dropTarget: local.dropTarget,
    loading: local.loading,
    empty: emptyFolder(),
    ref: (el: HTMLElement) => (collection = el),
    id: listId,
  });

  return (
    <div ref={(el) => (root = el)} class={cx(styles.view, local.class)}>
      <FilesSidebar
        favourites={local.favourites}
        locations={local.locations}
        tags={local.tags}
        selectedPlace={local.selectedPlace}
        onPlace={(id) => local.onPlace(id)}
        activeTags={local.activeTags}
        onToggleTag={local.onToggleTag}
        quota={local.quota}
        titlebarInset={local.titlebarInset}
      />
      <div class={styles.main}>
        <FilesToolbar
          title={local.title}
          titleId={titleId()}
          path={local.path}
          onNavigate={(path) => local.onNavigate(path)}
          canBack={local.canBack}
          canForward={local.canForward}
          onBack={() => local.onBack()}
          onForward={() => local.onForward()}
          view={local.results === undefined ? local.view : 'list'}
          onView={(view) => local.onView(view)}
          views={['icons', 'list']}
          availableViews={local.results === undefined ? ['icons', 'list'] : ['list']}
          sort={local.sort}
          onSort={(sort) => local.onSort(sort)}
          canShare={selectedEntries().length > 0}
          onShare={
            local.onShare === undefined ? undefined : () => local.onShare?.(selectedEntries())
          }
          search={{
            query: local.query,
            onQuery: (q) => local.onQuery(q),
            onSubmit: local.onSubmit,
            mode: local.searchMode,
            onMode: local.onSearchMode,
            onFocusChange: local.onSearchFocus,
            onEscape: () => collection?.querySelector<HTMLElement>('[tabindex="0"]')?.focus(),
            controls: listRendered() ? listId : undefined,
            semanticAvailable: local.semanticAvailable,
            scope: local.title,
            inputRef: (el) => (searchInput = el),
          }}
        />
        <div class={styles.content}>
          <div class={styles.pane}>
            <Switch>
              <Match when={local.results}>
                {(results) => (
                  <SemanticResults
                    mode={results().mode}
                    hits={results().hits}
                    scope={local.title}
                    elapsedMs={results().elapsedMs}
                    notices={results().notices}
                    loading={results().loading}
                    error={results().error}
                    onRetry={local.onRetry}
                    selected={selectedHit()}
                    onSelect={(id) => {
                      setOwnHit(id);
                      local.onSelectHit?.(id);
                    }}
                    onOpen={(hit) => local.onOpenHit(hit)}
                    onSearchAll={local.onSearchAll}
                    onTryKeyword={
                      local.onSearchMode === undefined
                        ? undefined
                        : () => local.onSearchMode?.('keyword')
                    }
                    listId={listId}
                  />
                )}
              </Match>
              <Match when={local.error}>
                {(error) => (
                  <div class={styles.errorBanner} role="alert">
                    <FolderLock size={18} stroke-width={2} aria-hidden="true" />
                    <span class={styles.errorText}>
                      {error().message} <span class={styles.errno}>({error().code})</span>
                    </span>
                    <Show when={local.canBack}>
                      <Button size="sm" onClick={() => local.onBack()}>
                        Back
                      </Button>
                    </Show>
                    <Show when={local.onRetry}>
                      <Button size="sm" onClick={() => local.onRetry?.()}>
                        Retry
                      </Button>
                    </Show>
                  </div>
                )}
              </Match>
              <Match when={local.view === 'icons'}>
                <FileGrid {...collectionProps()} />
              </Match>
              <Match when={local.view !== 'icons'}>
                <FileList
                  {...collectionProps()}
                  sort={local.sort}
                  onSort={(s) => local.onSort(s)}
                />
              </Match>
            </Switch>
          </div>
          <Show when={local.showInspector !== false}>
            <Inspector
              class={styles.inspectorPane}
              entries={inspected()}
              viewer={local.viewer}
              now={local.now}
              actions={local.inspectorActions}
              onAction={(action, entry) => local.onInspectorAction?.(action, entry)}
            />
          </Show>
        </div>
        <FilesStatusBar
          items={local.entries.length}
          selected={selectedEntries().length}
          selectedSize={selectedEntries().reduce((s, e) => s + (e.type === 'dir' ? 0 : e.size), 0)}
          quota={local.quota}
          user={local.user}
          path={local.path}
          search={local.results?.status}
        />
      </div>
      <Menu
        open={menu() !== undefined && menu()?.openWith !== true}
        at={menu()?.at}
        label={menuLabel(menuTargets())}
        items={fileMenuItems(menuTargets(), {
          viewer: local.viewer,
          folderWritable: local.folderWritable,
          mac: local.mac,
          inTrash: local.inTrash,
        })}
        onSelect={(id) => {
          const state = menu();
          if (state === undefined) return;
          if (id === 'open-with') {
            setMenu({ ...state, openWith: true });
            return;
          }
          act(id as FileAction, state.ids);
        }}
        onClose={(reason) => {
          if (menu()?.openWith === true) return;
          closeMenu(reason !== 'outside');
        }}
      />
      <Menu
        open={menu()?.openWith === true}
        at={menu()?.at}
        label="Open With"
        items={openWithItems(menuTargets())}
        onSelect={(id) => {
          const state = menu();
          if (state !== undefined) act(`open-with:${id as OpenWithTarget}`, state.ids);
        }}
        onClose={(reason) => closeMenu(reason !== 'outside')}
      />
    </div>
  );
}
