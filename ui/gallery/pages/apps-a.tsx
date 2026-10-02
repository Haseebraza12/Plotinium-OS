/**
 * Gallery: Files, Editor and Terminal (ui-apps-a). Each app runs inside the shell's
 * WindowFrame with realistic data from the designs (files-light, files-semantic-search,
 * editor-conflict, terminal-ai), in light, dark or both. The gallery header holds the global
 * theme, reduced-motion and reduced-transparency switches.
 */
import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js';

import { DocumentTabs, type DocumentTab } from '../../src/apps/editor/DocumentTabs.tsx';
import { EditorApp } from '../../src/apps/editor/EditorApp.tsx';
import { ConflictBanner, type ConflictState } from '../../src/apps/editor/EditorBanner.tsx';
import { EditorStatusBar } from '../../src/apps/editor/EditorStatusBar.tsx';
import { LockChip, type LockState } from '../../src/apps/editor/LockChip.tsx';
import { FilesStatusBar } from '../../src/apps/files/FilesStatusBar.tsx';
import { FilesView, type FilesIntent, type FilesResults } from '../../src/apps/files/FilesView.tsx';
import { sortEntries } from '../../src/apps/files/format.ts';
import type {
  FileEntry,
  FileSort,
  SearchMode,
  SemanticHit,
  ViewMode,
} from '../../src/apps/files/types.ts';
import {
  CRLF,
  formatAgentNote,
  formatConfirmationBlock,
  formatOutcome,
  formatPrompt,
  toTerminalText,
  type PlanOutcome,
} from '../../src/apps/terminal/ansi.ts';
import { TerminalApp, type TerminalSessionTab } from '../../src/apps/terminal/TerminalApp.tsx';
import type { TerminalHandle } from '../../src/apps/terminal/TerminalHost.tsx';
import {
  TerminalStatusStrip,
  type AgentStatus,
  type TxnStatus,
} from '../../src/apps/terminal/TerminalStatusStrip.tsx';
import { WindowFrame } from '../../src/shell/window/WindowFrame.tsx';
import { Button } from '../../src/primitives/button/Button.tsx';
import { SegmentedControl } from '../../src/primitives/segmented-control/SegmentedControl.tsx';
import { Caption, Demo, Grid, Page, Section, Stack } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import {
  AI_REQUEST,
  DOCUMENTS,
  EDITOR_DOCS,
  EDITOR_FILES,
  FAVOURITES,
  HIT_ENTRIES,
  HITS,
  LOCATIONS,
  NOW,
  PLAN,
  QUOTA,
  QUOTA_NEARLY_FULL,
  README,
  REPORT,
  SCHEDULER,
  TAGS,
} from './apps-a.data.ts';
import styles from './apps-a.module.css';

export const meta: GalleryPageMeta = {
  id: 'apps-a',
  title: 'Files, Editor & Terminal',
  group: 'Apps',
  order: 10,
  description:
    'Files (list, icons, semantic search, inspector), the Editor with a sync conflict and a remote lock, and the Terminal with an agent plan.',
};

type Theme = 'light' | 'dark';
type PreviewTheme = 'both' | Theme;

const noop = (): void => undefined;

/** One app in a WindowFrame on the wallpaper, in a forced theme. */
function AppWindow(props: {
  theme: Theme;
  title: string;
  appName: string;
  height?: number;
  toolbar?: JSX.Element;
  hideTitle?: boolean;
  /** Unified chrome: the view draws its own toolbar and full-height sidebar. */
  titlebar?: 'standard' | 'overlay';
  children: JSX.Element;
}): JSX.Element {
  return (
    <div data-theme={props.theme} class={styles.stage}>
      <span class={styles.themeLabel}>{props.theme === 'light' ? 'Light' : 'Dark'}</span>
      <div class={styles.frameBox} style={{ height: `${props.height ?? 680}px` }}>
        <WindowFrame
          title={props.title}
          appName={props.appName}
          focused
          hideTitle={props.hideTitle}
          toolbar={props.toolbar}
          titlebar={props.titlebar}
          resizable={false}
          style={{ width: '100%', height: '100%' }}
          onClose={noop}
          onMinimise={noop}
          onMaximize={noop}
        >
          {props.children}
        </WindowFrame>
      </div>
    </div>
  );
}

