import ArrowUp from 'lucide-solid/icons/arrow-up';
import CircleCheck from 'lucide-solid/icons/circle-check';
import SearchX from 'lucide-solid/icons/search-x';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { Button } from '../../primitives/button/Button.tsx';
import { EmptyState } from '../../primitives/empty-state/EmptyState.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { ContextMenu, type MenuEntry } from '../../primitives/menu/Menu.tsx';
import { Table, type SortState, type TableColumn } from '../../primitives/table/Table.tsx';
import { Tooltip } from '../../primitives/tooltip/Tooltip.tsx';
import {
  basePriority,
  canEnd,
  formatBytes,
  formatCount,
  formatCpu,
  formatNice,
  formatUptime,
  frameTone,
  ratio,
  trendOf,
} from './format.ts';
import type {
  ExecutorStat,
  PerformanceModel,
  ProcessBadge,
  ProcessRow,
  ProcessSummary,
} from './models.ts';
import { processIcon } from './process-icons.ts';
import styles from './ProcessesPanel.module.css';
import { Sparkline } from './Sparkline.tsx';
import { StatePill } from './StatePill.tsx';

const BADGE_TIPS: Partial<Record<ProcessBadge, string>> = {
  background: 'Idle-priority background job · yields to foreground input',
  speculative: 'Speculative pre-fetch at idle priority · first to be evicted',
};

function Badge(props: { badge: ProcessBadge }): JSX.Element {
  const tag = (): JSX.Element => (
    <span class={cx(styles.badge, styles[`badge-${props.badge}`])}>{props.badge}</span>
  );
  return (
    <Show when={BADGE_TIPS[props.badge]} fallback={tag()}>
      {(tip) => (
        <Tooltip content={tip()} placement="top">
          {tag()}
        </Tooltip>
      )}
    </Show>
  );
}

/** The Name cell: glyph tile, mono name and badges. */
export function ProcessName(props: {
  name: string;
  badges?: readonly ProcessBadge[];
  after?: JSX.Element;
}): JSX.Element {
  return (
    <span class={styles.name}>
      <span class={styles.glyph} aria-hidden="true">
        <Dynamic component={processIcon(props.name)} size={11} stroke-width={2.2} />
      </span>
      <span class={styles.nameText}>{props.name}</span>
      <For each={props.badges ?? []}>{(badge) => <Badge badge={badge} />}</For>
      {props.after}
    </span>
  );
}

/** Number plus an inline bar sized with scaleX (no layout on update); hot at 80 % and above. */
export function CpuCell(props: { cpu: number }): JSX.Element {
  const hot = (): boolean => props.cpu >= 80;
  return (
    <span class={cx(styles.cpu, hot() && styles.hot)}>
      <span class={styles.bar} aria-hidden="true">
        <span class={styles.fill} style={{ '--pl-fill': String(ratio(props.cpu, 100)) }} />
      </span>
      <span class={styles.num}>{formatCpu(props.cpu)}</span>
    </span>
  );
}

function priorityCell(row: ProcessRow): JSX.Element {
  return (
    <span class={styles.prio}>
      <span class={styles.mono}>
        {basePriority(row.priority, row.nice)} <span class={styles.slash}>/</span>{' '}
        {formatNice(row.nice)}
      </span>
      <Show when={row.nice > 0}>
        <span class={styles.niced}>niced</span>
      </Show>
      <Show when={row.nice <= -20}>
        <span class={styles.realtime}>
          <ArrowUp size={11} aria-hidden="true" />
          <span class={styles.hidden}>real-time</span>
        </span>
      </Show>
    </span>
  );
}

function memoryCell(row: ProcessRow): JSX.Element {
  return (
    <Show when={row.state === 'SUSPENDED'} fallback={formatBytes(row.residentBytes)}>
      <span>
        0 B <span class={styles.swapped}>({formatBytes(row.swappedBytes, 0)} swapped)</span>
      </span>
    </Show>
  );
}

