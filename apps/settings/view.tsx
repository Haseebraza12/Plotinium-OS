/**
 * The Settings window (ui-design-system.md §3.8.14): `SettingsView` from @plotinium/ui driven by
 * `SettingsController`. The window opens on the section named in argv[0] ("memory", "privacy",
 * "scheduler", …) so the Task Manager and the Control Centre can deep-link into it.
 */
import { ErrorBoundary, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';

import type { SettingsSectionId } from '@plotinium/ui/apps/settings';
import { SettingsView } from '@plotinium/ui/apps/settings';

import type { AppViewContext } from '../src/descriptor.ts';
import { NOTICE_HOST_STYLE, NoticeToast } from '../src/notice.tsx';
import { SETTINGS_TOPICS, SettingsController, type SettingsSnapshot } from './controller.ts';
import { sectionFromArgv, sectionOfCommand } from './model.ts';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A browser download: the fallback when the VFS cannot take the export (writeFile refused). */
function download(name: string, data: ArrayBuffer, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

/** The window's root component, closed over its (non-reactive) view context. */
function settingsApp(ctx: AppViewContext): () => JSX.Element {
  return function SettingsApp(): JSX.Element {
    const controller = new SettingsController({
      sys: ctx.sys,
      env: ctx.env,
      now: () => Date.now(),
      server: typeof location === 'undefined' ? 'server' : location.host,
      download,
      copy: copyText,
      launch: (app, argv) => {
        ctx.launch(app, argv === undefined ? undefined : { argv });
      },
    });
    const [state, setState] = createStore<SettingsSnapshot>(controller.snapshot());
    const [section, setSection] = createSignal<SettingsSectionId>(
      sectionFromArgv(ctx.argv) ?? 'general',
    );
    const off = controller.subscribe((snap) => {
      setState(reconcile(snap, { merge: true }));
    });
    const offEvents = ctx.subscribe(SETTINGS_TOPICS, (batch) => {
      controller.onEvents(batch);
    });
    const offMenu = ctx.onMenuCommand((id) => {
      const target = sectionOfCommand(id);
      if (target !== undefined) setSection(target);
    });

    onMount(() => {
      ctx.window.setTitle('Settings');
      void controller.load();
    });
    onCleanup(() => {
      off();
      offEvents();
      offMenu();
      controller.dispose();
    });

    return (
      <div style={NOTICE_HOST_STYLE}>
        <SettingsView
          section={section()}
          onSectionChange={setSection}
          user={state.user}
          values={state.values}
          about={state.about}
          privacy={state.privacy}
          network={state.network}
          users={state.users}
          storage={state.storage}
          updates={state.updates}
          memory={state.memory}
          bound={state.bound}
          aiAvailable={state.aiAvailable}
          onChange={(change) => void controller.change(change)}
          onAction={(action) => void controller.action(action)}
          onCopy={(_label, value) => void copyText(value)}
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
  const SettingsApp = settingsApp(ctx);
  return render(
    () => (
      <ErrorBoundary
        fallback={(err: unknown) => {
          ctx.reportCrash(err);
          return null;
        }}
      >
        <SettingsApp />
      </ErrorBoundary>
    ),
    ctx.container,
  );
}

export default mount;
