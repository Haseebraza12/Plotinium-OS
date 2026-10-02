import ArrowRight from 'lucide-solid/icons/arrow-right';
import Pause from 'lucide-solid/icons/pause';
import Settings2 from 'lucide-solid/icons/settings-2';
import { createMemo, createUniqueId, For, Show, splitProps, type JSX } from 'solid-js';

import type { Band } from '@plotinium/protocol';

import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { agingBound, formatCount, formatMs, formatWait, ratio } from './format.ts';
import type { ReadyBand, SchedulerModel } from './models.ts';
import styles from './SchedulerPanel.module.css';

const BAND_TEXT: Record<Band, { title: string; range: string }> = {
  interactive: { title: 'Interactive', range: 'PRI 0–9' },
  normal: { title: 'Normal', range: 'PRI 10–29' },
  background: { title: 'Background', range: 'PRI 30–39' },
};

export interface SchedulerPanelProps {
  scheduler: SchedulerModel;
  /** Opens Settings › Scheduler (quanta and T_age). */
  onOpenSettings?: () => void;
}

/**
 * Scheduler tab: what runs on each executor, the ready queue by band (base → effective
 * priority as aging lifts waiters), the quanta, and the declared PROC-04 starvation bound with
 * its terms (processes-and-scheduling.md §3.12).
 */
