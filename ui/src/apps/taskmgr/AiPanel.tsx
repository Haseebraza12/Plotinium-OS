import Bot from 'lucide-solid/icons/bot';
import ScrollText from 'lucide-solid/icons/scroll-text';
import Sparkles from 'lucide-solid/icons/sparkles';
import Wallet from 'lucide-solid/icons/wallet';
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { Pill, type Tone } from '../../primitives/badge/Badge.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { ProgressBar } from '../../primitives/progress/ProgressBar.tsx';
import { SegmentedControl } from '../../primitives/segmented-control/SegmentedControl.tsx';
import styles from './AiPanel.module.css';
import { formatCount, formatDollars, ratio } from './format.ts';
import type { AiModel, AuditEntry } from './models.ts';

const INDEXER_TEXT: Record<AiModel['indexer']['state'], { label: string; tone: Tone }> = {
  indexing: { label: 'Indexing', tone: 'warning' },
  idle: { label: 'Up to date', tone: 'success' },
  paused: { label: 'Paused while you search', tone: 'neutral' },
  error: { label: 'Stopped', tone: 'danger' },
  off: { label: 'Not installed', tone: 'neutral' },
};

const AGENT_TEXT: Record<AiModel['agent']['status'], { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'success' },
  // The kernel reports the service degraded or the link reconnecting; nothing measures latency.
  degraded: { label: 'Degraded', tone: 'warning' },
  offline: { label: 'Gateway unreachable', tone: 'danger' },
  'signed-out': { label: 'Sign in to use the agent', tone: 'neutral' },
};

const OUTCOME_TONE: Record<AuditEntry['outcome'], Tone> = {
  ok: 'success',
  confirmed: 'success',
  error: 'danger',
  rejected: 'danger',
  declined: 'neutral',
  killed_rolled_back: 'warning',
  attempt: 'info',
};

type AuditFilter = 'all' | 'agent' | 'user' | 'system';

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** What the kernel asks the user to confirm (ai/src/agent/confirm.ts, AGT-03). */
export const AGENT_CONFIRMS =
  'Asks before deletes, overwrites, permission changes, system paths and plans over 20 files';

export interface AiPanelProps {
  ai: AiModel;
  /** Opens a Terminal, where `ai log` prints the full history. */
  onOpenLog?: () => void;
  /** Opens Settings › Privacy & AI. */
  onOpenSettings?: () => void;
}

