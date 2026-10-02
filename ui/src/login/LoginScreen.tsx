import ArrowBigUp from 'lucide-solid/icons/arrow-big-up';
import ArrowRight from 'lucide-solid/icons/arrow-right';
import BatteryCharging from 'lucide-solid/icons/battery-charging';
import BatteryMedium from 'lucide-solid/icons/battery-medium';
import CircleAlert from 'lucide-solid/icons/circle-alert';
import CloudOff from 'lucide-solid/icons/cloud-off';
import Eye from 'lucide-solid/icons/eye';
import EyeOff from 'lucide-solid/icons/eye-off';
import Globe from 'lucide-solid/icons/globe';
import Lock from 'lucide-solid/icons/lock';
import PersonStanding from 'lucide-solid/icons/person-standing';
import Power from 'lucide-solid/icons/power';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import UserRound from 'lucide-solid/icons/user-round';
import Users from 'lucide-solid/icons/users';
import Wifi from 'lucide-solid/icons/wifi';
import WifiLow from 'lucide-solid/icons/wifi-low';
import WifiOff from 'lucide-solid/icons/wifi-off';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { AtomLogo } from '../icons/index.tsx';
import { colourSlotOf, initialsOf } from '../primitives/avatar/Avatar.tsx';
import { cx } from '../primitives/internal/cx.ts';
import { firstEnabled, lastEnabled, stepIndex } from '../primitives/internal/list-nav.ts';
import { prefersReducedMotion } from '../primitives/internal/motion.ts';
import { Toggle } from '../primitives/toggle/Toggle.tsx';
import styles from './LoginScreen.module.css';

export type LoginUserKind = 'user' | 'guest' | 'demo';

export interface LoginUser {
  id: string;
  /** Display name under the avatar: `student`, `Guest`. */
  name: string;
  kind?: LoginUserKind;
  /** Already has a running session (lock mode): a green dot on the avatar. */
  signedIn?: boolean;
  /** Offline without a saved verifier, or disabled by an admin; the reason is shown and spoken. */
  disabled?: boolean;
  disabledReason?: string;
  /** Picture URL supplied by the caller. */
  avatarSrc?: string;
  /** Avatar gradient 1..6 (--pl-avatar-N); by default a stable hash of the name. */
  colour?: 1 | 2 | 3 | 4 | 5 | 6;
}

export type LoginState = 'idle' | 'verifying' | 'error' | 'rate-limited' | 'unlocking' | 'busy';

export interface LoginStatus {
  wifi?: 'on' | 'off' | 'weak';
  /** Battery percentage. */
  battery?: number;
  charging?: boolean;
  /** Keyboard layout: `EN`. */
  layout?: string;
}

/** The two settings the login screen's Accessibility popover offers before anyone signs in. */
export interface LoginA11y {
  reduceMotion: boolean;
  reduceTransparency: boolean;
}
export type LoginA11ySetting = keyof LoginA11y;

