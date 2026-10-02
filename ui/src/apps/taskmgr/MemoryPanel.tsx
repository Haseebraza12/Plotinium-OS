import ArrowDownToLine from 'lucide-solid/icons/arrow-down-to-line';
import ArrowUpFromLine from 'lucide-solid/icons/arrow-up-from-line';
import CloudOff from 'lucide-solid/icons/cloud-off';
import Gauge from 'lucide-solid/icons/gauge';
import HardDrive from 'lucide-solid/icons/hard-drive';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import Zap from 'lucide-solid/icons/zap';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { Table, type SortState, type TableColumn } from '../../primitives/table/Table.tsx';
import { Toggle } from '../../primitives/toggle/Toggle.tsx';
import { Tooltip } from '../../primitives/tooltip/Tooltip.tsx';
import { BudgetBar } from './BudgetBar.tsx';
import { formatBytes, formatCount, formatMB, matchesQuery, mbNumber, ratio } from './format.ts';
import styles from './MemoryPanel.module.css';
import type { MemoryModel, MemoryProcessRow, PredictionsModel } from './models.ts';
import { PredictionsPanel } from './PredictionsPanel.tsx';
import { ProcessName } from './ProcessesPanel.tsx';
import { Sparkline } from './Sparkline.tsx';

export type BudgetLevel = 'ok' | 'elevated' | 'high' | 'over';

