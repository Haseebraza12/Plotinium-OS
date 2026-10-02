import CornerDownLeft from 'lucide-solid/icons/corner-down-left';
import File from 'lucide-solid/icons/file';
import FileCode from 'lucide-solid/icons/file-code';
import FileImage from 'lucide-solid/icons/file-image';
import FileSpreadsheet from 'lucide-solid/icons/file-spreadsheet';
import FileText from 'lucide-solid/icons/file-text';
import Folder from 'lucide-solid/icons/folder';
import FolderSearch from 'lucide-solid/icons/folder-search';
import Search from 'lucide-solid/icons/search';
import Sparkles from 'lucide-solid/icons/sparkles';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  onCleanup,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';
import { Dynamic, Portal } from 'solid-js/web';

import { AppIcon, AtomLogo, type IconId } from '../../icons/index.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { trapTabKey } from '../../primitives/internal/focus.ts';
import { firstEnabled, lastEnabled, stepIndex } from '../../primitives/internal/list-nav.ts';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import { createModalLayer, createSettled, idPart } from '../internal/behaviour.ts';
import shared from '../internal/shared.module.css';
import { MatchText, percentOf, plural } from '../internal/text.tsx';
import styles from './SearchPalette.module.css';

/** Result sections, in display order. A section with no rows is hidden. */
export type SearchGroup = 'top' | 'semantic' | 'apps' | 'commands';
export type SearchResultKind = 'file' | 'app' | 'command';
export type SearchFileKind = 'document' | 'spreadsheet' | 'code' | 'image' | 'folder' | 'other';

export interface SearchResult {
  id: string;
  group: SearchGroup;
  kind: SearchResultKind;
  title: string;
  /** Files: the `path:line` citation (`~/finance/budget-2026-w38.csv:14`), RAG-06. */
  citation?: string;
  /** Files: the cited line, for the spoken name ("line 14"). */
  line?: number;
  /** A matching excerpt; `terms` are highlighted in it. */
  snippet?: string;
  terms?: readonly string[];
  /** 0..1 relevance (semantic matches); drawn as a bar and always printed as a percentage. */
  relevance?: number;
  /** Right-hand detail: `Edited 18 Sep`, `Application`, `Ask the AI agent · Terminal`. */
  meta?: string;
  /** Owner, shown when the file lives in another user's home (`alice`). */
  owner?: string;
  fileKind?: SearchFileKind;
  /** Apps: our app icon, and whether the app is running. */
  app?: IconId;
  running?: boolean;
  /** Not selectable, with the reason in text (`No permission`, `Needs the gateway — offline`). */
  disabled?: boolean;
  disabledReason?: string;
}

export type SearchPreviewLineStyle = 'h1' | 'h2' | 'body' | 'muted' | 'gap' | 'table';

export interface SearchPreviewLine {
  /** Source line number; omitted for a gap (`…`). */
  n?: number;
  text?: string;
  style?: SearchPreviewLineStyle;
  /** A cited line: accent rule and tint (and announced as "matched line"). */
  highlight?: boolean;
  /** `table` lines: rows of cells, the first row is the header. */
  cells?: readonly (readonly string[])[];
}

export interface SearchPreview {
  /** The result this preview belongs to; a preview for another result is ignored. */
  resultId: string;
  state: 'loading' | 'ready' | 'unavailable';
  title: string;
  /** `Markdown · 12 KB · owner student · modified 18 Sep 16:20`. */
  meta?: string;
  lines?: readonly SearchPreviewLine[];
  /** Unavailable: `No preview — 48 MB binary`, `You do not have permission to read this file · EACCES`. */
  message?: string;
  /** App and command previews. */
  description?: string;
  syntax?: string;
  note?: string;
}

export type SemanticState = 'on' | 'loading' | 'unavailable' | 'off';
export type SearchCloseReason = 'escape' | 'scrim';

export interface SearchStats {
  count: number;
  ms: number;
  /** `local index`, `keyword index`, `server`. */
  source: string;
}

