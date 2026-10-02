import Download from 'lucide-solid/icons/download';
import RotateCw from 'lucide-solid/icons/rotate-cw';
import ScrollText from 'lucide-solid/icons/scroll-text';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import Trash2 from 'lucide-solid/icons/trash-2';
import { createSignal, createUniqueId, For, Show, splitProps, type JSX } from 'solid-js';

import { Pill, type Tone } from '../../../primitives/badge/Badge.tsx';
import { Button } from '../../../primitives/button/Button.tsx';
import { Checkbox } from '../../../primitives/checkbox/Checkbox.tsx';
import { Dialog } from '../../../primitives/dialog/Dialog.tsx';
import { cx } from '../../../primitives/internal/cx.ts';
import { Popover } from '../../../primitives/popover/Popover.tsx';
import { ProgressBar } from '../../../primitives/progress/ProgressBar.tsx';
import { Sheet } from '../../../primitives/sheet/Sheet.tsx';
import { unavailableNote } from '../availability.ts';
import { Group, Row, ToggleRow } from '../controls.tsx';
import type { PrivacyModel, SettingChange, SettingsAction, TelemetryEvent } from '../models.ts';
import styles from './PrivacyPane.module.css';

const grouped = new Intl.NumberFormat('en-GB');
/** Local time, like the menu-bar clock and the "oldest" date beside it (UI-142: it was UTC). */
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const STATUS: Record<PrivacyModel['agent']['status'], { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'success' },
  // The kernel reports the agent service degraded or the link reconnecting (nothing measures
  // response time), so the pill says exactly that (UI-141).
  degraded: { label: 'Degraded', tone: 'warning' },
  offline: { label: 'Gateway unreachable — the agent is disabled', tone: 'danger' },
  'signed-out': { label: 'Sign in to use the agent', tone: 'neutral' },
};

