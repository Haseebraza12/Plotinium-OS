import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  splitProps,
  untrack,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import type { NotificationLevel, ShellNotification } from '../types.ts';
import { createLeaving } from './leaving.ts';
import { NotificationCard } from './NotificationCard.tsx';
import styles from './Notifications.module.css';

export type ToastDismissReason = 'timeout' | 'user';

/** Auto-dismiss delay per level in ms; null keeps that level on screen until dismissed. */
export type ToastTimers = Partial<Record<NotificationLevel, number | null>>;

/** window-manager.md §3.17: info and success 6 s, warning 10 s, errors sticky. */
export const DEFAULT_TOAST_TIMERS: Readonly<Record<NotificationLevel, number | null>> = {
  info: 6000,
  success: 6000,
  warning: 10000,
  error: null,
};

export interface NotificationToastsProps {
  /** Pending banners, newest first; the first `max` show. */
  notifications: readonly ShellNotification[];
  now: number;
  /** After the exit animation: 'timeout' from the auto-dismiss timer, 'user' otherwise. */
  onDismiss: (id: string, reason: ToastDismissReason) => void;
  onAction: (id: string, actionId: string) => void;
  onOpen?: (id: string) => void;
  /** Auto-dismiss timers per level, or false to keep every banner until dismissed. */
  autoDismiss?: false | ToastTimers;
  /** At most this many banners at once. Default 3. */
  max?: number;
  /** Focus mode: info and success banners are held back (they stay in the centre). */
  focusMode?: boolean;
  /** Renders in place instead of fixed under the menu bar (previews). */
  inline?: boolean;
  class?: string;
}

const EXIT_MS = 220;

function Toast(props: {
  notification: ShellNotification;
  now: number;
  delay: number | null;
  leaving: boolean;
  onTimeout: () => void;
  onDismiss: () => void;
  onAction: (actionId: string) => void;
  onOpen?: () => void;
}): JSX.Element {
  let li: HTMLLIElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The delay is fixed per banner; it is read once, when the banner mounts.
  let remaining = untrack(() => props.delay) ?? 0;
  let startedAt = 0;
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);

  const stop = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  };
  const start = (): void => {
    if (props.delay === null || timer !== undefined || props.leaving) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = undefined;
      props.onTimeout();
    }, remaining);
  };

  // The timer pauses while the pointer is over the banner or focus is inside it (WCAG 2.2.1).
  createEffect(() => {
    if (hovered() || focused() || props.leaving) stop();
    else start();
  });
  onCleanup(() => clearTimeout(timer));

  return (
    <li
      ref={(el) => (li = el)}
      class={styles.toastItem}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusIn={() => setFocused(true)}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || li?.contains(next) !== true) setFocused(false);
      }}
    >
      <NotificationCard
        notification={props.notification}
        now={props.now}
        variant="banner"
        leaving={props.leaving}
        class={props.leaving ? undefined : 'pl-anim-notification-in'}
        onDismiss={() => props.onDismiss()}
        onAction={(actionId) => props.onAction(actionId)}
        onOpen={props.onOpen}
      />
    </li>
  );
}

/**
 * Notification banners (WMD-18): top right, under the menu bar, the column Notification Centre
 * opens in. At most three; they slide in with a spring and out to the right. Info, success and
 * warning banners dismiss themselves after their level's delay, errors stay; timers pause on
 * hover and focus. Banners never take focus. New banners are announced through one polite and one
 * assertive live region (errors), which stay mounted so every announcement is heard.
 */
export function NotificationToasts(props: NotificationToastsProps): JSX.Element {
  const [local] = splitProps(props, [
    'notifications',
    'now',
    'onDismiss',
    'onAction',
    'onOpen',
    'autoDismiss',
    'max',
    'focusMode',
    'inline',
    'class',
  ]);
  const leaving = createLeaving(EXIT_MS);

  const visible = createMemo(() =>
    local.notifications
      .filter((n) => local.focusMode !== true || n.level === 'warning' || n.level === 'error')
      .slice(0, Math.max(0, local.max ?? 3)),
  );
  const ids = createMemo(() => visible().map((n) => n.id));
  const byId = createMemo(() => new Map(visible().map((n) => [n.id, n] as const)));

  const delayFor = (level: NotificationLevel): number | null => {
    const timers = local.autoDismiss;
    if (timers === false) return null;
    const custom = timers?.[level];
    return custom === undefined ? DEFAULT_TOAST_TIMERS[level] : custom;
  };

  const dismiss = (id: string, reason: ToastDismissReason): void => {
    const onDismiss = local.onDismiss;
    leaving.leave(id, () => onDismiss(id, reason));
  };

  // ---------- announcements ----------
  const [polite, setPolite] = createSignal('');
  const [assertive, setAssertive] = createSignal('');
  const seen = new Set<string>();
  createEffect(() => {
    for (const n of visible()) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const text = [n.title, n.body, n.code].filter((t) => t !== undefined).join('. ');
      if (n.level === 'error') setAssertive(text);
      else setPolite(text);
    }
  });

  return (
    <section
      aria-label="Notification banners"
      class={cx(styles.toasts, local.inline === true && styles.toastsInline, local.class)}
    >
      <ol class={styles.toastList} role="list">
        <For each={ids()}>
          {(id) => (
            <Show when={byId().get(id)}>
              {(n) => (
                <Toast
                  notification={n()}
                  now={local.now}
                  delay={delayFor(n().level)}
                  leaving={leaving.isLeaving(id)}
                  onTimeout={() => dismiss(id, 'timeout')}
                  onDismiss={() => dismiss(id, 'user')}
                  onAction={(actionId) => local.onAction(id, actionId)}
                  onOpen={local.onOpen === undefined ? undefined : () => local.onOpen?.(id)}
                />
              )}
            </Show>
          )}
        </For>
      </ol>
      <div role="status" aria-live="polite" class={styles.srOnly}>
        {polite()}
      </div>
      <div role="alert" aria-live="assertive" class={styles.srOnly}>
        {assertive()}
      </div>
    </section>
  );
}
