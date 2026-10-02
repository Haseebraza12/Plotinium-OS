import { Show, splitProps, type JSX } from 'solid-js';

import { cx } from '../internal/cx.ts';
import styles from './Progress.module.css';
import type { ProgressTone } from './ProgressBar.tsx';

export interface ProgressRingProps {
  value: number;
  max?: number;
  label: string;
  valueText?: string;
  /** Pixel diameter. */
  size?: number;
  /** Stroke width in pixels. */
  thickness?: number;
  /** Show a short value inside the ring: centerLabel, else the percentage. */
  showValue?: boolean;
  /** Short text for the centre (e.g. "142"); valueText stays the spoken value. */
  centerLabel?: string;
  tone?: ProgressTone;
  class?: string;
}

/**
 * A circular determinate meter (memory pressure, quota, battery). The arc is a dash offset set
 * per value, not animated: only transform and opacity animate (PROC-05).
 */
export function ProgressRing(props: ProgressRingProps): JSX.Element {
  const [local] = splitProps(props, [
    'value',
    'max',
    'label',
    'valueText',
    'size',
    'thickness',
    'showValue',
    'centerLabel',
    'tone',
    'class',
  ]);
  const size = (): number => local.size ?? 36;
  const thickness = (): number => local.thickness ?? Math.max(3, Math.round(size() / 9));
  const radius = (): number => (size() - thickness()) / 2;
  const circumference = (): number => 2 * Math.PI * radius();
  const max = (): number => (local.max !== undefined && local.max > 0 ? local.max : 100);
  const ratio = (): number => Math.min(1, Math.max(0, local.value / max()));
  const text = (): string => local.valueText ?? `${Math.round(ratio() * 100)}%`;
  return (
    <div
      class={cx(
        styles.ring,
        local.tone !== undefined && local.tone !== 'accent' && styles[local.tone],
        local.class,
      )}
      role="progressbar"
      aria-label={local.label}
      aria-valuemin={0}
      aria-valuemax={max()}
      aria-valuenow={Math.min(max(), Math.max(0, local.value))}
      aria-valuetext={text()}
    >
      <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`} aria-hidden="true">
        <circle
          class={styles.ringTrack}
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          fill="none"
          stroke-width={thickness()}
        />
        <circle
          class={styles.ringFill}
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          fill="none"
          stroke-width={thickness()}
          stroke-linecap="round"
          stroke-dasharray={String(circumference())}
          stroke-dashoffset={String(circumference() * (1 - ratio()))}
        />
      </svg>
      <Show when={local.showValue}>
        <span class={styles.ringLabel} aria-hidden="true">
          {local.centerLabel ?? `${Math.round(ratio() * 100)}%`}
        </span>
      </Show>
    </div>
  );
}