function dollars(cents: number): string {
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

function kb(bytes: number): string {
  return `${grouped.format(Math.round(bytes / 1024))} KB`;
}

export interface PrivacyPaneProps {
  privacy: PrivacyModel;
  syncTelemetry: boolean;
  requireConfirm: boolean;
  /** AI-off build: the section is "Privacy" and the AI groups are hidden. */
  aiAvailable?: boolean;
  onChange: (change: SettingChange) => void;
  onAction: (action: SettingsAction) => void;
}

/**
 * Privacy & AI (PRE-05, DSN-17, settings-privacy-ai). Telemetry holds app ids and times only
 * (I-C6); it stays on the device unless the user opts in through a consent sheet. Clearing asks
 * in an alertdialog with Cancel focused. The agent's confirmation can be relaxed, but
 * destructive changes always ask (AGT-03).
 */
export function PrivacyPane(props: PrivacyPaneProps): JSX.Element {
  const [local] = splitProps(props, [
    'privacy',
    'syncTelemetry',
    'requireConfirm',
    'aiAvailable',
    'onChange',
    'onAction',
  ]);
  const [consentOpen, setConsentOpen] = createSignal(false);
  const [clearOpen, setClearOpen] = createSignal(false);
  const [alsoServer, setAlsoServer] = createSignal(true);
  const [rebuildOpen, setRebuildOpen] = createSignal(false);
  const [rebuildAnchor, setRebuildAnchor] = createSignal<HTMLButtonElement>();
  const [turned, setTurned] = createSignal(0);
  const uid = createUniqueId();

  const t = (): PrivacyModel['telemetry'] => local.privacy.telemetry;
  const idx = (): PrivacyModel['index'] => local.privacy.index;
  const agent = (): PrivacyModel['agent'] => local.privacy.agent;
  const pending = (): number => Math.max(0, idx().total - idx().indexed);
  /** No cap reported: the gateway was not reached, so there is no "$0 of $0" to show. */
  const budgetKnown = (): boolean => agent().capCents > 0;
  const budget = (): number => Math.min(1, agent().usedCents / Math.max(1, agent().capCents));
  const budgetTone = (): 'accent' | 'warning' | 'danger' =>
    budget() >= 1 ? 'danger' : budget() >= 0.85 ? 'warning' : 'accent';

  const eventLabel = (e: TelemetryEvent): string => e.event;

  return (
    <div class={styles.pane}>
      <Group title="Usage telemetry" index={0}>
        <ToggleRow
          label="Keep telemetry on this device"
          description="Always on. Telemetry never leaves the device unless you opt in."
          locked="Required for app pre-fetch. Never leaves the device unless you opt in."
          checked
          onChange={() => undefined}
        />
        <ToggleRow
          label="Sync telemetry to server"
          description={
            local.syncTelemetry
              ? 'On. Launch, focus and close events sync to your account so a new device can predict your apps.'
              : 'Off. Sends launch, focus and close events to your account so a new device can predict your apps.'
          }
          checked={local.syncTelemetry}
          disabled={t().pending === true}
          onChange={(next) => {
            if (next) setConsentOpen(true);
            else local.onChange({ key: 'telemetry.sync', value: false });
          }}
        />
        <Show when={t().error}>
          {(error) => (
            <p class={styles.inlineError} role="alert">
              {error()}
            </p>
          )}
        </Show>
        <Row
          title="Recent events"
          control={
            <span class={styles.summary}>
              {grouped.format(t().count)} events · {kb(t().bytes)} · oldest {t().oldest} · predictor{' '}
              {t().predictor}
            </span>
          }
        >
          <Show
            when={t().rows.length > 0}
            fallback={<p class={styles.empty}>No telemetry recorded yet</p>}
          >
            <div class={styles.tableWrap}>
              <table class={styles.table}>
                <caption class={styles.hidden}>Recent telemetry events</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Event</th>
                    <th scope="col">App</th>
                    <th scope="col">Previous app</th>
                    <th scope="col">Time bucket</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={t().rows}>
                    {(row) => (
                      <tr>
                        <td class={styles.mono}>
                          <time datetime={new Date(row.at).toISOString()}>
                            {timeFormat.format(row.at)}
                          </time>
                        </td>
                        <td>
                          <span class={styles.event}>
                            <span
                              class={cx(styles.eventDot, styles[`event-${row.event}`])}
                              aria-hidden="true"
                            />
                            {eventLabel(row)}
                          </span>
                        </td>
                        <td>{row.app}</td>
                        <td class={styles.muted}>{row.previousApp ?? '—'}</td>
                        <td class={styles.mono}>{row.bucket}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Row>
        <div class={styles.actionsRow}>
          <p class={styles.note}>App ids and times only. No file names, paths or content.</p>
          <div class={styles.buttons}>
            <Button
              size="sm"
              disabled={t().rows.length >= t().count}
              onClick={() => local.onAction('telemetry.viewAll')}
            >
              {/* UI-146: with every event listed there is nothing more to show. */}
              {t().rows.length >= t().count && t().count > 0 ? 'All events shown' : 'View all…'}
            </Button>
            <Button
              size="sm"
              icon={<Download size={13} />}
              disabled={t().exporting === true}
              onClick={() => local.onAction('telemetry.export')}
            >
              {t().exporting === true ? 'Exporting…' : 'Export…'}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={13} />}
              disabled={t().count === 0}
              onClick={() => {
                setAlsoServer(true);
                setClearOpen(true);
              }}
            >
              Clear telemetry
            </Button>
          </div>
        </div>
      </Group>

      <Show when={local.aiAvailable !== false}>
        <Group title="Semantic search" index={1}>
          <Row
            title="Embedding model"
            description={
              local.privacy.model.state === 'loading'
                ? 'Model loading — showing keyword matches'
                : local.privacy.model.state === 'unavailable'
                  ? 'Semantic search unavailable — showing keyword matches'
                  : local.privacy.model.state === 'off'
                    ? 'Semantic search not installed'
                    : undefined
            }
            control={
              <span class={styles.model}>
                <span class={styles.mono}>{local.privacy.model.name}</span>
                <span class={styles.muted}>({local.privacy.model.detail})</span>
                <Pill tone="accent" icon={<ShieldCheck size={11} />}>
                  On-device
                </Pill>
              </span>
            }
          />
          <Row
            title={
              <span class={styles.indexTitle}>
                Index status
                <span
                  class={cx(
                    styles.indexState,
                    styles[
                      // UI-141: indexing with nothing pending is neutral, not an amber warning.
                      `index-${idx().state === 'indexing' && pending() === 0 ? 'paused' : idx().state}`
                    ],
                  )}
                >
                  <span class={styles.stateDot} aria-hidden="true" />
                  {idx().state === 'indexing'
                    ? pending() > 0
                      ? `${grouped.format(pending())} chunks pending`
                      : 'Checking for changes'
                    : idx().state === 'idle'
                      ? `All ${grouped.format(idx().total)} chunks indexed`
                      : idx().state === 'paused'
                        ? 'Paused while you search'
                        : (idx().error ?? 'Indexer stopped')}
                </span>
              </span>
            }
            control={
              <>
                <Button
                  ref={setRebuildAnchor}
                  size="sm"
                  icon={
                    <Show keyed when={turned() + 1}>
                      {(n) => (
                        <span class={cx(styles.turn, n > 1 && styles.turnOnce)}>
                          <RotateCw size={13} />
                        </span>
                      )}
                    </Show>
                  }
                  disabled={idx().rebuilding === true || idx().rebuildUnavailable !== undefined}
                  aria-haspopup={idx().rebuildUnavailable === undefined ? 'dialog' : undefined}
                  aria-expanded={idx().rebuildUnavailable === undefined ? rebuildOpen() : undefined}
                  aria-describedby={
                    idx().rebuildUnavailable === undefined ? undefined : `pl-rebuild-${uid}`
                  }
                  onClick={() => setRebuildOpen((o) => !o)}
                >
                  {idx().rebuilding === true ? 'Rebuilding…' : 'Rebuild index'}
                </Button>
                <Popover
                  open={rebuildOpen()}
                  anchor={rebuildAnchor()}
                  placement="bottom-end"
                  label="Rebuild the index"
                  onClose={() => setRebuildOpen(false)}
                >
                  <div class={styles.confirm}>
                    <p class={styles.confirmText}>
                      Re-embed {grouped.format(idx().total)} chunks in the background?
                    </p>
                    <div class={styles.buttons}>
                      <Button size="sm" data-autofocus onClick={() => setRebuildOpen(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setRebuildOpen(false);
                          setTurned((n) => n + 1);
                          local.onAction('index.rebuild');
                        }}
                      >
                        Rebuild
                      </Button>
                    </div>
                  </div>
                </Popover>
              </>
            }
          >
            <Show when={idx().state !== 'idle'}>
              <ProgressBar
                label="Chunks indexed"
                hideLabel
                size="sm"
                tone={idx().state === 'error' ? 'danger' : 'warning'}
                value={idx().indexed}
                max={Math.max(1, idx().total)}
                valueText={`${grouped.format(idx().indexed)} of ${grouped.format(idx().total)} chunks indexed`}
              />
            </Show>
            <p class={styles.indexMeta}>
              {grouped.format(idx().indexed)} of {grouped.format(idx().total)} chunks indexed ·{' '}
              {idx().pid > 0
                ? `ai.indexer pid ${idx().pid} · priority ${idx().priority}`
                : 'ai.indexer is not running'}
            </p>
            <Show when={idx().rebuildUnavailable}>
              {(note) => (
                <p class={styles.note} id={`pl-rebuild-${uid}`}>
                  {note()}
                </p>
              )}
            </Show>
          </Row>
        </Group>

        <Group title="AI agent" index={2}>
          <Row
            title="Provider"
            control={
              <span class={styles.model}>
                <span class={styles.muted}>{agent().provider}</span>
                <Pill tone={STATUS[agent().status].tone} dot>
                  {STATUS[agent().status].label}
                </Pill>
              </span>
            }
          />
          <Row
            title="Monthly budget"
            description={
              !budgetKnown()
                ? 'The server has not reported this month’s budget yet.'
                : budget() >= 1
                  ? `Budget used — the agent is paused until ${agent().resetsOn}`
                  : `${(budget() * 100).toFixed(1)}% used · resets ${agent().resetsOn}`
            }
            control={
              <Show when={budgetKnown()} fallback={<span class={styles.muted}>Not reported</span>}>
                <span class={styles.budget}>
                  <span
                    class={cx(styles.meter, styles[`meter-${budgetTone()}`])}
                    role="meter"
                    aria-label="Monthly agent budget"
                    aria-valuemin={0}
                    aria-valuemax={agent().capCents / 100}
                    aria-valuenow={agent().usedCents / 100}
                    aria-valuetext={`${dollars(agent().usedCents)} of ${dollars(agent().capCents)} used this month`}
                  >
                    <span class={styles.meterFill} style={{ '--pl-fill': String(budget()) }} />
                  </span>
                  <span class={styles.budgetText}>
                    <strong>{dollars(agent().usedCents)}</strong> of {dollars(agent().capCents)}
                  </span>
                </span>
              </Show>
            }
          />
          <ToggleRow
            label="Require confirmation for all changes"
            description={
              local.requireConfirm
                ? 'The agent shows its plan and asks before it writes files, kills processes or changes settings.'
                : 'Destructive changes still always ask.'
            }
            unavailable={unavailableNote('agent.requireConfirm')}
            checked={local.requireConfirm}
            onChange={(value) => local.onChange({ key: 'agent.requireConfirm', value })}
          />
          <Row
            title={
              <span class={styles.lastAction}>
                <Show when={agent().lastAction} fallback="No agent actions yet">
                  {(last) => (
                    <>
                      Last action {last().time} · <span class={styles.mono}>{last().summary}</span>{' '}
                      · {last().outcome}
                    </>
                  )}
                </Show>
              </span>
            }
            control={
              <Button
                size="sm"
                icon={<ScrollText size={13} />}
                onClick={() => local.onAction('ai.openLog')}
              >
                Open ai log…
              </Button>
            }
          />
        </Group>
      </Show>

      <Sheet
        open={consentOpen()}
        onClose={() => setConsentOpen(false)}
        title="Sync telemetry to your account?"
        description="Plotinium will send launch, focus and close events so a new device can predict your apps."
        icon={<ShieldCheck size={28} />}
        actions={
          <>
            <Button data-autofocus onClick={() => setConsentOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConsentOpen(false);
                local.onChange({ key: 'telemetry.sync', value: true });
              }}
            >
              Turn on sync
            </Button>
          </>
        }
      >
        <ul class={styles.consentList}>
          <li>What is sent: app ids, event kinds and times.</li>
          <li>Never sent: file names, paths or content.</li>
          <li>You can turn sync off and delete the server copy at any time.</li>
        </ul>
      </Sheet>

      <Dialog
        open={clearOpen()}
        role="alertdialog"
        size="sm"
        title={`Clear ${grouped.format(t().count)} events?`}
        description="The predictor restarts from cold start."
        icon={<Trash2 size={26} />}
        onClose={() => setClearOpen(false)}
        actions={
          <>
            <Button data-autofocus onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setClearOpen(false);
                local.onAction(
                  local.syncTelemetry && alsoServer() && t().serverDeleteUnavailable === undefined
                    ? 'telemetry.clearServerToo'
                    : 'telemetry.clear',
                );
              }}
            >
              Clear telemetry
            </Button>
          </>
        }
      >
        <Show when={local.syncTelemetry}>
          <Show
            when={t().serverDeleteUnavailable}
            fallback={
              <Checkbox
                label="Also delete the copy on the server"
                checked={alsoServer()}
                onChange={setAlsoServer}
              />
            }
          >
            {(note) => <p class={styles.note}>{note()}</p>}
          </Show>
        </Show>
      </Dialog>
    </div>
  );
}