/** Renders a demo once per selected theme. */
function Themed(props: {
  preview: PreviewTheme;
  children: (theme: Theme) => JSX.Element;
}): JSX.Element {
  const themes = (): Theme[] => (props.preview === 'both' ? ['light', 'dark'] : [props.preview]);
  return (
    <div class={styles.stack}>
      <For each={themes()}>{(theme) => props.children(theme)}</For>
    </div>
  );
}

function IntentLog(props: { text: string }): JSX.Element {
  return (
    <p class={styles.log} aria-live="polite">
      <span class={styles.logLabel}>Last intent</span> <code>{props.text}</code>
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

type Scenario = 'semantic' | 'model-loading' | 'unavailable' | 'searching' | 'empty' | 'error';

const SCENARIOS: readonly { value: Scenario; label: string }[] = [
  { value: 'semantic', label: 'Semantic' },
  { value: 'model-loading', label: 'Model loading' },
  { value: 'unavailable', label: 'Unavailable' },
  { value: 'searching', label: 'Searching' },
  { value: 'empty', label: 'No matches' },
  { value: 'error', label: 'Error' },
];

function resultsFor(scenario: Scenario): FilesResults {
  const status = { results: 4, indexedFiles: 1284, indexer: { pid: 23, priority: 32 } };
  switch (scenario) {
    case 'semantic':
      return { mode: 'semantic', hits: HITS, elapsedMs: 184, status };
    case 'model-loading':
      return {
        mode: 'keyword',
        hits: HITS.slice(0, 3),
        elapsedMs: 41,
        notices: [
          { kind: 'model-loading', progress: 0.6 },
          { kind: 'shared-hidden', count: 1 },
        ],
        status: { ...status, results: 3, paused: true },
      };
    case 'unavailable':
      return {
        mode: 'keyword',
        hits: HITS.slice(0, 2),
        elapsedMs: 38,
        notices: [{ kind: 'unavailable' }],
        status: { ...status, results: 2 },
      };
    case 'searching':
      return { mode: 'semantic', hits: [], loading: true };
    case 'empty':
      return { mode: 'semantic', hits: [], elapsedMs: 122, status: { ...status, results: 0 } };
    case 'error':
      return {
        mode: 'semantic',
        hits: [],
        error: { code: 'EIO', message: 'The search index is being rebuilt' },
      };
  }
}

function FilesDemo(props: {
  theme: Theme;
  initialQuery?: string;
  scenario?: Scenario;
  initialView?: ViewMode;
}): JSX.Element {
  const [path, setPath] = createSignal('/home/student/Documents');
  const [back, setBack] = createSignal<string[]>([]);
  const [forward, setForward] = createSignal<string[]>([]);
  const [view, setView] = createSignal<ViewMode>(props.initialView ?? 'list');
  const [sort, setSort] = createSignal<FileSort>({ key: 'name', direction: 'ascending' });
  const [query, setQuery] = createSignal(props.initialQuery ?? '');
  const [submitted, setSubmitted] = createSignal(props.initialQuery !== undefined);
  const [mode, setMode] = createSignal<SearchMode>('semantic');
  const [hit, setHit] = createSignal<string | undefined>('week6');
  const [tags, setTags] = createSignal<ReadonlySet<string>>(new Set());
  const [log, setLog] = createSignal('—');
  const semantic = (): boolean => props.scenario !== undefined;

  const title = (): string => (semantic() ? 'notes' : (path().split('/').pop() ?? '/') || '/');
  const entries = (): FileEntry[] => {
    const filter = tags();
    const list =
      filter.size === 0
        ? DOCUMENTS
        : DOCUMENTS.filter((e) => e.tags?.some((t) => filter.has(t)) === true);
    return sortEntries(list, sort());
  };
  const navigate = (next: string): void => {
    if (next === path()) return;
    setBack([...back(), path()]);
    setForward([]);
    setPath(next);
    setLog(`navigate ${next}`);
  };
  const results = (): FilesResults | undefined => {
    if (props.scenario !== undefined) return resultsFor(props.scenario);
    if (!submitted() || query() === '') return undefined;
    return { ...resultsFor('semantic'), mode: mode() };
  };

  return (
    <Stack>
      <AppWindow theme={props.theme} title={title()} appName="Files" titlebar="overlay">
        <FilesView
          titlebarInset
          title={title()}
          path={semantic() ? '/home/student/notes' : path()}
          onNavigate={navigate}
          canBack={back().length > 0}
          canForward={forward().length > 0}
          onBack={() => {
            const prev = back().at(-1);
            if (prev === undefined) return;
            setBack(back().slice(0, -1));
            setForward([path(), ...forward()]);
            setPath(prev);
          }}
          onForward={() => {
            const [next, ...rest] = forward();
            if (next === undefined) return;
            setForward(rest);
            setBack([...back(), path()]);
            setPath(next);
          }}
          favourites={FAVOURITES}
          locations={LOCATIONS}
          tags={TAGS}
          selectedPlace={semantic() ? 'home' : 'documents'}
          onPlace={(id) => {
            const place = [...FAVOURITES, ...LOCATIONS].find((p) => p.id === id);
            if (place !== undefined) navigate(place.path);
          }}
          activeTags={tags()}
          onToggleTag={(id) => {
            const next = new Set(tags());
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setTags(next);
          }}
          quota={QUOTA}
          entries={entries()}
          view={view()}
          onView={setView}
          sort={sort()}
          onSort={setSort}
          viewer={{ user: 'student' }}
          folderWritable
          now={NOW}
          onAction={(intent: FilesIntent, targets: readonly FileEntry[]) =>
            setLog(`${intent} ${targets.map((t) => t.name).join(', ')}`)
          }
          query={query()}
          onQuery={(q) => {
            setQuery(q);
            if (q === '') setSubmitted(false);
          }}
          onSubmit={() => setSubmitted(true)}
          searchMode={
            props.scenario === 'model-loading' || props.scenario === 'unavailable'
              ? 'keyword'
              : mode()
          }
          onSearchMode={setMode}
          onSearchFocus={(focused) => focused && setLog('ai.search.focus {on: true}')}
          results={results()}
          selectedHit={hit()}
          onSelectHit={setHit}
          onOpenHit={(h: SemanticHit) => setLog(`open ${h.path} at line ${h.lineStart}`)}
          onSearchAll={() => setLog('search all of Home')}
          onRetry={() => setLog('retry')}
          hitEntries={HIT_ENTRIES}
          onInspectorAction={(action, entry) => setLog(`${action} ${entry?.name ?? ''}`)}
          onShare={(list) => setLog(`share ${list.map((e) => e.name).join(', ')}`)}
          user="student"
        />
      </AppWindow>
      <IntentLog text={log()} />
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

const LEASE_MS = 30_000;

function EditorDemo(props: { theme: Theme }): JSX.Element {
  const [selected, setSelected] = createSignal('os-report');
  const [conflict, setConflict] = createSignal<ConflictState | undefined>({
    kind: 'conflict',
    copyName: 'os-report (conflict from student, 2026-09-24).md',
    offline: true,
  });
  const [lock, setLock] = createSignal<LockState>({
    kind: 'other',
    holder: 'alice',
    expiresAt: Date.now() + 12_000,
    leaseMs: LEASE_MS,
    fence: 41,
  });
  const [attempts, setAttempts] = createSignal(0);
  const [log, setLog] = createSignal('—');
  // alice's client renews every TTL/3 (VFS-09); the chip pulses and its ring refills.
  const renew = setInterval(() => {
    const state = lock();
    if (state.kind === 'other') setLock({ ...state, expiresAt: Date.now() + LEASE_MS });
  }, 10_000);
  onCleanup(() => clearInterval(renew));
  const holder = (): string | undefined => {
    const state = lock();
    return state.kind === 'other' ? state.holder : undefined;
  };
  const docText = (): string =>
    selected() === 'scheduler' ? SCHEDULER : selected() === 'readme' ? README : REPORT;
  const docs = (): typeof EDITOR_DOCS =>
    EDITOR_DOCS.map((d) =>
      d.id === 'os-report' && conflict()?.kind !== 'conflict' ? { ...d, state: 'clean' } : d,
    );

  return (
    <Stack>
      <AppWindow
        theme={props.theme}
        title="os-report.md — ~/notes"
        appName="Editor"
        toolbar={
          <div class={styles.titleAccessory}>
            <LockChip
              state={lock()}
              attemptKey={attempts()}
              onActivate={() => setLog('lock popover: Request edit access · Notify me when free')}
            />
          </div>
        }
      >
        <EditorApp
          documents={docs()}
          selected={selected()}
          onSelect={setSelected}
          onClose={(id) => setLog(`close ${id}`)}
          onNew={() => setLog('new document')}
          doc={docText()}
          lockHolder={selected() === 'os-report' ? holder() : undefined}
          conflict={selected() === 'os-report' ? conflict() : undefined}
          onConflictAction={(action) => {
            setLog(`conflict: ${action}`);
            if (action === 'compare') setConflict({ kind: 'checking' });
          }}
          onConflictDismiss={() => setConflict(undefined)}
          folder="/home/student/notes"
          files={EDITOR_FILES}
          selectedFile={selected() === 'os-report' ? 'os-report' : undefined}
          onFileSelect={(id) => setLog(`open ${id}`)}
          save={{ kind: 'saved', version: 8 }}
          sync={
            conflict()?.kind === 'conflict' ? { kind: 'conflict', count: 1 } : { kind: 'synced' }
          }
          cursor={{ line: 42, col: 7 }}
          onSave={() => setLog('save')}
          onAskAi={() => setLog('ask AI')}
          onReadOnlyAttempt={() => setAttempts((n) => n + 1)}
          scheme={props.theme}
        />
      </AppWindow>
      <div class={styles.controls}>
        <Button
          size="sm"
          onClick={() =>
            setLock({
              kind: 'other',
              holder: 'alice',
              expiresAt: Date.now() + LEASE_MS,
              leaseMs: LEASE_MS,
              fence: 42,
            })
          }
        >
          alice renews the lease
        </Button>
        <Button size="sm" onClick={() => setLock({ kind: 'released', holder: 'alice' })}>
          alice releases the lock
        </Button>
        <Button size="sm" onClick={() => setLock({ kind: 'mine' })}>
          I hold the lock
        </Button>
        <Button size="sm" onClick={() => setConflict({ kind: 'resolved', version: 8 })}>
          Resolve conflict
        </Button>
        <Button size="sm" onClick={() => setConflict({ kind: 'error', retryInSeconds: 4 })}>
          Server unreachable
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setConflict({
              kind: 'conflict',
              copyName: 'os-report (conflict from student, 2026-09-24).md',
              offline: true,
            })
          }
        >
          Replay conflict
        </Button>
      </div>
      <IntentLog text={log()} />
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------------------------

const PROMPT = formatPrompt({ user: 'student', host: 'plotinium', cwd: '~' });

function session(outcome: PlanOutcome, cols: number): string {
  const lines = [
    `${PROMPT}ls ~/notes`,
    'os-report.md   sched-notes.md   lab3-vfs.pdf   todo.txt',
    '',
    `${PROMPT}${AI_REQUEST}`,
    formatAgentNote(
      'looking',
      'find ~ -type f -name "*.pdf" (changed 2026-09-17 → 2026-09-24) … 12 files · 38 ms',
    ),
    ...formatConfirmationBlock(PLAN, Math.max(60, Math.min(cols, 110))),
  ];
  const answer = outcome.kind === 'committed' ? 'y' : outcome.kind === 'declined' ? 'N' : '';
  return `${toTerminalText(lines)}${answer}${CRLF}${formatOutcome(outcome)}${CRLF}${CRLF}${PROMPT}`;
}

const OUTCOMES: readonly { value: PlanOutcome['kind']; label: string }[] = [
  { value: 'committed', label: 'Confirmed' },
  { value: 'declined', label: 'Declined' },
  { value: 'rejected', label: 'Rejected' },
];

function outcomeOf(kind: PlanOutcome['kind']): PlanOutcome {
  switch (kind) {
    case 'committed':
      return { kind: 'committed', ms: 41, txn: '8f2c' };
    case 'declined':
      return { kind: 'declined' };
    case 'rejected':
      return { kind: 'rejected', reason: 'EAGAIN changed-since' };
    case 'committed-offline':
      return { kind: 'committed-offline', txn: '8f2c' };
    case 'timeout':
      return { kind: 'timeout' };
  }
}

function TerminalDemo(props: { theme: Theme }): JSX.Element {
  const [sessions, setSessions] = createSignal<TerminalSessionTab[]>([
    { id: 't1', label: 'zsh-like shell — 1' },
  ]);
  const [selected, setSelected] = createSignal('t1');
  const [outcome, setOutcome] = createSignal<PlanOutcome['kind']>('committed');
  const handles = new Map<string, TerminalHandle>();
  const txn = (): TxnStatus | undefined =>
    outcome() === 'committed' ? { id: '8f2c', state: 'committed' } : undefined;

  const play = (id: string): void => {
    const handle = handles.get(id);
    if (handle === undefined) return;
    handle.reset();
    handle.write(id === 't1' ? session(outcomeOf(outcome()), handle.size().cols) : PROMPT);
  };

  return (
    <Stack>
      <AppWindow
        theme={props.theme}
        title="student@plotinium: ~ — 120×36"
        appName="Terminal"
        height={620}
      >
        <TerminalApp
          title="student@plotinium: ~"
          sessions={sessions()}
          selected={selected()}
          onSelect={setSelected}
          onNew={() => {
            const n = sessions().length + 1;
            const id = `t${Date.now()}`;
            setSessions([...sessions(), { id, label: `zsh-like shell — ${n}` }]);
            setSelected(id);
          }}
          onClose={(id) => {
            if (sessions().length === 1) return;
            const rest = sessions().filter((s) => s.id !== id);
            setSessions(rest);
            if (selected() === id) setSelected(rest[0]?.id ?? 't1');
          }}
          cwd="/home/student"
          agent={{ state: 'running', pid: 212, route: 'Claude via gateway' }}
          txn={txn()}
          fontSize={13}
          onReady={(id, handle) => {
            handles.set(id, handle);
            play(id);
          }}
          onData={(id, data) => {
            // Gallery echo only: the real line discipline is the kernel TTY's.
            const handle = handles.get(id);
            if (handle === undefined) return;
            if (data === '\r') handle.write(`${CRLF}${PROMPT}`);
            else if (data === '\u007f') handle.write('\b \b');
            else handle.write(data);
          }}
        />
      </AppWindow>
      <div class={styles.controls}>
        <SegmentedControl
          label="Plan outcome"
          size="sm"
          options={OUTCOMES}
          value={outcome()}
          onChange={(value) => {
            setOutcome(value);
            play('t1');
          }}
        />
        <Button size="sm" onClick={() => play('t1')}>
          Replay session
        </Button>
      </div>
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------
// Component states
// ---------------------------------------------------------------------------------------------

function LockChipStates(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const start = Date.now();
  /** A lease that `left` ms from now runs out, then is renewed for a full lease, forever. */
  const renewing = (left: number): number => {
    const elapsed = now() - start;
    return start + left + Math.max(0, Math.ceil((elapsed - left) / LEASE_MS)) * LEASE_MS;
  };
  return (
    <Stack>
      <LockChip
        state={{
          kind: 'other',
          holder: 'alice',
          expiresAt: renewing(12_000),
          leaseMs: LEASE_MS,
          fence: 41,
        }}
      />
      <LockChip
        state={{ kind: 'other', holder: 'bob', expiresAt: renewing(4_000), leaseMs: LEASE_MS }}
      />
      <LockChip state={{ kind: 'mine' }} />
      <LockChip state={{ kind: 'released', holder: 'alice' }} />
    </Stack>
  );
}

const TAB_SAMPLE: DocumentTab[] = [
  { id: 'a', label: 'os-report.md', badge: 'MD', state: 'conflict' },
  { id: 'b', label: 'scheduler.ts', badge: 'TS', state: 'dirty' },
  { id: 'c', label: 'README.md', badge: 'MD' },
];

function ComponentStates(props: { theme: Theme }): JSX.Element {
  const [tab, setTab] = createSignal('a');
  const [termTab, setTermTab] = createSignal('1');
  const agents: readonly AgentStatus[] = [
    { state: 'running', pid: 212, route: 'Claude via gateway' },
    { state: 'waiting', pid: 212, on: 'net:llm' },
    { state: 'idle' },
    { state: 'unavailable' },
  ];
  return (
    <div data-theme={props.theme} class={styles.componentPane}>
      <span class={styles.themeLabel}>{props.theme === 'light' ? 'Light' : 'Dark'}</span>
      <Grid min={320}>
        <Demo title="Lock chip" note="lease ring, expiring, mine, released" column>
          <LockChipStates />
        </Demo>
        <Demo title="Document tabs" note="conflict dot, unsaved dot, pill tabs" column>
          <div class={styles.surface}>
            <DocumentTabs
              label="Open files"
              tabs={TAB_SAMPLE}
              selected={tab()}
              onSelect={setTab}
              onClose={noop}
              onNew={noop}
            />
          </div>
          <div class={styles.surface}>
            <DocumentTabs
              variant="terminal"
              label="Terminal tabs"
              tabs={[
                { id: '1', label: 'zsh-like shell — 1' },
                { id: '2', label: 'zsh-like shell — 2', activity: 'output' },
                { id: '3', label: 'zsh-like shell — 3', activity: 'bell' },
              ]}
              selected={termTab()}
              onSelect={setTermTab}
              onClose={noop}
              onNew={noop}
            />
          </div>
        </Demo>
        <Demo title="Conflict banner" note="conflict, checking, resolved, error" column>
          <div class={styles.surface}>
            <ConflictBanner
              state={{ kind: 'conflict', copyName: 'report (conflict from alice, 2026-11-14).md' }}
              onAction={noop}
              onDismiss={noop}
            />
            <ConflictBanner state={{ kind: 'checking' }} onAction={noop} />
            <ConflictBanner state={{ kind: 'resolved', version: 8 }} onAction={noop} />
            <ConflictBanner state={{ kind: 'error', retryInSeconds: 4 }} onAction={noop} />
          </div>
        </Demo>
        <Demo title="Status bars" note="save and sync states, quota levels, indexing" column>
          <div class={styles.surface}>
            <EditorStatusBar
              line={42}
              col={7}
              language="Markdown"
              save={{ kind: 'saved', version: 8 }}
              sync={{ kind: 'synced' }}
              onAskAi={noop}
            />
            <EditorStatusBar
              line={3}
              col={1}
              language="TypeScript"
              save={{ kind: 'queued', queued: 1 }}
              sync={{ kind: 'offline', queued: 3 }}
              readOnly
            />
            <FilesStatusBar
              items={42}
              quota={QUOTA}
              user="student"
              path="/home/student/Documents"
            />
            <FilesStatusBar
              items={42}
              selected={1}
              selectedSize={1.8 * 1024 * 1024}
              quota={QUOTA_NEARLY_FULL}
              user="student"
              path="/home/student/Documents"
            />
            <FilesStatusBar
              items={0}
              user="student"
              path="/home/student/notes"
              search={{ results: 4, indexedFiles: 1284, indexing: { done: 12, total: 40 } }}
            />
          </div>
        </Demo>
        <Demo title="Terminal status strip" note="agent states in words and colour" column>
          <div class={styles.surface}>
            <For each={agents}>
              {(agent, i) => (
                <TerminalStatusStrip
                  agent={agent}
                  txn={
                    i() === 0
                      ? { id: '8f2c', state: 'committed' }
                      : i() === 1
                        ? { id: '8f2c', state: 'syncing' }
                        : undefined
                  }
                  cols={120}
                  rows={36}
                  cwd="/home/student"
                />
              )}
            </For>
          </div>
        </Demo>
      </Grid>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export default function AppsAPage(): JSX.Element {
  const [preview, setPreview] = createSignal<PreviewTheme>('both');
  const [scenario, setScenario] = createSignal<Scenario>('semantic');
  return (
    <Page
      title="Files, Editor & Terminal"
      lead="The three document apps inside real window chrome. Every control works: select, sort, right-click, search, switch tabs, type into the locked editor, answer the plan. Use the header switches for reduced motion and reduced transparency."
    >
      <div class={styles.toolbar}>
        <SegmentedControl
          label="Preview theme"
          size="sm"
          options={[
            { value: 'both', label: 'Both' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={preview()}
          onChange={setPreview}
        />
        <Caption>Themes are scoped with [data-theme], so both render side by side.</Caption>
      </div>

      <Section
        title="Files — list view"
        lead="files-light: sortable Name, Date Modified, Size, Kind and Permissions (monospace), folders first, keyboard multi-selection (arrows, Shift, Space, Ctrl+A), the context menu with Lock for Editing and Change Permissions, tags as filters, the inspector and the quota bar. Switch to icons in the toolbar."
      >
        <Themed preview={preview()}>{(theme) => <FilesDemo theme={theme} />}</Themed>
      </Section>

      <Section
        title="Files — semantic search"
        lead="files-semantic-search: citation cards with path:start-end, marked snippets, relevance meters with their numbers, owners and the Shared · verified badge. Pick a state to see the keyword fallback notices (a determinate ring, never a spinner), loading, no matches and errors."
      >
        <div class={styles.toolbar}>
          <SegmentedControl
            label="Search state"
            size="sm"
            options={SCENARIOS}
            value={scenario()}
            onChange={setScenario}
          />
        </div>
        <Themed preview={preview()}>
          {(theme) => (
            <Show keyed when={scenario()}>
              {(s) => (
                <FilesDemo
                  theme={theme}
                  scenario={s}
                  initialQuery="where did I discuss the memory leak in the UI component"
                />
              )}
            </Show>
          )}
        </Themed>
      </Section>

      <Section
        title="Editor — sync conflict and remote lock"
        lead="editor-conflict: the amber conflict banner (Compare, Open conflicted copy), the read-only lock chip with its countdown ring in the title bar, the outline that follows the caret, and the status bar. Type in os-report.md to see the lock refuse the edit."
      >
        <Themed preview={preview()}>{(theme) => <EditorDemo theme={theme} />}</Themed>
      </Section>

      <Section
        title="Terminal — agent plan"
        lead="terminal-ai: xterm.js 6 with the Plotinium theme and JetBrains Mono. The kernel confirmation block is plain ANSI text from the helpers (header, steps with chmod named in red and in words, blast radius, N as the default), so it reads the same to a screen reader and on copy."
      >
        <Themed preview={preview()}>{(theme) => <TerminalDemo theme={theme} />}</Themed>
      </Section>

      <Section
        title="Component states"
        lead="The pieces on their own, in every state the designs list."
      >
        <Themed preview={preview()}>{(theme) => <ComponentStates theme={theme} />}</Themed>
      </Section>
    </Page>
  );
}