export interface LoginScreenProps {
  users: readonly LoginUser[];
  selectedId: string;
  onSelectUser: (id: string) => void;
  /** The current time; the caller ticks it once a minute. */
  now: Date;
  locale?: string;
  hour12?: boolean;
  /** Enter or the arrow: the password never leaves this component except through this call. */
  onSubmit: (userId: string, password: string) => void;
  /** Guest and demo tiles have no password. */
  onContinueWithout: (userId: string) => void;
  state?: LoginState | undefined;
  /** The real stage while verifying (no spinner): `Checking password`, `Loading your desktop`. */
  stage?: string | undefined;
  /** Default `Invalid username or password` (no user enumeration). */
  errorText?: string | undefined;
  /** Bump it on each failed attempt: the field clears and shakes (a message under reduced motion). */
  errorKey?: number | undefined;
  /**
   * Rate-limited back-off of the selected user: `Too many attempts. Try again in 28 s` (minutes
   * from 60 s up). The countdown is shown, not spoken; the back-off is announced once.
   */
  retryInS?: number | undefined;
  /** Offline: the badge says the saved verifier is used (OFF-03). */
  offline?: boolean | undefined;
  /** Signed-in sessions (lock mode); the pill shows when > 0 and not offline. */
  sessions?: number | undefined;
  /** Tooltip for the sessions pill: `student — since 08:15 · alice — since 09:02`. */
  sessionsDetail?: string | undefined;
  status?: LoginStatus;
  version: string;
  build: string;
  language?: string;
  /**
   * Not shown (ui-implementation-guide D-17: a browser cannot sleep the machine, so the power
   * row is Restart and Shut Down only). Kept so existing callers still type-check.
   */
  onSleep?: () => void;
  onRestart: () => void;
  onShutDown: () => void;
  /** Told when "Forgot password?" opens its popover (D-17: it only explains what to do). */
  onForgotPassword?: () => void;
  /**
   * The Accessibility popover's switches (Reduce motion, Reduce transparency). With `onA11y` the
   * corner button opens the built-in popover.
   */
  a11y?: LoginA11y;
  onA11y?: (setting: LoginA11ySetting, on: boolean) => void;
  /** Without `onA11y`: the anchor is passed so the shell can open its own popover next to it. */
  onAccessibility?: (anchor: HTMLElement) => void;
  onLanguage?: (anchor: HTMLElement) => void;
  /** Called once the unlock transition has played (state `unlocking`). */
  onUnlocked?: () => void;
  /** A custom wallpaper (a CSS background); it is blurred. Default: the Plotinium glow field. */
  wallpaper?: string;
  /** Render inside the parent (gallery) instead of as the page's main landmark. */
  contained?: boolean;
  class?: string;
}

/** Tile pitch: 116 px tile + 28 px gap, so the selected avatar can be centred by translateX. */
const PITCH = 144;
const CONFIRM_MS = 5000;
const UNLOCK_MS = 420;
const FORGOT_TEXT = 'Ask an administrator to reset your password.';

/** A back-off in words: `28 s` below a minute, then whole minutes rounded up (`20 min`). */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}

/** The same wait spoken once, in full words: `30 seconds`, `20 minutes`. */
function spokenWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return s === 1 ? '1 second' : `${s} seconds`;
  const m = Math.ceil(s / 60);
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/** What a back-off is about: the Guest tile is limited per network, a password per account. */
function backoffWhat(kind: LoginUserKind): string {
  return kind === 'guest' ? 'Too many guest sessions from this network' : 'Too many attempts';
}

/** `Thursday, 24 September` and `10:42` for the lock-screen clock. */
export function formatLockClock(
  now: Date,
  locale = 'en-GB',
  hour12 = false,
): { date: string; time: string; iso: string } {
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const time = new Intl.DateTimeFormat(locale, {
    hour: hour12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12,
  })
    .format(now)
    .replace(/\s?[AP]M$/iu, '');
  return {
    date: `${part('weekday')}, ${part('day')} ${part('month')}`,
    time,
    iso: now.toISOString(),
  };
}

/**
 * The login and lock screen (BOOT-14, OFF-03; docs/design/stitch/login-dark and login-light):
 * a blurred glow wallpaper, a large clock and date, the user picker (a radiogroup that centres
 * the chosen avatar with a spring), the glass password pill with its arrow, the offline badge or
 * the sessions pill, and Sleep, Restart and Shut Down (the last two confirm first). A wrong
 * password shakes the pill once and says so; under reduced motion only the words and the border
 * change. A successful sign-in plays the unlock transition, then calls `onUnlocked`.
 */