export const PROCESS_COLUMNS: readonly TableColumn<ProcessRow>[] = [
  {
    id: 'pid',
    header: 'PID',
    cell: (r) => r.pid,
    sortValue: (r) => r.pid,
    width: '52px',
    align: 'end',
    muted: true,
  },
  {
    id: 'name',
    header: 'Name',
    cell: (r) => <ProcessName name={r.name} badges={r.badges} />,
    sortValue: (r) => r.name,
    width: 'minmax(0, 2.3fr)',
  },
  {
    id: 'user',
    header: 'User',
    cell: (r) => r.user,
    sortValue: (r) => r.user,
    width: '76px',
    muted: true,
  },
  {
    id: 'state',
    header: 'State',
    cell: (r) => <StatePill state={r.state} reason={r.reason} />,
    sortValue: (r) => r.state,
    width: 'minmax(0, 1.5fr)',
  },
  {
    id: 'prio',
    header: 'Priority / Nice',
    cell: priorityCell,
    sortValue: (r) => basePriority(r.priority, r.nice),
    width: 'minmax(0, 1fr)',
  },
  {
    id: 'cpu',
    header: 'CPU %',
    cell: (r) => <CpuCell cpu={r.cpu} />,
    sortValue: (r) => r.cpu,
    width: '132px',
    align: 'end',
  },
  {
    id: 'memory',
    header: 'Memory',
    cell: memoryCell,
    sortValue: (r) => r.residentBytes,
    width: 'minmax(0, 1.2fr)',
    align: 'end',
  },
  {
    id: 'faults',
    header: 'Faults',
    cell: (r) => (
      <span class={r.faults > 100 ? styles.warn : undefined}>{formatCount(r.faults)}</span>
    ),
    sortValue: (r) => r.faults,
    width: '56px',
    align: 'end',
  },
  {
    id: 'executor',
    header: 'Executor',
    cell: (r) => (r.executor === undefined ? '—' : `exec-${r.executor}`),
    sortValue: (r) => r.executor ?? -1,
    width: '68px',
    mono: true,
    muted: true,
  },
];

const SORT_LABEL: Record<string, string> = {
  pid: 'PID',
  name: 'Name',
  user: 'User',
  state: 'State',
  prio: 'Priority',
  cpu: 'CPU %',
  memory: 'Memory',
  faults: 'Faults',
  executor: 'Executor',
};

export type RowAction = 'end' | 'kill' | 'renice' | 'suspend' | 'memory' | 'copy-pid';

export interface ProcessesPanelProps {
  rows: readonly ProcessRow[];
  /** Rows before the search filter (for "No process matches"). */
  totalRows: number;
  summary: ProcessSummary;
  performance: PerformanceModel;
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  selected: ReadonlySet<string>;
  onSelectionChange: (ids: ReadonlySet<string>) => void;
  query: string;
  onClearQuery: () => void;
  onRowAction: (action: RowAction, row: ProcessRow) => void;
  /** Live data motion (sparklines scroll) — off while paused. */
  live: boolean;
  /** First paint before the first sample: static skeleton rows. */
  loading?: boolean;
  /** "Kernel not responding · last update 6 s ago": numbers freeze and dim. */
  stale?: string;
}