export function SchedulerPanel(props: SchedulerPanelProps): JSX.Element {
  const [local] = splitProps(props, ['scheduler', 'onOpenSettings']);
  const uid = createUniqueId();
  const s = (): SchedulerModel => local.scheduler;
  const bound = createMemo(() => agingBound({ ...s().bound, tAgeMs: s().tAgeMs }));
  const waitRatio = (): number => ratio(s().maxWaitMs, bound());
  const ready = (): number => s().bands.reduce((n, b) => n + b.entries.length, 0);

  return (
    <div class={styles.panel}>
      <ul class={styles.stats} role="list" aria-label="Scheduler summary">
        <li class={styles.stat}>
          <span class={styles.statLabel}>Run tokens</span>
          <span class={styles.statValue}>
            {s().runTokens.used}
            <span class={styles.statUnit}> / {s().runTokens.total} in use</span>
          </span>
        </li>
        <li class={styles.stat}>
          <span class={styles.statLabel}>Dispatches</span>
          <span class={styles.statValue}>
            {formatCount(s().dispatchesPerSecond)}
            <span class={styles.statUnit}> /s</span>
          </span>
          <span class={styles.statSub}>{formatCount(s().preemptionsPerSecond)} pre-emptions/s</span>
        </li>
        <li class={styles.stat}>
          <span class={styles.statLabel}>Ready</span>
          <span class={styles.statValue}>
            {ready()}
            <span class={styles.statUnit}> waiting</span>
          </span>
          <span class={styles.statSub}>aging every {formatMs(s().tAgeMs)}</span>
        </li>
        <li class={cx(styles.stat, styles.boundStat)}>
          <span class={styles.statLabel}>Longest wait</span>
          <span class={styles.statValue}>
            {formatWait(s().maxWaitMs)}
            <span class={styles.statUnit}> of {formatMs(bound())}</span>
          </span>
          <span
            class={styles.meter}
            role="meter"
            aria-label="Longest ready wait against the declared bound"
            aria-valuemin={0}
            aria-valuemax={Math.round(bound())}
            aria-valuenow={Math.round(s().maxWaitMs)}
            aria-valuetext={`${formatWait(s().maxWaitMs)} of the ${formatMs(bound())} bound`}
          >
            <span class={styles.meterFill} style={{ '--pl-fill': String(waitRatio()) }} />
          </span>
        </li>
      </ul>

      <section class={styles.block} aria-labelledby={`pl-sch-run-${uid}`}>
        <h3 class={styles.caption} id={`pl-sch-run-${uid}`}>
          Running now
        </h3>
        <ul class={styles.running} role="list">
          <For each={s().running}>
            {(slice) => (
              <li class={cx(styles.slot, slice.pid === undefined && styles.slotIdle)}>
                <span class={styles.slotExec}>exec-{slice.executor}</span>
                <Show
                  when={slice.pid !== undefined}
                  fallback={<span class={styles.slotName}>idle</span>}
                >
                  <span class={styles.slotName}>
                    <span
                      class={cx(styles.bandDot, styles[`dot-${slice.band ?? 'normal'}`])}
                      aria-hidden="true"
                    />
                    {slice.name} <span class={styles.muted}>{slice.pid}</span>
                  </span>
                  <span
                    class={styles.quantum}
                    role="meter"
                    aria-label={`exec-${slice.executor} quantum used`}
                    aria-valuemin={0}
                    aria-valuemax={slice.quantumMs ?? 0}
                    aria-valuenow={slice.usedMs ?? 0}
                    aria-valuetext={`${slice.usedMs ?? 0} of ${slice.quantumMs ?? 0} ms`}
                  >
                    <span
                      class={styles.quantumFill}
                      style={{
                        '--pl-fill': String(ratio(slice.usedMs ?? 0, slice.quantumMs ?? 1)),
                      }}
                    />
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>

      <div class={styles.lower}>
        <section class={styles.queue} aria-labelledby={`pl-sch-q-${uid}`}>
          <div class={styles.blockHead}>
            <h3 class={styles.caption} id={`pl-sch-q-${uid}`}>
              Ready queue by band
            </h3>
            <Show when={local.onOpenSettings}>
              <Button
                size="sm"
                variant="ghost"
                icon={<Settings2 size={13} />}
                onClick={() => local.onOpenSettings?.()}
              >
                Quanta…
              </Button>
            </Show>
          </div>
          <div class={styles.lanes}>
            <For each={s().bands}>
              {(band) => (
                <Lane band={band} paused={band.band === 'background' && s().interactivePause} />
              )}
            </For>
          </div>
        </section>

        <section class={styles.boundCard} aria-labelledby={`pl-sch-b-${uid}`}>
          <h3 class={styles.caption} id={`pl-sch-b-${uid}`}>
            Aging bound (PROC-04)
          </h3>
          <p class={styles.formula}>
            W(P) ≤ (p + 1)·T<sub>age</sub> + ⌈(N − 1)/E⌉·(Q + δ) + H<sub>kill</sub>
          </p>
          <dl class={styles.terms}>
            <div>
              <dt>p · worst base priority</dt>
              <dd>{s().bound.p}</dd>
            </div>
            <div>
              <dt>
                T<sub>age</sub> · aging interval
              </dt>
              <dd>{formatMs(s().tAgeMs)}</dd>
            </div>
            <div>
              <dt>N · runnable processes</dt>
              <dd>{s().bound.n}</dd>
            </div>
            <div>
              <dt>E · parallelism (declared)</dt>
              <dd>{s().bound.e}</dd>
            </div>
            <div>
              <dt>Q + δ · longest slice</dt>
              <dd>{formatMs(s().bound.qMs + s().bound.deltaMs)}</dd>
            </div>
            <div>
              <dt>
                H<sub>kill</sub> · runaway kill
              </dt>
              <dd>{formatMs(s().bound.hKillMs)}</dd>
            </div>
          </dl>
          <p class={styles.result}>
            <span class={styles.resultLabel}>Declared bound</span>
            <span class={styles.resultValue}>{formatMs(bound())}</span>
          </p>
          <p class={styles.resultNote}>
            {(s().bound.p + 1) * s().tAgeMs} +{' '}
            {Math.ceil((s().bound.n - 1) / Math.max(1, s().bound.e))} ×{' '}
            {s().bound.qMs + s().bound.deltaMs} + {s().bound.hKillMs}. No runnable process waits
            longer, whatever its priority.
          </p>
        </section>
      </div>
    </div>
  );
}

function Lane(props: { band: ReadyBand; paused: boolean }): JSX.Element {
  const entries = createMemo(() =>
    [...props.band.entries].sort((a, b) => a.effPrio - b.effPrio || b.waitedMs - a.waitedMs),
  );
  const longest = (): number => Math.max(1, ...props.band.entries.map((e) => e.waitedMs));
  const text = (): { title: string; range: string } => BAND_TEXT[props.band.band];
  return (
    <div class={cx(styles.lane, styles[`lane-${props.band.band}`])}>
      <div class={styles.laneHead}>
        <span class={styles.laneTitle}>
          <span class={cx(styles.bandDot, styles[`dot-${props.band.band}`])} aria-hidden="true" />
          {text().title}
        </span>
        <span class={styles.laneCount}>{props.band.entries.length}</span>
      </div>
      <p class={styles.laneMeta}>
        {text().range} · quantum {formatMs(props.band.quantumMs)}
        <Show when={props.paused}>
          <span class={styles.pausedPill}>
            <Pause size={10} aria-hidden="true" /> paused while you interact
          </span>
        </Show>
      </p>
      <Show when={entries().length > 0} fallback={<p class={styles.laneEmpty}>Nothing waiting</p>}>
        <ol class={styles.entries} aria-label={`${text().title} band, ready processes`}>
          <For each={entries()}>
            {(entry) => (
              <li class={styles.entry}>
                <span class={styles.entryPid}>{entry.pid}</span>
                <span class={styles.entryName}>{entry.name}</span>
                <span class={cx(styles.aging, entry.effPrio < entry.base && styles.aged)}>
                  <span aria-hidden="true">{entry.base}</span>
                  <Show when={entry.effPrio < entry.base}>
                    <ArrowRight size={10} aria-hidden="true" />
                    <span aria-hidden="true">{entry.effPrio}</span>
                  </Show>
                  <span class={styles.hidden}>
                    {entry.effPrio < entry.base
                      ? `priority ${entry.base}, aged to ${entry.effPrio}`
                      : `priority ${entry.base}`}
                  </span>
                </span>
                <span class={styles.wait}>
                  <span class={styles.waitBar} aria-hidden="true">
                    <span
                      class={styles.waitFill}
                      style={{ '--pl-fill': String(entry.waitedMs / longest()) }}
                    />
                  </span>
                  {formatWait(entry.waitedMs)}
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}
