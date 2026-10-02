import { createMemo, Index, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { createThrottled } from '../internal/behaviour.ts';
import shared from '../internal/shared.module.css';
import styles from './FrameMeterHUD.module.css';

/** The meter summary (window-manager.md §4.8 `FrameStats`, computed by the WM at 1 Hz). */
export interface FrameMeterStats {
  /** Refresh rate from the median rAF interval: 60, 120. */
  refreshHz: number;
  /** p95 of the vsync-quantised frame intervals, in ms. */
  p95Ms: number;
  /** Share of dropped frames, 0..1. */
  droppedShare: number;
  /** Long animation frames over 50 ms attributed to our origin, and to anything else. */
  loafOurs: number;
  loafOther: number;
}

export type FrameMeterCorner = 'top-right' | 'bottom-right' | 'bottom-left' | 'top-left';

export interface FrameMeterHUDProps {
  /** Undefined during the first second (`collecting…`). */
  stats: FrameMeterStats | undefined;
  /** Recent quantised frame intervals in ms, oldest first. */
  samples: readonly number[];
  /** Frame budget, 16.7 ms by default (WM-03). */
  budgetMs?: number;
  /** Expanded shows 60 bars and the full WMD-19 line. */
  expanded?: boolean;
  /** Makes the HUD a button that toggles compact and expanded. */
  onToggleExpanded?: () => void;
  /** WMD-19 puts it top-right; the offline mock uses bottom-right. */
  corner?: FrameMeterCorner;
  /**
   * Something occupies the right column under the menu bar (Control Centre, banners): the HUD
   * slides left of it instead of covering it (D-22). Transform only.
   */
  shifted?: boolean;
  /** Render in the flow of the parent instead of fixed to a screen corner (gallery). */
  contained?: boolean;
  class?: string;
}

const COMPACT_BARS = 24;
/** Samples are vsync-quantised; half a millisecond absorbs the leftover jitter (16.8 at 60 Hz). */
const JITTER_MS = 0.5;
const EXPANDED_BARS = 60;

function fmt(value: number, digits = 1): string {
  return value.toFixed(digits);
}

/**
 * The frame meter HUD (WMD-19; the live indicator for WM-03 and PROC-05, never the gate): p95,
 * refresh rate, an OK or over-budget state in words, and a bar strip against a dashed budget line.
 * The numbers are the accessible content, announced at most once every 5 s; the bars are
 * decorative. It redraws only when the WM posts new stats (1 Hz), and its bars move by scaleY.
 */
export function FrameMeterHUD(props: FrameMeterHUDProps): JSX.Element {
  const [local] = splitProps(props, [
    'stats',
    'samples',
    'budgetMs',
    'expanded',
    'onToggleExpanded',
    'corner',
    'shifted',
    'contained',
    'class',
  ]);
  const budget = (): number => local.budgetMs ?? 16.7;
  const over = (): boolean => local.stats !== undefined && local.stats.p95Ms > budget();
  const bars = createMemo(() => {
    const count = local.expanded === true ? EXPANDED_BARS : COMPACT_BARS;
    const recent = local.samples.slice(-count);
    const padding = Array.from({ length: Math.max(0, count - recent.length) }, () => 0);
    return [...padding, ...recent];
  });
  const spoken = (): string => {
    const stats = local.stats;
    if (stats === undefined) return 'Frame meter: collecting';
    return `Frame meter: p95 ${fmt(stats.p95Ms)} milliseconds at ${Math.round(stats.refreshHz)} hertz, ${over() ? 'over budget' : 'within budget'}`;
  };
  const announcement = createThrottled(spoken, 5000);

  const body = (): JSX.Element => (
    <>
      <span class={styles.top} aria-hidden="true">
        <Show when={local.stats} fallback={<span class={styles.headline}>collecting…</span>}>
          {(stats) => (
            <span class={styles.headline}>
              p95 {fmt(stats().p95Ms)} ms · {Math.round(stats().refreshHz)} Hz
            </span>
          )}
        </Show>
        <Show when={local.stats !== undefined}>
          <span class={styles.state} data-over={over() ? 'true' : undefined}>
            <span class={styles.stateDot} />
            {over() ? 'over budget' : 'OK'}
          </span>
        </Show>
      </span>
      <span class={styles.graph} aria-hidden="true">
        <span class={styles.budgetLine} />
        <Index each={bars()}>
          {(value) => (
            <span
              class={styles.bar}
              data-over={value() > budget() + JITTER_MS ? 'true' : undefined}
              style={{ '--pl-bar': String(Math.min(1, value() / (budget() * 2))) }}
            />
          )}
        </Index>
      </span>
      <span class={styles.foot} aria-hidden="true">
        budget {fmt(budget())} ms
        <Show when={local.stats}>
          {(stats) => (
            <>
              {' '}
              · dropped {fmt(stats().droppedShare * 100)}%
              <Show when={local.expanded === true} fallback={<> · LoAF {stats().loafOurs}</>}>
                {' '}
                · LoAF&gt;50 ours {stats().loafOurs} / other {stats().loafOther}
              </Show>
            </>
          )}
        </Show>
      </span>
    </>
  );

  return (
    <div
      class={cx(
        styles.hud,
        local.contained !== true && styles.fixed,
        local.contained !== true && styles[local.corner ?? 'top-right'],
        local.expanded === true && styles.expanded,
        local.class,
      )}
      data-shifted={local.contained !== true && local.shifted === true ? 'true' : undefined}
      role="status"
    >
      <span class={shared.srOnly}>{announcement()}</span>
      <Show when={local.onToggleExpanded} fallback={<div class={styles.inner}>{body()}</div>}>
        {(toggle) => (
          <button
            type="button"
            class={cx(styles.inner, styles.button)}
            aria-expanded={local.expanded === true ? 'true' : 'false'}
            aria-label="Frame meter details"
            onClick={() => toggle()()}
          >
            {body()}
          </button>
        )}
      </Show>
    </div>
  );
}
