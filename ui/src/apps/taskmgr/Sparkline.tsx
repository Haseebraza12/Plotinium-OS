import { createEffect, createMemo, createUniqueId, on, Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { prefersReducedMotion } from '../../primitives/internal/motion.ts';
import { sparkPath } from './format.ts';
import styles from './Sparkline.module.css';

export type SparkTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface SparklineProps {
  /** Samples, oldest first. */
  values: readonly number[];
  /** Top of the scale (default 100, for percentages). */
  max?: number;
  tone?: SparkTone;
  /** Draw the gradient area under the line. */
  area?: boolean;
  /**
   * Live data: each new sample scrolls the path one step left over a second (transform only).
   * Off while paused and under reduced motion, where the path redraws in place.
   */
  live?: boolean;
  /** A dimmed flat look for idle series. */
  muted?: boolean;
  /** Accessible summary ("exec-4, CPU 99 percent, rising"). Without it the chart is decorative. */
  label?: string;
  /** viewBox size; the SVG stretches to its box (non-scaling stroke). */
  width?: number;
  height?: number;
  class?: string;
}

/**
 * A cheap SVG sparkline: one path (and an optional area), no axes, no layout reads. It stretches
 * to its container with a non-scaling stroke, so a 1 Hz update costs one attribute write.
 */
export function Sparkline(props: SparklineProps): JSX.Element {
  const [local] = splitProps(props, [
    'values',
    'max',
    'tone',
    'area',
    'live',
    'muted',
    'label',
    'width',
    'height',
    'class',
  ]);
  const uid = createUniqueId();
  const w = (): number => local.width ?? 120;
  const h = (): number => local.height ?? 32;
  const geometry = createMemo(() => sparkPath(local.values, w(), h(), local.max ?? 100));
  let group: SVGGElement | undefined;

  // Scroll one step on each new sample (WAAPI on a <g>: transform only, 1 s linear). Keyed on
  // the geometry, so it also fires when a store updates the samples in place.
  createEffect(
    on(
      geometry,
      () => {
        const el = group;
        if (el === undefined || local.live !== true || typeof el.animate !== 'function') return;
        if (prefersReducedMotion(el.ownerDocument)) return;
        const step = geometry().step;
        if (step <= 0) return;
        el.animate([{ transform: `translateX(${step}px)` }, { transform: 'translateX(0)' }], {
          duration: 1000,
          easing: 'linear',
        });
      },
      { defer: true },
    ),
  );

  return (
    <svg
      class={cx(
        styles.spark,
        styles[local.tone ?? 'accent'],
        local.muted === true && styles.muted,
        local.class,
      )}
      viewBox={`0 0 ${w()} ${h()}`}
      preserveAspectRatio="none"
      role={local.label === undefined ? undefined : 'img'}
      aria-label={local.label}
      aria-hidden={local.label === undefined ? 'true' : undefined}
    >
      <defs>
        <linearGradient id={`pl-spark-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class={styles.stopTop} />
          <stop offset="1" class={styles.stopBottom} />
        </linearGradient>
      </defs>
      <g ref={(el) => (group = el)}>
        <Show when={local.area === true}>
          <path class={styles.area} d={geometry().area} fill={`url(#pl-spark-${uid})`} />
        </Show>
        <path class={styles.line} d={geometry().line} vector-effect="non-scaling-stroke" />
      </g>
    </svg>
  );
}
