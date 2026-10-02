import Lock from 'lucide-solid/icons/lock';
import LockOpen from 'lucide-solid/icons/lock-open';
import PenLine from 'lucide-solid/icons/pen-line';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  Match,
  on,
  onCleanup,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';

import { Avatar } from '../../primitives/avatar/Avatar.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { leaseSecondsLeft } from './format.ts';
import styles from './LockChip.module.css';

/** Under this many seconds the chip turns to full-strength warning ("Lease expiring"). */
export const LEASE_WARNING_SECONDS = 5;

/** Lock states of the open file (VFS-09; editor-conflict notes). */
export type LockState =
  | {
      kind: 'other';
      /** Who holds the write lease. */
      holder: string;
      /** Epoch ms when the lease lapses unless renewed. */
      expiresAt: number;
      /** Lease length, for the ring (30 s by default). */
      leaseMs?: number;
      /** Fencing number, shown in the tooltip. */
      fence?: number;
    }
  | { kind: 'mine' }
  | { kind: 'released'; holder: string };

export interface LockChipProps {
  state: LockState;
  /** Clock source, for tests and replays. */
  now?: () => number;
  /** Click: open the lock popover ("Request edit access", "Notify me when free"). */
  onActivate?: () => void;
  /** Bumps a shake when the user typed into the locked buffer. */
  attemptKey?: number;
  class?: string;
}

/** The chip's visible text for a state and the seconds left. */
export function lockChipText(state: LockState, seconds: number): string {
  switch (state.kind) {
    case 'other':
      return `Read-only — locked by ${state.holder} (lease ${seconds} s)`;
    case 'mine':
      return 'Editing — you hold the lock';
    case 'released':
      return 'Editable';
  }
}

/** The spoken name: the same facts in words that read well aloud. */
export function lockChipLabel(state: LockState, seconds: number): string {
  switch (state.kind) {
    case 'other':
      return `Read-only, locked by ${state.holder}, lease ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    case 'mine':
      return 'Editing, you hold the lock';
    case 'released':
      return `Editable, ${state.holder} released the lock`;
  }
}

const RING_R = 6;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The title-bar lock chip: amber while another user holds the write lease, with a countdown
 * ring stepped once per second from the lease's expiry (data, not decoration: no free-running
 * loop), full-strength warning under 5 s, a pulse when the lease is renewed, and green
 * "Editable" once released. The seconds live in a role="timer" region that is not live; only
 * "released" and "Lease expiring" are announced.
 */
export function LockChip(props: LockChipProps): JSX.Element {
  const [local] = splitProps(props, ['state', 'now', 'onActivate', 'attemptKey', 'class']);
  const uid = createUniqueId();
  const clock = (): number => (local.now ?? Date.now)();
  const [tick, setTick] = createSignal(clock());
  const [pulse, setPulse] = createSignal(false);
  const [shake, setShake] = createSignal(false);
  const [entered, setEntered] = createSignal(false);

  const timer = setInterval(() => {
    if (local.state.kind === 'other') setTick(clock());
  }, 1000);
  onCleanup(() => clearInterval(timer));

  const seconds = createMemo(() => {
    const state = local.state;
    return state.kind === 'other' ? leaseSecondsLeft(state.expiresAt, tick()) : 0;
  });
  const fraction = createMemo(() => {
    const state = local.state;
    if (state.kind !== 'other') return 0;
    const lease = state.leaseMs ?? 30_000;
    return Math.min(1, Math.max(0, (state.expiresAt - tick()) / lease));
  });
  const expiring = (): boolean =>
    local.state.kind === 'other' && seconds() <= LEASE_WARNING_SECONDS;

  // A renewal pushes expiresAt forward: pulse once and refill the ring.
  createEffect(
    on(
      () => (local.state.kind === 'other' ? local.state.expiresAt : undefined),
      (next, previous) => {
        setTick(clock());
        if (next !== undefined && previous !== undefined && next > previous) setPulse(true);
      },
    ),
  );
  createEffect(
    on(
      () => local.attemptKey,
      (key, previous) => {
        if (key !== undefined && key !== previous) setShake(true);
      },
      { defer: true },
    ),
  );

  const announcement = (): string => {
    const state = local.state;
    if (state.kind === 'released') return `${state.holder} released the lock`;
    if (expiring() && seconds() > 0) return 'Lease expiring';
    return '';
  };
  const tooltip = (): string | undefined => {
    const state = local.state;
    if (state.kind !== 'other') return undefined;
    const fence = state.fence === undefined ? '' : ` · fence ${state.fence}`;
    return `${state.holder} holds the write lease · ${seconds()} s left${fence}`;
  };

  return (
    <>
      <button
        type="button"
        class={cx(
          styles.chip,
          !entered() && styles.enter,
          pulse() && styles.pulse,
          shake() && styles.shake,
          expiring() && styles.expiring,
          local.class,
        )}
        data-kind={local.state.kind}
        title={tooltip()}
        aria-label={lockChipLabel(local.state, seconds())}
        aria-describedby={`pl-lock-${uid}-timer`}
        onClick={() => local.onActivate?.()}
        onAnimationEnd={() => {
          setEntered(true);
          setPulse(false);
          setShake(false);
        }}
      >
        <span class={styles.icon} aria-hidden="true">
          <Switch>
            <Match when={local.state.kind === 'other'}>
              <Lock size={12} stroke-width={2.2} />
            </Match>
            <Match when={local.state.kind === 'mine'}>
              <PenLine size={12} stroke-width={2.2} />
            </Match>
            <Match when={local.state.kind === 'released'}>
              <LockOpen size={12} stroke-width={2.2} />
            </Match>
          </Switch>
        </span>
        <span class={styles.text} aria-hidden="true">
          {lockChipText(local.state, seconds())}
        </span>
        <Show when={local.state.kind === 'other'}>
          <svg class={styles.ring} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle class={styles.ringTrack} cx="8" cy="8" r={RING_R} />
            <circle
              class={styles.ringFill}
              cx="8"
              cy="8"
              r={RING_R}
              stroke-dasharray={`${RING_C}`}
              stroke-dashoffset={`${RING_C * (1 - fraction())}`}
            />
          </svg>
        </Show>
        <Show when={local.state.kind === 'other' ? local.state.holder : undefined}>
          {(holder) => <Avatar name={holder()} size="sm" decorative class={styles.avatar} />}
        </Show>
      </button>
      <span id={`pl-lock-${uid}-timer`} role="timer" aria-live="off" class={styles.hidden}>
        <Show when={local.state.kind === 'other'}>{`${seconds()} seconds left on the lease`}</Show>
      </span>
      <span role="status" aria-live="polite" class={styles.hidden}>
        {announcement()}
      </span>
    </>
  );
}