/** Processes tab: summary line, the dense sortable table and the performance strip. */
export function ProcessesPanel(props: ProcessesPanelProps): JSX.Element {
  const [local] = splitProps(props, [
    'rows',
    'totalRows',
    'summary',
    'performance',
    'sort',
    'onSortChange',
    'selected',
    'onSelectionChange',
    'query',
    'onClearQuery',
    'onRowAction',
    'live',
    'loading',
    'stale',
  ]);
  const selectedRow = createMemo(() => {
    const id = [...local.selected][0];
    return local.rows.find((r) => String(r.pid) === id);
  });

  const menuItems = (): MenuEntry[] => {
    const row = selectedRow();
    const endable = canEnd(row);
    return [
      { id: 'end', label: 'End', disabled: !endable, shortcut: ['Delete'] },
      { id: 'kill', label: 'Force kill', danger: true, disabled: !endable },
      { id: 'renice', label: 'Renice…', disabled: row === undefined },
      { id: 'suspend', label: 'Suspend', disabled: !endable || row?.state === 'SUSPENDED' },
      { kind: 'separator' },
      { id: 'memory', label: 'Show in Memory tab', disabled: row === undefined },
      { id: 'copy-pid', label: 'Copy PID', disabled: row === undefined },
    ];
  };

  const selectRowAt = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target.closest('[data-row-id]') : null;
    const id = target?.getAttribute('data-row-id');
    if (id !== null && id !== undefined && !local.selected.has(id))
      local.onSelectionChange(new Set([id]));
  };

  return (
    <div class={cx(styles.panel, local.stale !== undefined && styles.stale)}>
      <div class={styles.summary}>
        <p class={styles.summaryText}>
          <span>
            <strong>{formatCount(local.summary.processes)}</strong> processes
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <strong>{local.summary.executors}</strong>
            <Show
              when={local.summary.executorsMax}
              fallback={local.summary.executors === 1 ? ' executor' : ' executors'}
            >
              {(max) => ` of ${formatCount(max())} executors`}
            </Show>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            load <strong>{local.summary.load.toFixed(2)}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            uptime <strong>{formatUptime(local.summary.uptimeMs)}</strong>
          </span>
        </p>
        <span class={styles.sortedBy}>
          <span class={cx(styles.liveDot, !local.live && styles.pausedDot)} aria-hidden="true" />
          Sorted by {SORT_LABEL[local.sort.column] ?? local.sort.column}
          {local.live ? ', live' : ', paused'}
        </span>
      </div>
      <Show when={local.stale}>
        {(text) => (
          <div class={styles.banner} role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            {text()}
          </div>
        )}
      </Show>
      <div class={styles.tableWrap}>
        <Show
          when={local.loading !== true}
          fallback={
            <div class={styles.skeleton} role="status" aria-label="Loading processes">
              <Index each={Array.from({ length: 8 })}>
                {() => <span class={styles.skeletonRow} aria-hidden="true" />}
              </Index>
            </div>
          }
        >
          <ContextMenu
            label="Process actions"
            items={menuItems()}
            onSelect={(id) => {
              const row = selectedRow();
              if (row !== undefined) local.onRowAction(id as RowAction, row);
            }}
            class={styles.menuTarget}
          >
            <div class={styles.tableHost} onContextMenu={selectRowAt}>
              <Table
                label="Processes"
                class={styles.table}
                columns={PROCESS_COLUMNS}
                rows={local.rows}
                rowId={(r) => String(r.pid)}
                sort={local.sort}
                onSortChange={(sort) => local.onSortChange(sort)}
                selectionMode="single"
                selected={local.selected}
                onSelectionChange={(ids) => local.onSelectionChange(ids)}
                empty={
                  <EmptyState
                    compact
                    live
                    icon={<SearchX size={28} />}
                    title={`No process matches “${local.query}”`}
                    description={`${formatCount(local.totalRows)} processes are hidden by the search.`}
                    actions={
                      <Button size="sm" onClick={() => local.onClearQuery()}>
                        Show all processes
                      </Button>
                    }
                  />
                }
              />
            </div>
          </ContextMenu>
        </Show>
      </div>
      <PerformanceStrip performance={local.performance} live={local.live} />
    </div>
  );
}

