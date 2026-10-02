import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import UserLock from 'lucide-solid/icons/user-lock';
import { createEffect, createSignal, Show, splitProps, type JSX } from 'solid-js';

import { Button } from '../../../primitives/button/Button.tsx';
import { Banner, Group, Row, SliderRow, ToggleRow, ValueRow } from '../controls.tsx';
import type {
  BoundTerms,
  MemoryStatus,
  SettingChange,
  SettingKey,
  SettingsAction,
  SettingValues,
} from '../models.ts';
import styles from './SystemPanes.module.css';

const grouped = new Intl.NumberFormat('en-GB');
const MB = 1048576;

/** Slider value that follows the model but only sends a change when the user commits. */
function createDraft<K extends SettingKey>(
  value: () => SettingValues[K],
): [() => SettingValues[K], (v: SettingValues[K]) => void] {
  const [draft, setDraft] = createSignal<SettingValues[K]>(value());
  createEffect(() => setDraft(() => value()));
  return [draft, (v) => setDraft(() => v)];
}

const GUESTS = 'Guests cannot change device settings.';

export interface MemoryPaneProps {
  values: Pick<SettingValues, 'mm.budgetMB' | 'mm.softLimitMB' | 'mm.remoteOnly'>;
  status: MemoryStatus;
  /** Device settings are read-only for guests. */
  readOnly?: boolean;
  onChange: (change: SettingChange) => void;
  onAction: (action: SettingsAction) => void;
}

/** Memory (MEM-01): the global budget, the per-process soft limit and the swap tier. */
export function MemoryPane(props: MemoryPaneProps): JSX.Element {
  const [local] = splitProps(props, ['values', 'status', 'readOnly', 'onChange', 'onAction']);
  const [budget, setBudget] = createDraft<'mm.budgetMB'>(() => local.values['mm.budgetMB']);
  const [soft, setSoft] = createDraft<'mm.softLimitMB'>(() => local.values['mm.softLimitMB']);
  const usedMB = (): number => local.status.usedBytes / MB;
  const pct = (r: number): string => `${Math.round(r * 100)}%`;

  return (
    <div class={styles.pane}>
      <Show when={local.readOnly === true}>
        <Banner tone="warning" icon={<UserLock size={14} />}>
          {GUESTS}
        </Banner>
      </Show>
      <Group
        title="Memory budget"
        index={0}
        footer={
          <span>
            Background reclaim starts above {pct(local.status.highWatermark)} and stops at{' '}
            {pct(local.status.lowWatermark)} of the budget.
          </span>
        }
      >
        <SliderRow
          label="Global budget"
          description="Resident process memory the kernel may hand out (MEM-01). Raising it applies at once."
          value={budget()}
          min={64}
          max={2048}
          step={16}
          format={(v) => `${grouped.format(v)} MB`}
          disabled={local.readOnly}
          onInput={setBudget}
          onCommit={(value) => local.onChange({ key: 'mm.budgetMB', value })}
          note={
            budget() < usedMB()
              ? `Lowering below ${Math.round(usedMB())} MB starts reclaim now; nothing is killed.`
              : undefined
          }
        />
        <Row
          title="In use now"
          control={<span class={styles.usage}>{Math.round(usedMB())} MB accounted</span>}
        >
          <span class={styles.usageBar} aria-hidden="true">
            <span
              class={styles.usageFill}
              style={{ '--pl-fill': String(Math.min(1, usedMB() / Math.max(1, budget()))) }}
            />
            <span class={styles.mark} style={{ '--pl-at': String(local.status.lowWatermark) }} />
            <span
              class={styles.markHigh}
              style={{ '--pl-at': String(local.status.highWatermark) }}
            />
          </span>
        </Row>
        <SliderRow
          label="Per-process soft limit"
          description="Above it a process is marked ! and its pages are evicted first. It is never blocked for it."
          value={soft()}
          min={8}
          max={Math.max(8, budget())}
          step={8}
          format={(v) => `${grouped.format(v)} MB`}
          disabled={local.readOnly}
          onInput={setSoft}
          onCommit={(value) => local.onChange({ key: 'mm.softLimitMB', value })}
        />
      </Group>
      <Group title="Swap" index={1}>
        <ToggleRow
          label="Keep swapped pages only on the server"
          description="Demo mode, the same as swapctl --tier remote: page-outs skip the local tier."
          checked={local.values['mm.remoteOnly']}
          disabled={local.readOnly}
          onChange={(value) => local.onChange({ key: 'mm.remoteOnly', value })}
        />
        <ValueRow title="Local tier" value="OPFS · write-behind to server: on" />
      </Group>
      <div class={styles.footer}>
        <Button
          size="sm"
          icon={<RotateCcw size={13} />}
          disabled={local.readOnly}
          onClick={() => local.onAction('memory.restoreDefaults')}
        >
          Restore defaults
        </Button>
      </div>
    </div>
  );
}