export interface SearchPaletteProps {
  open: boolean;
  onClose: (reason: SearchCloseReason) => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: readonly SearchResult[];
  /** Preview of the active result, supplied after `onActiveChange`. */
  preview?: SearchPreview;
  /** The keyboard or pointer selection moved (load its preview). */
  onActiveChange?: (result: SearchResult | undefined) => void;
  /** Enter, double-click or the Open chip. The caller closes the palette. */
  onOpen: (result: SearchResult) => void;
  /** Ctrl+Enter (⌘↩ on a Mac keyboard) or the Reveal chip; files only. */
  onReveal?: (result: SearchResult) => void;
  /**
   * Hands a prompt to the agent in a Terminal (`ai "…"`), where the plan is still validated and
   * confirmed. Without it the AI mode and the Ask chip are hidden (AI-off build).
   */
  onAskAgent?: (prompt: string, about?: SearchResult) => void;
  /** AI mode (Tab): the field asks the agent instead of searching. Controlled. */
  aiMode?: boolean;
  onAiModeChange?: (on: boolean) => void;
  /** Semantic model state (RAG-06): loading and unavailable fall back to keyword matches. */
  semantic?: SemanticState;
  /** 0..1 while a query is in flight (keyword stage .5, semantic 1); undefined when idle. */
  progress?: number;
  /** No results yet for this query: static skeleton rows. */
  loading?: boolean;
  /** `Search failed — EIO. Showing keyword matches.` (role="alert"). */
  error?: string;
  /** Extra notice, e.g. `1 shared result hidden while offline`. */
  notice?: string;
  stats?: SearchStats;
  /** The modifier keycap for reveal: `Ctrl` (default) or `⌘` on a Mac keyboard. */
  modKey?: 'Ctrl' | '⌘';
  /**
   * What the palette can find. `apps` (no search provider in this session) says "Search apps",
   * hides the Semantic pill and the file hints, so it never promises what it cannot do (UI-046).
   * Default `all`.
   */
  scope?: 'all' | 'apps';
  /** Render inside the nearest positioned ancestor instead of a full-screen portal (gallery). */
  contained?: boolean;
  class?: string;
}

const GROUPS: readonly SearchGroup[] = ['top', 'semantic', 'apps', 'commands'];
/** RAG-05: a query over this many milliseconds shows its timing in the warning colour. */
export const SEARCH_BUDGET_MS = 500;

const FILE_ICON: Readonly<Record<SearchFileKind, typeof FileText>> = {
  document: FileText,
  spreadsheet: FileSpreadsheet,
  code: FileCode,
  image: FileImage,
  folder: Folder,
  other: File,
};
const FILE_TINT: Readonly<Record<SearchFileKind, string>> = {
  document: 'var(--pl-tint-indigo)',
  spreadsheet: 'var(--pl-tint-green)',
  code: 'var(--pl-tint-orange)',
  image: 'var(--pl-tint-pink)',
  folder: 'var(--pl-tint-blue)',
  other: 'var(--pl-tint-gray)',
};

function groupLabel(group: SearchGroup, semantic: SemanticState): string {
  switch (group) {
    case 'top':
      return 'Top hit';
    case 'semantic':
      return semantic === 'on' ? 'Semantic matches' : 'Keyword matches';
    case 'apps':
      return 'Apps';
    case 'commands':
      return 'Commands';
  }
}

/** The option's accessible name: title, where, and why it ranks (RAG-06 citations). */
export function spokenResult(result: SearchResult): string {
  const parts = [result.title];
  if (result.kind === 'file') {
    if (result.group === 'top') {
      if (result.citation !== undefined) parts.push(result.citation);
      parts.push('top hit');
    } else {
      if (result.line !== undefined) parts.push(`line ${result.line}`);
      else if (result.citation !== undefined) parts.push(result.citation);
      if (result.relevance !== undefined)
        parts.push(`relevance ${percentOf(result.relevance)} percent`);
    }
    if (result.owner !== undefined) parts.push(`owner ${result.owner}`);
  } else if (result.kind === 'app') {
    parts.push('application');
    if (result.running === true) parts.push('running');
  } else if (result.meta !== undefined) {
    parts.push(result.meta);
  }
  if (result.disabled === true) parts.push(result.disabledReason ?? 'unavailable');
  return parts.join(', ');
}