function ExecutorCard(props: { executor: ExecutorStat; live: boolean }): JSX.Element {
  const hot = (): boolean => props.executor.cpu > 90;
  const idle = (): boolean => props.executor.cpu < 5;
  const summary = (): string =>
    props.executor.lost === true
      ? `exec-${props.executor.id}, restarting`
      : `exec-${props.executor.id}, CPU ${Math.round(props.executor.cpu)} percent, ${trendOf(
          props.executor.samples,
        )}${hot() ? ', hot' : ''}, runs ${props.executor.runs}`;
  return (
    <li
      class={cx(
        styles.exec,
        hot() && styles.execHot,
        idle() && styles.execIdle,
        props.executor.lost === true && styles.execLost,
      )}
    >
      <div class={styles.execInner} role="img" aria-label={summary()}>
        <div class={styles.execHead}>
          <span class={styles.execName}>exec-{props.executor.id}</span>
          <span class={styles.execPct}>
            <Show when={props.executor.lost !== true} fallback="—">
              {Math.round(props.executor.cpu)}%
            </Show>
          </span>
        </div>
        <span class={styles.execRuns}>
          {props.executor.lost === true ? 'restarting…' : props.executor.runs}
        </span>
        <div class={styles.execChart}>
          <Sparkline
            values={props.executor.samples}
            tone={hot() ? 'danger' : 'accent'}
            muted={idle() || props.executor.lost === true}
            live={props.live && props.executor.lost !== true}
            area
          />
        </div>
      </div>
    </li>
  );
}

/** The PROC-05 frame budget in ms (60 Hz). */
const FRAME_BUDGET_MS = 16.7;

/** "within the 16.7 ms budget", "over budget · 16.7 to 33 ms", "over 33 ms · 2 long frames". */
export function frameVerdict(
  frame: Pick<PerformanceModel['frame'], 'p95Ms' | 'longFrames'>,
): string {
  switch (frameTone(frame.p95Ms)) {
    case 'ok':
      return 'within the 16.7 ms budget';
    case 'warn':
      return 'over budget · 16.7 to 33 ms';
    case 'bad':
      return frame.longFrames > 0
        ? `over 33 ms · ${formatCount(frame.longFrames)} long ${frame.longFrames === 1 ? 'frame' : 'frames'}`
        : 'over 33 ms';
  }
}

/** Histogram rows with frames, in words ("16–20 ms"; the last bucket is open: "48+ ms"). */
export function frameBuckets(
  frame: Pick<PerformanceModel['frame'], 'histogram' | 'bucketMs'>,
): { label: string; count: number; over: boolean }[] {
  const size = frame.bucketMs ?? 4;
  const last = frame.histogram.length - 1;
  return frame.histogram.flatMap((count, i) =>
    count === 0
      ? []
      : [
          {
            label: i === last ? `${i * size}+ ms` : `${i * size}–${(i + 1) * size} ms`,
            count,
            // A bucket is over budget when all of it is: 16–20 ms also holds 16.7 ms frames.
            over: i * size >= FRAME_BUDGET_MS,
          },
        ],
  );
}