export interface SchedulerPaneProps {
  values: Pick<
    SettingValues,
    | 'sched.quantumMs.interactive'
    | 'sched.quantumMs.normal'
    | 'sched.quantumMs.background'
    | 'sched.tAgeMs'
  >;
  bound: BoundTerms;
  readOnly?: boolean;
  onChange: (change: SettingChange) => void;
  onAction: (action: SettingsAction) => void;
}

/**
 * Scheduler (PROC-03, PROC-04): the quantum of each band and the aging interval, with the
 * declared starvation bound recomputed live as the sliders move.
 */
export function SchedulerPane(props: SchedulerPaneProps): JSX.Element {
  const [local] = splitProps(props, ['values', 'bound', 'readOnly', 'onChange', 'onAction']);
  const [qi, setQi] = createDraft<'sched.quantumMs.interactive'>(
    () => local.values['sched.quantumMs.interactive'],
  );
  const [qn, setQn] = createDraft<'sched.quantumMs.normal'>(
    () => local.values['sched.quantumMs.normal'],
  );
  const [qb, setQb] = createDraft<'sched.quantumMs.background'>(
    () => local.values['sched.quantumMs.background'],
  );
  const [tAge, setTAge] = createDraft<'sched.tAgeMs'>(() => local.values['sched.tAgeMs']);
  const ms = (v: number): string => `${grouped.format(v)} ms`;
  const q = (): number => Math.max(qi(), qn(), qb());
  const bound = (): number => {
    const b = local.bound;
    return (
      (b.p + 1) * tAge() + Math.ceil((b.n - 1) / Math.max(1, b.e)) * (q() + b.deltaMs) + b.hKillMs
    );
  };

  return (
    <div class={styles.pane}>
      <Show when={local.readOnly === true}>
        <Banner tone="warning" icon={<UserLock size={14} />}>
          {GUESTS}
        </Banner>
      </Show>
      <Group
        title="Quantum per band"
        index={0}
        footer="Round-robin among equal priorities; a change applies from the next dispatch."
      >
        <SliderRow
          label="Interactive (PRI 0–9)"
          description="The focused window and the foreground job. Default 5 ms."
          value={qi()}
          min={2}
          max={50}
          format={ms}
          disabled={local.readOnly}
          onInput={setQi}
          onCommit={(value) => local.onChange({ key: 'sched.quantumMs.interactive', value })}
        />
        <SliderRow
          label="Normal (PRI 10–29)"
          description="Default 10 ms."
          value={qn()}
          min={2}
          max={50}
          format={ms}
          disabled={local.readOnly}
          onInput={setQn}
          onCommit={(value) => local.onChange({ key: 'sched.quantumMs.normal', value })}
        />
        <SliderRow
          label="Background (PRI 30–39)"
          description="The indexer and pre-fetch jobs. Paused while you drag. Default 20 ms."
          value={qb()}
          min={2}
          max={50}
          format={ms}
          disabled={local.readOnly}
          onInput={setQb}
          onCommit={(value) => local.onChange({ key: 'sched.quantumMs.background', value })}
        />
      </Group>
      <Group title="Aging" index={1}>
        <SliderRow
          label={'Aging interval (T_age)'}
          description="A waiting process gains one priority level per interval. Default 100 ms."
          value={tAge()}
          min={50}
          max={1000}
          step={10}
          format={ms}
          disabled={local.readOnly}
          onInput={setTAge}
          onCommit={(value) => local.onChange({ key: 'sched.tAgeMs', value })}
        />
        <Row
          title="Declared starvation bound (PROC-04)"
          description={
            <span class={styles.formula}>
              (p + 1)·T<sub>age</sub> + ⌈(N − 1)/E⌉·(Q + δ) + H<sub>kill</sub> with p ={' '}
              {local.bound.p}, N = {local.bound.n}, E = {local.bound.e}
            </span>
          }
          control={
            <output class={styles.bound} aria-live="polite">
              {ms(bound())}
            </output>
          }
        />
      </Group>
      <div class={styles.footer}>
        <Button
          size="sm"
          icon={<RotateCcw size={13} />}
          disabled={local.readOnly}
          onClick={() => local.onAction('scheduler.restoreDefaults')}
        >
          Restore defaults
        </Button>
      </div>
    </div>
  );
}