/** Where accounted memory stands against the watermarks (MEM-01). */
export function budgetLevel(
  m: Pick<
    MemoryModel,
    'budgetBytes' | 'segments' | 'lowWatermark' | 'highWatermark' | 'overBudgetMs'
  >,
): BudgetLevel {
  const used = m.segments.reduce((sum, s) => sum + s.bytes, 0);
  const r = ratio(used, m.budgetBytes);
  if (m.overBudgetMs > 0 || used > m.budgetBytes) return 'over';
  if (r > m.highWatermark) return 'high';
  if (r > m.lowWatermark) return 'elevated';
  return 'ok';
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

export interface MemoryPanelProps {
  memory: MemoryModel;
  predictions: PredictionsModel;
  query: string;
  selected: ReadonlySet<string>;
  onSelectionChange: (ids: ReadonlySet<string>) => void;
  onReclaim: () => void;
  onPinChange: (pid: number, pinned: boolean) => void;
  onOpenSettings?: () => void;
  onRestartPredictor?: () => void;
  live: boolean;
}

/**
 * Memory tab (task-manager-memory): the budget headline and stacked bar, fault/hit/paging/swap
 * cards with sparklines, the per-process table with Pin switches, and the Predictions aside.
 */
export function MemoryPanel(props: MemoryPanelProps): JSX.Element {
  const [local] = splitProps(props, [
    'memory',
    'predictions',
    'query',
    'selected',
    'onSelectionChange',
    'onReclaim',
    'onPinChange',
    'onOpenSettings',
    'onRestartPredictor',
    'live',
  ]);
  const uid = createUniqueId();
  const m = (): MemoryModel => local.memory;
  const used = createMemo(() => m().segments.reduce((sum, s) => sum + s.bytes, 0));
  const usedRatio = (): number => ratio(used(), m().budgetBytes);
  const level = createMemo(() => budgetLevel(m()));
  const [sort, setSort] = createSignal<SortState>({ column: 'resident', direction: 'descending' });
  const [announcement, setAnnouncement] = createSignal('');

  // Threshold events are announced once, never the 1 Hz samples.
  createEffect(
    on(level, (next, prev) => {
      if (prev === undefined || next === prev) return;
      if (next === 'high') setAnnouncement('Memory above high watermark');
      else if (next === 'over') setAnnouncement('Memory over budget');
      else if (prev === 'high' || prev === 'over')
        setAnnouncement('Memory back under the high watermark');
    }),
  );
  createEffect(
    on(
      () => m().thrashingGuard,
      (on_, prev) => {
        if (prev !== undefined && on_ && !prev) setAnnouncement('Thrashing guard on');
      },
    ),
  );

  const chip = (): { tone: string; text: string } => {
    switch (level()) {
      case 'over':
        return {
          tone: 'danger',
          text: `Over budget for ${(m().overBudgetMs / 1000).toFixed(1)} s`,
        };
      case 'high':
        return {
          tone: 'warning',
          text: `${pct(usedRatio())} · above high watermark ${pct(m().highWatermark)}`,
        };
      case 'elevated':
        return {
          tone: 'neutral',
          text: `${pct(usedRatio())} · reclaim starts at ${pct(m().highWatermark)}`,
        };
      case 'ok':
        return { tone: 'success', text: `${pct(usedRatio())} · healthy` };
    }
  };

  const valueText = (): string =>
    `${mbNumber(used())} of ${formatMB(m().budgetBytes)} accounted, ${pct(usedRatio())}${
      level() === 'high' ? ', above high watermark' : level() === 'over' ? ', over budget' : ''
    }`;

  const reclaimDisabled = (): boolean =>
    m().reclaimUnavailable !== undefined || m().reclaiming || usedRatio() <= m().lowWatermark;

  const rows = createMemo(() => m().processes.filter((r) => matchesQuery(r, local.query)));
  const maxResident = createMemo(() => Math.max(1, ...m().processes.map((r) => r.residentBytes)));

  const columns: readonly TableColumn<MemoryProcessRow>[] = [
    {
      id: 'pid',
      header: 'PID',
      cell: (r) => r.pid,
      sortValue: (r) => r.pid,
      width: '48px',
      muted: true,
    },
    {
      id: 'name',
      header: 'Process',
      cell: (r) => (
        <ProcessName
          name={r.name}
          after={
            <>
              <Show when={r.note}>{(note) => <span class={styles.note}>· {note()}</span>}</Show>
              <Show when={r.tag}>
                {(tag) => <span class={cx(styles.tag, styles[`tag-${tag()}`])}>{tag()}</span>}
              </Show>
              <Show when={r.overSoftLimit === true}>
                <span class={styles.limit} data-over-limit="true">
                  <span aria-hidden="true">!</span>
                  <span class={styles.hidden}>over the soft limit</span>
                </span>
              </Show>
            </>
          }
        />
      ),
      sortValue: (r) => r.name,
      width: 'minmax(0, 2.2fr)',
    },
    {
      id: 'user',
      header: 'User',
      cell: (r) => r.user,
      sortValue: (r) => r.user,
      width: '64px',
      muted: true,
    },
    {
      id: 'resident',
      header: 'Resident',
      cell: (r) => (
        <span class={styles.resident}>
          <span class={styles.residentValue}>{formatBytes(r.residentBytes)}</span>
          <span class={styles.bar} aria-hidden="true">
            <span
              class={styles.fill}
              style={{ '--pl-fill': String(ratio(r.residentBytes, maxResident())) }}
            />
          </span>
        </span>
      ),
      sortValue: (r) => r.residentBytes,
      width: 'minmax(0, 1.6fr)',
      align: 'end',
    },
    {
      id: 'swapped',
      header: 'Swapped local / remote',
      cell: (r) => (
        <span class={styles.swap}>
          {mbShort(r.swappedLocalBytes)} <span class={styles.slash}>/</span>{' '}
          {mbShort(r.swappedRemoteBytes)}
        </span>
      ),
      sortValue: (r) => r.swappedLocalBytes + r.swappedRemoteBytes,
      width: 'minmax(0, 1.7fr)',
      align: 'end',
    },
    {
      id: 'faults',
      header: 'Faults',
      cell: (r) => (
        <span class={r.faults > 100 ? styles.warn : undefined}>{formatCount(r.faults)}</span>
      ),
      sortValue: (r) => r.faults,
      width: '60px',
      align: 'end',
    },
    {
      id: 'pin',
      header: 'Pin',
      cell: (r) => (
        <PinSwitch
          row={r}
          unavailable={m().pinUnavailable}
          onChange={(pinned) => local.onPinChange(r.pid, pinned)}
        />
      ),
      width: '52px',
      align: 'center',
    },
  ];

  return (
    <div class={styles.panel}>
      <div class={styles.live} role="status" aria-live="polite">
        {announcement()}
      </div>
      <Show when={m().staleSince}>
        {(since) => (
          <div class={styles.banner} role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            Memory figures are stale (last {since()})
          </div>
        )}
      </Show>
      <section class={styles.budget} aria-labelledby={`pl-mem-${uid}`}>
        <div class={styles.headline}>
          <div class={styles.headlineText}>
            <h3 class={styles.caption} id={`pl-mem-${uid}`}>
              Memory budget
            </h3>
            <p class={styles.figure}>
              <span class={styles.big}>
                {mbNumber(used())} / {formatMB(m().budgetBytes)}
              </span>
              <span class={styles.accounted}>accounted</span>
              <span class={cx(styles.chip, styles[`chip-${chip().tone}`])}>
                <span class={styles.chipDot} aria-hidden="true" />
                {chip().text}
              </span>
            </p>
          </div>
          <Tooltip
            content={
              m().reclaimUnavailable ??
              (m().reclaiming
                ? 'A reclaim pass is running'
                : reclaimDisabled()
                  ? `Nothing to reclaim at or below the low watermark (${pct(m().lowWatermark)})`
                  : 'Page out least recently used memory down to the low watermark')
            }
            placement="bottom"
          >
            <Button
              icon={<RotateCcw size={14} />}
              disabled={reclaimDisabled()}
              onClick={() => local.onReclaim()}
            >
              {m().reclaiming ? `Reclaiming… ${formatMB(m().reclaimedBytes)}` : 'Reclaim now'}
            </Button>
          </Tooltip>
        </div>
        <BudgetBar
          segments={m().segments}
          budgetBytes={m().budgetBytes}
          lowWatermark={m().lowWatermark}
          highWatermark={m().highWatermark}
          stale={m().staleSince !== undefined}
          valueText={valueText()}
        />
      </section>

      <ul class={styles.cards} role="list" aria-label="Paging statistics">
        <li class={styles.card}>
          <span class={styles.cardLabel}>
            <Zap size={13} aria-hidden="true" /> Page faults
          </span>
          <span class={styles.cardValue}>{formatCount(m().stats.faults)}</span>
          <span class={styles.cardSub}>
            <span class={m().stats.faultsPerSecond > 20 ? styles.warnText : styles.upText}>
              +{formatCount(m().stats.faultsPerSecond)}/s
            </span>{' '}
            · {formatCount(m().stats.majorFaults)} major
          </span>
          <Sparkline
            class={styles.cardSpark}
            values={m().stats.faultSamples}
            max={Math.max(1, ...m().stats.faultSamples)}
            tone="warning"
            live={local.live}
          />
        </li>
        <li class={styles.card}>
          <span class={styles.cardLabel}>
            <Gauge size={13} aria-hidden="true" /> Hit ratio
          </span>
          <span class={cx(styles.cardValue, m().stats.hitRatio < 0.9 && styles.warnText)}>
            {(m().stats.hitRatio * 100).toFixed(1)}%
          </span>
          <span class={styles.cardSub}>
            <span class={m().stats.hitRatioDelta >= 0 ? styles.upText : styles.warnText}>
              {m().stats.hitRatioDelta >= 0 ? '▲' : '▼'}{' '}
              {Math.abs(m().stats.hitRatioDelta).toFixed(1)}
            </span>{' '}
            vs 5 min ago
          </span>
          <Sparkline
            class={styles.cardSpark}
            values={m().stats.hitSamples}
            max={100}
            tone="success"
            live={local.live}
          />
        </li>
        <li class={styles.card}>
          <span class={styles.cardLabel}>
            <ArrowUpFromLine size={13} aria-hidden="true" /> Paged out
          </span>
          <span class={styles.cardValue}>{formatMB(m().stats.pagedOutBytes)}</span>
          <span class={styles.cardSub}>
            since boot · {formatCount(m().stats.pagedOutPages)} pages
          </span>
          <Sparkline
            class={styles.cardSpark}
            values={m().stats.pagedOutSamples}
            max={Math.max(1, ...m().stats.pagedOutSamples)}
            tone="accent"
            live={local.live}
          />
        </li>
        <li class={styles.card}>
          <span class={styles.cardLabel}>
            <ArrowDownToLine size={13} aria-hidden="true" /> Paged in
          </span>
          <span class={styles.cardValue}>{formatMB(m().stats.pagedInBytes)}</span>
          <span class={styles.cardSub}>p95 page-in {m().stats.pageInP95Ms} ms local</span>
          <Sparkline
            class={styles.cardSpark}
            values={m().stats.pagedInSamples}
            max={Math.max(1, ...m().stats.pagedInSamples)}
            tone="info"
            live={local.live}
          />
        </li>
        <li class={cx(styles.card, styles.swapCard)}>
          <span class={styles.cardLabel}>
            <HardDrive size={13} aria-hidden="true" /> Swap
          </span>
          <For each={m().swap}>
            {(tier) => (
              <span class={styles.tier}>
                <span class={styles.tierName}>{tier.name}</span>
                <Show
                  when={tier.online !== false}
                  fallback={
                    <span class={styles.offline}>
                      <CloudOff size={12} aria-hidden="true" /> offline
                    </span>
                  }
                >
                  <span class={styles.bar} aria-hidden="true">
                    <span
                      class={cx(styles.fill, styles.tierFill)}
                      style={{ '--pl-fill': String(ratio(tier.usedBytes, tier.capacityBytes)) }}
                    />
                  </span>
                  <span class={styles.tierValue}>
                    {formatBytes(
                      tier.usedBytes,
                      tier.usedBytes >= 100 * 1048576 && tier.usedBytes < 1073741824 ? 0 : 1,
                    )}
                  </span>
                </Show>
              </span>
            )}
          </For>
          <span class={styles.cardSub}>{m().swapNote}</span>
        </li>
      </ul>

      <div class={styles.lower}>
        <div class={styles.tableCard}>
          <Table
            label="Processes by memory"
            class={styles.table}
            columns={columns}
            rows={rows()}
            rowId={(r) => String(r.pid)}
            sort={sort()}
            onSortChange={setSort}
            selectionMode="single"
            selected={local.selected}
            onSelectionChange={(ids) => local.onSelectionChange(ids)}
            density="compact"
            empty={<p class={styles.empty}>No processes match “{local.query}”</p>}
          />
          <div class={styles.tableFoot}>
            <span>
              {rows().length} of {formatCount(m().totalProcesses)} processes · sorted by{' '}
              {sort().column === 'resident' ? 'Resident' : sort().column}
            </span>
            <span>
              Soft limit {formatMB(m().softLimitBytes)} per process · budget in Settings › Memory
            </span>
          </div>
        </div>
        <PredictionsPanel
          class={styles.predictions}
          predictions={local.predictions}
          onOpenSettings={local.onOpenSettings}
          onRestart={local.onRestartPredictor}
        />
      </div>
    </div>
  );
}

/** "6.8" MB with one decimal, "0" when empty (the header carries the unit). */
function mbShort(bytes: number): string {
  if (bytes <= 0) return '0';
  const mb = bytes / 1048576;
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1);
}

function PinSwitch(props: {
  row: MemoryProcessRow;
  /** Why pinning cannot work in this build (UI-146): the switch is disabled with this reason. */
  unavailable?: string;
  onChange: (pinned: boolean) => void;
}): JSX.Element {
  // The tooltip shows the reason and also describes the switch (aria-describedby).
  const reason = (): string | undefined =>
    props.row.pinLocked === true ? 'Kernel processes are always resident' : props.unavailable;
  const toggle = (): JSX.Element => (
    <Toggle
      size="sm"
      hideLabel
      class={cx(styles.pin, props.row.pinPending === true && styles.pinPending)}
      label={`Pin ${props.row.name}, pid ${props.row.pid}`}
      checked={props.row.pinned}
      disabled={reason() !== undefined}
      onChange={(next) => props.onChange(next)}
    />
  );
  return (
    <Show when={reason()} fallback={toggle()}>
      {(text) => (
        <Tooltip content={text()} placement="left">
          {toggle()}
        </Tooltip>
      )}
    </Show>
  );
}