/** AI tab: the indexer's progress and priority, the agent's monthly budget, and the audit log. */
export function AiPanel(props: AiPanelProps): JSX.Element {
  const [local] = splitProps(props, ['ai', 'onOpenLog', 'onOpenSettings']);
  const uid = createUniqueId();
  const [filter, setFilter] = createSignal<AuditFilter>('all');
  const indexer = (): AiModel['indexer'] => local.ai.indexer;
  const agent = (): AiModel['agent'] => local.ai.agent;
  const budgetRatio = (): number => ratio(agent().usedCents, agent().capCents);
  /** No cap reported (the gateway was not reached): say so instead of "$0.00 of $0.00". */
  const budgetKnown = (): boolean => agent().capCents > 0;
  const budgetTone = (): 'accent' | 'warning' | 'danger' =>
    budgetRatio() >= 1 ? 'danger' : budgetRatio() >= 0.85 ? 'warning' : 'accent';
  const entries = createMemo(() =>
    local.ai.audit.filter((e) => filter() === 'all' || e.actor === filter()),
  );

  return (
    <div class={styles.panel}>
      <div class={styles.top}>
        <section class={styles.card} aria-labelledby={`pl-ai-idx-${uid}`}>
          <header class={styles.cardHead}>
            <h3 class={styles.cardTitle} id={`pl-ai-idx-${uid}`}>
              <span class={cx(styles.tile, styles.tileIndexer)} aria-hidden="true">
                <Sparkles size={14} />
              </span>
              Semantic indexer
            </h3>
            <Pill tone={INDEXER_TEXT[indexer().state].tone} dot>
              {INDEXER_TEXT[indexer().state].label}
            </Pill>
          </header>
          <Show
            when={indexer().state !== 'off'}
            fallback={<p class={styles.note}>Semantic search is not installed in this build.</p>}
          >
            <ProgressBar
              label="Chunks indexed"
              value={indexer().indexed}
              max={Math.max(1, indexer().total)}
              valueText={`${formatCount(indexer().indexed)} of ${formatCount(indexer().total)} chunks`}
              showValue
              tone={
                indexer().state === 'error'
                  ? 'danger'
                  : indexer().state === 'idle'
                    ? 'success'
                    : 'warning'
              }
            />
            <Show when={indexer().error}>
              {(error) => (
                <p class={styles.error} role="alert">
                  {error()}
                </p>
              )}
            </Show>
            <dl class={styles.facts}>
              <div>
                <dt>Pending</dt>
                <dd>{formatCount(Math.max(0, indexer().total - indexer().indexed))} chunks</dd>
              </div>
              <div>
                <dt>Rate</dt>
                <dd>{formatCount(indexer().chunksPerSecond)} chunks/s</dd>
              </div>
              <div>
                <dt>Process</dt>
                <dd>
                  {indexer().pid > 0
                    ? `ai.indexer pid ${indexer().pid} · priority ${indexer().priority}`
                    : 'ai.indexer is not running'}
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd class={styles.mono}>{indexer().model}</dd>
              </div>
            </dl>
            <p class={styles.note}>
              Runs in the background band and yields while you type or drag.
            </p>
          </Show>
        </section>

        <section class={styles.card} aria-labelledby={`pl-ai-agent-${uid}`}>
          <header class={styles.cardHead}>
            <h3 class={styles.cardTitle} id={`pl-ai-agent-${uid}`}>
              <span class={cx(styles.tile, styles.tileAgent)} aria-hidden="true">
                <Bot size={14} />
              </span>
              Agent budget
            </h3>
            <Pill tone={AGENT_TEXT[agent().status].tone} dot>
              {AGENT_TEXT[agent().status].label}
            </Pill>
          </header>
          <Show
            when={budgetKnown()}
            fallback={
              <p class={styles.note}>
                The server has not reported this month’s budget yet. It shows here once the agent
                gateway answers.
              </p>
            }
          >
            <p class={styles.budgetFigure}>
              <Wallet size={16} aria-hidden="true" class={styles.budgetIcon} />
              <strong>{formatDollars(agent().usedCents)}</strong>
              <span class={styles.budgetOf}> of {formatDollars(agent().capCents)} this month</span>
            </p>
            <div
              class={cx(styles.meter, styles[`meter-${budgetTone()}`])}
              role="meter"
              aria-label="Agent budget used"
              aria-valuemin={0}
              aria-valuemax={agent().capCents / 100}
              aria-valuenow={agent().usedCents / 100}
              aria-valuetext={`${formatDollars(agent().usedCents)} of ${formatDollars(agent().capCents)} used this month`}
            >
              <span class={styles.meterFill} style={{ '--pl-fill': String(budgetRatio()) }} />
            </div>
            <p class={styles.note}>
              {(budgetRatio() * 100).toFixed(1)}% used · resets {agent().resetsOn}
              <Show when={budgetRatio() >= 1}>
                {' '}
                · <span class={styles.dangerText}>the agent is paused until then</span>
              </Show>
            </p>
          </Show>
          <dl class={styles.facts}>
            <div>
              <dt>Provider</dt>
              <dd>{agent().provider}</dd>
            </div>
            <div>
              <dt>Requests today</dt>
              <dd>{formatCount(agent().requestsToday)}</dd>
            </div>
            <div>
              <dt>Confirmation</dt>
              <dd>{AGENT_CONFIRMS}</dd>
            </div>
          </dl>
          <Show when={local.onOpenSettings}>
            <div class={styles.actions}>
              <Button size="sm" onClick={() => local.onOpenSettings?.()}>
                Privacy &amp; AI settings…
              </Button>
            </div>
          </Show>
        </section>
      </div>

      <section class={cx(styles.card, styles.log)} aria-labelledby={`pl-ai-log-${uid}`}>
        <header class={styles.cardHead}>
          <h3 class={styles.cardTitle} id={`pl-ai-log-${uid}`}>
            <span class={cx(styles.tile, styles.tileLog)} aria-hidden="true">
              <ScrollText size={14} />
            </span>
            Audit log
          </h3>
          <div class={styles.logTools}>
            <SegmentedControl
              size="sm"
              label="Show entries from"
              value={filter()}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'agent', label: 'Agent' },
                { value: 'user', label: 'User' },
                { value: 'system', label: 'System' },
              ]}
            />
            <Show when={local.onOpenLog}>
              <Button
                size="sm"
                icon={<ScrollText size={13} />}
                aria-describedby={`pl-ai-log-hint-${uid}`}
                onClick={() => local.onOpenLog?.()}
              >
                Open Terminal…
              </Button>
            </Show>
          </div>
        </header>
        <p class={styles.note} id={`pl-ai-log-hint-${uid}`}>
          The last 50 entries. For the full history, run <code class={styles.mono}>ai log</code> in
          the Terminal.
        </p>
        <Show
          when={entries().length > 0}
          fallback={<p class={styles.note}>No agent actions yet</p>}
        >
          <ol class={styles.entries} aria-label="Audit entries, newest first">
            <For each={entries()}>
              {(entry) => (
                <li class={styles.entry}>
                  <time class={styles.time} datetime={new Date(entry.at).toISOString()}>
                    {timeFormat.format(entry.at)}
                  </time>
                  <span class={cx(styles.actor, styles[`actor-${entry.actor}`])}>
                    {entry.actor}
                  </span>
                  <span class={styles.call}>{entry.call}</span>
                  <span class={styles.summary}>{entry.summary}</span>
                  <span class={styles.pid}>pid {entry.pid}</span>
                  <Pill tone={OUTCOME_TONE[entry.outcome]} size="sm">
                    {entry.outcome.replaceAll('_', ' ')}
                  </Pill>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
    </div>
  );
}
