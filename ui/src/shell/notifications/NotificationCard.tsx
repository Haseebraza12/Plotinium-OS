import ChevronRight from 'lucide-solid/icons/chevron-right';
import CircleCheck from 'lucide-solid/icons/circle-check';
import Info from 'lucide-solid/icons/info';
import OctagonAlert from 'lucide-solid/icons/octagon-alert';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import X from 'lucide-solid/icons/x';
import {
  createMemo,
  createUniqueId,
  For,
  Match,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';

import { AppIcon } from '../../icons/index.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { relativeTime } from '../format.ts';
import type { NotificationLevel, ShellNotification } from '../types.ts';
import styles from './Notifications.module.css';

export interface NotificationCardProps {
  notification: ShellNotification;
  /** Epoch ms, for the relative time ("2m ago"). */
  now: number;
  /** centre: in Notification Centre; banner: a toast under the menu bar. */
  variant?: 'centre' | 'banner';
  /** The close button, or Delete or Backspace on the focused card (never Escape, UI-082). */
  onDismiss: () => void;
  onAction?: (actionId: string) => void;
  /** Click or Enter on the card: open the source app. */
  onOpen?: () => void;
  /** Plays the exit animation (the owner removes the card when it ends). */
  leaving?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
}

const LEVEL_WORD: Record<NotificationLevel, string> = {
  info: 'Information',
  success: 'Done',
  warning: 'Warning',
  error: 'Error',
};

/**
 * One notification card (WMD-18): app icon (or a level tile), title, body, relative time, unread
 * dot, level glyph, a "×3" count for merged repeats, and actions. It is a focusable article
 * labelled by its level and title and described by its body and time; Delete or Backspace
 * dismisses it, Enter opens it. Escape is left to the surrounding panel (it closes Control
 * Centre and never deletes a notification). The level is never colour alone: the glyph has a
 * spoken word.
 */
export function NotificationCard(props: NotificationCardProps): JSX.Element {
  const [local] = splitProps(props, [
    'notification',
    'now',
    'variant',
    'onDismiss',
    'onAction',
    'onOpen',
    'leaving',
    'class',
    'style',
  ]);
  const uid = createUniqueId();
  const ids = {
    level: `pl-note-${uid}-level`,
    title: `pl-note-${uid}-title`,
    body: `pl-note-${uid}-body`,
    time: `pl-note-${uid}-time`,
  };
  const n = (): ShellNotification => local.notification;
  const time = createMemo(() => relativeTime(n().at, local.now));
  const buttons = (): NonNullable<ShellNotification['actions']> =>
    (n().actions ?? []).filter((a) => a.kind !== 'link');
  const links = (): NonNullable<ShellNotification['actions']> =>
    (n().actions ?? []).filter((a) => a.kind === 'link');
  const hasBody = (): boolean => n().body !== undefined || n().code !== undefined;

  const fromControl = (event: Event): boolean =>
    event.target instanceof Element &&
    event.target !== event.currentTarget &&
    event.target.closest('button, a[href]') !== null;

  return (
    <article
      class={cx(
        styles.card,
        local.variant === 'banner' && styles.banner,
        local.leaving === true && 'pl-anim-notification-out',
        local.class,
      )}
      style={local.style}
      tabindex={0}
      data-note-id={n().id}
      data-level={n().level}
      data-unread={n().unread === true ? 'true' : 'false'}
      aria-labelledby={`${ids.level} ${ids.title}`}
      aria-describedby={hasBody() ? `${ids.body} ${ids.time}` : ids.time}
      onClick={(event) => {
        if (!fromControl(event)) local.onOpen?.();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          local.onDismiss();
        } else if (event.key === 'Enter' && local.onOpen !== undefined) {
          event.preventDefault();
          local.onOpen();
        }
      }}
    >
      <span class={styles.appIcon} aria-hidden="true">
        <Show
          when={n().app}
          fallback={
            <span class={styles.levelTile} data-level={n().level}>
              <Switch fallback={<Info size={18} />}>
                <Match when={n().level === 'success'}>
                  <CircleCheck size={18} />
                </Match>
                <Match when={n().level === 'warning'}>
                  <TriangleAlert size={18} />
                </Match>
                <Match when={n().level === 'error'}>
                  <OctagonAlert size={18} />
                </Match>
              </Switch>
            </span>
          }
        >
          {(app) => <AppIcon app={app()} size={36} />}
        </Show>
      </span>

      <div class={styles.main}>
        <div class={styles.top}>
          <span class={styles.srOnly} id={ids.level}>
            {`${LEVEL_WORD[n().level]}${n().appName === undefined ? '' : ` from ${n().appName}`}:`}
          </span>
          <span class={styles.title} id={ids.title}>
            {n().title}
          </span>
          <span class={styles.meta}>
            <Show when={(n().count ?? 1) > 1}>
              <span class={styles.count} aria-hidden="true">
                ×{n().count}
              </span>
            </Show>
            <Show when={n().unread === true}>
              <span class={cx(styles.unreadDot, 'pl-anim-pop-in')} aria-hidden="true" />
            </Show>
            <span class={styles.levelGlyph} aria-hidden="true">
              <Switch>
                <Match when={n().level === 'success'}>
                  <CircleCheck size={12} />
                </Match>
                <Match when={n().level === 'warning'}>
                  <TriangleAlert size={12} />
                </Match>
                <Match when={n().level === 'error'}>
                  <OctagonAlert size={12} />
                </Match>
              </Switch>
            </span>
            <time id={ids.time} datetime={new Date(n().at).toISOString()} class={styles.time}>
              <span aria-hidden="true">{time().short}</span>
              <span class={styles.srOnly}>
                {time().spoken}
                {(n().count ?? 1) > 1 ? `, ${String(n().count)} times` : ''}
                {n().unread === true ? ', unread' : ''}
              </span>
            </time>
          </span>
        </div>

        <Show when={hasBody()}>
          <p class={styles.body} id={ids.body}>
            {n().body}
            <Show when={n().code}>
              {(code) => (
                <>
                  {n().body === undefined ? '' : ' '}
                  <code class={styles.code}>{code()}</code>
                </>
              )}
            </Show>
          </p>
        </Show>

        <Show when={links().length > 0}>
          <div class={styles.links}>
            <For each={links()}>
              {(action) => (
                <button
                  type="button"
                  class={styles.link}
                  onClick={() => local.onAction?.(action.id)}
                >
                  {action.label}
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={buttons().length > 0}>
          <div class={styles.actions}>
            <For each={buttons()}>
              {(action) => (
                <Button
                  size="sm"
                  variant={action.kind === 'primary' ? 'primary' : 'secondary'}
                  onClick={() => local.onAction?.(action.id)}
                >
                  {action.label}
                </Button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <button
        type="button"
        class={styles.close}
        aria-label={`Dismiss ${n().title}`}
        onClick={() => local.onDismiss()}
      >
        <X size={11} stroke-width={2.6} aria-hidden="true" />
      </button>
    </article>
  );
}
