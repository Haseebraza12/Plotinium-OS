/**
 * Gallery: system overlays and the login screen (ui/src/overlays, ui/src/login). Every scene is
 * live: it runs on realistic sample data from docs/design/stitch, has its own Light/Dark switch
 * (a scoped [data-theme]) and a Replay button, and follows the gallery's Reduce motion and
 * Reduce transparency toggles.
 */
import CloudOff from 'lucide-solid/icons/cloud-off';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from 'solid-js';

import { AtomLogo } from '../../src/icons/index.tsx';
import { LOGIN_NOW, LOGIN_USERS } from '../../src/login/fixtures.ts';
import { LoginScreen, type LoginState } from '../../src/login/LoginScreen.tsx';
import {
  AgentConfirmSheet,
  type AgentConfirmStatus,
} from '../../src/overlays/agent-confirm/AgentConfirmSheet.tsx';
import {
  AGENT_BLAST,
  AGENT_POLICY,
  AGENT_REASONS,
  AGENT_REQUEST,
  AGENT_STEPS,
} from '../../src/overlays/agent-confirm/fixtures.ts';
import {
  FrameMeterHUD,
  type FrameMeterStats,
} from '../../src/overlays/frame-meter/FrameMeterHUD.tsx';
import { DEGRADED_SERVICES, QUEUED_OPS } from '../../src/overlays/offline/fixtures.ts';
import { LockBanner } from '../../src/overlays/offline/LockBanner.tsx';
import { OfflinePopover, type RetryState } from '../../src/overlays/offline/OfflinePopover.tsx';
import { Overview, type OverviewWindow } from '../../src/overlays/overview/Overview.tsx';
import {
  SEARCH_PREVIEWS,
  SEARCH_QUERY,
  SEARCH_RESULTS,
  SEARCH_STATS,
} from '../../src/overlays/search/fixtures.ts';
import {
  SearchPalette,
  type SearchResult,
  type SemanticState,
} from '../../src/overlays/search/SearchPalette.tsx';
import { AppSwitcher, type SwitcherItem } from '../../src/overlays/switcher/AppSwitcher.tsx';
import {
  SHUTDOWN_STEPS,
  UPDATE_CURRENT,
  UPDATE_NEXT,
  UPDATE_NOTES,
} from '../../src/overlays/update/fixtures.ts';
import { RestartToUpdateDialog } from '../../src/overlays/update/RestartToUpdateDialog.tsx';
import {
  ShutdownProgress,
  type ShutdownStep,
} from '../../src/overlays/update/ShutdownProgress.tsx';
import { Button } from '../../src/primitives/button/Button.tsx';
import { cx } from '../../src/primitives/internal/cx.ts';
import type { Rect } from '../../src/primitives/internal/position.ts';
import {
  SegmentedControl,
  type SegmentOption,
} from '../../src/primitives/segmented-control/SegmentedControl.tsx';
import { Toggle } from '../../src/primitives/toggle/Toggle.tsx';
import { Caption, Page, Section } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import styles from './overlays.module.css';

export const meta: GalleryPageMeta = {
  id: 'overlays',
  title: 'Overlays and login',
  group: 'System',
  order: 10,
  description:
    'Search, Overview, the window switcher, the agent confirmation, Restart to update, offline and lock states, the frame meter and the login screen.',
};

type ThemeChoice = 'light' | 'dark';
const THEMES: readonly SegmentOption<ThemeChoice>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/* ------------------------------------------------------------------------------------------ */
/* Scene: a wallpapered stage with its own theme switch and a Replay (re-mount) button.        */
/* ------------------------------------------------------------------------------------------ */

