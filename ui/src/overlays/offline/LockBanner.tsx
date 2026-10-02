import Bell from 'lucide-solid/icons/bell-ring';
import Check from 'lucide-solid/icons/check';
import Lock from 'lucide-solid/icons/lock';
import LockOpen from 'lucide-solid/icons/lock-open';
import { createEffect, Match, on, Show, splitProps, Switch, type JSX } from 'solid-js';

import { colourSlotOf, initialsOf } from '../../primitives/avatar/Avatar.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { createNudge } from '../internal/behaviour.ts';
import shared from '../internal/shared.module.css';
import styles from './Offline.module.css';

export type LockBannerState = 'held' | 'released' | 'expired';

export interface LockBannerProps {
  /** The lease holder. */
  holder: { name: string; uid: number };
  /** The file's display name: `report.md`. */
  file: string;
  /** Seconds left on the holder's lease, and the lease TTL (15 s in the demo profile). */
  remainingS: number;
  ttlS: number;
  /** Lease details for the second line: `X lease · fence 41 · last seen 14:31:02`. */
  lease?: { mode: string; fence: number; lastSeen?: string };
  /** held (read-only), released (the file can be opened for writing), expired (our own lock lapsed). */
  state?: LockBannerState;
  /** Notify me is armed (aria-pressed). */
  notifying?: boolean;
  onNotify?: () => void;
  onOpenForWriting?: () => void;
  /** Change it (a counter) when the user types into the read-only buffer: the banner nudges once. */
  nudgeKey?: number;
  class?: string;
}

const RING = 36;
const RING_STROKE = 2.5;
const RING_R = (RING - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The read-only lease banner (VFS-09, OFF-02): who holds the lock, that you have read-only
 * access, and when the lease runs out, as text, as a countdown ring around the holder's avatar
 * and as a bar that drains linearly. It is a polite status: announced when it appears and when
 * the lease is released, never on every tick. Notify me arms a notification for the release.
 */
export function LockBanner(props: LockBannerProps): JSX.Element {
  const [local] = splitProps(props, [
    'holder',
    'file',
    'remainingS',
    'ttlS',
    'lease',
    'state',
    'notifying',
    'onNotify',
    'onOpenForWriting',
    'nudgeKey',
    'class',
  ]);
  const state = (): LockBannerState => local.state ?? 'held';
  const remaining = (): number => Math.max(0, Math.min(local.ttlS, Math.round(local.remainingS)));
  const ratio = (): number => (local.ttlS > 0 ? remaining() / local.ttlS : 0);
  const { nudge, attr } = createNudge();
  createEffect(
    on(
      () => local.nudgeKey,
      () => nudge(),
      { defer: true },
    ),
  );

  return (
    <div
      class={cx(styles.banner, shared.nudge, local.class)}
      data-state={state()}
      data-nudge={attr()}
      role="status"
    >
      <div class={styles.bannerTint} aria-hidden="true" />
      <div class={styles.holder} aria-hidden="true">
        <svg class={styles.leaseRing} width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`}>
          <circle
            class={styles.leaseTrack}
            cx={RING / 2}
            cy={RING / 2}
            r={RING_R}
            fill="none"
            stroke-width={RING_STROKE}
          />
          <Show when={state() === 'held'}>
            <circle
              class={styles.leaseArc}
              cx={RING / 2}
              cy={RING / 2}
              r={RING_R}
              fill="none"
              stroke-width={RING_STROKE}
              stroke-linecap="round"
              stroke-dasharray={String(RING_C)}
              stroke-dashoffset={String(RING_C * (1 - ratio()))}
              transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
            />
          </Show>
        </svg>
        <span class={cx(styles.holderAvatar, styles[`c${colourSlotOf(local.holder.name)}`])}>
          {initialsOf(local.holder.name)}
        </span>
        <span class={styles.lockBadge}>
          <Show when={state() === 'released'} fallback={<Lock size={9} stroke-width={3} />}>
            <LockOpen size={9} stroke-width={3} />
          </Show>
        </span>
      </div>

      <div class={styles.bannerText}>
        <Switch>
          <Match when={state() === 'held'}>
            <p class={styles.bannerLine}>
              <strong>
                {local.holder.name} is editing {local.file}
              </strong>{' '}
              — you have read-only access.
            </p>
            <p class={styles.bannerMeta} aria-live="off">
              Lease expires in <strong class={styles.seconds}>{remaining()} s</strong>
              <Show when={local.lease}>
                {(lease) => (
                  <>
                    {' '}
                    · {lease().mode} lease · fence {lease().fence}
                    <Show when={lease().lastSeen}>{(seen) => <> · last seen {seen()}</>}</Show>
                  </>
                )}
              </Show>
            </p>
          </Match>
          <Match when={state() === 'released'}>
            <p class={styles.bannerLine}>
              <strong>{local.file} is available</strong> — open for writing
            </p>
            <p class={styles.bannerMeta}>
              {local.holder.name} (uid {local.holder.uid}) released the lock
            </p>
          </Match>
          <Match when={state() === 'expired'}>
            <p class={styles.bannerLine}>
              <strong>Your lock expired while this tab was in the background</strong>
            </p>
            <p class={styles.bannerMeta}>{local.file} is read-only until you lock it again</p>
          </Match>
        </Switch>
      </div>

      <Switch>
        <Match when={state() === 'held' && local.onNotify}>
          {(onNotify) => (
            <Button
              variant={local.notifying === true ? 'tinted' : 'primary'}
              aria-pressed={local.notifying === true ? 'true' : 'false'}
              icon={
                local.notifying === true ? (
                  <Check size={13} stroke-width={2.6} />
                ) : (
                  <Bell size={13} stroke-width={2.2} />
                )
              }
              onClick={() => onNotify()()}
              class={styles.bannerAction}
            >
              {local.notifying === true ? 'Notifying you' : 'Notify me'}
            </Button>
          )}
        </Match>
        <Match when={state() === 'released' && local.onOpenForWriting}>
          {(open) => (
            <Button variant="primary" onClick={() => open()()} class={styles.releasedAction}>
              Open for writing
            </Button>
          )}
        </Match>
      </Switch>

      <Show when={state() === 'held'}>
        <div
          class={styles.leaseBar}
          role="progressbar"
          aria-label="Lease time left"
          aria-valuemin={0}
          aria-valuemax={local.ttlS}
          aria-valuenow={remaining()}
          aria-valuetext={`${remaining()} seconds left`}
        >
          <span class={styles.leaseFill} style={{ '--pl-progress-ratio': String(ratio()) }} />
        </div>
      </Show>
    </div>
  );
}
