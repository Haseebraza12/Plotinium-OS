import CircleCheck from 'lucide-solid/icons/circle-check';
import CircleX from 'lucide-solid/icons/circle-x';
import Columns2 from 'lucide-solid/icons/columns-2';
import Info from 'lucide-solid/icons/info';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import X from 'lucide-solid/icons/x';
import { createMemo, For, Match, Show, splitProps, Switch, type JSX } from 'solid-js';

import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { createPresence } from '../../primitives/internal/presence.ts';
import styles from './EditorBanner.module.css';

export type BannerTone = 'warning' | 'danger' | 'success' | 'info';

export interface BannerAction {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary';
  icon?: JSX.Element;
  /** Disabled with a reason (kept focusable, reason as the tooltip). */
  disabledReason?: string;
}

export interface EditorBannerProps {
  tone: BannerTone;
  /** Accessible name of the region ("Sync conflict", "File lock"). */
  label: string;
  title: JSX.Element;
  detail?: JSX.Element;
  actions?: readonly BannerAction[];
  onAction?: (id: string) => void;
  onDismiss?: () => void;
  /** Announce the title when the banner appears (role="alert"); otherwise it is polite. */
  assertive?: boolean;
  class?: string;
}

function ToneIcon(props: { tone: BannerTone }): JSX.Element {
  return (
    <Switch>
      <Match when={props.tone === 'warning'}>
        <TriangleAlert size={16} stroke-width={2} />
      </Match>
      <Match when={props.tone === 'danger'}>
        <CircleX size={16} stroke-width={2} />
      </Match>
      <Match when={props.tone === 'success'}>
        <CircleCheck size={16} stroke-width={2} />
      </Match>
      <Match when={props.tone === 'info'}>
        <Info size={16} stroke-width={2} />
      </Match>
    </Switch>
  );
}

/**
 * An in-window banner above the editor (ui-design-system.md §3.8.12): tinted material with a
 * 1 px tone border, an icon, a title, a detail line and real buttons. Its tone is always named
 * by the icon and the words as well as the colour (DSN-08). Focus is not moved to it.
 */
export function EditorBanner(props: EditorBannerProps): JSX.Element {
  const [local] = splitProps(props, [
    'tone',
    'label',
    'title',
    'detail',
    'actions',
    'onAction',
    'onDismiss',
    'assertive',
    'class',
  ]);
  return (
    <section
      role="region"
      aria-label={local.label}
      class={cx(styles.banner, local.class)}
      data-tone={local.tone}
    >
      <span class={styles.icon} aria-hidden="true">
        <ToneIcon tone={local.tone} />
      </span>
      <div class={styles.text}>
        <p
          class={styles.title}
          role={local.assertive === true ? 'alert' : 'status'}
          aria-live={local.assertive === true ? 'assertive' : 'polite'}
        >
          {local.title}
        </p>
        <Show when={local.detail}>
          <p class={styles.detail}>{local.detail}</p>
        </Show>
      </div>
      <Show when={(local.actions?.length ?? 0) > 0}>
        <div class={styles.actions}>
          <For each={local.actions}>
            {(action) => (
              <Button
                size="sm"
                variant={action.variant === 'primary' ? 'primary' : 'secondary'}
                icon={action.icon}
                disabled={action.disabledReason !== undefined}
                title={action.disabledReason}
                onClick={() => local.onAction?.(action.id)}
              >
                {action.label}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Show when={local.onDismiss}>
        <button
          type="button"
          class={styles.dismiss}
          aria-label="Dismiss"
          onClick={() => local.onDismiss?.()}
        >
          <X size={14} stroke-width={2} aria-hidden="true" />
        </button>
      </Show>
    </section>
  );
}

/** The states of the sync-conflict banner (editor-conflict notes; SYN-08, VFS-10). */
export type ConflictState =
  | {
      kind: 'conflict';
      /** The sibling that holds the offline bytes, `name (conflict from user, date).ext`. */
      copyName: string;
      /** The change happened while this device was offline. */
      offline?: boolean;
      /** The conflicted copy was deleted: Compare and Open are disabled with a reason. */
      copyMissing?: boolean;
    }
  | { kind: 'checking' }
  | { kind: 'resolved'; version: number }
  | { kind: 'error'; retryInSeconds?: number };

export type ConflictAction = 'compare' | 'open-copy' | 'retry';

export interface ConflictBannerProps {
  /** undefined hides the banner (with its exit animation). */
  state: ConflictState | undefined;
  onAction: (action: ConflictAction) => void;
  onDismiss?: () => void;
  class?: string;
}

/** Exact strings (ui-design-system.md §3.8.12, editor-conflict notes). */
export function conflictTitle(state: ConflictState): string {
  switch (state.kind) {
    case 'conflict':
      return state.offline === true
        ? 'This file changed on the server while you were offline.'
        : 'This file changed on the server.';
    case 'checking':
      return 'Checking server version…';
    case 'resolved':
      return `Conflict resolved · kept v${state.version}`;
    case 'error':
      return state.retryInSeconds === undefined
        ? 'Could not reach server.'
        : `Could not reach server · retry in ${state.retryInSeconds} s`;
  }
}

const TONE: Record<ConflictState['kind'], BannerTone> = {
  conflict: 'warning',
  checking: 'info',
  resolved: 'success',
  error: 'danger',
};

/**
 * The amber sync-conflict banner: nothing was overwritten, the offline version was kept as a
 * conflicted copy, and the user can Compare or open that copy (VFS-10: no update is silently
 * lost). It turns green when resolved and red when the server cannot be reached.
 */
export function ConflictBanner(props: ConflictBannerProps): JSX.Element {
  const [local] = splitProps(props, ['state', 'onAction', 'onDismiss', 'class']);
  // Keeps the last state on screen while the banner plays its exit animation.
  const shown = createMemo<ConflictState | undefined>((previous) => local.state ?? previous);
  const presence = createPresence(() => local.state !== undefined, 200);

  const detail = (state: ConflictState): JSX.Element | undefined =>
    state.kind === 'conflict' ? (
      <>
        Your version was saved as “<code class={styles.code}>{state.copyName}</code>”.
      </>
    ) : undefined;

  const actions = (state: ConflictState): BannerAction[] => {
    if (state.kind === 'error') return [{ id: 'retry', label: 'Retry', variant: 'secondary' }];
    if (state.kind !== 'conflict') return [];
    const missing = state.copyMissing === true ? 'The conflicted copy was deleted' : undefined;
    return [
      {
        id: 'compare',
        label: 'Compare',
        variant: 'primary',
        icon: <Columns2 size={14} stroke-width={2} />,
        disabledReason: missing,
      },
      { id: 'open-copy', label: 'Open conflicted copy', disabledReason: missing },
    ];
  };

  return (
    <Show when={presence.mounted() ? shown() : undefined}>
      {(state) => (
        <EditorBanner
          tone={TONE[state().kind]}
          label="Sync conflict"
          assertive={state().kind === 'conflict' || state().kind === 'error'}
          class={cx(styles.enter, presence.state() === 'closing' && styles.leave, local.class)}
          title={conflictTitle(state())}
          detail={detail(state())}
          actions={actions(state())}
          onAction={(id) => local.onAction(id as ConflictAction)}
          onDismiss={local.onDismiss === undefined ? undefined : () => local.onDismiss?.()}
        />
      )}
    </Show>
  );
}
