/**
 * Task Manager and Settings (ui/src/apps/taskmgr, ui/src/apps/settings), drawn at the reference
 * window sizes (docs/design/stitch/task-manager-*, settings-*) in both themes, inside the real
 * WindowFrame with its overlay title bar (unified chrome: the views draw their own toolbar and
 * sidebar top; the compositor supplies geometry and gestures). "Live data"
 * replays a 1 Hz sample stream so the sparklines, bars and numbers move exactly as they would;
 * the gallery toolbar's Reduce motion switch turns every one of those motions into a cut.
 */
import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';

import {
  DEFAULT_VALUES,
  SAMPLE_ABOUT,
  SAMPLE_BOUND,
  SAMPLE_MEMORY_STATUS,
  SAMPLE_NETWORK,
  SAMPLE_PRIVACY,
  SAMPLE_STORAGE,
  SAMPLE_UPDATES,
  SAMPLE_USER,
  SAMPLE_USERS,
} from '../../src/apps/settings/fixtures.ts';
import type { SettingsSectionId, SettingValues } from '../../src/apps/settings/models.ts';
import { SECTIONS } from '../../src/apps/settings/sections.ts';
import { SettingsView } from '../../src/apps/settings/SettingsView.tsx';
import { BudgetBar } from '../../src/apps/taskmgr/BudgetBar.tsx';
import {
  SAMPLE_AI,
  SAMPLE_MEMORY,
  SAMPLE_PERFORMANCE,
  SAMPLE_PREDICTIONS,
  SAMPLE_PROCESSES,
  SAMPLE_SCHEDULER,
  SAMPLE_SUMMARY,
} from '../../src/apps/taskmgr/fixtures.ts';
import type {
  MemoryModel,
  PerformanceModel,
  PredictionsModel,
  ProcessRow,
  ProcStateView,
  TaskManagerTab,
} from '../../src/apps/taskmgr/models.ts';
import { EndProcessButton } from '../../src/apps/taskmgr/ProcessActions.tsx';
import { FrameCard } from '../../src/apps/taskmgr/ProcessesPanel.tsx';
import { PredictionsPanel } from '../../src/apps/taskmgr/PredictionsPanel.tsx';
import { Sparkline, type SparkTone } from '../../src/apps/taskmgr/Sparkline.tsx';
import { StatePill } from '../../src/apps/taskmgr/StatePill.tsx';
import { TASK_MANAGER_TABS, TaskManagerView } from '../../src/apps/taskmgr/TaskManagerView.tsx';
import { SegmentedControl } from '../../src/primitives/segmented-control/SegmentedControl.tsx';
import { Select } from '../../src/primitives/select/Select.tsx';
import { Toggle } from '../../src/primitives/toggle/Toggle.tsx';
import { WindowFrame } from '../../src/shell/window/WindowFrame.tsx';
import { Caption, Demo, Grid, Page, Section, Stack, ThemeSplit } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import styles from './apps-b.module.css';

export const meta: GalleryPageMeta = {
  id: 'apps-b',
  title: 'Task Manager & Settings',
  group: 'Apps',
  order: 20,
  description: 'Processes, Memory, Scheduler and AI; System Settings with every section.',
};

type PreviewTheme = 'both' | 'dark' | 'light';
const MB = 1048576;

// ---------------------------------------------------------------------------------------------
// The window frame (overlay title bar), scaled to the column.
// ---------------------------------------------------------------------------------------------

