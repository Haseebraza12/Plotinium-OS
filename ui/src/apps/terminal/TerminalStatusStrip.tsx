import Check from 'lucide-solid/icons/check';
import { Match, Show, splitProps, Switch, type JSX } from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import styles from './Terminal.module.css';

/** The agent process behind the Terminal's AI features (agentic-shell.md). */
export type AgentStatus =
  | { state: 'running'; pid: number; route: string }
  | { state: 'waiting'; pid: number; on: string }
  | { state: 'idle' }
  | { state: 'unavailable' };

export type TxnStatus =
  | { id: string; state: 'committed' }
  | { id: string; state: 'syncing' }
  | { id: string; state: 'rejected' };

export interface TerminalStatusStripProps {
  agent?: AgentStatus;
  txn?: TxnStatus;
  encoding?: string;
  /** Shell name shown on the right ("zsh-like"). */
  shell?: string;
  cols: number;
  rows: number;
  /** Working directory, e.g. /home/student. */
  cwd: string;
  /** Enter on the agent item opens Task Manager filtered to its pid. */
  onAgentActivate?: () => void;
  /** Enter on the transaction item runs `ai log <txn>`. */
  onTxnActivate?: (txn: string) => void;
  class?: string;
}

/** The status text for the agent, the same string the screen reader hears. */
export function agentStatusText(agent: AgentStatus): string {
  switch (agent.state) {
    case 'running':
      return `ai.agent pid ${agent.pid} · ${agent.route}`;
    case 'waiting':
      return `ai.agent pid ${agent.pid} · waiting on ${agent.on}`;
    case 'idle':
      return 'ai.agent idle';
    case 'unavailable':
      return 'AI unavailable · plain shell';
  }
}

export function txnStatusText(txn: TxnStatus): string {
  switch (txn.state) {
    case 'committed':
      return `txn ${txn.id} committed`;
    case 'syncing':
      return `txn ${txn.id} · syncing`;
    case 'rejected':
      return `txn ${txn.id} · rejected on sync`;
  }
}

/**
 * The 26 px strip at the foot of a Terminal window: the agent process with a live dot (its
 * state is also in the words, DSN-08), the last transaction, and the session facts. Changes are
 * announced politely; the static facts are plain text.
 */
export function TerminalStatusStrip(props: TerminalStatusStripProps): JSX.Element {
  const [local] = splitProps(props, [
    'agent',
    'txn',
    'encoding',
    'shell',
    'cols',
    'rows',
    'cwd',
    'onAgentActivate',
    'onTxnActivate',
    'class',
  ]);
  const facts = (): string =>
    [
      local.encoding ?? 'UTF-8',
      local.shell ?? 'zsh-like',
      `${local.cols}×${local.rows}`,
      local.cwd,
    ].join(' · ');

  return (
    <footer class={cx(styles.strip, local.class)}>
      <div class={styles.stripStart} role="status" aria-live="polite">
        <Show when={local.agent}>
          {(agent) => (
            <button
              type="button"
              class={styles.stripItem}
              data-agent={agent().state}
              aria-disabled={local.onAgentActivate === undefined ? 'true' : undefined}
              onClick={() => local.onAgentActivate?.()}
            >
              <Show keyed when={agent().state}>
                {(state) => (
                  <span class={styles.liveDot} data-state={state} aria-hidden="true">
                    <span class={styles.halo} />
                  </span>
                )}
              </Show>
              <span>{agentStatusText(agent())}</span>
            </button>
          )}
        </Show>
      </div>
      <div class={styles.stripMiddle} role="status" aria-live="polite">
        <Show when={local.txn}>
          {(txn) => (
            <button
              type="button"
              class={cx(styles.stripItem, txn().state === 'rejected' && styles.stripDanger)}
              aria-disabled={local.onTxnActivate === undefined ? 'true' : undefined}
              onClick={() => local.onTxnActivate?.(txn().id)}
            >
              <Switch>
                <Match when={txn().state === 'committed'}>
                  <Check size={12} stroke-width={2.4} class={styles.okIcon} aria-hidden="true" />
                </Match>
              </Switch>
              <span>{txnStatusText(txn())}</span>
            </button>
          )}
        </Show>
      </div>
      <div class={styles.stripEnd}>{facts()}</div>
    </footer>
  );
}