function Scene(props: {
  title: string;
  note?: string;
  theme: ThemeChoice;
  height: number;
  controls?: JSX.Element;
  children: () => JSX.Element;
}): JSX.Element {
  const [theme, setTheme] = createSignal<ThemeChoice>(untrack(() => props.theme));
  const [run, setRun] = createSignal(0);
  return (
    <div class={styles.scene}>
      <div class={styles.sceneBar}>
        <div class={styles.sceneTitle}>
          <h3>{props.title}</h3>
          <Show when={props.note}>
            <Caption>{props.note}</Caption>
          </Show>
        </div>
        <div class={styles.sceneControls}>
          {props.controls}
          <SegmentedControl
            label={`${props.title} theme`}
            options={THEMES}
            value={theme()}
            onChange={setTheme}
            size="sm"
          />
          <Button size="sm" onClick={() => setRun((n) => n + 1)}>
            Replay
          </Button>
        </div>
      </div>
      <div class={styles.stage} data-theme={theme()} style={{ height: `${props.height}px` }}>
        <Show keyed when={run() + 1}>
          {(_run) => props.children()}
        </Show>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Miniature windows (Overview thumbnails and the desktop behind the overlays).                */
/* ------------------------------------------------------------------------------------------ */

function MiniWindow(props: { title: string; children: JSX.Element; dark?: boolean }): JSX.Element {
  return (
    <div class={styles.mini} data-theme={props.dark === true ? 'dark' : undefined}>
      <div class={styles.miniBar}>
        <span class={styles.lights}>
          <span />
          <span />
          <span />
        </span>
        <span class={styles.miniTitle}>{props.title}</span>
      </div>
      <div class={styles.miniBody}>{props.children}</div>
    </div>
  );
}

const PS_ROWS = [
  ['1', '0', 'S', '1.2 MB', 'init'],
  ['7', '8', 'S', '2.4 MB', 'sched'],
  ['9', '8', 'S', '6.1 MB', 'vfs'],
  ['14', '16', 'S', '3.8 MB', 'syncd'],
  ['23', '32', 'R', '41.0 MB', 'ai.indexer'],
  ['31', '16', 'R', '4.6 MB', 'terminal'],
  ['35', '16', 'S', '12.3 MB', 'files'],
] as const;

function TerminalMini(): JSX.Element {
  return (
    <MiniWindow title="student@plotinium: ~" dark>
      <pre class={styles.term}>
        <span class={styles.prompt}>student@plotinium:~$</span> ps{'\n'}
        {'  PID PRI STATE     MEM  NAME\n'}
        <For each={PS_ROWS}>
          {(row) =>
            `${row[0].padStart(5)} ${row[1].padStart(3)}   ${row[2]}   ${row[3].padStart(7)}  ${row[4]}\n`
          }
        </For>
        <span class={styles.prompt}>student@plotinium:~$</span> nice -n 32 ai.indexer --status{'\n'}
        indexed 1,284 files · 0 errors · up to date{'\n'}
        <span class={styles.prompt}>student@plotinium:~$</span> <span class={styles.cursor} />
      </pre>
    </MiniWindow>
  );
}

function FilesMini(): JSX.Element {
  const files = [
    ['os-report.md', '14 KB', 'Today 10:31'],
    ['report.md', '9 KB', 'Today 10:40'],
    ['report (conflict from bob).md', '9 KB', 'Today 10:28'],
    ['lecture-07-scheduling.md', '22 KB', 'Yesterday'],
    ['lab3-vfs.png', '380 KB', '21 Sep'],
    ['todo.txt', '1 KB', 'Today 09:02'],
  ];
  return (
    <MiniWindow title="notes">
      <div class={styles.files}>
        <div class={styles.filesSide}>
          <span>Favourites</span>
          <span>student</span>
          <span>Documents</span>
          <span class={styles.sideOn}>notes</span>
          <span>Downloads</span>
        </div>
        <div class={styles.filesList}>
          <For each={files}>
            {(f, i) => (
              <div class={cx(styles.fileRow, i() === 0 && styles.fileOn)}>
                <span>{f[0]}</span>
                <span>{f[1]}</span>
                <span>{f[2]}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </MiniWindow>
  );
}

function EditorMini(): JSX.Element {
  return (
    <MiniWindow title="os-report.md">
      <div class={styles.doc}>
        <strong># OS Report — Process Scheduling</strong>
        <p>
          Plotinium schedules every app as a process. <code>sched</code> keeps a binary-heap ready
          queue ordered by priority, so <code>ai.indexer</code> (pid 23, priority 32) never delays{' '}
          <code>terminal</code>.
        </p>
        <strong>## Measurements</strong>
        <p>With 10 windows dragged and the frame meter on, p95 frame time stayed at 16.7 ms.</p>
        <strong>## Memory</strong>
        <p>Budget 256 MB; minimised windows are paged first when use reaches 85%.</p>
      </div>
    </MiniWindow>
  );
}

function TasksMini(): JSX.Element {
  return (
    <MiniWindow title="Task Manager">
      <div class={styles.tasks}>
        <For each={PS_ROWS.slice(0, 6)}>
          {(row) => (
            <div class={cx(styles.taskRow, row[4] === 'ai.indexer' && styles.fileOn)}>
              <span>{row[0]}</span>
              <span>{row[4]}</span>
              <span>{row[1]}</span>
              <span>{row[3]}</span>
            </div>
          )}
        </For>
        <div class={styles.memory}>
          <span class={styles.memoryFill} />
        </div>
        <span class={styles.memoryText}>142 / 256 MB</span>
      </div>
    </MiniWindow>
  );
}

function AboutMini(): JSX.Element {
  return (
    <MiniWindow title="About">
      <div class={styles.about}>
        <AtomLogo size={40} />
        <strong>Plotinium</strong>
        <code>Plotinium 0.3.0 · build a1f93c2</code>
        <span>Signed in as student (uid 1001)</span>
      </div>
    </MiniWindow>
  );
}

interface DesktopWindow extends Omit<OverviewWindow, 'thumbnail' | 'rect'> {
  /** Position on the stage in %, used to place the desktop window and its Overview zoom. */
  at: { x: number; y: number; w: number };
  mini: () => JSX.Element;
}

const DESKTOP: readonly DesktopWindow[] = [
  {
    id: 'files',
    title: 'Files — notes',
    app: 'files',
    appName: 'Files',
    aspect: 1.6,
    at: { x: 4, y: 12, w: 36 },
    mini: FilesMini,
  },
  {
    id: 'term',
    title: 'Terminal — ~',
    app: 'terminal',
    appName: 'Terminal',
    aspect: 1.5,
    at: { x: 34, y: 20, w: 34 },
    mini: TerminalMini,
  },
  {
    id: 'editor',
    title: 'Editor — os-report.md',
    app: 'editor',
    appName: 'Editor',
    aspect: 1.6,
    at: { x: 62, y: 8, w: 34 },
    mini: EditorMini,
  },
  {
    id: 'tasks',
    title: 'Task Manager',
    app: 'task-manager',
    appName: 'Task Manager',
    aspect: 1.8,
    at: { x: 10, y: 52, w: 34 },
    mini: TasksMini,
    state: 'minimised',
  },
  {
    id: 'about',
    title: 'Settings — About',
    app: 'settings',
    appName: 'Settings',
    aspect: 1.8,
    at: { x: 58, y: 50, w: 32 },
    mini: AboutMini,
  },
];

/* ------------------------------------------------------------------------------------------ */
/* Search                                                                                      */
/* ------------------------------------------------------------------------------------------ */

type SearchScenario = 'results' | 'loading' | 'empty' | 'error';

function SearchScene(): JSX.Element {
  const [scenario, setScenario] = createSignal<SearchScenario>('results');
  const [semantic, setSemantic] = createSignal<SemanticState>('on');
  const [log, setLog] = createSignal('Use ↑ ↓, Enter, Ctrl+Enter and Tab in the field.');
  return (
    <Scene
      title="Search palette"
      note="RAG-05, RAG-06 · Ctrl+Space"
      theme="dark"
      height={720}
      controls={
        <>
          <SegmentedControl
            label="Search state"
            size="sm"
            value={scenario()}
            onChange={setScenario}
            options={[
              { value: 'results', label: 'Results' },
              { value: 'loading', label: 'Loading' },
              { value: 'empty', label: 'Empty' },
              { value: 'error', label: 'Error' },
            ]}
          />
          <SegmentedControl
            label="Semantic model"
            size="sm"
            value={semantic()}
            onChange={setSemantic}
            options={[
              { value: 'on', label: 'Semantic' },
              { value: 'loading', label: 'Model loading' },
              { value: 'off', label: 'AI off' },
            ]}
          />
        </>
      }
    >
      {() => {
        const [open, setOpen] = createSignal(true);
        const queryFor = (s: SearchScenario): string => (s === 'empty' ? 'xyzzy' : SEARCH_QUERY);
        const [query, setQuery] = createSignal(untrack(() => queryFor(scenario())));
        createEffect(on(scenario, (s) => setQuery(queryFor(s)), { defer: true }));
        const [ai, setAi] = createSignal(false);
        const [active, setActive] = createSignal<string>();
        const results = createMemo<readonly SearchResult[]>(() => {
          if (scenario() === 'empty' || scenario() === 'loading') return [];
          const q = query().trim().toLowerCase();
          if (q === '' || SEARCH_QUERY.startsWith(q) || q === SEARCH_QUERY) return SEARCH_RESULTS;
          return SEARCH_RESULTS.filter((r) => r.title.toLowerCase().includes(q));
        });
        return (
          <>
            <DesktopBackdrop />
            <Show when={!open()}>
              <div class={styles.reopen}>
                <Button variant="primary" onClick={() => setOpen(true)}>
                  Open Search
                </Button>
                <Caption>{log()}</Caption>
              </div>
            </Show>
            <SearchPalette
              contained
              open={open()}
              onClose={(reason) => {
                setLog(`Closed (${reason}).`);
                setOpen(false);
              }}
              query={query()}
              onQueryChange={setQuery}
              results={results()}
              preview={SEARCH_PREVIEWS[active() ?? ''] ?? undefined}
              onActiveChange={(r) => setActive(r?.id)}
              onOpen={(r) => {
                setLog(`Open ${r.title}.`);
                setOpen(false);
              }}
              onReveal={(r) => {
                setLog(`Reveal ${r.citation ?? r.title} in Files.`);
                setOpen(false);
              }}
              onAskAgent={
                semantic() === 'off'
                  ? undefined
                  : (prompt, about) => {
                      setLog(
                        `ai "${prompt}"${about === undefined ? '' : ` about ${about.title}`} in a new Terminal.`,
                      );
                      setOpen(false);
                    }
              }
              aiMode={ai()}
              onAiModeChange={setAi}
              semantic={semantic()}
              loading={scenario() === 'loading'}
              progress={scenario() === 'loading' ? 0.5 : undefined}
              error={
                scenario() === 'error' ? 'Search failed — EIO. Showing keyword matches.' : undefined
              }
              stats={
                scenario() === 'results' || scenario() === 'error'
                  ? { ...SEARCH_STATS, count: results().length }
                  : undefined
              }
            />
          </>
        );
      }}
    </Scene>
  );
}

/** A dimmed desktop behind overlays: mini windows on the wallpaper. */
function DesktopBackdrop(props: { hidden?: boolean }): JSX.Element {
  return (
    <div
      class={styles.desktop}
      data-hidden={props.hidden === true ? 'true' : undefined}
      aria-hidden="true"
    >
      <For each={DESKTOP}>
        {(w) => (
          <div
            class={styles.desktopWindow}
            data-state={w.state}
            style={{
              left: `${w.at.x}%`,
              top: `${w.at.y}%`,
              width: `${w.at.w}%`,
              'aspect-ratio': String(w.aspect),
            }}
          >
            {w.mini()}
          </div>
        )}
      </For>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Overview and the window switcher                                                            */
/* ------------------------------------------------------------------------------------------ */

function OverviewScene(): JSX.Element {
  const [withDesktops, setWithDesktops] = createSignal(true);
  return (
    <Scene
      title="Overview"
      note="WM-07 · Alt+O · every window zooms from its rectangle"
      theme="dark"
      height={720}
      controls={
        <Toggle
          size="sm"
          label="Desktops strip"
          checked={withDesktops()}
          onChange={setWithDesktops}
        />
      }
    >
      {() => {
        let stage: HTMLDivElement | undefined;
        const [open, setOpen] = createSignal(false);
        const [selected, setSelected] = createSignal('term');
        const [rects, setRects] = createSignal<Record<string, Rect>>({});
        const [closed, setClosed] = createSignal<readonly string[]>([]);
        const show = (): void => {
          if (stage === undefined) return;
          const r = stage.getBoundingClientRect();
          const next: Record<string, Rect> = {};
          for (const w of DESKTOP) {
            const width = (w.at.w / 100) * r.width;
            next[w.id] = {
              x: r.left + (w.at.x / 100) * r.width,
              y: r.top + (w.at.y / 100) * r.height,
              width,
              height: width / w.aspect,
            };
          }
          setRects(next);
          setOpen(true);
        };
        onMount(() => requestAnimationFrame(show));
        const windows = createMemo<readonly OverviewWindow[]>(() =>
          DESKTOP.filter((w) => !closed().includes(w.id)).map((w) => ({
            id: w.id,
            title: w.title,
            app: w.app,
            appName: w.appName,
            aspect: w.aspect,
            state: w.state,
            rect: rects()[w.id],
            thumbnail: w.mini(),
          })),
        );
        return (
          <div ref={(el) => (stage = el)} class={styles.fill}>
            <DesktopBackdrop hidden={open()} />
            <Show when={!open()}>
              <div class={styles.reopen}>
                <Button variant="primary" onClick={show}>
                  Enter Overview
                </Button>
                <Caption>Picked: {selected()}</Caption>
              </div>
            </Show>
            <Overview
              contained
              open={open()}
              windows={windows()}
              selectedId={selected()}
              onSelect={setSelected}
              onPick={(id) => {
                setSelected(id);
                setOpen(false);
              }}
              onCancel={() => setOpen(false)}
              onCloseWindow={(id) => setClosed((list) => [...list, id])}
              onLaunch={() => setClosed([])}
              desktops={
                withDesktops()
                  ? [
                      { id: 'd1', name: 'Desktop 1', active: true, preview: <MiniDesktop /> },
                      { id: 'd2', name: 'Desktop 2' },
                    ]
                  : undefined
              }
              onAddDesktop={() => undefined}
            />
          </div>
        );
      }}
    </Scene>
  );
}

function MiniDesktop(): JSX.Element {
  return (
    <span class={styles.miniDesktop}>
      <For each={DESKTOP}>
        {(w) => (
          <span
            style={{
              left: `${w.at.x}%`,
              top: `${w.at.y}%`,
              width: `${w.at.w}%`,
              'aspect-ratio': String(w.aspect),
            }}
          />
        )}
      </For>
    </span>
  );
}

const SWITCHER: readonly SwitcherItem[] = [
  { id: 'files', title: 'Files — notes', app: 'files', appName: 'Files' },
  { id: 'term', title: 'Terminal — ~', app: 'terminal', appName: 'Terminal' },
  { id: 'editor', title: 'Editor — os-report.md', app: 'editor', appName: 'Editor' },
  {
    id: 'tasks',
    title: 'Task Manager',
    app: 'task-manager',
    appName: 'Task Manager',
    state: 'minimised',
  },
  { id: 'about', title: 'Settings — About', app: 'settings', appName: 'Settings' },
];

function SwitcherScene(): JSX.Element {
  return (
    <Scene
      title="Window switcher"
      note="WM-07 · Alt+` next · Alt+Shift+` previous"
      theme="dark"
      height={360}
    >
      {() => {
        const [open, setOpen] = createSignal(true);
        const [selected, setSelected] = createSignal('term');
        const [note, setNote] = createSignal('Focus the HUD and use ← →, Alt+`, Enter or Esc.');
        return (
          <>
            <DesktopBackdrop />
            <Show when={!open()}>
              <div class={styles.reopen}>
                <Button variant="primary" onClick={() => setOpen(true)}>
                  Show switcher
                </Button>
                <Caption>{note()}</Caption>
              </div>
            </Show>
            <AppSwitcher
              contained
              open={open()}
              items={SWITCHER}
              selectedId={selected()}
              onHighlight={setSelected}
              onCommit={(id) => {
                setNote(`Focused ${SWITCHER.find((i) => i.id === id)?.title ?? id}.`);
                setOpen(false);
              }}
              onCancel={() => {
                setNote('Cancelled; focus unchanged.');
                setOpen(false);
              }}
            />
          </>
        );
      }}
    </Scene>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Agent confirmation                                                                          */
/* ------------------------------------------------------------------------------------------ */

type AgentScenario = AgentConfirmStatus | 'over-quota';

function AgentScene(): JSX.Element {
  const [scenario, setScenario] = createSignal<AgentScenario>('ready');
  return (
    <Scene
      title="Agent confirmation sheet"
      note="AGT-03 · DSN-15 · DSN-16 · Cancel is the default"
      theme="dark"
      height={840}
      controls={
        <SegmentedControl
          label="Plan state"
          size="sm"
          value={scenario()}
          onChange={setScenario}
          options={[
            { value: 'ready', label: 'Ready' },
            { value: 'loading', label: 'Dry run' },
            { value: 'running', label: 'Running' },
            { value: 'over-quota', label: 'Over quota' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
      }
    >
      {() => {
        const [open, setOpen] = createSignal(true);
        const [result, setResult] = createSignal('');
        const status = (): AgentConfirmStatus =>
          scenario() === 'over-quota' ? 'ready' : (scenario() as AgentConfirmStatus);
        return (
          <div class={styles.centerWindow}>
            <div class={styles.window}>
              <div class={styles.windowBar}>
                <span class={styles.lights}>
                  <span />
                  <span />
                  <span />
                </span>
                <span class={styles.windowTitle}>student@plotinium: ~ — 120×36</span>
              </div>
              <div class={styles.tabs}>
                <span class={styles.tab}>
                  <span class={styles.tabDot} /> zsh-like shell — 1 <em>waiting</em>
                </span>
              </div>
              <div class={styles.windowContent}>
                <pre class={styles.term}>
                  <span class={styles.prompt}>student@plotinium:~$</span> du -sh ~/projects/*/build
                  {'\n'}
                  41M /home/student/projects{'\n'}
                  <span class={styles.prompt}>student@plotinium:~$</span> ai "{AGENT_REQUEST}"{'\n'}
                  ai: looking: find ~/projects -name build -type d{'\n'}⠿ planning with ai.agent…
                  {'\n'}
                  {result()}
                </pre>
                <Show when={!open()}>
                  <div class={styles.reopen}>
                    <Button variant="primary" onClick={() => setOpen(true)}>
                      Show confirmation
                    </Button>
                  </div>
                </Show>
                <AgentConfirmSheet
                  open={open()}
                  agent="ai.agent"
                  pid={212}
                  request={AGENT_REQUEST}
                  steps={AGENT_STEPS}
                  blast={status() === 'loading' ? undefined : AGENT_BLAST}
                  quota={
                    scenario() === 'over-quota'
                      ? { ok: false, text: 'over quota by 38 MB' }
                      : { ok: true, text: 'within quota · 1.2 GB free' }
                  }
                  runAs={{ user: 'student', uid: 1001 }}
                  reasons={AGENT_REASONS}
                  reasonsExpanded
                  policy={AGENT_POLICY}
                  provider="Claude via gateway"
                  status={status()}
                  progress={{ done: 3, total: 5 }}
                  rejection="Plan rejected: EACCES /system/bin — nothing ran"
                  onCancel={(reason) => {
                    setResult(reason === 'close' ? '' : '✗ declined — nothing ran');
                    setOpen(false);
                  }}
                  onRun={() => {
                    setResult('✓ committed in 41 ms · txn 8f2c · undo with: ai undo 8f2c');
                    setOpen(false);
                  }}
                  onEditPlan={() => setResult('Plan opened in Editor (read-write copy).')}
                  onOpenLog={() => setResult('ai log --request 8f2c')}
                />
              </div>
            </div>
          </div>
        );
      }}
    </Scene>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Restart to update                                                                           */
/* ------------------------------------------------------------------------------------------ */

const TOTAL_SERVICES = 18;

function shutdownSteps(stopped: number): readonly ShutdownStep[] {
  const done = Math.min(stopped, TOTAL_SERVICES);
  return SHUTDOWN_STEPS.map((step) => {
    if (step.id === 'services')
      return {
        ...step,
        state: done >= TOTAL_SERVICES ? 'done' : 'active',
        detail: `${done} / ${TOTAL_SERVICES}`,
        segments: { done, total: TOTAL_SERVICES },
        label: done >= TOTAL_SERVICES ? 'Stopped 18 services' : step.label,
      };
    if (step.id === 'activate')
      return { ...step, state: done >= TOTAL_SERVICES ? 'active' : 'pending' };
    return step;
  });
}

function UpdateScene(): JSX.Element {
  return (
    <Scene
      title="Restart to update"
      note="OFF-05 · BOOT-12 · Later has the initial focus"
      theme="light"
      height={660}
    >
      {() => {
        const [open, setOpen] = createSignal(true);
        const [auto, setAuto] = createSignal(true);
        const [stopped, setStopped] = createSignal(10);
        let timer: ReturnType<typeof setInterval> | undefined;
        const restart = (): void => {
          setOpen(false);
          setStopped(0);
          clearInterval(timer);
          timer = setInterval(() => {
            setStopped((n) => {
              if (n >= TOTAL_SERVICES) clearInterval(timer);
              return Math.min(TOTAL_SERVICES, n + 1);
            });
          }, 450);
        };
        onCleanup(() => clearInterval(timer));
        return (
          <div class={styles.fill}>
            <DesktopBackdrop />
            <div class={styles.dialogArea}>
              <Show when={!open()}>
                <div class={styles.reopen}>
                  <Button variant="primary" onClick={() => setOpen(true)}>
                    Restart to update
                  </Button>
                </div>
              </Show>
              <RestartToUpdateDialog
                contained
                class={styles.dialogLayer}
                open={open()}
                current={UPDATE_CURRENT}
                next={UPDATE_NEXT}
                notes={UPDATE_NOTES}
                onReleaseNotes={() => undefined}
                autoInstall={auto()}
                onAutoInstallChange={setAuto}
                onLater={() => setOpen(false)}
                onRestart={restart}
              />
            </div>
            <div class={styles.inset}>
              <span class={styles.insetLabel}>After “Restart Now”</span>
              <div data-theme="dark">
                <ShutdownProgress
                  title="Restarting Plotinium…"
                  percent={Math.round(30 + (stopped() / TOTAL_SERVICES) * 70)}
                  phase={stopped() >= TOTAL_SERVICES ? 'activating 0.3.1' : 'stopping services'}
                  stopped={Math.min(TOTAL_SERVICES, stopped() + 1)}
                  total={TOTAL_SERVICES}
                  verbose="Stopping services (reverse order) · flushing 3 dirty pages · saving session…"
                  steps={shutdownSteps(stopped())}
                  footer="Session saved for student (uid 1001) · 4 windows"
                  bound="≤ 8 s"
                />
              </div>
            </div>
          </div>
        );
      }}
    </Scene>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Offline, lock contention, frame meter                                                       */
/* ------------------------------------------------------------------------------------------ */

const STATS: FrameMeterStats = {
  refreshHz: 60,
  p95Ms: 14.2,
  droppedShare: 0.004,
  loafOurs: 0,
  loafOther: 1,
};

function OfflineScene(): JSX.Element {
  return (
    <Scene
      title="Offline and lock contention"
      note="OFF-01 · OFF-02 · OFF-04 · VFS-09 · WMD-19"
      theme="dark"
      height={620}
    >
      {() => {
        const [chip, setChip] = createSignal<HTMLButtonElement>();
        const [open, setOpen] = createSignal(false);
        const [retry, setRetry] = createSignal<RetryState>('idle');
        const [next, setNext] = createSignal(42);
        const [lease, setLease] = createSignal(11);
        const [notify, setNotify] = createSignal(false);
        const [nudge, setNudge] = createSignal(0);
        const [samples, setSamples] = createSignal<readonly number[]>(
          Array.from({ length: 60 }, (_, i) => (i % 17 === 9 ? 33.4 : 16.7)),
        );
        const [expanded, setExpanded] = createSignal(false);
        const tick = setInterval(() => {
          setNext((n) => (n <= 1 ? 60 : n - 1));
          setLease((n) => (n <= 0 ? 15 : n - 1));
          setSamples((list) => [...list.slice(1), Math.random() < 0.06 ? 33.4 : 16.7]);
        }, 1000);
        let probe: ReturnType<typeof setTimeout> | undefined;
        onCleanup(() => {
          clearInterval(tick);
          clearTimeout(probe);
        });
        return (
          <div class={styles.offline}>
            <div class={styles.menubar}>
              <span class={styles.menubarApp}>
                <AtomLogo size={16} /> <strong>Editor</strong> File Edit View Window Help
              </span>
              <button
                ref={setChip}
                type="button"
                class={styles.chip}
                aria-expanded={open() ? 'true' : 'false'}
                aria-haspopup="dialog"
                onClick={() => setOpen((v) => !v)}
              >
                <CloudOff size={13} stroke-width={2.2} aria-hidden="true" />
                Offline · 3 queued
              </button>
            </div>
            <OfflinePopover
              open={open()}
              onClose={() => setOpen(false)}
              anchor={chip()}
              queued={QUEUED_OPS}
              degraded={DEGRADED_SERVICES}
              retry={retry()}
              nextCheckS={next()}
              onRetry={() => {
                setRetry('checking');
                probe = setTimeout(() => setRetry('failed'), 3000);
              }}
              onOpenTaskManager={() => setOpen(false)}
              onOpenOp={() => undefined}
            />
            <div class={styles.banners}>
              <LockBanner
                holder={{ name: 'bob', uid: 1002 }}
                file="report.md"
                remainingS={lease()}
                ttlS={15}
                lease={{ mode: 'X', fence: 41, lastSeen: '14:31:02' }}
                notifying={notify()}
                onNotify={() => setNotify((v) => !v)}
                nudgeKey={nudge()}
              />
              <div class={styles.bannerRow}>
                <Button size="sm" onClick={() => setNudge((n) => n + 1)}>
                  Type into the read-only buffer
                </Button>
                <Caption>The banner nudges once; under reduced motion it stays still.</Caption>
              </div>
              <LockBanner
                holder={{ name: 'bob', uid: 1002 }}
                file="report.md"
                remainingS={0}
                ttlS={15}
                state="released"
                onOpenForWriting={() => undefined}
              />
              <LockBanner
                holder={{ name: 'student', uid: 1001 }}
                file="plan.md"
                remainingS={0}
                ttlS={15}
                state="expired"
              />
            </div>
            <div class={styles.meters}>
              <FrameMeterHUD
                contained
                stats={STATS}
                samples={samples()}
                expanded={expanded()}
                onToggleExpanded={() => setExpanded((v) => !v)}
              />
              <FrameMeterHUD
                contained
                stats={{ ...STATS, p95Ms: 21.4, droppedShare: 0.062, loafOurs: 2 }}
                samples={samples().map((s, i) => (i % 5 === 0 ? 33.4 : s))}
              />
              <FrameMeterHUD contained stats={undefined} samples={[]} />
            </div>
          </div>
        );
      }}
    </Scene>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Login                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function LoginScene(props: { theme: ThemeChoice }): JSX.Element {
  const [offline, setOffline] = createSignal(untrack(() => props.theme === 'dark'));
  return (
    <Scene
      title={props.theme === 'dark' ? 'Login — dark' : 'Login — light'}
      note="BOOT-14 · OFF-03 · try any password; “hunter2” unlocks"
      theme={props.theme}
      height={760}
      controls={<Toggle size="sm" label="Offline" checked={offline()} onChange={setOffline} />}
    >
      {() => {
        const [selected, setSelected] = createSignal('student');
        const [state, setState] = createSignal<LoginState>('idle');
        const [unlocked, setUnlocked] = createSignal(false);
        const [errorKey, setErrorKey] = createSignal(0);
        const [attempts, setAttempts] = createSignal(0);
        const [retryIn, setRetryIn] = createSignal(0);
        const [now, setNow] = createSignal(LOGIN_NOW);
        const clock = setInterval(() => setNow((d) => new Date(d.getTime() + 60_000)), 4000);
        let countdown: ReturnType<typeof setInterval> | undefined;
        let verify: ReturnType<typeof setTimeout> | undefined;
        onCleanup(() => {
          clearInterval(clock);
          clearInterval(countdown);
          clearTimeout(verify);
        });
        const fail = (): void => {
          const n = attempts() + 1;
          setAttempts(n);
          if (n >= 3) {
            setState('rate-limited');
            setRetryIn(28);
            countdown = setInterval(() => {
              setRetryIn((s) => {
                if (s <= 1) {
                  clearInterval(countdown);
                  setAttempts(0);
                  setState('idle');
                  return 0;
                }
                return s - 1;
              });
            }, 1000);
            return;
          }
          setState('error');
          setErrorKey((k) => k + 1);
        };
        return (
          <Show
            when={!unlocked()}
            fallback={
              <div class={styles.unlocked}>
                <AtomLogo size={52} />
                <p>Unlocked — the desktop mounts here.</p>
                <Button
                  variant="primary"
                  onClick={() => {
                    setState('idle');
                    setUnlocked(false);
                  }}
                >
                  Lock again
                </Button>
              </div>
            }
          >
            <LoginScreen
              contained
              users={
                offline()
                  ? LOGIN_USERS.map((u) =>
                      u.id === 'bob'
                        ? {
                            ...u,
                            disabled: true,
                            disabledReason: 'Needs network (no saved verifier)',
                          }
                        : u,
                    )
                  : LOGIN_USERS.map((u) => (u.id === 'student' ? { ...u, signedIn: true } : u))
              }
              selectedId={selected()}
              onSelectUser={setSelected}
              now={now()}
              state={state()}
              stage="Checking password"
              errorKey={errorKey()}
              errorText={
                attempts() >= 2
                  ? 'Invalid username or password — 1 attempt before a 30 s wait'
                  : undefined
              }
              retryInS={retryIn()}
              offline={offline()}
              sessions={offline() ? undefined : 1}
              sessionsDetail="student — since 08:15"
              status={{ wifi: offline() ? 'off' : 'on', battery: 82, layout: 'EN' }}
              version="0.3.0"
              build="a1f93c2"
              language="English"
              onSubmit={(_user, password) => {
                setState('verifying');
                verify = setTimeout(() => {
                  if (password === 'hunter2') setState('unlocking');
                  else fail();
                }, 900);
              }}
              onContinueWithout={() => setState('unlocking')}
              onUnlocked={() => setUnlocked(true)}
              onSleep={() => undefined}
              onRestart={() => undefined}
              onShutDown={() => undefined}
              onForgotPassword={() => undefined}
              onAccessibility={() => undefined}
              onLanguage={() => undefined}
            />
          </Show>
        );
      }}
    </Scene>
  );
}

/* ------------------------------------------------------------------------------------------ */

export default function OverlaysPage(): JSX.Element {
  return (
    <Page
      title="Overlays and login"
      lead="System overlays over a live desktop, pixel-matched to docs/design/stitch. Each scene has its own Light/Dark switch and a Replay button; the toolbar's Reduce motion and Reduce transparency apply to all of them. Popovers are portalled to the page, so they follow the gallery theme."
    >
      <Section
        title="Search"
        lead="Grouped results with path:line citations and relevance, a preview, AI mode on Tab, and the keyword fallback while the model loads."
      >
        <SearchScene />
      </Section>
      <Section
        title="Overview and switcher"
        lead="Enter Overview zooms each window from its desktop rectangle into its slot (transform only) and back."
      >
        <OverviewScene />
        <SwitcherScene />
      </Section>
      <Section
        title="Agent confirmation"
        lead="The kernel's sheet on the secure layer: plan, blast radius, why, and Cancel as the default. Only Ctrl+Enter or a click runs the plan."
      >
        <AgentScene />
      </Section>
      <Section
        title="Restart to update"
        lead="Later is focused first; Restart Now hands off to the ordered, determinate shutdown (it plays in the inset)."
      >
        <UpdateScene />
      </Section>
      <Section
        title="Offline, locks and the frame meter"
        lead="Click the amber chip for the queued outbox and degraded services. The lease counts down in text, on a ring and on a draining bar."
      >
        <OfflineScene />
      </Section>
      <Section
        title="Login"
        lead="Arrow keys choose a user; Enter signs in; three wrong passwords start the back-off. Restart and Shut Down ask first."
      >
        <LoginScene theme="dark" />
        <LoginScene theme="light" />
      </Section>
    </Page>
  );
}
