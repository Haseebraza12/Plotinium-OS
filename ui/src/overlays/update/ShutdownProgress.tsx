import Check from 'lucide-solid/icons/check';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import { For, Index, Match, Show, splitProps, Switch, type JSX } from 'solid-js';

import { AtomLogo } from '../../icons/index.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { createThrottled } from '../internal/behaviour.ts';
import shared from '../internal/shared.module.css';
import styles from './Update.module.css';

export type ShutdownStepState = 'done' | 'active' | 'pending' | 'warning';

export interface ShutdownStep {
  id: string;
  /** `Checkpointed 4 window processes`, `Stopping sync · outbox flushed`. */
  label: string;
  state: ShutdownStepState;
  /** Right-hand detail: `4 / 4`, `strict`, `next`. */
  detail?: string;
  /** Services stopped so far, drawn as a segment bar under this step (`11 of 18`). */
  segments?: { done: number; total: number };
}

export interface ShutdownProgressProps {
  /** `Restarting Plotinium…` or `Shutting down…`. */
  title: string;
  /** 0..100, driven by stopped-service weights (the truthful rule, BOOT-12). */
  percent: number;
  /** The current phase in words: `stopping services`. */
  phase: string;
  /** Services stopped and the total (`11 of 18`). */
  stopped?: number;
  total?: number;
  /** One mono line with the current phase detail. */
  verbose?: string;
  steps: readonly ShutdownStep[];
  /** `Session saved for student (uid 1001) · 4 windows`. */
  footer?: string;
  /** Upper bound: `≤ 8 s`. */
  bound?: string;
  /** inset: a HUD card (the preview next to the dialog); screen: the full-screen shutdown view. */
  variant?: 'inset' | 'screen';
  class?: string;
}

const STATE_WORD: Readonly<Record<ShutdownStepState, string>> = {
  done: 'done',
  active: 'in progress',
  pending: 'waiting',
  warning: 'warning',
};

const RING = 76;
const STROKE = 5;
const RADIUS = (RING - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The ordered shutdown progress (BOOT-12, SVC-11): a determinate ring around the atom, the phase
 * and `n of 18`, the verbose line, and the real step order (checkpoint, flush, save the session,
 * stop services in reverse order, activate). There is no spinner (DSN-07): the ring and the
 * service segments advance only when work really completes. The live summary is throttled to one
 * announcement every 5 s.
 */
export function ShutdownProgress(props: ShutdownProgressProps): JSX.Element {
  const [local] = splitProps(props, [
    'title',
    'percent',
    'phase',
    'stopped',
    'total',
    'verbose',
    'steps',
    'footer',
    'bound',
    'variant',
    'class',
  ]);
  const percent = (): number => Math.round(Math.min(100, Math.max(0, local.percent)));
  const count = (): string =>
    local.stopped === undefined || local.total === undefined
      ? ''
      : `${local.stopped} of ${local.total}`;
  const valueText = (): string =>
    [`${percent()} percent`, local.phase, count()].filter((p) => p !== '').join(', ');
  const announcement = createThrottled(valueText, 5000);

  return (
    <section
      class={cx(styles.shutdown, local.variant === 'screen' && styles.shutdownScreen, local.class)}
      aria-label={local.title}
    >
      <div class={styles.shutdownHead}>
        <div
          class={styles.ring}
          role="progressbar"
          aria-label={local.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent()}
          aria-valuetext={valueText()}
        >
          <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden="true">
            <circle
              class={styles.ringTrack}
              cx={RING / 2}
              cy={RING / 2}
              r={RADIUS}
              fill="none"
              stroke-width={STROKE}
            />
            <circle
              class={styles.ringFill}
              cx={RING / 2}
              cy={RING / 2}
              r={RADIUS}
              fill="none"
              stroke-width={STROKE}
              stroke-linecap="round"
              stroke-dasharray={String(CIRCUMFERENCE)}
              stroke-dashoffset={String(CIRCUMFERENCE * (1 - percent() / 100))}
              transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
            />
          </svg>
          <span class={styles.ringMark} aria-hidden="true">
            <AtomLogo size={30} />
          </span>
        </div>
        <div class={styles.shutdownHeadings}>
          <h2 class={styles.shutdownTitle}>{local.title}</h2>
          <p class={styles.shutdownPhase}>
            {percent()}% · {local.phase}
            <Show when={count() !== ''}> · {count()}</Show>
          </p>
        </div>
      </div>

      <Show when={local.verbose}>{(verbose) => <p class={styles.verbose}>{verbose()}</p>}</Show>

      <ol class={styles.steps}>
        <For each={local.steps}>
          {(step) => (
            <li class={styles.stepRow} data-state={step.state}>
              <span class={styles.stepIcon} aria-hidden="true">
                <Switch>
                  <Match when={step.state === 'done'}>
                    <Check size={10} stroke-width={3.4} />
                  </Match>
                  <Match when={step.state === 'warning'}>
                    <TriangleAlert size={11} stroke-width={2.4} />
                  </Match>
                  <Match when={step.state === 'active'}>
                    <span class={styles.stepDot} />
                  </Match>
                </Switch>
              </span>
              <span class={styles.stepLabel}>
                {step.label}
                <span class={shared.srOnly}>, {STATE_WORD[step.state]}</span>
              </span>
              <Show when={step.detail}>
                {(detail) => <span class={styles.stepDetail}>{detail()}</span>}
              </Show>
              <Show when={step.segments}>
                {(segments) => (
                  <span class={styles.segments} aria-hidden="true">
                    <Index each={Array.from({ length: segments().total }, (_, i) => i)}>
                      {(i) => (
                        <span
                          class={styles.segment}
                          data-state={
                            i() < segments().done
                              ? 'done'
                              : i() === segments().done && step.state === 'active'
                                ? 'active'
                                : undefined
                          }
                        />
                      )}
                    </Index>
                  </span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ol>

      <Show when={local.footer !== undefined || local.bound !== undefined}>
        <footer class={styles.shutdownFooter}>
          <span>{local.footer}</span>
          <span class={styles.bound}>{local.bound}</span>
        </footer>
      </Show>
      <div class={shared.srOnly} role="status" aria-live="polite">
        {local.title} {announcement()}
      </div>
    </section>
  );
}
