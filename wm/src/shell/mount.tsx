/**
 * `mountDesktop(root, env)`: the graphical shell's entry (window-manager.md §3.1). It applies the
 * appearance preferences, shows the login screen (unless a session is already signed in), then
 * mounts the desktop underneath while the unlock transition plays, and keeps the lock screen
 * available over it. Returns a handle with `dispose()` and the WM test hooks.
 */
import '@plotinium/ui/motion.css';

import { createEffect, createSignal, onCleanup, Show, untrack, type JSX } from 'solid-js';
import { render } from 'solid-js/web';

import type { KEvent } from '@plotinium/protocol';

import type { Compositor, LayoutRow } from '../compositor/index.ts';
import { Desktop, type DesktopApi } from './Desktop.tsx';
import { watchMedia } from './dom.ts';
import type { DesktopEnv, Prefs, PowerAction, Session } from './env.ts';
import { LoginGate } from './Login.tsx';
import { applyPrefs, resolvedTheme, withDefaults } from './prefs.ts';
import { focusableIn, type ShellNotification } from './ui.ts';

export interface DesktopHandle {
  /** Unmount everything and remove the shell's listeners. */
  dispose(): void;
  /** Windows bottom to top (the `window.__plt.layout()` hook), empty before sign-in. */
  layout(): LayoutRow[];
  /** The OS session id (the `window.__plt.sessionId()` hook), null before sign-in. */
  sessionId(): string | null;
  /** The compositor, once the desktop is mounted (for perf harnesses and tests). */
  compositor(): Compositor | null;
  /**
   * Change preferences from outside the shell (the Settings app): applied at once, then saved
   * through `env.prefs.save` like a Control Centre change.
   */
  setPrefs(patch: Partial<Prefs>): void;
  /** The preferences as applied now. */
  prefs(): Prefs;
  /** Open an app as the Dock would; ignored before sign-in. */
  launch(app: string, argv?: readonly string[]): void;
  /** Post a notification (banner plus Notification Centre); ignored before sign-in. */
  notify(n: ShellNotification): void;
  /** Push kernel event batches when the host gave no `kernel.subscribe`. */
  events(batch: readonly KEvent[]): void;
  /** Show the lock screen (needs `env.auth`). */
  lock(): void;
}

/** What `ShellApp` hands back to the handle. */
interface ShellControl {
  setPrefs(patch: Partial<Prefs>): void;
  prefs(): Prefs;
  lock(): void;
}

/** Used when the host gives no auth: a single local user, signed in. */
export const LOCAL_SESSION: Session = Object.freeze({ uid: 1000, user: 'student', kind: 'user' });

function ShellApp(props: {
  env: DesktopEnv;
  onApi: (api: DesktopApi | null) => void;
  onControl: (c: ShellControl) => void;
}): JSX.Element {
  // The environment is fixed for the life of the shell.
  const env = untrack(() => props.env);
  const doc = document;
  const clock = env.now ?? (() => Date.now());
  const [prefs, setPrefsSignal] = createSignal<Prefs>(withDefaults(env.prefs?.initial));
  const setPrefs = (patch: Partial<Prefs>): void => {
    const next = { ...prefs(), ...patch };
    setPrefsSignal(next);
    env.prefs?.save?.(next);
  };
  createEffect(() => applyPrefs(doc.documentElement, prefs()));

  const [systemDark, setSystemDark] = createSignal(false);
  const [systemReduced, setSystemReduced] = createSignal(false);
  const dark = watchMedia(window, '(prefers-color-scheme: dark)', setSystemDark);
  const reduced = watchMedia(window, '(prefers-reduced-motion: reduce)', setSystemReduced);
  setSystemDark(dark.matches);
  setSystemReduced(reduced.matches);
  onCleanup(() => {
    dark.stop();
    reduced.stop();
  });

  const auth = env.auth;
  const initial = auth === undefined ? LOCAL_SESSION : (auth.current?.() ?? null);
  const [session, setSession] = createSignal<Session | null>(initial);
  const [loginShown, setLoginShown] = createSignal(initial === null);
  const [locked, setLocked] = createSignal(false);
  const theme = (): 'light' | 'dark' => resolvedTheme(prefs().theme, systemDark());

  const power = (action: PowerAction): void => {
    if (action === 'lock') {
      if (session() !== null) setLocked(true);
      return;
    }
    env.power?.(action);
  };
  /**
   * While the login or lock screen is up, Tab wraps inside it as it does on the desktop, so focus
   * never rests on the page body between its last and first control (UI-027, UI-088). Focus in
   * another layer (a confirmation dialog portalled to <body>) is left alone.
   */
  const onGateTab = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Tab' || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (!locked() && !loginShown()) return;
    const gate = doc.querySelector<HTMLElement>('[data-testid="login-screen"]');
    if (gate === null) return;
    const stops = focusableIn(gate).filter((el) => el.getAttribute('tabindex') !== '-1');
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) return;
    const active = doc.activeElement;
    if (active === null || active === doc.body || active === doc.documentElement) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    } else if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    }
  };
  window.addEventListener('keydown', onGateTab);
  onCleanup(() => window.removeEventListener('keydown', onGateTab));

  // The control callback is fixed for the life of the shell, like `env`.
  untrack(() => props.onControl)({
    setPrefs,
    prefs,
    lock: () => {
      if (auth !== undefined && session() !== null) setLocked(true);
    },
  });

  return (
    <>
      <Show when={session()} keyed>
        {(s) => (
          <Desktop
            env={env}
            session={s}
            prefs={prefs()}
            setPrefs={setPrefs}
            theme={theme()}
            systemReducedMotion={systemReduced()}
            locked={locked() || loginShown()}
            onLock={() => setLocked(true)}
            onApi={props.onApi}
          />
        )}
      </Show>
      <Show when={auth !== undefined && loginShown() ? auth : undefined}>
        {(a) => (
          <LoginGate
            auth={a()}
            identity={env.identity}
            now={clock}
            onVerified={(s) => setSession(s)}
            onDone={() => setLoginShown(false)}
            onPower={power}
            onShown={() => {
              a().shown?.();
              env.onPhase?.('login');
            }}
          />
        )}
      </Show>
      <Show when={auth !== undefined && locked() ? session() : null} keyed>
        {(s) =>
          auth === undefined ? null : (
            <LoginGate
              auth={auth}
              identity={env.identity}
              now={clock}
              lock={s}
              onVerified={() => undefined}
              onDone={() => setLocked(false)}
              onPower={power}
            />
          )
        }
      </Show>
    </>
  );
}

/**
 * Mount the desktop shell into `root` (web/'s `#plt-desktop`). The host loads the design tokens
 * (`@plotinium/ui/tokens.css`, inlined for boot) and the fonts; this module brings motion.css.
 */
export function mountDesktop(root: HTMLElement, env: DesktopEnv): DesktopHandle {
  let api: DesktopApi | null = null;
  let control: ShellControl | null = null;
  const dispose = render(
    () => (
      <ShellApp
        env={env}
        onApi={(a) => {
          api = a;
        }}
        onControl={(c) => {
          control = c;
        }}
      />
    ),
    root,
  );
  return {
    dispose,
    layout: () => api?.layout() ?? [],
    sessionId: () => api?.sessionId() ?? null,
    compositor: () => api?.compositor() ?? null,
    setPrefs: (patch) => control?.setPrefs(patch),
    prefs: () => control?.prefs() ?? withDefaults(env.prefs?.initial),
    launch: (app, argv = []) => api?.launch(app, argv),
    notify: (n) => api?.notify(n),
    events: (batch) => api?.events(batch),
    lock: () => control?.lock(),
  };
}
