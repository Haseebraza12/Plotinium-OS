import CircleDot from 'lucide-solid/icons/circle-dot';
import CirclePause from 'lucide-solid/icons/circle-pause';
import CircleX from 'lucide-solid/icons/circle-x';
import Clock from 'lucide-solid/icons/clock';
import Moon from 'lucide-solid/icons/moon';
import Play from 'lucide-solid/icons/play';
import Sparkle from 'lucide-solid/icons/sparkle';
import { Show, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../../primitives/internal/cx.ts';
import type { IconComponent } from '../../primitives/internal/icon.ts';
import { stateLabel } from './format.ts';
import type { ProcStateView } from './models.ts';
import styles from './StatePill.module.css';

const GLYPH: Record<ProcStateView, IconComponent> = {
  NEW: Sparkle,
  READY: CircleDot,
  RUNNING: Play,
  BLOCKED: Clock,
  SUSPENDED: Moon,
  STOPPED: CirclePause,
  TERMINATED: CircleX,
};

const TONE: Record<ProcStateView, string> = {
  NEW: 'accent',
  READY: 'info',
  RUNNING: 'success',
  BLOCKED: 'warning',
  SUSPENDED: 'neutral',
  STOPPED: 'neutral',
  TERMINATED: 'danger',
};

export interface StatePillProps {
  state: ProcStateView;
  /** Second word: the wait reason ("awaiting llm") or "paged out". */
  reason?: string;
  class?: string;
}

/**
 * A process state as glyph + word (+ reason), so state is never shown by colour alone (DSN-08).
 * The text reads "Blocked, awaiting llm" to assistive technology.
 */
export function StatePill(props: StatePillProps): JSX.Element {
  const [local] = splitProps(props, ['state', 'reason', 'class']);
  return (
    <span class={cx(styles.pill, styles[TONE[local.state]], local.class)} data-state={local.state}>
      <span class={styles.glyph} aria-hidden="true">
        <Dynamic component={GLYPH[local.state]} size={10} stroke-width={2.6} />
      </span>
      <span class={styles.word}>{stateLabel(local.state)}</span>
      <Show when={local.reason !== undefined && local.reason !== ''}>
        <span class={styles.hidden}>, </span>
        <span class={styles.reason}>{local.reason}</span>
      </Show>
    </span>
  );
}