export function LoginScreen(props: LoginScreenProps): JSX.Element {
  const [local] = splitProps(props, [
    'users',
    'selectedId',
    'onSelectUser',
    'now',
    'locale',
    'hour12',
    'onSubmit',
    'onContinueWithout',
    'state',
    'stage',
    'errorText',
    'errorKey',
    'retryInS',
    'offline',
    'sessions',
    'sessionsDetail',
    'status',
    'version',
    'build',
    'language',
    'onRestart',
    'onShutDown',
    'onForgotPassword',
    'a11y',
    'onA11y',
    'onAccessibility',
    'onLanguage',
    'onUnlocked',
    'wallpaper',
    'contained',
    'class',
  ]);
  const uid = createUniqueId();
  const ids = {
    hint: `pl-login-${uid}-hint`,
    status: `pl-login-${uid}-status`,
    confirm: `pl-login-${uid}-confirm`,
    forgot: `pl-login-${uid}-forgot`,
    a11y: `pl-login-${uid}-a11y`,
  };
  let input: HTMLInputElement | undefined;
  let radios: HTMLDivElement | undefined;
  let powerNav: HTMLElement | undefined;

  // Memos compare values, so a caller whose props are re-read on every tick (a parent clock,
  // a merged spread) re-runs nothing below unless the value really changed (UI-001).
  const state = createMemo((): LoginState => local.state ?? 'idle');
  const selectedId = createMemo(() => local.selectedId);
  const errorKey = createMemo(() => local.errorKey);
  const clock = createMemo(() => formatLockClock(local.now, local.locale, local.hour12));
  const index = createMemo(() => local.users.findIndex((u) => u.id === selectedId()));
  const selected = (): LoginUser | undefined => local.users[index()];
  const kind = (): LoginUserKind => selected()?.kind ?? 'user';
  const needsPassword = (): boolean => kind() === 'user';
  const locked = (): boolean =>
    state() === 'verifying' || state() === 'unlocking' || state() === 'busy';
  const rateLimited = createMemo(() => state() === 'rate-limited');

  // ---------- password (never stored outside this component) ----------
  const [password, setPassword] = createSignal('');
  const [reveal, setReveal] = createSignal(false);
  const [capsLock, setCapsLock] = createSignal(false);
  const [shaking, setShaking] = createSignal(false);
  const [forgotOpen, setForgotOpen] = createSignal(false);
  createEffect(
    on(
      selectedId,
      () => {
        setPassword('');
        setReveal(false);
        setForgotOpen(false);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      errorKey,
      () => {
        setPassword('');
        setShaking(false);
        // A frame without the class, so the one-shot shake can play again.
        requestAnimationFrame(() => setShaking(true));
        input?.focus();
      },
      { defer: true },
    ),
  );

  // A back-off is announced once, politely, when it starts; the ticking number stays out of
  // every live region (UI-065).
  const [backoffNote, setBackoffNote] = createSignal('');
  createEffect(
    on(rateLimited, (active) => {
      if (!active) {
        setBackoffNote('');
        return;
      }
      const wait = untrack(() => local.retryInS);
      const what = untrack(() => backoffWhat(kind()));
      setBackoffNote(
        wait === undefined ? `${what}.` : `${what}. Try again in ${spokenWait(wait)}.`,
      );
    }),
  );

  const submit = (): void => {
    const user = selected();
    if (user === undefined || locked() || rateLimited()) return;
    setForgotOpen(false);
    if (!needsPassword()) {
      local.onContinueWithout(user.id);
      return;
    }
    if (password() === '') return;
    local.onSubmit(user.id, password());
  };
  const onFieldKey = (event: KeyboardEvent): void => {
    setCapsLock(event.getModifierState('CapsLock'));
  };

  // ---------- user picker (radiogroup, roving tabindex) ----------
  const disabledAt = (i: number): boolean => local.users[i]?.disabled === true;
  const choose = (i: number, focus: boolean): void => {
    const user = local.users[i];
    if (user === undefined || user.disabled === true) return;
    local.onSelectUser(user.id);
    if (focus)
      queueMicrotask(() => radios?.querySelector<HTMLElement>(`[data-user-index="${i}"]`)?.focus());
  };
  const onRadioKey = (event: KeyboardEvent): void => {
    const count = local.users.length;
    const next = ((): number | undefined => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          return stepIndex(index(), 1, count, disabledAt, true);
        case 'ArrowLeft':
        case 'ArrowUp':
          return stepIndex(index(), -1, count, disabledAt, true);
        case 'Home':
          return firstEnabled(count, disabledAt);
        case 'End':
          return lastEnabled(count, disabledAt);
        default:
          return undefined;
      }
    })();
    if (next === undefined) return;
    event.preventDefault();
    choose(next, true);
  };
  const rowShift = (): number => ((local.users.length - 1) / 2 - Math.max(0, index())) * PITCH;

  // ---------- power (Restart and Shut Down confirm first; D-17: no Sleep) ----------
  const [confirming, setConfirming] = createSignal<'restart' | 'shutdown'>();
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ends the confirmation; focus inside it goes back to the power button it came from. */
  const cancelConfirm = (): void => {
    const which = confirming();
    const hadFocus =
      typeof document !== 'undefined' && powerNav?.contains(document.activeElement) === true;
    clearTimeout(confirmTimer);
    setConfirming(undefined);
    if (which !== undefined && hadFocus)
      queueMicrotask(() =>
        powerNav?.querySelector<HTMLElement>(`[data-power="${which}"]`)?.focus(),
      );
  };
  const askConfirm = (action: 'restart' | 'shutdown'): void => {
    clearTimeout(confirmTimer);
    setConfirming(action);
    confirmTimer = setTimeout(cancelConfirm, CONFIRM_MS);
  };
  onCleanup(() => clearTimeout(confirmTimer));

  // ---------- popovers: Forgot password (D-17) and Accessibility ----------
  const [a11yOpen, setA11yOpen] = createSignal(false);
  let a11yButton: HTMLButtonElement | undefined;
  let a11yPanel: HTMLDivElement | undefined;
  let forgotButton: HTMLButtonElement | undefined;
  const closeA11y = (refocus: boolean): void => {
    if (!a11yOpen()) return;
    setA11yOpen(false);
    if (refocus) a11yButton?.focus();
  };
  const onDocPointer = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (a11yOpen() && a11yPanel?.contains(target) !== true && a11yButton?.contains(target) !== true)
      closeA11y(false);
    if (forgotOpen() && forgotButton?.contains(target) !== true) setForgotOpen(false);
  };
  const onDocKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (a11yOpen()) {
      event.preventDefault();
      closeA11y(true);
    } else if (forgotOpen()) {
      event.preventDefault();
      setForgotOpen(false);
      forgotButton?.focus();
    } else if (confirming() !== undefined) {
      event.preventDefault();
      cancelConfirm();
    }
  };
  onMount(() => {
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey);
  });
  onCleanup(() => {
    if (typeof document === 'undefined') return;
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey);
  });

  // The password field takes focus on mount (not in the gallery, where several screens render).
  onMount(() => {
    if (local.contained !== true) input?.focus();
  });

  // ---------- unlock ----------
  let unlockTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(state, (s) => {
      clearTimeout(unlockTimer);
      if (s !== 'unlocking') return;
      const instant = typeof document === 'undefined' || prefersReducedMotion(document);
      unlockTimer = setTimeout(() => local.onUnlocked?.(), instant ? 0 : UNLOCK_MS);
    }),
  );
  onCleanup(() => clearTimeout(unlockTimer));

  /**
   * The line under the password pill or the Continue button: the idle hint, the real stage
   * while verifying or unlocking, an error, or the back-off countdown. The same states read the
   * same way for password, Guest and demo tiles (UI-005, UI-149).
   */
  const hint = (): { text: string; tone: 'hint' | 'error' | 'stage' } => {
    switch (state()) {
      case 'rate-limited': {
        const what = backoffWhat(kind());
        return local.retryInS === undefined
          ? { text: `${what}. Try again soon`, tone: 'error' }
          : { text: `${what}. Try again in ${formatWait(local.retryInS)}`, tone: 'error' };
      }
      case 'error':
        return {
          text:
            local.errorText ??
            (needsPassword() ? 'Invalid username or password' : 'Could not start the session'),
          tone: 'error',
        };
      case 'verifying':
        return {
          text: `${local.stage ?? (needsPassword() ? 'Checking password' : 'Starting session')}…`,
          tone: 'stage',
        };
      case 'unlocking':
        return { text: `${local.stage ?? 'Loading your desktop'}…`, tone: 'stage' };
      case 'busy':
        return { text: `${local.stage ?? 'Please wait'}…`, tone: 'stage' };
      case 'idle':
        if (needsPassword()) return { text: 'Press Enter to sign in', tone: 'hint' };
        return {
          text:
            kind() === 'demo'
              ? 'The demo resets when you log out.'
              : 'Guest files are deleted when you log out.',
          tone: 'hint',
        };
    }
  };
  /** An error is an alert; the back-off is announced once through `backoffNote` instead. */
  const hintRole = (): 'alert' | undefined =>
    hint().tone === 'error' && !rateLimited() ? 'alert' : undefined;
  const hintLive = (): 'polite' | undefined => (hint().tone === 'stage' ? 'polite' : undefined);

  return (
    <Dynamic
      component={local.contained === true ? 'section' : 'main'}
      class={cx(
        styles.screen,
        local.contained === true && styles.contained,
        state() === 'unlocking' && 'pl-anim-login-unlock',
        local.class,
      )}
      aria-label="Sign in to Plotinium"
      aria-busy={locked() ? 'true' : undefined}
      data-state={state()}
    >
      <div
        class={cx(styles.wallpaper, local.wallpaper !== undefined && styles.wallpaperImage)}
        style={local.wallpaper === undefined ? undefined : { background: local.wallpaper }}
        aria-hidden="true"
      />
      <div class={styles.vignette} aria-hidden="true" />

      {/* ---------- status cluster (the same facts are spoken by the badge and the form) ---------- */}
      <div class={styles.statusBar} aria-hidden="true">
        <Show when={local.status?.wifi !== undefined}>
          <WifiGlyph wifi={local.status?.wifi} />
        </Show>
        <Show when={local.status?.battery}>
          {(battery) => (
            <span class={styles.battery}>
              <Show
                when={local.status?.charging === true}
                fallback={<BatteryMedium size={18} stroke-width={1.8} />}
              >
                <BatteryCharging size={18} stroke-width={1.8} />
              </Show>
              {battery()}%
            </span>
          )}
        </Show>
        <Show when={local.status?.layout}>
          {(layout) => <span class={styles.layout}>{layout()}</span>}
        </Show>
      </div>

      {/* ---------- clock ---------- */}
      <header class={styles.clock} aria-live="off">
        <p class={styles.date}>{clock().date}</p>
        {/* Read as one time ("10:42"), not digit by digit (UI-150). */}
        <time class={styles.time} datetime={clock().iso} aria-label={clock().time}>
          <span class={styles.digits} aria-hidden="true">
            <Index each={[...clock().time]}>
              {(char) => (
                <Show keyed when={char()}>
                  {(c) => <span class={cx(styles.digit, c === ':' && styles.colon)}>{c}</span>}
                </Show>
              )}
            </Index>
          </span>
        </time>
      </header>

      {/* ---------- users ---------- */}
      <div class={styles.center}>
        <div
          ref={(el) => (radios = el)}
          class={styles.users}
          role="radiogroup"
          aria-label="Choose user"
          onKeyDown={onRadioKey}
        >
          <div class={styles.userRow} style={{ transform: `translateX(${rowShift()}px)` }}>
            <For each={local.users}>
              {(user, i) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={user.id === local.selectedId ? 'true' : 'false'}
                  aria-disabled={user.disabled === true ? 'true' : undefined}
                  aria-label={[
                    user.name,
                    user.kind === 'guest' || user.kind === 'demo' ? 'no password' : undefined,
                    user.signedIn === true ? 'signed in' : undefined,
                    user.disabled === true ? (user.disabledReason ?? 'unavailable') : undefined,
                  ]
                    .filter((p) => p !== undefined)
                    .join(', ')}
                  title={user.disabled === true ? user.disabledReason : undefined}
                  tabindex={user.id === local.selectedId ? 0 : -1}
                  data-user-index={i()}
                  class={styles.user}
                  data-selected={user.id === local.selectedId ? 'true' : undefined}
                  style={{ '--pl-stagger-index': String(i()) }}
                  disabled={locked()}
                  onClick={() => choose(i(), false)}
                >
                  <span class={styles.avatarBox}>
                    <span
                      class={cx(
                        styles.avatar,
                        user.kind === 'guest' || user.kind === 'demo'
                          ? styles.avatarGlass
                          : user.avatarSrc === undefined &&
                              styles[`c${user.colour ?? colourSlotOf(user.name)}`],
                      )}
                    >
                      <Switch fallback={initialsOf(user.name)}>
                        <Match when={user.avatarSrc}>
                          {(src) => (
                            <img class={styles.avatarImg} src={src()} alt="" draggable={false} />
                          )}
                        </Match>
                        <Match when={user.kind === 'guest' || user.kind === 'demo'}>
                          <UserRound size={30} stroke-width={1.6} />
                        </Match>
                      </Switch>
                    </span>
                    <Show when={user.signedIn === true}>
                      <span class={styles.signedIn} />
                    </Show>
                    <Show when={user.disabled === true}>
                      <span class={styles.lockBadge}>
                        <Lock size={10} stroke-width={2.6} />
                      </span>
                    </Show>
                  </span>
                  <span class={styles.userName}>{user.name}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* ---------- password or continue ---------- */}
        <div class={styles.auth}>
          <Show
            when={needsPassword()}
            fallback={
              <div class={styles.guest}>
                <button
                  type="button"
                  class={styles.guestButton}
                  disabled={locked()}
                  aria-disabled={rateLimited() ? 'true' : undefined}
                  aria-describedby={`${ids.hint} ${ids.status}`}
                  data-error={
                    state() === 'error' || state() === 'rate-limited' ? 'true' : undefined
                  }
                  onClick={submit}
                >
                  Continue as {selected()?.name ?? 'Guest'}
                  <ArrowRight size={15} stroke-width={2.2} aria-hidden="true" />
                </button>
                <p
                  class={styles.hint}
                  id={ids.hint}
                  data-tone={hint().tone}
                  role={hintRole()}
                  aria-live={hintLive()}
                >
                  <Show when={hint().tone === 'error'}>
                    <CircleAlert size={13} stroke-width={2.2} aria-hidden="true" />
                  </Show>
                  <span>{hint().text}</span>
                </p>
              </div>
            }
          >
            <form
              class={styles.form}
              aria-label={`Sign in as ${selected()?.name ?? 'user'}`}
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div
                class={cx(styles.pill, shaking() && 'pl-anim-login-shake')}
                data-error={state() === 'error' || state() === 'rate-limited' ? 'true' : undefined}
                data-verifying={state() === 'verifying' ? 'true' : undefined}
                onAnimationEnd={() => setShaking(false)}
              >
                <Show when={state() === 'verifying'}>
                  <span class={cx(styles.sweep, 'pl-anim-progress-sweep')} aria-hidden="true" />
                </Show>
                <input
                  ref={(el) => (input = el)}
                  class={styles.input}
                  type={reveal() ? 'text' : 'password'}
                  autocomplete="current-password"
                  placeholder="Enter password"
                  aria-label={`Password for ${selected()?.name ?? 'user'}`}
                  aria-describedby={`${ids.hint} ${ids.status}`}
                  aria-invalid={state() === 'error' ? 'true' : undefined}
                  disabled={state() === 'rate-limited' || state() === 'busy'}
                  readOnly={locked()}
                  spellcheck={false}
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  onKeyDown={onFieldKey}
                  onKeyUp={onFieldKey}
                />
                <Show when={capsLock()}>
                  <span class={styles.caps} title="Caps Lock is on">
                    <ArrowBigUp size={15} stroke-width={2} aria-hidden="true" />
                    <span class={styles.srOnly}>Caps Lock is on</span>
                  </span>
                </Show>
                <button
                  type="button"
                  class={styles.eye}
                  aria-label="Show password"
                  aria-pressed={reveal() ? 'true' : 'false'}
                  onClick={() => setReveal((v) => !v)}
                >
                  <Show when={reveal()} fallback={<Eye size={15} stroke-width={2} />}>
                    <EyeOff size={15} stroke-width={2} />
                  </Show>
                </button>
                <button
                  type="submit"
                  class={styles.go}
                  aria-label="Sign in"
                  aria-disabled={password() === '' || locked() ? 'true' : undefined}
                  data-ready={password() !== '' ? 'true' : undefined}
                >
                  <ArrowRight size={15} stroke-width={2.4} aria-hidden="true" />
                </button>
              </div>
              <p
                class={styles.hint}
                id={ids.hint}
                data-tone={hint().tone}
                role={hintRole()}
                aria-live={hintLive()}
              >
                <Show when={hint().tone === 'error'}>
                  <CircleAlert size={13} stroke-width={2.2} aria-hidden="true" />
                </Show>
                <span>{hint().text}</span>
                <Show when={hint().tone === 'hint'}>
                  <span class={styles.dotSep} aria-hidden="true">
                    ·
                  </span>
                  <button
                    ref={(el) => (forgotButton = el)}
                    type="button"
                    class={styles.link}
                    aria-expanded={forgotOpen() ? 'true' : 'false'}
                    aria-controls={ids.forgot}
                    onClick={() => {
                      const open = !forgotOpen();
                      setForgotOpen(open);
                      if (open) local.onForgotPassword?.();
                    }}
                  >
                    Forgot password?
                  </button>
                </Show>
              </p>
              {/* D-17: a text popover; the region is always present so its text is announced. */}
              <div class={styles.forgotAnchor} id={ids.forgot} aria-live="polite">
                <Show when={forgotOpen() && hint().tone === 'hint'}>
                  <p class={styles.forgot}>{FORGOT_TEXT}</p>
                </Show>
              </div>
            </form>
          </Show>

          <div id={ids.status}>
            <Switch>
              <Match when={local.offline === true}>
                <p class={cx(styles.badge, styles.badgeOffline)} role="status">
                  <span class={styles.badgeDot} aria-hidden="true" />
                  <CloudOff size={14} stroke-width={2} aria-hidden="true" />
                  Offline — using cached verifier
                </p>
              </Match>
              <Match when={(local.sessions ?? 0) > 0}>
                <p class={styles.badge} role="status" title={local.sessionsDetail}>
                  <span class={cx(styles.badgeDot, styles.badgeDotOk)} aria-hidden="true" />
                  <Users size={14} stroke-width={2} aria-hidden="true" />
                  Signed-in sessions: {local.sessions}
                </p>
              </Match>
            </Switch>
          </div>
          <p class={styles.srOnly} aria-live="polite" aria-atomic="true">
            {backoffNote()}
          </p>
        </div>
      </div>

      {/* ---------- power ---------- */}
      <nav ref={(el) => (powerNav = el)} class={styles.power} aria-label="Power">
        <Show
          when={confirming()}
          fallback={
            <>
              <PowerButton
                label="Restart"
                action="restart"
                index={0}
                disabled={locked()}
                onClick={() => askConfirm('restart')}
              >
                <RotateCcw size={20} stroke-width={1.8} />
              </PowerButton>
              <PowerButton
                label="Shut Down"
                action="shutdown"
                index={1}
                disabled={locked()}
                onClick={() => askConfirm('shutdown')}
              >
                <Power size={20} stroke-width={1.8} />
              </PowerButton>
            </>
          }
        >
          {(action) => (
            <div
              class={styles.confirm}
              role="group"
              aria-label={`Confirm ${action() === 'restart' ? 'restart' : 'shut down'}`}
            >
              <button
                type="button"
                class={styles.confirmYes}
                aria-describedby={(local.sessions ?? 0) > 0 ? ids.confirm : undefined}
                ref={(el) => queueMicrotask(() => el.focus())}
                onClick={() => {
                  const which = action();
                  cancelConfirm();
                  if (which === 'restart') local.onRestart();
                  else local.onShutDown();
                }}
              >
                <Show
                  when={action() === 'restart'}
                  fallback={<Power size={16} stroke-width={2} aria-hidden="true" />}
                >
                  <RotateCcw size={16} stroke-width={2} aria-hidden="true" />
                </Show>
                {action() === 'restart' ? 'Restart?' : 'Shut Down?'}
              </button>
              <button type="button" class={styles.confirmNo} onClick={() => cancelConfirm()}>
                Cancel
              </button>
              <Show when={(local.sessions ?? 0) > 0}>
                <p class={styles.confirmNote} id={ids.confirm}>
                  {local.sessions === 1
                    ? '1 user is signed in'
                    : `${local.sessions} users are signed in`}{' '}
                  — unsaved work may be lost
                </p>
              </Show>
            </div>
          )}
        </Show>
      </nav>

      {/* ---------- corners ---------- */}
      <footer class={styles.brand}>
        {/* 32 px: a size the mark is hinted for (atomLogoFor), and taller than the two text
            lines, so the row's height, and so the mark, stays on whole pixels (verify-a). */}
        <AtomLogo size={32} label="Plotinium" />
        <span class={styles.brandText}>
          <span class={styles.brandName}>Plotinium {local.version}</span>
          <span class={styles.brandBuild}>build {local.build}</span>
        </span>
      </footer>
      <div class={styles.corner}>
        <Show
          when={local.onA11y}
          fallback={
            <Show when={local.onAccessibility}>
              {(open) => (
                <button
                  type="button"
                  class={styles.roundButton}
                  aria-label="Accessibility"
                  aria-haspopup="dialog"
                  onClick={(event) => open()(event.currentTarget)}
                >
                  <PersonStanding size={16} stroke-width={2} aria-hidden="true" />
                </button>
              )}
            </Show>
          }
        >
          {(onA11y) => (
            <div class={styles.a11yAnchor}>
              <Show when={a11yOpen()}>
                <div
                  ref={(el) => (a11yPanel = el)}
                  id={ids.a11y}
                  class={styles.a11yPop}
                  role="group"
                  aria-label="Accessibility"
                >
                  <Toggle
                    size="sm"
                    class={styles.a11yRow}
                    label="Reduce motion"
                    checked={local.a11y?.reduceMotion === true}
                    onChange={(v) => onA11y()('reduceMotion', v)}
                  />
                  <Toggle
                    size="sm"
                    class={styles.a11yRow}
                    label="Reduce transparency"
                    checked={local.a11y?.reduceTransparency === true}
                    onChange={(v) => onA11y()('reduceTransparency', v)}
                  />
                </div>
              </Show>
              <button
                ref={(el) => (a11yButton = el)}
                type="button"
                class={styles.roundButton}
                aria-label="Accessibility"
                aria-expanded={a11yOpen() ? 'true' : 'false'}
                aria-controls={ids.a11y}
                onClick={() => {
                  const open = !a11yOpen();
                  setA11yOpen(open);
                  if (open)
                    queueMicrotask(() =>
                      a11yPanel?.querySelector<HTMLElement>('[role="switch"]')?.focus(),
                    );
                }}
              >
                <PersonStanding size={16} stroke-width={2} aria-hidden="true" />
              </button>
            </div>
          )}
        </Show>
        <Show when={local.onLanguage}>
          {(open) => (
            <button
              type="button"
              class={styles.languageButton}
              aria-haspopup="listbox"
              onClick={(event) => open()(event.currentTarget)}
            >
              <Globe size={15} stroke-width={2} aria-hidden="true" />
              {local.language ?? 'English'}
            </button>
          )}
        </Show>
      </div>
    </Dynamic>
  );
}

function WifiGlyph(props: { wifi: LoginStatus['wifi'] }): JSX.Element {
  return (
    <Switch fallback={<Wifi size={16} stroke-width={2} />}>
      <Match when={props.wifi === 'off'}>
        <WifiOff size={16} stroke-width={2} />
      </Match>
      <Match when={props.wifi === 'weak'}>
        <WifiLow size={16} stroke-width={2} />
      </Match>
    </Switch>
  );
}

function PowerButton(props: {
  label: string;
  action: 'restart' | 'shutdown';
  index: number;
  disabled: boolean;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      class={styles.powerButton}
      data-power={props.action}
      style={{ '--pl-stagger-index': String(props.index) }}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      <span class={styles.powerIcon} aria-hidden="true">
        {props.children}
      </span>
      <span class={styles.powerLabel}>{props.label}</span>
    </button>
  );
}