function Tile(props: { result: SearchResult; large?: boolean }): JSX.Element {
  const fileKind = (): SearchFileKind => props.result.fileKind ?? 'document';
  return (
    <span
      class={cx(
        styles.tile,
        props.large === true && styles.tileLarge,
        props.result.kind === 'command' && styles.tileCommand,
      )}
      style={{ '--pl-tile-tint': FILE_TINT[fileKind()] }}
      aria-hidden="true"
    >
      <Switch>
        <Match when={props.result.kind === 'app' && props.result.app}>
          {(app) => <AppIcon app={app()} size={props.large === true ? 40 : 28} />}
        </Match>
        <Match when={props.result.kind === 'command'}>
          <AppIcon app="terminal" size={props.large === true ? 40 : 28} />
        </Match>
        <Match when={props.result.kind === 'file'}>
          <Dynamic
            component={FILE_ICON[fileKind()]}
            size={props.large === true ? 20 : 15}
            stroke-width={1.9}
          />
        </Match>
      </Switch>
    </span>
  );
}

/**
 * The system-wide Search palette (RAG-05, RAG-06): a combobox over one grouped listbox (Top hit,
 * Semantic matches with `path:line` citations and relevance, Apps, Commands) and a preview of
 * the active result. Keyboard first: arrows and Home/End move, Enter opens, Ctrl+Enter reveals
 * in Files, Tab switches to AI mode, Escape closes. Opening springs in (scale + fade); running a
 * result plays a short "launch" exit. Presentational: the caller runs the query and supplies
 * results, preview and stats.
 */
