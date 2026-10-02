import ShieldCheck from 'lucide-solid/icons/shield-check';
import Sparkles from 'lucide-solid/icons/sparkles';
import { createUniqueId, For, Match, Show, splitProps, Switch, type JSX } from 'solid-js';

import { AppIcon } from '../../icons/index.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { formatCount, formatMB } from './format.ts';
import type { PredictionsModel } from './models.ts';
import styles from './PredictionsPanel.module.css';

export interface PredictionsPanelProps {
  predictions: PredictionsModel;
  /** "Predictions are off": opens Settings › Privacy & AI. */
  onOpenSettings?: () => void;
  /** "Predictor unavailable": restart the predictor. */
  onRestart?: () => void;
  class?: string;
}

/**
 * Predictions (PRE-06): the next-app ranking with confidence meters (the number is always in
 * text), the top reason, the model's threshold and training size, and the speculative bytes the
 * pre-fetcher holds. Telemetry never leaves the device unless the user opts in.
 */
export function PredictionsPanel(props: PredictionsPanelProps): JSX.Element {
  const [local] = splitProps(props, ['predictions', 'onOpenSettings', 'onRestart', 'class']);
  const uid = createUniqueId();
  const p = (): PredictionsModel => local.predictions;
  return (
    <aside class={cx(styles.panel, local.class)} aria-labelledby={`pl-pred-${uid}`}>
      <header class={styles.head}>
        <h3 class={styles.title} id={`pl-pred-${uid}`}>
          <Sparkles size={16} aria-hidden="true" class={styles.titleIcon} />
          Predictions
        </h3>
        <span class={styles.modelChip}>
          <ShieldCheck size={12} aria-hidden="true" />
          {p().model} · local only
        </span>
      </header>
      <Switch>
        <Match when={p().state === 'off'}>
          <div class={styles.state}>
            <p class={styles.stateTitle}>Predictions are off</p>
            <p class={styles.stateText}>Turn them on in Settings › Privacy &amp; AI.</p>
            <Button size="sm" onClick={() => local.onOpenSettings?.()}>
              Open Settings
            </Button>
          </div>
        </Match>
        <Match when={p().state === 'crashed'}>
          <div class={styles.state} role="alert">
            <p class={styles.stateTitle}>Predictor unavailable</p>
            <p class={styles.stateText}>Apps open normally; nothing is pre-fetched.</p>
            <Button size="sm" onClick={() => local.onRestart?.()}>
              Restart
            </Button>
          </div>
        </Match>
        <Match when={p().state === 'cold'}>
          <div class={styles.state}>
            <p class={styles.stateTitle}>Learning your habits</p>
            <p class={styles.stateText}>
              {formatCount(p().launches)}/{formatCount(p().coldTarget)} launches · most-used apps
              are suggested until then
            </p>
            <div
              class={styles.meter}
              role="meter"
              aria-label="Training progress"
              aria-valuemin={0}
              aria-valuemax={p().coldTarget}
              aria-valuenow={p().launches}
            >
              <span
                class={styles.fill}
                style={{
                  '--pl-fill': String(Math.min(1, p().launches / Math.max(1, p().coldTarget))),
                }}
              />
            </div>
          </div>
        </Match>
        <Match when={p().state === 'ready'}>
          <section class={styles.section} aria-labelledby={`pl-pred-next-${uid}`}>
            <h4 class={styles.caption} id={`pl-pred-next-${uid}`}>
              Next app
            </h4>
            <ol class={styles.rows}>
              <For each={p().rows}>
                {(row, index) => (
                  <li class={styles.row} style={{ '--pl-stagger-index': String(index()) }}>
                    <AppIcon app={row.app} size={22} class={styles.appIcon} />
                    <div class={styles.rowMain}>
                      <span class={styles.rowName}>
                        {row.label}
                        <Show when={row.prefetched === true}>
                          <span class={styles.prefetched}>pre-fetched</span>
                        </Show>
                      </span>
                      <span
                        class={styles.meter}
                        role="meter"
                        aria-label={`${row.label} confidence`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(row.confidence * 100)}
                        aria-valuetext={`${Math.round(row.confidence * 100)} percent`}
                      >
                        <span class={styles.fill} style={{ '--pl-fill': String(row.confidence) }} />
                      </span>
                    </div>
                    <span class={styles.pct} aria-hidden="true">
                      {Math.round(row.confidence * 100)}%
                    </span>
                  </li>
                )}
              </For>
            </ol>
          </section>
          <p class={styles.reason}>
            <span class={styles.reasonLabel}>Top reason:</span> {p().reason}
          </p>
          <dl class={styles.facts}>
            <div>
              <dt>Threshold θ</dt>
              <dd>{p().threshold.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Training launches</dt>
              <dd>{formatCount(p().launches)}</dd>
            </div>
            <div>
              <dt>Speculative</dt>
              <dd>
                {formatMB(p().speculativeBytes)} · expires {p().expiresIn}
              </dd>
            </div>
            <div>
              <dt>Today adopted / wasted</dt>
              <dd>
                {Math.round(p().adoptedBytes / 1048576)} / {formatMB(p().wastedBytes)}
              </dd>
            </div>
          </dl>
        </Match>
      </Switch>
      <p class={styles.foot}>
        <ShieldCheck size={12} aria-hidden="true" />
        Usage telemetry stays on this device.
      </p>
    </aside>
  );
}