/** Frame-time p95 card: value, verdict in words, a histogram with the 16.7 ms budget line. */
export function FrameCard(props: { frame: PerformanceModel['frame'] }): JSX.Element {
  const uid = createUniqueId();
  const [asTable, setAsTable] = createSignal(false);
  const tone = (): 'ok' | 'warn' | 'bad' => frameTone(props.frame.p95Ms);
  const peak = (): number => Math.max(1, ...props.frame.histogram);
  const bucketMs = (): number => props.frame.bucketMs ?? 4;
  const budgetAt = (): number =>
    ratio(FRAME_BUDGET_MS, bucketMs() * Math.max(1, props.frame.histogram.length));
  return (
    <section
      class={cx(styles.frame, styles[`frame-${tone()}`])}
      aria-labelledby={`pl-tm-frame-${uid}`}
    >
      <div class={styles.frameHead}>
        <h3 class={styles.caption} id={`pl-tm-frame-${uid}`}>
          Frame time p95
        </h3>
        <button
          type="button"
          class={styles.linkButton}
          aria-pressed={asTable()}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable() ? 'View as chart' : 'View as table'}
        </button>
      </div>
      <div class={styles.frameBody}>
        <div class={styles.frameValue}>
          <p class={styles.frameNumber}>
            {props.frame.p95Ms.toFixed(1)}
            <span class={styles.unit}> ms</span>
            <Show
              when={tone() === 'ok'}
              fallback={<TriangleAlert size={18} aria-hidden="true" class={styles.frameIcon} />}
            >
              <CircleCheck
                size={18}
                aria-hidden="true"
                class={cx(styles.frameIcon, styles.popIn)}
              />
            </Show>
          </p>
          <p class={styles.frameVerdict}>{frameVerdict(props.frame)}</p>
        </div>
        <Show
          when={asTable()}
          fallback={
            <div class={styles.histogram} aria-hidden="true">
              <For each={props.frame.histogram}>
                {(count, index) => (
                  <span
                    class={cx(
                      styles.histBar,
                      index() * bucketMs() >= FRAME_BUDGET_MS && styles.histOver,
                    )}
                    style={{
                      '--pl-fill': String(count / peak()),
                      '--pl-stagger-index': String(index()),
                    }}
                  />
                )}
              </For>
              <span class={styles.budgetLine} style={{ '--pl-at': String(budgetAt()) }} />
            </div>
          }
        >
          {/* UI-044: only the buckets with frames, in a box that scrolls instead of growing. */}
          <div
            class={styles.histTableBox}
            role="group"
            aria-label="Frame-time histogram"
            tabindex="0"
          >
            <table class={styles.histTable}>
              <caption class={styles.hidden}>Frame-time histogram</caption>
              <thead>
                <tr>
                  <th scope="col">Frame time</th>
                  <th scope="col">Frames</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={frameBuckets(props.frame)}
                  fallback={
                    <tr>
                      <td colSpan={2}>No frames sampled yet</td>
                    </tr>
                  }
                >
                  {(bucket) => (
                    <tr class={bucket.over ? styles.histRowOver : undefined}>
                      <td>{bucket.label}</td>
                      <td>{formatCount(bucket.count)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>
    </section>
  );
}

/** The bottom strip: CPU per executor, frame p95, memory and page faults. */
export function PerformanceStrip(props: {
  performance: PerformanceModel;
  live: boolean;
}): JSX.Element {
  const uid = createUniqueId();
  const memRatio = (): number =>
    ratio(props.performance.memory.usedBytes, props.performance.memory.totalBytes);
  return (
    <div class={styles.strip}>
      <section class={styles.executors} aria-labelledby={`pl-tm-exec-${uid}`}>
        <div class={styles.stripHead}>
          <h3 class={styles.caption} id={`pl-tm-exec-${uid}`}>
            CPU per executor
          </h3>
          <span class={styles.stripNote}>last 60 s · 1 sample/s</span>
        </div>
        <ul class={styles.execGrid} role="list">
          <For each={props.performance.executors}>
            {(executor) => <ExecutorCard executor={executor} live={props.live} />}
          </For>
        </ul>
      </section>
      <div class={styles.side}>
        <FrameCard frame={props.performance.frame} />
        <div class={styles.minis}>
          <div class={cx(styles.mini, memRatio() > 0.8 && styles.miniWarn)}>
            <span class={styles.caption}>Memory</span>
            <span class={styles.miniValue}>
              {formatBytes(props.performance.memory.usedBytes)}
              <span class={styles.miniTotal}>
                {' '}
                / {formatBytes(props.performance.memory.totalBytes)}
              </span>
            </span>
            <span class={styles.miniBar} aria-hidden="true">
              <span class={styles.miniFill} style={{ '--pl-fill': String(memRatio()) }} />
            </span>
          </div>
          <div class={cx(styles.mini, props.performance.faultsPerSecond > 500 && styles.miniWarn)}>
            <span class={styles.caption}>Page faults</span>
            <span class={styles.miniValue}>
              {formatCount(props.performance.faultsPerSecond)}
              <span class={styles.miniTotal}> /s</span>
            </span>
            <span class={styles.miniBar} aria-hidden="true">
              <span
                class={cx(styles.miniFill, styles.miniFillWarm)}
                style={{ '--pl-fill': String(ratio(props.performance.faultsPerSecond, 1000)) }}
              />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