export function SearchPalette(props: SearchPaletteProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'query',
    'onQueryChange',
    'results',
    'preview',
    'onActiveChange',
    'onOpen',
    'onReveal',
    'onAskAgent',
    'aiMode',
    'onAiModeChange',
    'semantic',
    'progress',
    'loading',
    'error',
    'notice',
    'stats',
    'modKey',
    'scope',
    'contained',
    'class',
  ]);
  const uid = createUniqueId();
  const listId = `pl-search-${uid}-list`;
  const appsOnly = (): boolean => local.scope === 'apps';
  const fieldLabel = (): string =>
    aiMode() ? 'Ask the agent' : appsOnly() ? 'Search apps' : 'Search files, apps and commands';
  const optionId = (id: string): string => `pl-search-${uid}-opt-${idPart(id)}`;
  const askOptionId = `pl-search-${uid}-ask`;
  let panel: HTMLDivElement | undefined;
  let list: HTMLDivElement | undefined;

  const [exit, setExit] = createSignal<'dismiss' | 'launch'>('dismiss');
  const close = (reason: SearchCloseReason): void => {
    setExit('dismiss');
    local.onClose(reason);
  };
  const presence = createModalLayer({
    open: () => local.open,
    panel: () => panel,
    exitMs: 160,
    onEscape: () => close('escape'),
  });

  const semantic = (): SemanticState => local.semantic ?? 'on';
  const aiAvailable = (): boolean => local.onAskAgent !== undefined;
  const aiMode = (): boolean => local.aiMode === true && aiAvailable();
  const modKey = (): 'Ctrl' | '⌘' => local.modKey ?? 'Ctrl';

  const groups = createMemo(() =>
    GROUPS.map((id) => ({ id, rows: local.results.filter((r) => r.group === id) })).filter(
      (g) => g.rows.length > 0,
    ),
  );
  /** Navigation order: sections top to bottom. */
  const ordered = createMemo(() => groups().flatMap((g) => g.rows));
  const hasQuery = (): boolean => local.query.trim() !== '';
  const isEmpty = (): boolean => local.loading !== true && hasQuery() && ordered().length === 0;
  const showSkeleton = (): boolean => local.loading === true && ordered().length === 0;
  const suggestAgent = (): boolean => isEmpty() && aiAvailable();

  // ---------- active option ----------
  const [activeId, setActiveId] = createSignal<string>();
  const disabledAt = (i: number): boolean => ordered()[i]?.disabled === true;
  createEffect(
    on(ordered, (rows) => {
      const current = rows.find((r) => r.id === activeId());
      if (current !== undefined && current.disabled !== true) return;
      const first = firstEnabled(rows.length, (i) => rows[i]?.disabled === true);
      setActiveId(first < 0 ? undefined : rows[first]?.id);
    }),
  );
  const active = createMemo(() => ordered().find((r) => r.id === activeId()));
  createEffect(on(active, (result) => local.onActiveChange?.(result)));
  const activeOptionId = (): string | undefined => {
    if (suggestAgent()) return askOptionId;
    const result = active();
    return result === undefined ? undefined : optionId(result.id);
  };

  const moveTo = (index: number): void => {
    const row = ordered()[index];
    if (row !== undefined && row.disabled !== true) setActiveId(row.id);
  };
  const move = (delta: 1 | -1): void => {
    const rows = ordered();
    const current = rows.findIndex((r) => r.id === activeId());
    if (current < 0) {
      moveTo(
        delta === 1 ? firstEnabled(rows.length, disabledAt) : lastEnabled(rows.length, disabledAt),
      );
      return;
    }
    moveTo(stepIndex(current, delta, rows.length, disabledAt, true));
  };

  // ---------- the sliding selection pill (one element, FLIP by transform) ----------
  const [pill, setPill] = createSignal<{ top: number; height: number }>();
  const [pillReady, setPillReady] = createSignal(false);
  /** One layout read per selection change, never on pointermove (P8). */
  const placePill = (): void => {
    const id = activeOptionId();
    const row =
      id === undefined ? null : (list?.querySelector<HTMLElement>(`[id="${id}"]`) ?? null);
    if (row === null) {
      setPill(undefined);
      return;
    }
    setPill({ top: row.offsetTop, height: row.offsetHeight });
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  };
  createEffect(
    on([activeOptionId, ordered, () => presence.mounted()], () => {
      placePill();
      // Re-measure once the frame is laid out (portal attach, section entrance), then let the
      // pill slide on later changes instead of flying in from the top on first paint.
      requestAnimationFrame(() => {
        placePill();
        setPillReady(presence.mounted());
      });
    }),
  );

  // ---------- actions ----------
  const openResult = (result: SearchResult | undefined): void => {
    if (result === undefined || result.disabled === true) return;
    setExit('launch');
    local.onOpen(result);
  };
  const reveal = (result: SearchResult | undefined): void => {
    if (result === undefined || result.kind !== 'file' || local.onReveal === undefined) return;
    setExit('launch');
    local.onReveal(result);
  };
  const ask = (about?: SearchResult): void => {
    if (local.onAskAgent === undefined) return;
    setExit('launch');
    local.onAskAgent(local.query.trim(), about);
  };
  const toggleAi = (): void => {
    if (!aiAvailable() || local.onAiModeChange === undefined) return;
    local.onAiModeChange(!aiMode());
  };

  // ---------- footer keycap feedback ----------
  const [pressed, setPressed] = createSignal<'enter' | 'reveal' | 'tab'>();
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  const flash = (key: 'enter' | 'reveal' | 'tab'): void => {
    clearTimeout(pressTimer);
    setPressed(key);
    pressTimer = setTimeout(() => setPressed(undefined), 160);
  };
  onCleanup(() => clearTimeout(pressTimer));

  const onFieldKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(firstEnabled(ordered().length, disabledAt));
        return;
      case 'End':
        event.preventDefault();
        moveTo(lastEnabled(ordered().length, disabledAt));
        return;
      case 'Enter': {
        if (event.isComposing) return;
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          flash('reveal');
          reveal(active());
          return;
        }
        flash('enter');
        if (aiMode() || suggestAgent()) {
          if (hasQuery()) ask();
          return;
        }
        openResult(active());
        return;
      }
      case 'Tab':
        if (event.shiftKey || !aiAvailable() || local.onAiModeChange === undefined) return;
        event.preventDefault();
        flash('tab');
        toggleAi();
        return;
      case 'Escape':
        // First Escape leaves AI mode; the next one closes (the layer skips a handled key).
        if (aiMode()) {
          event.preventDefault();
          toggleAi();
        }
        return;
      default:
        return;
    }
  };

  // ---------- announcements ----------
  const summary = (): string => {
    if (!hasQuery()) return '';
    if (local.loading === true) return 'Searching';
    const parts: string[] = [];
    if (isEmpty()) parts.push(`No results for "${local.query.trim()}"`);
    else parts.push(plural(local.stats?.count ?? ordered().length, 'result'));
    const fallback = semanticNotice();
    if (fallback !== undefined) parts.push(fallback);
    if (local.notice !== undefined) parts.push(local.notice);
    return parts.join('. ');
  };
  const announcement = createSettled(summary, 400);

  function semanticNotice(): string | undefined {
    if (semantic() === 'loading') return 'Semantic model loading — showing keyword matches';
    if (semantic() === 'unavailable')
      return 'Semantic search unavailable — showing keyword matches';
    return undefined;
  }

  const previewFor = (result: SearchResult): SearchPreview | undefined =>
    local.preview?.resultId === result.id ? local.preview : undefined;

  const layer = (): JSX.Element => (
    <div
      class={cx(styles.layer, local.contained === true && styles.contained, local.class)}
      data-state={presence.state()}
    >
      <div
        class={cx(
          styles.scrim,
          presence.state() === 'closing' ? 'pl-anim-scrim-out' : 'pl-anim-scrim-in',
        )}
        aria-hidden="true"
        onClick={() => close('scrim')}
      />
      <div
        ref={(el) => (panel = el)}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        class={cx(
          styles.panel,
          presence.state() === 'closing'
            ? exit() === 'launch'
              ? styles.launch
              : 'pl-anim-search-out'
            : 'pl-anim-search-in',
        )}
        onKeyDown={(event) => {
          if (panel !== undefined && !event.defaultPrevented) trapTabKey(event, panel);
        }}
      >
        {/* ---------- query field ---------- */}
        <div class={cx(styles.field, aiMode() && styles.fieldAi)}>
          <span class={styles.fieldIcon} aria-hidden="true">
            <Show when={aiMode()} fallback={<Search size={20} stroke-width={2} />}>
              <span class={styles.aiIcon}>
                <Sparkles size={20} stroke-width={2} />
              </span>
            </Show>
          </span>
          <input
            class={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId()}
            aria-label={fieldLabel()}
            aria-keyshortcuts="ArrowUp ArrowDown Enter Control+Enter Tab Escape"
            placeholder={aiMode() ? 'Ask the agent…' : fieldLabel()}
            autocomplete="off"
            spellcheck={false}
            data-autofocus
            value={local.query}
            onInput={(event) => local.onQueryChange(event.currentTarget.value)}
            onKeyDown={onFieldKeyDown}
          />
          <Show when={semantic() !== 'off' && (!appsOnly() || aiMode())}>
            <span
              class={styles.modePill}
              data-mode={aiMode() ? 'ai' : semantic() === 'on' ? 'semantic' : 'keyword'}
            >
              <span class={cx(styles.modeLabel, styles.modeSemantic)}>
                <Sparkles size={12} stroke-width={2.2} aria-hidden="true" />
                {aiMode() ? 'Agent' : 'Semantic'}
              </span>
              <span class={cx(styles.modeLabel, styles.modeKeyword)}>Keyword</span>
            </span>
          </Show>
          <button
            type="button"
            class={styles.escKey}
            aria-label="Close"
            title="Close"
            onClick={() => close('escape')}
          >
            esc
          </button>
          <span
            class={styles.progress}
            data-active={local.progress !== undefined ? 'true' : undefined}
            style={{ '--pl-progress-ratio': String(Math.min(1, Math.max(0, local.progress ?? 1))) }}
            aria-hidden="true"
          />
        </div>

        <div class={styles.body}>
          {/* ---------- results ---------- */}
          {/* The combobox scrolls it (the active option scrolls into view); it is also a tab stop
              (after the field, via Shift+Tab) so the list can be scrolled natively (WCAG 2.1.1). */}
          <div class={styles.results} tabindex={0} role="region" aria-label="Search results">
            <Show when={semanticNotice()}>
              {(text) => (
                <p class={styles.notice}>
                  <TriangleAlert size={13} stroke-width={2.2} aria-hidden="true" />
                  {text()}
                </p>
              )}
            </Show>
            <Show when={local.notice}>
              {(text) => <p class={cx(styles.notice, styles.noticeInfo)}>{text()}</p>}
            </Show>
            <Show when={local.error}>
              {(text) => (
                <p class={styles.error} role="alert">
                  <TriangleAlert size={13} stroke-width={2.2} aria-hidden="true" />
                  {text()}
                </p>
              )}
            </Show>
            <Show when={isEmpty()}>
              <div class={styles.empty}>
                <span class={styles.emptyMark} aria-hidden="true">
                  <AtomLogo size={40} />
                </span>
                <p class={styles.emptyTitle}>No results for “{local.query.trim()}”</p>
                <Show when={!aiAvailable()}>
                  <p class={styles.emptyHint}>
                    {appsOnly() ? 'Try another app name.' : 'Try fewer words, or a file name.'}
                  </p>
                </Show>
              </div>
            </Show>
            <Show when={showSkeleton()}>
              <div class={styles.skeleton} aria-hidden="true">
                <For each={[0, 1, 2, 3, 4]}>
                  {(i) => (
                    <div class={styles.skeletonRow}>
                      <span class={styles.skeletonTile} />
                      <span class={styles.skeletonLines}>
                        <span class={styles.skeletonLine} style={{ width: `${62 - i * 6}%` }} />
                        <span class={styles.skeletonLineShort} />
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div
              ref={(el) => (list = el)}
              id={listId}
              role="listbox"
              aria-label={aiMode() ? 'Agent suggestions' : 'Results'}
              class={styles.list}
              onMouseDown={(event) => event.preventDefault()}
            >
              <div
                class={styles.pill}
                data-visible={pill() !== undefined ? 'true' : undefined}
                data-ready={pillReady() ? 'true' : undefined}
                style={{
                  transform: `translateY(${pill()?.top ?? 0}px)`,
                  height: `${pill()?.height ?? 0}px`,
                }}
                aria-hidden="true"
              />
              <Show when={suggestAgent()}>
                <div
                  id={askOptionId}
                  role="option"
                  aria-selected="true"
                  class={cx(styles.row, styles.askRow)}
                  data-active="true"
                  onClick={() => ask()}
                >
                  <span class={cx(styles.tile, styles.tileAi)} aria-hidden="true">
                    <Sparkles size={15} stroke-width={2.2} />
                  </span>
                  <span class={styles.main}>
                    <span class={styles.titleLine}>
                      <span class={styles.title}>Ask the agent:</span>
                      <code class={styles.command}>ai "{local.query.trim()}"</code>
                    </span>
                  </span>
                  <span class={styles.meta}>
                    <Kbd keys={['⇥']} decorative />
                  </span>
                </div>
              </Show>
              <For each={groups()}>
                {(group, groupIndex) => (
                  <div
                    role="group"
                    aria-labelledby={`pl-search-${uid}-g-${group.id}`}
                    class={styles.group}
                    style={{ '--pl-stagger-index': String(Math.min(groupIndex(), 3)) }}
                  >
                    <div class={styles.groupLabel} id={`pl-search-${uid}-g-${group.id}`}>
                      {groupLabel(group.id, semantic())}
                    </div>
                    <For each={group.rows}>
                      {(result, rowIndex) => (
                        <div
                          id={optionId(result.id)}
                          role="option"
                          aria-selected={result.id === activeId() ? 'true' : 'false'}
                          aria-disabled={result.disabled === true ? 'true' : undefined}
                          aria-label={spokenResult(result)}
                          class={cx(
                            styles.row,
                            result.group === 'top' && styles.topRow,
                            result.kind === 'command' && styles.commandRow,
                          )}
                          data-active={result.id === activeId() ? 'true' : undefined}
                          onClick={() => {
                            if (result.disabled !== true) setActiveId(result.id);
                          }}
                          onDblClick={() => openResult(result)}
                        >
                          <Tile result={result} />
                          <span class={styles.main}>
                            <span class={styles.titleLine}>
                              <span
                                class={cx(
                                  styles.title,
                                  result.kind === 'command' && styles.commandTitle,
                                )}
                              >
                                {result.title}
                              </span>
                              <Show when={result.owner}>
                                {(owner) => <span class={styles.owner}>{owner()}</span>}
                              </Show>
                              <Show when={result.running === true}>
                                <span class={styles.running}>
                                  <span class={styles.runningDot} aria-hidden="true" />
                                  running
                                </span>
                              </Show>
                            </span>
                            <Show when={result.citation}>
                              {(citation) => <span class={styles.citation}>{citation()}</span>}
                            </Show>
                            <Show when={result.snippet}>
                              {(snippet) => (
                                <span class={styles.snippet}>
                                  <MatchText
                                    text={snippet()}
                                    terms={result.terms}
                                    markClass={styles.mark}
                                  />
                                </span>
                              )}
                            </Show>
                            <Show when={result.disabled === true}>
                              <span class={styles.disabledReason}>
                                {result.disabledReason ?? 'Unavailable'}
                              </span>
                            </Show>
                          </span>
                          <Show
                            when={result.relevance}
                            fallback={
                              <Show when={result.meta}>
                                {(meta) => <span class={styles.meta}>{meta()}</span>}
                              </Show>
                            }
                          >
                            {(relevance) => (
                              <span class={styles.relevance}>
                                <span class={styles.bar}>
                                  <span
                                    class={styles.fill}
                                    style={{
                                      '--pl-relevance': String(relevance()),
                                      '--pl-stagger-index': String(rowIndex()),
                                    }}
                                  />
                                </span>
                                <span class={styles.percent}>{percentOf(relevance())}%</span>
                              </span>
                            )}
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* ---------- preview ---------- */}
          <div class={styles.previewPane}>
            <Show keyed when={active()}>
              {(result) => (
                <SearchPreviewPane
                  result={result}
                  preview={previewFor(result)}
                  modKey={modKey()}
                  onOpen={() => openResult(result)}
                  onReveal={local.onReveal === undefined ? undefined : () => reveal(result)}
                  onAsk={aiAvailable() ? () => ask(result) : undefined}
                />
              )}
            </Show>
          </div>
        </div>

        {/* ---------- footer ---------- */}
        <footer class={styles.footer}>
          <span class={styles.hints}>
            <span class={styles.hint} data-pressed={pressed() === 'enter' ? 'true' : undefined}>
              <Kbd keys={['↵']} />
              {aiMode() ? 'ask' : 'open'}
            </span>
            {/* Reveal applies to files only: no "reveal in Files" hint on an app (UI-046). */}
            <Show when={local.onReveal !== undefined && active()?.kind === 'file'}>
              <span class={styles.hintSep} aria-hidden="true">
                ·
              </span>
              <span class={styles.hint} data-pressed={pressed() === 'reveal' ? 'true' : undefined}>
                <Kbd keys={[modKey(), '↵']} />
                reveal in Files
              </span>
            </Show>
            <Show when={aiAvailable()}>
              <span class={styles.hintSep} aria-hidden="true">
                ·
              </span>
              <span class={styles.hint} data-pressed={pressed() === 'tab' ? 'true' : undefined}>
                <Kbd keys={['⇥']} />
                {aiMode() ? 'search mode' : 'ai mode'}
              </span>
            </Show>
          </span>
          <Show when={local.stats}>
            {(stats) => (
              <span
                class={styles.stats}
                data-slow={stats().ms > SEARCH_BUDGET_MS ? 'true' : undefined}
              >
                <span class={styles.statsDot} aria-hidden="true" />
                {plural(stats().count, 'result')} · {Math.round(stats().ms)} ms · {stats().source}
              </span>
            )}
          </Show>
        </footer>
        <div class={shared.srOnly} role="status" aria-live="polite">
          {announcement()}
        </div>
      </div>
    </div>
  );

  return (
    <Show when={presence.mounted()}>
      <Show when={local.contained === true} fallback={<Portal>{layer()}</Portal>}>
        {layer()}
      </Show>
    </Show>
  );
}

/** An app result's preview line when the host gives none: what Open will do. */
function appDescription(result: SearchResult): string | undefined {
  if (result.kind !== 'app') return result.meta;
  return result.running === true
    ? `${result.title} is running. Open brings its window to the front or opens a new one.`
    : `Open starts ${result.title}.`;
}

interface PreviewPaneProps {
  result: SearchResult;
  preview: SearchPreview | undefined;
  modKey: string;
  onOpen: () => void;
  onReveal: (() => void) | undefined;
  onAsk: (() => void) | undefined;
}

function SearchPreviewPane(props: PreviewPaneProps): JSX.Element {
  const title = (): string => props.preview?.title ?? props.result.title;
  const state = (): SearchPreview['state'] => props.preview?.state ?? 'loading';
  return (
    <section class={styles.preview} aria-label={`Preview of ${title()}`}>
      <header class={styles.previewHeader}>
        <Tile result={props.result} large />
        <div class={styles.previewHeadings}>
          <h2 class={styles.previewTitle}>{title()}</h2>
          <p class={styles.previewMeta}>
            {props.preview?.meta ?? props.result.citation ?? props.result.meta ?? ''}
          </p>
        </div>
      </header>

      <Switch>
        <Match when={props.result.kind !== 'file'}>
          <div class={cx(styles.previewCard, styles.previewCompact)}>
            <Show when={props.preview?.description ?? appDescription(props.result)}>
              {(text) => <p class={styles.previewText}>{text()}</p>}
            </Show>
            <Show when={props.preview?.syntax}>
              {(syntax) => <pre class={styles.previewSyntax}>{syntax()}</pre>}
            </Show>
            <Show when={props.preview?.note}>
              {(note) => <p class={styles.previewNote}>{note()}</p>}
            </Show>
          </div>
        </Match>
        <Match when={state() === 'loading'}>
          <div class={cx(styles.previewCard, styles.previewLoading)} aria-busy="true">
            <For each={[78, 54, 90, 66, 40, 72]}>
              {(width) => <span class={styles.skeletonLine} style={{ width: `${width}%` }} />}
            </For>
            <span class={shared.srOnly}>Loading preview</span>
          </div>
        </Match>
        <Match when={state() === 'unavailable'}>
          <div class={cx(styles.previewCard, styles.previewUnavailable)}>
            <FileText size={28} stroke-width={1.5} aria-hidden="true" />
            <p>{props.preview?.message ?? 'No preview available'}</p>
          </div>
        </Match>
        <Match when={state() === 'ready'}>
          <ol class={styles.previewCard}>
            <For each={props.preview?.lines ?? []}>
              {(line) => (
                <li
                  class={cx(
                    styles.line,
                    line.style !== undefined && styles[`line-${line.style}`],
                    line.highlight === true && styles.lineHit,
                  )}
                >
                  <span class={styles.lineNo} aria-hidden="true">
                    {line.style === 'gap' ? '…' : (line.n ?? '')}
                  </span>
                  <Show
                    when={line.style === 'table' && line.cells}
                    fallback={
                      <span class={styles.lineText}>
                        <Show when={line.highlight === true}>
                          <span class={shared.srOnly}>Matched line {line.n}: </span>
                        </Show>
                        <MatchText
                          text={line.text ?? ''}
                          terms={line.highlight === true ? props.result.terms : undefined}
                          markClass={styles.mark}
                        />
                      </span>
                    }
                  >
                    {(cells) => (
                      <table class={styles.previewTable}>
                        <tbody>
                          <For each={cells()}>
                            {(row, rowIndex) => (
                              <tr>
                                <For each={row}>
                                  {(cell) => (
                                    <Show when={rowIndex() === 0} fallback={<td>{cell}</td>}>
                                      <th scope="col">{cell}</th>
                                    </Show>
                                  )}
                                </For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Match>
      </Switch>

      <div class={styles.actions}>
        <Button
          variant="primary"
          icon={<CornerDownLeft size={14} stroke-width={2.2} />}
          aria-keyshortcuts="Enter"
          disabled={props.result.disabled === true}
          onClick={() => props.onOpen()}
        >
          Open
        </Button>
        <Show when={props.result.kind === 'file' && props.onReveal}>
          {(onReveal) => (
            <Button
              icon={<FolderSearch size={14} stroke-width={2} />}
              aria-keyshortcuts={props.modKey === '⌘' ? 'Meta+Enter' : 'Control+Enter'}
              onClick={() => onReveal()()}
            >
              Reveal in Files
            </Button>
          )}
        </Show>
        <Show when={props.result.kind === 'file' && props.onAsk}>
          {(onAsk) => (
            <Button icon={<Sparkles size={14} stroke-width={2} />} onClick={() => onAsk()()}>
              Ask AI about this
            </Button>
          )}
        </Show>
      </div>
    </section>
  );
}
