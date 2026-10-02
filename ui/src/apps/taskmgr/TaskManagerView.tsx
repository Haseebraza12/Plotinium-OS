import Cpu from 'lucide-solid/icons/cpu';
import ListOrdered from 'lucide-solid/icons/list-ordered';
import MemoryStick from 'lucide-solid/icons/memory-stick';
import Pause from 'lucide-solid/icons/pause';
import Play from 'lucide-solid/icons/play';
import Sparkles from 'lucide-solid/icons/sparkles';
import {
  createMemo,
  createSignal,
  Match,
  Show,
  splitProps,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import { SearchField } from '../../primitives/search-field/SearchField.tsx';
import {
  SegmentedControl,
  type SegmentOption,
} from '../../primitives/segmented-control/SegmentedControl.tsx';
import type { SortState } from '../../primitives/table/Table.tsx';
import { AiPanel } from './AiPanel.tsx';
import { canEnd, formatCount, matchesQuery } from './format.ts';
import { MemoryPanel } from './MemoryPanel.tsx';
import type {
  AiModel,
  MemoryModel,
  PerformanceModel,
  PredictionsModel,
  ProcessRow,
  ProcessSignal,
  ProcessSummary,
  SchedulerModel,
  TaskManagerTab,
} from './models.ts';
import { EndProcessButton, KillDialog, ReniceButton, type KillRequest } from './ProcessActions.tsx';
import { ProcessesPanel, type RowAction } from './ProcessesPanel.tsx';
import { SchedulerPanel } from './SchedulerPanel.tsx';
import styles from './TaskManagerView.module.css';

export const TASK_MANAGER_TABS: readonly SegmentOption<TaskManagerTab>[] = [
  { value: 'processes', label: 'Processes', icon: ListOrdered },
  { value: 'memory', label: 'Memory', icon: MemoryStick },
  { value: 'scheduler', label: 'Scheduler', icon: Cpu },
  { value: 'ai', label: 'AI', icon: Sparkles },
];

export type SettingsLink = 'memory' | 'scheduler' | 'privacy-ai';

export interface TaskManagerViewProps {
  /** Selected tab (controlled); without it the view keeps its own. */
  tab?: TaskManagerTab;
  onTabChange?: (tab: TaskManagerTab) => void;
  processes: readonly ProcessRow[];
  summary: ProcessSummary;
  performance: PerformanceModel;
  memory: MemoryModel;
  predictions: PredictionsModel;
  scheduler: SchedulerModel;
  ai: AiModel;
  /** Live updates paused (controlled); pausing stops every live-data motion (WCAG 2.2.2). */
  paused?: boolean;
  onPauseChange?: (paused: boolean) => void;
  version: string;
  build: string;
  /** Root may set a negative nice. */
  isRoot?: boolean;
  /** A signal is in flight for this pid ("Ending…"). */
  pendingPid?: number;
  reniceError?: string;
  loading?: boolean;
  /** "Kernel not responding · last update 6 s ago". */
  stale?: string;
  /** Hide the AI tab (AI-off build). */
  aiAvailable?: boolean;
  /** Leave room for the window's traffic lights at the top-left (unified chrome). Default true. */
  chromeInset?: boolean;
  /** Row selected when the view mounts (uncontrolled), e.g. the process a notification named. */
  defaultSelectedPid?: number;
  onSignal: (pid: number, signal: ProcessSignal) => void;
  onRenice: (pid: number, nice: number) => void;
  onPinChange: (pid: number, pinned: boolean) => void;
  onReclaim: () => void;
  onCopy?: (text: string) => void;
  onOpenSettings?: (section: SettingsLink) => void;
  onOpenLog?: () => void;
  onRestartPredictor?: () => void;
  class?: string;
}

const TAB_ORDER: readonly TaskManagerTab[] = ['processes', 'memory', 'scheduler', 'ai'];

/**
 * The Task Manager window content (unified chrome): a toolbar that is also the drag region,
 * with the Processes | Memory | Scheduler | AI segmented control, the process actions and the
 * search field; the selected panel; and a status bar with the live-update pause.
 */
export function TaskManagerView(props: TaskManagerViewProps): JSX.Element {
  const [local] = splitProps(props, [
    'tab',
    'onTabChange',
    'processes',
    'summary',
    'performance',
    'memory',
    'predictions',
    'scheduler',
    'ai',
    'paused',
    'onPauseChange',
    'version',
    'build',
    'isRoot',
    'pendingPid',
    'reniceError',
    'loading',
    'stale',
    'aiAvailable',
    'chromeInset',
    'defaultSelectedPid',
    'onSignal',
    'onRenice',
    'onPinChange',
    'onReclaim',
    'onCopy',
    'onOpenSettings',
    'onOpenLog',
    'onRestartPredictor',
    'class',
  ]);
  const [ownTab, setOwnTab] = createSignal<TaskManagerTab>('processes');
  const [ownPaused, setOwnPaused] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [sort, setSort] = createSignal<SortState>({ column: 'cpu', direction: 'descending' });
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    untrack(() =>
      local.defaultSelectedPid === undefined
        ? new Set()
        : new Set([String(local.defaultSelectedPid)]),
    ),
  );
  const [kill, setKill] = createSignal<KillRequest | null>(null);
  const [direction, setDirection] = createSignal<'forward' | 'back'>('forward');
  const [reniceOpen, setReniceOpen] = createSignal(false);
  let search: HTMLInputElement | undefined;

  const tab = (): TaskManagerTab => local.tab ?? ownTab();
  const paused = (): boolean => local.paused ?? ownPaused();
  const tabs = createMemo(() =>
    TASK_MANAGER_TABS.filter((t) => t.value !== 'ai' || local.aiAvailable !== false),
  );

  const changeTab = (next: TaskManagerTab): void => {
    setDirection(TAB_ORDER.indexOf(next) >= TAB_ORDER.indexOf(tab()) ? 'forward' : 'back');
    setOwnTab(next);
    local.onTabChange?.(next);
  };
  const setPaused = (next: boolean): void => {
    setOwnPaused(next);
    local.onPauseChange?.(next);
  };

  const filtered = createMemo(() => local.processes.filter((r) => matchesQuery(r, query())));
  const target = createMemo(() => {
    const id = [...selected()][0];
    return id === undefined ? undefined : local.processes.find((r) => String(r.pid) === id);
  });
  const selectedName = (): string =>
    target() === undefined ? '' : `${target()?.name ?? ''}, pid ${target()?.pid ?? ''}`;

  const requestEnd = (row: ProcessRow, signal: KillRequest['signal']): void => {
    if (canEnd(row)) setKill({ pid: row.pid, name: row.name, signal });
  };

  const onRowAction = (action: RowAction, row: ProcessRow): void => {
    switch (action) {
      case 'end':
        requestEnd(row, 'SIGTERM');
        break;
      case 'kill':
        requestEnd(row, 'SIGKILL');
        break;
      case 'suspend':
        local.onSignal(row.pid, 'SIGSTOP');
        break;
      case 'renice':
        setReniceOpen(true);
        break;
      case 'memory':
        changeTab('memory');
        break;
      case 'copy-pid':
        local.onCopy?.(String(row.pid));
        break;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const el = event.target;
    const typing =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      search?.focus();
      return;
    }
    if (typing || event.defaultPrevented) return;
    const row = target();
    if (
      event.key === 'Delete' &&
      row !== undefined &&
      (tab() === 'processes' || tab() === 'memory')
    ) {
      event.preventDefault();
      requestEnd(row, 'SIGTERM');
    } else if (
      (event.key === 'p' || event.key === 'P') &&
      tab() === 'memory' &&
      row !== undefined
    ) {
      const mem = local.memory.processes.find((r) => r.pid === row.pid);
      if (
        mem !== undefined &&
        mem.pinLocked !== true &&
        local.memory.pinUnavailable === undefined
      ) {
        event.preventDefault();
        local.onPinChange(mem.pid, !mem.pinned);
      }
    }
  };

  const showsProcessTools = (): boolean => tab() === 'processes' || tab() === 'memory';

  return (
    <div
      class={cx(styles.view, local.chromeInset !== false && styles.inset, local.class)}
      data-testid="task-manager"
      onKeyDown={onKeyDown}
    >
      <header class={styles.toolbar} data-pl-drag-region>
        <div class={styles.lead}>
          <span class={styles.title}>Task Manager</span>
        </div>
        <SegmentedControl
          class={styles.tabs}
          label="Task Manager view"
          options={tabs()}
          value={tab()}
          onChange={changeTab}
        />
        <div class={styles.tools} role="group" aria-label="Process actions">
          <Show when={showsProcessTools()}>
            <EndProcessButton
              target={target()}
              pending={local.pendingPid !== undefined && local.pendingPid === target()?.pid}
              onSignal={(pid, signal) => local.onSignal(pid, signal)}
              onRequestKill={setKill}
            />
            <Show when={tab() === 'processes'}>
              <ReniceButton
                open={reniceOpen()}
                onOpenChange={setReniceOpen}
                target={target()}
                mayRaise={local.isRoot}
                error={local.reniceError}
                onRenice={(pid, nice) => local.onRenice(pid, nice)}
              />
            </Show>
            <SearchField
              class={styles.search}
              label="Search processes"
              placeholder={tab() === 'memory' ? 'Filter processes' : 'Search processes'}
              value={query()}
              onInput={setQuery}
              inputRef={(el) => (search = el)}
              trailing={
                <Show when={query() === ''}>
                  <Kbd keys={['/']} decorative />
                </Show>
              }
            />
          </Show>
        </div>
      </header>

      <div class={styles.announcer} role="status" aria-live="polite">
        <Show when={query() !== '' && showsProcessTools()}>
          {formatCount(filtered().length)}{' '}
          {filtered().length === 1 ? 'process matches' : 'processes match'}
        </Show>
      </div>

      <Show keyed when={tab()}>
        {(current) => (
          <section
            class={styles.content}
            data-dir={direction()}
            aria-label={TASK_MANAGER_TABS.find((t) => t.value === current)?.label}
          >
            <Switch>
              <Match when={current === 'processes'}>
                <ProcessesPanel
                  rows={filtered()}
                  totalRows={local.processes.length}
                  summary={local.summary}
                  performance={local.performance}
                  sort={sort()}
                  onSortChange={setSort}
                  selected={selected()}
                  onSelectionChange={setSelected}
                  query={query()}
                  onClearQuery={() => {
                    setQuery('');
                    search?.focus();
                  }}
                  onRowAction={onRowAction}
                  live={!paused()}
                  loading={local.loading}
                  stale={local.stale}
                />
              </Match>
              <Match when={current === 'memory'}>
                <MemoryPanel
                  memory={local.memory}
                  predictions={local.predictions}
                  query={query()}
                  selected={selected()}
                  onSelectionChange={setSelected}
                  onReclaim={() => local.onReclaim()}
                  onPinChange={(pid, pinned) => local.onPinChange(pid, pinned)}
                  onOpenSettings={() => local.onOpenSettings?.('privacy-ai')}
                  onRestartPredictor={() => local.onRestartPredictor?.()}
                  live={!paused()}
                />
              </Match>
              <Match when={current === 'scheduler'}>
                <SchedulerPanel
                  scheduler={local.scheduler}
                  onOpenSettings={
                    local.onOpenSettings === undefined
                      ? undefined
                      : () => local.onOpenSettings?.('scheduler')
                  }
                />
              </Match>
              <Match when={current === 'ai'}>
                <AiPanel
                  ai={local.ai}
                  onOpenLog={() => local.onOpenLog?.()}
                  onOpenSettings={
                    local.onOpenSettings === undefined
                      ? undefined
                      : () => local.onOpenSettings?.('privacy-ai')
                  }
                />
              </Match>
            </Switch>
          </section>
        )}
      </Show>

      <footer class={styles.status}>
        <span class={styles.statusLeft}>
          <Show
            when={tab() === 'memory'}
            fallback={
              <span class={styles.mono}>
                Plotinium {local.version} · build {local.build}
              </span>
            }
          >
            <span class={cx(styles.guard, local.memory.thrashingGuard && styles.guardOn)}>
              <span class={styles.dot} aria-hidden="true" />
              {local.memory.thrashingGuard
                ? 'Thrashing guard: ON · new heavy processes are refused'
                : 'Thrashing guard: off'}
            </span>
            <span class={styles.muted}>
              {local.memory.stats.faultsPerSecond.toFixed(1)} faults/s
            </span>
          </Show>
          <Show when={target() !== undefined}>
            <span class={styles.muted}>Selected: {selectedName()}</span>
          </Show>
        </span>
        <span class={styles.statusRight}>
          <Show when={tab() === 'memory'}>
            <span class={styles.mono}>
              Plotinium {local.version} · build {local.build}
            </span>
          </Show>
          <button
            type="button"
            class={styles.pause}
            aria-pressed={paused()}
            onClick={() => setPaused(!paused())}
          >
            <span class={styles.pauseIcon} aria-hidden="true">
              <Show when={paused()} fallback={<Pause size={12} />}>
                <Play size={12} />
              </Show>
            </span>
            {paused() ? 'Paused · click to resume' : 'Updated every 1 s'}
          </button>
        </span>
      </footer>

      <KillDialog
        request={kill()}
        onCancel={() => setKill(null)}
        onConfirm={(request) => {
          setKill(null);
          local.onSignal(request.pid, request.signal);
        }}
      />
    </div>
  );
}