function Window(props: {
  theme: 'dark' | 'light';
  title: string;
  width: number;
  height: number;
  zoomDisabled?: boolean;
  children: JSX.Element;
}): JSX.Element {
  let outer: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(1);
  onMount(() => {
    const box = outer;
    if (box === undefined) return;
    const fit = (): void => {
      setScale(Math.min(1, box.clientWidth / (props.width + 64)));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    fit();
    onCleanup(() => observer.disconnect());
  });
  return (
    <div
      ref={(el) => (outer = el)}
      class={styles.stage}
      data-theme={props.theme}
      style={{ height: `${Math.round((props.height + 64) * scale())}px` }}
    >
      <div
        class={styles.scaler}
        style={{
          top: `${Math.round(32 * scale())}px`,
          width: `${props.width}px`,
          height: `${props.height}px`,
          transform: `scale(${scale()})`,
        }}
      >
        <WindowFrame
          title={props.title}
          titlebar="overlay"
          focused
          canMaximise={props.zoomDisabled !== true}
          resizable={false}
          style={{ width: '100%', height: '100%' }}
          onClose={() => undefined}
          onMinimise={() => undefined}
          onMaximize={() => undefined}
        >
          {props.children}
        </WindowFrame>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A 1 Hz sample stream for the Task Manager (deterministic, so screenshots are stable).
// ---------------------------------------------------------------------------------------------

interface TaskState {
  processes: ProcessRow[];
  performance: PerformanceModel;
  memory: MemoryModel;
  predictions: PredictionsModel;
}

function wave(t: number, base: number, swing: number, phase: number): number {
  return Math.max(
    0,
    base + swing * Math.sin(t / 2.3 + phase) + (swing / 3) * Math.sin(t * 1.9 + phase),
  );
}

function createTaskStream(): {
  state: TaskState;
  live: () => boolean;
  setLive: (on: boolean) => void;
} {
  const [state, setState] = createStore<TaskState>({
    processes: SAMPLE_PROCESSES.map((p) => ({ ...p })),
    performance: structuredClone(SAMPLE_PERFORMANCE),
    memory: structuredClone(SAMPLE_MEMORY),
    predictions: structuredClone(SAMPLE_PREDICTIONS),
  });
  const [live, setLive] = createSignal(true);
  let t = 0;
  const tick = (): void => {
    t += 1;
    const cpu = (pid: number, base: number): number => {
      const p = SAMPLE_PROCESSES.find((r) => r.pid === pid);
      if (p === undefined || p.cpu === 0) return p?.cpu ?? 0;
      return Math.min(99.9, wave(t, base, Math.max(0.2, base * 0.12), pid));
    };
    setState(
      'processes',
      reconcile(
        SAMPLE_PROCESSES.map((p) => ({
          ...p,
          cpu: cpu(p.pid, p.cpu),
          faults: p.faults === 0 ? 0 : Math.round(wave(t, p.faults, p.faults * 0.1, p.pid)),
        })),
        { key: 'pid' },
      ),
    );
    setState(
      'performance',
      'executors',
      reconcile(
        state.performance.executors.map((e) => {
          const next =
            e.id === 4 ? 97 + Math.sin(t) * 2 : wave(t, e.cpu, Math.max(2, e.cpu * 0.25), e.id);
          return { ...e, cpu: next, samples: [...e.samples.slice(1), next] };
        }),
      ),
    );
    setState('performance', 'frame', {
      p95Ms: Math.round(wave(t, 14.2, 0.8, 1) * 10) / 10,
      histogram: SAMPLE_PERFORMANCE.frame.histogram.map((v, i) =>
        Math.round(wave(t, v, v * 0.2, i)),
      ),
    });
    setState('performance', 'faultsPerSecond', Math.round(wave(t, 627, 60, 3)));
    const apps = Math.round(wave(t, 86, 3, 2) * 10) / 10;
    setState('memory', 'segments', 1, 'bytes', apps * MB);
    setState('memory', 'stats', (s) => ({
      ...s,
      faults: s.faults + Math.round(wave(t, 12, 4, 1)),
      faultsPerSecond: Math.round(wave(t, 12, 4, 1)),
      faultSamples: [...s.faultSamples.slice(1), wave(t, 10, 5, 4)],
      hitSamples: [...s.hitSamples.slice(1), wave(t, 96, 1.5, 2)],
      pagedOutSamples: [...s.pagedOutSamples.slice(1), wave(t, 8, 4, 9)],
      pagedInSamples: [...s.pagedInSamples.slice(1), wave(t, 5, 3, 6)],
    }));
    setState('predictions', 'rows', 0, 'confidence', Math.min(0.9, wave(t, 0.62, 0.04, 5)));
  };
  onMount(() => {
    const timer = setInterval(() => {
      if (live()) tick();
    }, 1000);
    onCleanup(() => clearInterval(timer));
  });
  return { state, live, setLive };
}

const noop = (): void => undefined;

function TaskManagerDemo(props: {
  theme: 'dark' | 'light';
  tab: TaskManagerTab;
  onTab: (tab: TaskManagerTab) => void;
  state: TaskState;
  live: boolean;
  onLive: (live: boolean) => void;
  log: (text: string) => void;
}): JSX.Element {
  return (
    <Window theme={props.theme} title="Task Manager" width={1240} height={760}>
      <TaskManagerView
        tab={props.tab}
        onTabChange={props.onTab}
        defaultSelectedPid={301}
        processes={props.state.processes}
        summary={SAMPLE_SUMMARY}
        performance={props.state.performance}
        memory={props.state.memory}
        predictions={props.state.predictions}
        scheduler={SAMPLE_SCHEDULER}
        ai={SAMPLE_AI}
        version="0.3.0"
        build="a1f93c2"
        paused={!props.live}
        onPauseChange={(paused) => props.onLive(!paused)}
        onSignal={(pid, signal) => props.log(`kill -s ${signal} ${pid}`)}
        onRenice={(pid, nice) => props.log(`renice ${nice} -p ${pid}`)}
        onPinChange={(pid, pinned) => props.log(`${pinned ? 'pin' : 'unpin'} ${pid}`)}
        onReclaim={() => props.log('reclaim now')}
        onCopy={(text) => props.log(`copy ${text}`)}
        onOpenSettings={(section) => props.log(`open Settings › ${section}`)}
        onOpenLog={() => props.log('ai log -n 20')}
        onRestartPredictor={noop}
      />
    </Window>
  );
}

function SettingsDemo(props: {
  theme: 'dark' | 'light';
  section: SettingsSectionId;
  onSection: (id: SettingsSectionId) => void;
  values: SettingValues;
  onValues: (next: SettingValues) => void;
  log: (text: string) => void;
  guest: boolean;
}): JSX.Element {
  return (
    <Window theme={props.theme} title="Settings" width={1080} height={760} zoomDisabled>
      <SettingsView
        section={props.section}
        onSectionChange={props.onSection}
        user={props.guest ? { name: 'guest', uid: 65534, guest: true } : SAMPLE_USER}
        values={props.values}
        about={SAMPLE_ABOUT}
        privacy={SAMPLE_PRIVACY}
        network={SAMPLE_NETWORK}
        users={SAMPLE_USERS}
        storage={SAMPLE_STORAGE}
        updates={SAMPLE_UPDATES}
        memory={SAMPLE_MEMORY_STATUS}
        bound={SAMPLE_BOUND}
        onChange={(change) => {
          props.onValues({ ...props.values, [change.key]: change.value });
          props.log(`set ${change.key} = ${String(change.value)}`);
        }}
        onAction={(action) => props.log(`action ${action}`)}
        onCopy={(label, value) => props.log(`copy ${label}: ${value}`)}
      />
    </Window>
  );
}

const STATES: readonly { state: ProcStateView; reason?: string }[] = [
  { state: 'NEW' },
  { state: 'READY' },
  { state: 'RUNNING' },
  { state: 'BLOCKED', reason: 'awaiting llm' },
  { state: 'SUSPENDED', reason: 'paged out' },
  { state: 'STOPPED' },
  { state: 'TERMINATED' },
];

const TONES: readonly SparkTone[] = ['accent', 'success', 'warning', 'danger', 'info', 'neutral'];

function ComponentsShowcase(): JSX.Element {
  const burn = SAMPLE_PROCESSES[0];
  const init = SAMPLE_PROCESSES[SAMPLE_PROCESSES.length - 1];
  return (
    <Grid min={300}>
      <Demo title="State pills" note="glyph + word + reason" column>
        <For each={STATES}>{(s) => <StatePill state={s.state} reason={s.reason} />}</For>
      </Demo>
      <Demo title="Sparklines" note="cheap SVG, tones" column>
        <For each={TONES}>
          {(tone, i) => (
            <div class={styles.spark}>
              <Caption>{tone}</Caption>
              <Sparkline
                values={SAMPLE_PERFORMANCE.executors[i() % 6]?.samples ?? []}
                tone={tone}
                area
              />
            </div>
          )}
        </For>
      </Demo>
      <Demo title="Frame time p95" note="ok · warn · bad" column>
        <FrameCard frame={SAMPLE_PERFORMANCE.frame} />
        <FrameCard frame={{ ...SAMPLE_PERFORMANCE.frame, p95Ms: 21.4 }} />
        <FrameCard frame={{ ...SAMPLE_PERFORMANCE.frame, p95Ms: 38.9, longFrames: 7 }} />
      </Demo>
      <Demo title="End Process" note="enabled · protected · pending" column>
        <EndProcessButton target={burn} onSignal={noop} onRequestKill={noop} />
        <EndProcessButton target={init} onSignal={noop} onRequestKill={noop} />
        <EndProcessButton target={burn} pending onSignal={noop} onRequestKill={noop} />
      </Demo>
      <Demo title="Budget bar" note="healthy · above high watermark" column>
        <BudgetBar
          segments={SAMPLE_MEMORY.segments.map((s) => ({ ...s, bytes: s.bytes * 0.62 }))}
          budgetBytes={SAMPLE_MEMORY.budgetBytes}
          lowWatermark={0.75}
          highWatermark={0.85}
          valueText="143 of 256 MB accounted, 56%"
        />
        <BudgetBar
          segments={SAMPLE_MEMORY.segments}
          budgetBytes={SAMPLE_MEMORY.budgetBytes}
          lowWatermark={0.75}
          highWatermark={0.85}
          valueText="231 of 256 MB accounted, 90%, above high watermark"
        />
      </Demo>
      <Demo title="Predictions" note="ready · learning · off" column>
        <PredictionsPanel predictions={SAMPLE_PREDICTIONS} />
        <PredictionsPanel predictions={{ ...SAMPLE_PREDICTIONS, state: 'cold', launches: 12 }} />
        <PredictionsPanel predictions={{ ...SAMPLE_PREDICTIONS, state: 'off' }} />
      </Demo>
    </Grid>
  );
}

export default function AppsBPage(): JSX.Element {
  const [preview, setPreview] = createSignal<PreviewTheme>('both');
  const [tab, setTab] = createSignal<TaskManagerTab>('processes');
  const [section, setSection] = createSignal<SettingsSectionId>('about');
  const [values, setValues] = createSignal<SettingValues>(DEFAULT_VALUES);
  const [guest, setGuest] = createSignal(false);
  const [events, setEvents] = createSignal<string[]>([]);
  const stream = createTaskStream();
  const log = (text: string): void => {
    setEvents((e) => [text, ...e].slice(0, 6));
  };
  const themes = (): ('dark' | 'light')[] =>
    preview() === 'both' ? ['dark', 'light'] : [preview() === 'dark' ? 'dark' : 'light'];

  return (
    <Page
      title="Task Manager & Settings"
      lead="The app views at their reference sizes, fed by sample models through props. Every control emits an intent (shown in the log); nothing here reads storage or the kernel."
    >
      <div class={styles.controls} role="group" aria-label="Preview options">
        <SegmentedControl
          label="Preview theme"
          size="sm"
          value={preview()}
          onChange={setPreview}
          options={[
            { value: 'both', label: 'Both themes' },
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
        <Toggle
          size="sm"
          label="Live data (1 Hz)"
          checked={stream.live()}
          onChange={stream.setLive}
        />
        <Toggle size="sm" label="Guest user" checked={guest()} onChange={setGuest} />
        <span class={styles.hint}>Reduce motion and transparency: gallery toolbar.</span>
      </div>
      <p class={styles.log} role="log" aria-label="Intents" aria-live="off">
        <Show when={events().length > 0} fallback="Intents appear here.">
          <For each={events()}>{(e) => <span>{e}</span>}</For>
        </Show>
      </p>

      <Section
        title="Task Manager"
        lead="Processes | Memory | Scheduler | AI. Select a row, then press End Process twice, or open the chevron for kill -9; Delete asks too; / focuses search; the status-bar pause stops every live motion."
      >
        <SegmentedControl
          label="Task Manager tab"
          value={tab()}
          onChange={setTab}
          options={TASK_MANAGER_TABS}
        />
        <For each={themes()}>
          {(theme) => (
            <TaskManagerDemo
              theme={theme}
              tab={tab()}
              onTab={setTab}
              state={stream.state}
              live={stream.live()}
              onLive={stream.setLive}
              log={log}
            />
          )}
        </For>
      </Section>

      <Section
        title="Settings"
        lead="System Settings layout: sidebar search (Ctrl+F), the user card, grouped sections, back and forward (Ctrl+[ and Ctrl+]). The Settings window has a fixed size, so its zoom light is hollow."
      >
        <Stack>
          <Select
            label="Section"
            value={section()}
            onChange={setSection}
            options={SECTIONS.map((s) => ({ value: s.id, label: s.label, icon: s.icon }))}
          />
        </Stack>
        <For each={themes()}>
          {(theme) => (
            <SettingsDemo
              theme={theme}
              section={section()}
              onSection={setSection}
              values={values()}
              onValues={setValues}
              log={log}
              guest={guest()}
            />
          )}
        </For>
      </Section>

      <Section title="Parts" lead="The building blocks on their own, in both themes.">
        <ThemeSplit wallpaper>{() => <ComponentsShowcase />}</ThemeSplit>
      </Section>
    </Page>
  );
}
