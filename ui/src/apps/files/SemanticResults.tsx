import CircleCheck from 'lucide-solid/icons/circle-check';
import CircleX from 'lucide-solid/icons/circle-x';
import Info from 'lucide-solid/icons/info';
import RotateCw from 'lucide-solid/icons/rotate-cw';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import WifiOff from 'lucide-solid/icons/wifi-off';
import {
  createMemo,
  createUniqueId,
  For,
  Index,
  Match,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';

import { AtomLogo } from '../../icons/index.tsx';
import { Avatar } from '../../primitives/avatar/Avatar.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { EmptyState } from '../../primitives/empty-state/EmptyState.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { ProgressRing } from '../../primitives/progress/ProgressRing.tsx';
import { FileIcon } from './FileIcon.tsx';
import { citation, highlightRuns } from './format.ts';
import styles from './SemanticResults.module.css';
import type { SearchMode, SearchNotice, SemanticHit } from './types.ts';

/** Exact notice strings (rag-semantic-search.md §3.5, RAG-06; files notes). */
export function noticeText(notice: SearchNotice): string {
  switch (notice.kind) {
    case 'model-loading':
      return 'semantic model loading — showing keyword matches';
    case 'model-ready':
      return 'Semantic ready';
    case 'unavailable':
      return 'Semantic search unavailable — showing keyword matches';
    case 'shared-hidden':
      return `${notice.count} shared ${notice.count === 1 ? 'result' : 'results'} hidden while offline`;
    case 'truncated':
      return 'Query shortened to 512 tokens';
  }
}

/** Spoken name of a result card. */
export function hitLabel(hit: SemanticHit): string {
  const lines =
    hit.lineEnd > hit.lineStart
      ? `line ${hit.lineStart} to ${hit.lineEnd}`
      : `line ${hit.lineStart}`;
  const parts = [
    hit.name,
    `${hit.path} ${lines}`,
    `score ${hit.score.toFixed(2)}`,
    `owner ${hit.owner}`,
  ];
  if (hit.verified === 'server') parts.push('shared, verified');
  if (hit.stale === true) parts.push('updating');
  return parts.join(', ');
}

export interface SearchError {
  /** errno, e.g. EACCES or EIO. */
  code: string;
  message: string;
}

export interface SemanticResultsProps {
  mode: SearchMode;
  hits: readonly SemanticHit[];
  /** Folder name the search covered ("notes"). */
  scope: string;
  elapsedMs?: number;
  notices?: readonly SearchNotice[];
  selected?: string;
  onSelect: (id: string) => void;
  /** Enter or double-click: open in Editor at lineStart. */
  onOpen: (hit: SemanticHit) => void;
  /** Results take longer than 150 ms: static skeleton cards. */
  loading?: boolean;
  error?: SearchError;
  onRetry?: () => void;
  onSearchAll?: () => void;
  onTryKeyword?: () => void;
  /** Id for the search box's aria-controls. */
  listId?: string;
  class?: string;
}

/** Relevance as a meter: bar plus the number, so length is never the only cue. */
function Relevance(props: { score: number; stale?: boolean }): JSX.Element {
  const pct = (): number => Math.round(Math.min(1, Math.max(0, props.score)) * 100);
  return (
    <div class={cx(styles.relevance, props.stale === true && styles.stale)}>
      <div
        role="meter"
        aria-label="Relevance"
        aria-valuenow={props.score}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuetext={`${pct()} percent relevant`}
        class={styles.meter}
      >
        <span class={styles.meterFill} style={{ '--score': String(pct() / 100) }} />
      </div>
      <span class={styles.score} aria-hidden="true">
        {props.score.toFixed(2)}
      </span>
    </div>
  );
}

function NoticeChip(props: { notice: SearchNotice }): JSX.Element {
  const failed = (): boolean => props.notice.kind === 'unavailable';
  return (
    <div class={styles.chip} data-kind={props.notice.kind} role={failed() ? 'alert' : undefined}>
      <Switch>
        <Match when={props.notice.kind === 'model-loading' ? props.notice : undefined}>
          {(loading) => (
            <ProgressRing
              value={Math.round(loading().progress * 100)}
              label="Loading search model"
              valueText={`Loading search model, ${Math.round(loading().progress * 100)} percent`}
              size={14}
              thickness={2}
              tone="warning"
            />
          )}
        </Match>
        <Match when={props.notice.kind === 'model-ready'}>
          <CircleCheck size={14} stroke-width={2.2} aria-hidden="true" class={styles.popIcon} />
        </Match>
        <Match when={props.notice.kind === 'unavailable'}>
          <CircleX size={14} stroke-width={2.2} aria-hidden="true" />
        </Match>
        <Match when={props.notice.kind === 'shared-hidden'}>
          <WifiOff size={14} stroke-width={2.2} aria-hidden="true" />
        </Match>
        <Match when={props.notice.kind === 'truncated'}>
          <Info size={14} stroke-width={2.2} aria-hidden="true" />
        </Match>
      </Switch>
      <span>{noticeText(props.notice)}</span>
    </div>
  );
}

/**
 * Semantic results (RAG-06, VFS-07): a header with the count, scope and time; notice chips in
 * a polite live region (the failure is an alert); and ranked cards in a listbox that keeps
 * focus on itself (aria-activedescendant). Each card shows the citation `path:start-end`, the
 * snippet with its matches marked (text nodes only), the relevance as a meter with its number,
 * and the owner. Up/Down move, Enter opens the file in Editor at the cited line.
 */
export function SemanticResults(props: SemanticResultsProps): JSX.Element {
  const [local] = splitProps(props, [
    'mode',
    'hits',
    'scope',
    'elapsedMs',
    'notices',
    'selected',
    'onSelect',
    'onOpen',
    'loading',
    'error',
    'onRetry',
    'onSearchAll',
    'onTryKeyword',
    'listId',
    'class',
  ]);
  const uid = createUniqueId();
  const listId = (): string => local.listId ?? `pl-sem-${uid}`;
  const optionId = (id: string): string => `${listId()}-${id}`;
  const index = createMemo(() => local.hits.findIndex((h) => h.id === local.selected));
  const title = (): string => (local.mode === 'semantic' ? 'Semantic results' : 'Keyword results');
  const subtitle = (): string => {
    const count = local.hits.length;
    const files = `${count} ${count === 1 ? 'file' : 'files'} in ${local.scope}`;
    return local.elapsedMs === undefined ? files : `${files} · ${Math.round(local.elapsedMs)} ms`;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const hits = local.hits;
    if (hits.length === 0) return;
    const current = index();
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(hits.length - 1, current + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, current < 0 ? 0 : current - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = hits.length - 1;
        break;
      case 'Enter': {
        const hit = hits[current < 0 ? 0 : current];
        if (hit !== undefined) local.onOpen(hit);
        event.preventDefault();
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    const hit = hits[next];
    if (hit === undefined) return;
    local.onSelect(hit.id);
    document.getElementById(optionId(hit.id))?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <section class={cx(styles.results, local.class)} aria-labelledby={`${listId()}-title`}>
      <header class={styles.header}>
        <div class={styles.titles}>
          <h2 id={`${listId()}-title`} class={styles.title}>
            {title()}
          </h2>
          <Show when={local.loading !== true && local.error === undefined}>
            <p class={styles.subtitle}>{subtitle()}</p>
          </Show>
        </div>
        <div class={styles.chips} role="status" aria-live="polite">
          <For each={local.notices ?? []}>{(notice) => <NoticeChip notice={notice} />}</For>
        </div>
      </header>

      <Switch>
        <Match when={local.error}>
          {(error) => (
            <div class={styles.error} role="alert">
              <CircleX size={16} stroke-width={2.2} aria-hidden="true" />
              <span>
                {error().message} <span class={styles.errno}>({error().code})</span>
              </span>
              <Show when={local.onRetry}>
                <Button
                  size="sm"
                  icon={<RotateCw size={13} stroke-width={2.2} />}
                  onClick={() => local.onRetry?.()}
                >
                  Retry
                </Button>
              </Show>
            </div>
          )}
        </Match>
        <Match when={local.loading === true}>
          <div class={styles.list} aria-busy="true" aria-label={`${title()}, loading`}>
            <Index each={Array.from({ length: 4 })}>
              {() => (
                <div class={cx(styles.card, styles.skeletonCard)} aria-hidden="true">
                  <span class={styles.skeletonLine} />
                  <span class={cx(styles.skeletonLine, styles.skeletonShort)} />
                  <span class={styles.skeletonLine} />
                </div>
              )}
            </Index>
          </div>
        </Match>
        <Match when={local.hits.length === 0}>
          <EmptyState
            live
            icon={<AtomLogo size={48} class={styles.emptyMark} />}
            title={`No matches in ${local.scope}`}
            description="Try a broader question, or search every folder you can read."
            actions={
              <>
                <Show when={local.onSearchAll}>
                  <Button size="sm" onClick={() => local.onSearchAll?.()}>
                    Search all of Home
                  </Button>
                </Show>
                <Show when={local.onTryKeyword}>
                  <Button size="sm" variant="ghost" onClick={() => local.onTryKeyword?.()}>
                    Try keyword search
                  </Button>
                </Show>
              </>
            }
          />
        </Match>
        <Match when={local.hits.length > 0}>
          <div
            id={listId()}
            role="listbox"
            tabindex={0}
            aria-label={title()}
            aria-activedescendant={
              local.selected === undefined ? undefined : optionId(local.selected)
            }
            class={styles.list}
            onKeyDown={onKeyDown}
          >
            <For each={local.hits}>
              {(hit, i) => (
                <div
                  id={optionId(hit.id)}
                  role="option"
                  aria-selected={hit.id === local.selected}
                  aria-label={hitLabel(hit)}
                  class={cx(styles.card, hit.stale === true && styles.cardStale)}
                  style={{ '--pl-stagger-index': String(Math.min(i(), 6)) }}
                  onClick={() => local.onSelect(hit.id)}
                  onDblClick={() => local.onOpen(hit)}
                >
                  <span class={styles.cardIcon}>
                    <FileIcon entry={{ type: 'file', name: hit.name }} size={20} />
                  </span>
                  <div class={styles.cardMain}>
                    <div class={styles.cardTop}>
                      <span class={styles.name}>{hit.name}</span>
                      <span class={styles.citation}>
                        {citation(hit.path, hit.lineStart, hit.lineEnd)}
                      </span>
                      <Show when={hit.verified === 'server'}>
                        <span class={styles.verified}>
                          <ShieldCheck size={11} stroke-width={2.4} aria-hidden="true" />
                          Shared · verified
                        </span>
                      </Show>
                      <Show when={hit.stale === true}>
                        <span class={styles.updating}>Updating…</span>
                      </Show>
                    </div>
                    <p class={styles.snippet}>
                      <For each={highlightRuns(hit.snippet, hit.highlights)}>
                        {(run) => (
                          <Show when={run.mark} fallback={run.text}>
                            <mark class={styles.mark}>{run.text}</mark>
                          </Show>
                        )}
                      </For>
                    </p>
                  </div>
                  <div class={styles.cardSide}>
                    <Relevance score={hit.score} stale={hit.stale} />
                    <span class={styles.owner}>
                      <Avatar name={hit.owner} size="sm" decorative />
                      {hit.owner}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Match>
      </Switch>
    </section>
  );
}
