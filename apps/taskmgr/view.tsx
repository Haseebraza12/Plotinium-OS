/**
 * The Task Manager window (ui-design-system.md §3.8.13; ui-implementation-guide.md §3.6.2): a Solid
 * root that renders `TaskManagerView` from @plotinium/ui and drives it from
 * `TaskManagerController`. The view keeps only ephemeral UI state (tab, selection, search); every
 * number comes from a system call or a kernel event (SYS-01).
 */
import { ErrorBoundary, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';

import type { SettingsLink, TaskManagerTab } from '@plotinium/ui/apps/taskmgr';
import { TaskManagerView } from '@plotinium/ui/apps/taskmgr';

import type { AppFrameStats, AppViewContext } from '../src/descriptor.ts';
import { NOTICE_HOST_STYLE, NoticeToast } from '../src/notice.tsx';
import { TASKMGR_TOPICS, TaskManagerController, type TaskManagerSnapshot } from './controller.ts';
import { frameStats } from './model.ts';

const TABS: readonly TaskManagerTab[] = ['processes', 'memory', 'scheduler', 'ai'];

/** Menu-bar command ids (see the descriptor's menus). */
export const TASKMGR_COMMANDS = {
  processes: 'view.processes',
  memory: 'view.memory',
  scheduler: 'view.scheduler',
  ai: 'view.ai',
  pause: 'view.pause',
  refresh: 'view.refresh',
} as const;

function initialTab(argv: readonly string[]): TaskManagerTab {
  const want = argv[0];
  return TABS.find((t) => t === want) ?? 'processes';
}

/**
 * Main-thread frame sampler used when the host has no frame meter: rAF deltas of the last
 * 2 seconds, summarised once per refresh. It runs only while the window is live.
 */
function createFrameSampler(): { stats: () => AppFrameStats; stop: () => void } {
  const deltas: number[] = [];
  let last = 0;
  let raf = 0;
  const loop = (t: number): void => {
    if (last !== 0) {
      deltas.push(t - last);
      if (deltas.length > 240) deltas.splice(0, deltas.length - 240);
    }
    last = t;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return {
    stats: () => frameStats(deltas),
    stop: () => {
      cancelAnimationFrame(raf);
    },
  };
}

function settingsSection(link: SettingsLink): string {
  return link === 'privacy-ai' ? 'privacy' : link;
}

/** The window's root component, closed over its (non-reactive) view context. */
function taskManagerApp(ctx: AppViewContext): () => JSX.Element {
  return function TaskManagerApp(): JSX.Element {
    const sampler = ctx.env.frames === undefined ? createFrameSampler() : null;
    const controller = new TaskManagerController({
      sys: ctx.sys,
      timers: {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => {
          clearTimeout(h as ReturnType<typeof setTimeout>);
        },
      },
      aiAvailable: ctx.env.aiAvailable,
      frames: ctx.env.frames ?? (() => sampler?.stats() ?? null),
      requireConfirm: () => ctx.env.prefs.get()['agent.requireConfirm'],
      ...(ctx.env.agentBudget === undefined ? {} : { agentBudget: ctx.env.agentBudget }),
    });
    const [state, setState] = createStore<TaskManagerSnapshot>(controller.snapshot());
    const [tab, setTab] = createSignal<TaskManagerTab>(initialTab(ctx.argv));
    const [paused, setPaused] = createSignal(false);
    /** A plain mirror of `paused` for the menu-command callback (not a tracked scope). */
    let pausedNow = false;

    const offState = controller.subscribe((snap) => {
      setState(reconcile(snap, { key: 'pid', merge: true }));
    });
    const offEvents = ctx.subscribe(TASKMGR_TOPICS, (batch) => {
      controller.onEvents(batch);
    });
    const offMenu = ctx.onMenuCommand((id) => {
      switch (id) {
        case TASKMGR_COMMANDS.processes:
          setTab('processes');
          break;
        case TASKMGR_COMMANDS.memory:
          setTab('memory');
          break;
        case TASKMGR_COMMANDS.scheduler:
          setTab('scheduler');
          break;
        case TASKMGR_COMMANDS.ai:
          setTab('ai');
          break;
        case TASKMGR_COMMANDS.pause:
          changePaused(!pausedNow);
          break;
        case TASKMGR_COMMANDS.refresh:
          void controller.refresh();
          break;
        default:
          break;
      }
    });

    const changePaused = (next: boolean): void => {
      pausedNow = next;
      setPaused(next);
      controller.setPaused(next);
    };

    onMount(() => {
      ctx.window.setTitle('Task Manager');
      controller.start();
    });
    onCleanup(() => {
      controller.stop();
      sampler?.stop();
      offState();
      offEvents();
      offMenu();
    });

    return (
      <div style={NOTICE_HOST_STYLE}>
        <TaskManagerView
          tab={tab()}
          onTabChange={setTab}
          processes={state.processes}
          summary={state.summary}
          performance={state.performance}
          memory={state.memory}
          predictions={state.predictions}
          scheduler={state.scheduler}
          ai={state.ai}
          paused={paused()}
          onPauseChange={changePaused}
          version={ctx.env.identity.version}
          build={ctx.env.identity.build}
          isRoot={state.isRoot}
          pendingPid={state.pendingPid}
          reniceError={state.reniceError}
          loading={state.loading}
          stale={state.stale}
          aiAvailable={ctx.env.aiAvailable}
          onSignal={(pid, sig) => void controller.signal(pid, sig)}
          onRenice={(pid, nice) => void controller.renice(pid, nice)}
          onPinChange={(pid, pinned) => void controller.pin(pid, pinned)}
          onReclaim={() => void controller.reclaim()}
          onCopy={(text) => void navigator.clipboard.writeText(text).catch(() => undefined)}
          onOpenSettings={(section) => {
            ctx.launch('settings', { argv: [settingsSection(section)] });
          }}
          onOpenLog={() => {
            ctx.launch('terminal');
          }}
          onRestartPredictor={() => void controller.restartPredictor()}
        />
        <NoticeToast
          notice={state.notice}
          onDismiss={() => {
            controller.dismissNotice();
          }}
        />
      </div>
    );
  };
}

/** The view module's entry (apps/src/descriptor.ts `AppMount`). */
export function mount(ctx: AppViewContext): () => void {
  const TaskManagerApp = taskManagerApp(ctx);
  return render(
    () => (
      <ErrorBoundary
        fallback={(err: unknown) => {
          ctx.reportCrash(err);
          return null;
        }}
      >
        <TaskManagerApp />
      </ErrorBoundary>
    ),
    ctx.container,
  );
}

export default mount;
