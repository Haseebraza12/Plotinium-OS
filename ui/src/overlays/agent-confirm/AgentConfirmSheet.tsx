import Check from 'lucide-solid/icons/check';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import CircleX from 'lucide-solid/icons/circle-x';
import FileX from 'lucide-solid/icons/file-x';
import Layers from 'lucide-solid/icons/layers';
import Lock from 'lucide-solid/icons/lock';
import Pencil from 'lucide-solid/icons/pencil';
import Play from 'lucide-solid/icons/play';
import ShieldAlert from 'lucide-solid/icons/shield-alert';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import Trash2 from 'lucide-solid/icons/trash-2';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import User from 'lucide-solid/icons/user';
import {
  createSignal,
  createUniqueId,
  For,
  Match,
  Show,
  splitProps,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { AtomLogo } from '../../icons/index.tsx';
import { Pill } from '../../primitives/badge/Badge.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { trapTabKey } from '../../primitives/internal/focus.ts';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import {
  createModalLayer,
  createNudge,
  createTransientMessage,
  isTextEntry,
} from '../internal/behaviour.ts';
import shared from '../internal/shared.module.css';
import { plural } from '../internal/text.tsx';
import styles from './AgentConfirmSheet.module.css';

export type PlanOpTone = 'danger' | 'accent' | 'warning' | 'neutral';

export interface AgentPlanStep {
  id: string;
  /** The operation, shown as an uppercase badge whose word carries the meaning (DELETE, MOVE, CHMOD). */
  op: string;
  /** Badge colour; by default from the operation (deletes red, moves violet, mode changes amber). */
  tone?: PlanOpTone;
  path: string;
  /** Destination of a MOVE or COPY, shown as `path → target`. */
  target?: string;
  /** Arguments such as `-R go-rwx`, shown after the path. */
  args?: string;
  /** The dry-run effect: `remove 1 dir, 9 files`. */
  effect: string;
  /** A qualifier after the effect: `to trash`. */
  effectNote?: string;
  /** Intent-binding flags from the kernel (agentic-shell.md §3.10). */
  flag?: 'ungrounded' | 'suspicious';
}

export interface AgentBlastRadius {
  /** Distinct inodes the transaction changes. */
  inodes: number;
  deletions: number;
  overwrites: number;
  /** Deleted items go to the trash (agent deletes are recoverable, §3.12). */
  recoverable?: boolean;
}

/** Mirrors ConfirmReason in protocol/src/ai/agent.ts (the kernel's confirmation predicate). */
export type AgentConfirmReasonKind =
  'delete' | 'overwrite' | 'chmod' | 'chown' | 'over-20-inodes' | 'system-path';

export interface AgentConfirmReason {
  kind: AgentConfirmReasonKind;
  /** `Deletes files (3 directories, 16 files)`. */
  text: string;
  /** The kernel reason code shown beside it: `DELETE`, `BLAST_RADIUS`, `CHMOD`. */
  code: string;
}

export type AgentConfirmStatus = 'loading' | 'ready' | 'running' | 'rejected';
export type AgentCancelReason = 'button' | 'escape' | 'close';

export interface AgentConfirmSheetProps {
  open: boolean;
  /** The requesting process: `ai.agent` and its pid. */
  agent: string;
  pid: number;
  /** The user's request, quoted verbatim in the subtitle. */
  request: string;
  steps: readonly AgentPlanStep[];
  /** Undefined while the dry run is still finishing (tiles show a dash). */
  blast?: AgentBlastRadius;
  /** `within quota · 1.2 GB free`, or `over quota by 38 MB` with ok false (Run plan disabled). */
  quota: { ok: boolean; text: string };
  runAs: { user: string; uid: number; elevated?: boolean };
  /** Default `one transaction · undo token issued`. */
  transactionNote?: string;
  reasons: readonly AgentConfirmReason[];
  /** `agent.confirm.destructive = always · deleted items go to ~/.trash/8f2c/`. */
  policy?: string;
  /** Footer meta: `txn pending` and `Claude via gateway`. */
  txnState?: string;
  provider?: string;
  status?: AgentConfirmStatus;
  /** Steps done while the batch runs. */
  progress?: { done: number; total: number };
  /** Replaces the body when the dry run or the batch is rejected: `Plan rejected: EACCES /system/bin — nothing ran`. */
  rejection?: string;
  /** Seconds left before the kernel treats silence as No; the warning shows at 20 s or less. */
  expiresInS?: number;
  /** Start with the reasons expanded (collapsed by default in production). */
  reasonsExpanded?: boolean;
  onCancel: (reason: AgentCancelReason) => void;
  onRun: () => void;
  onEditPlan?: () => void;
  /** Opens `ai log` for this request. */
  onOpenLog?: () => void;
  /** Keycap for the Run shortcut: `Ctrl` (default) or `⌘`. */
  modKey?: 'Ctrl' | '⌘';
  class?: string;
}

const REASON_ICON: Readonly<Record<AgentConfirmReasonKind, typeof Trash2>> = {
  delete: Trash2,
  overwrite: FileX,
  chmod: Lock,
  chown: Lock,
  'over-20-inodes': Layers,
  'system-path': ShieldAlert,
};

/** The badge tone an operation gets unless the caller says otherwise. */
export function toneOfOp(op: string): PlanOpTone {
  const word = op.toLowerCase();
  if (['delete', 'rm', 'rmdir', 'unlink', 'overwrite', 'truncate'].includes(word)) return 'danger';
  if (['move', 'mv', 'rename', 'copy', 'cp', 'link'].includes(word)) return 'accent';
  if (['chmod', 'chown', 'chgrp', 'setfacl'].includes(word)) return 'warning';
  return 'neutral';
}

function BlastTile(props: {
  value: number | undefined;
  label: string;
  tone: 'neutral' | 'danger' | 'success';
  index: number;
}): JSX.Element {
  return (
    <div
      class={cx(styles.tile, styles[`tile-${props.tone}`])}
      style={{ '--pl-stagger-index': String(props.index) }}
    >
      <span class={styles.tileValue}>{props.value ?? '—'}</span>
      <span class={styles.tileLabel}>{props.label}</span>
    </div>
  );
}

/**
 * The kernel confirmation sheet (AGT-03, DSN-15, DSN-16). It hangs from under the Terminal's
 * tab strip and dims only that window: an accent security band, the plan table with operation
 * badges, the blast radius, who the plan runs as, and why the kernel asks. **Cancel is the
 * default and has the initial focus**; Run plan is a danger action that needs a click or
 * Ctrl+Enter, never plain Enter. Escape cancels; E edits the plan. The compositor mounts it on
 * the secure layer and wires the buttons straight to the kernel's confirm path.
 */
export function AgentConfirmSheet(props: AgentConfirmSheetProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'agent',
    'pid',
    'request',
    'steps',
    'blast',
    'quota',
    'runAs',
    'transactionNote',
    'reasons',
    'policy',
    'txnState',
    'provider',
    'status',
    'progress',
    'rejection',
    'expiresInS',
    'reasonsExpanded',
    'onCancel',
    'onRun',
    'onEditPlan',
    'onOpenLog',
    'modKey',
    'class',
  ]);
  const uid = createUniqueId();
  const ids = {
    title: `pl-agent-${uid}-title`,
    subtitle: `pl-agent-${uid}-sub`,
    blast: `pl-agent-${uid}-blast`,
    reasons: `pl-agent-${uid}-reasons`,
  };
  let panel: HTMLDivElement | undefined;
  const status = (): AgentConfirmStatus => local.status ?? 'ready';
  const presence = createModalLayer({
    open: () => local.open,
    panel: () => panel,
    exitMs: 200,
    onEscape: () => local.onCancel('escape'),
  });
  // The initial disclosure state only; the user toggles it afterwards.
  const [expanded, setExpanded] = createSignal(untrack(() => local.reasonsExpanded === true));
  const { nudge, attr: nudgeAttr } = createNudge();
  const answerFirst = createTransientMessage(3000);

  const runBlocked = (): boolean => status() !== 'ready' || !local.quota.ok;
  const run = (): void => {
    if (!runBlocked()) local.onRun();
  };
  const blastText = (): string => {
    const blast = local.blast;
    if (blast === undefined) return 'Blast radius still being computed';
    return `${plural(blast.inodes, 'inode')}, ${plural(blast.deletions, 'deletion')}, ${plural(blast.overwrites, 'overwrite')}`;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (panel === undefined) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
      return;
    }
    if (
      (event.key === 'e' || event.key === 'E') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !isTextEntry(event.target) &&
      local.onEditPlan !== undefined &&
      status() === 'ready'
    ) {
      event.preventDefault();
      local.onEditPlan();
      return;
    }
    trapTabKey(event, panel);
  };

  return (
    <Show when={presence.mounted()}>
      <div class={cx(styles.layer, local.class)} data-state={presence.state()}>
        <div
          class={cx(
            styles.scrim,
            presence.state() === 'closing' ? 'pl-anim-scrim-out' : 'pl-anim-scrim-in',
          )}
          aria-hidden="true"
          onClick={() => {
            nudge();
            answerFirst.show('Answer the confirmation first');
          }}
        />
        <div class={cx(styles.clip, shared.nudge)} data-nudge={nudgeAttr()}>
          <div
            ref={(el) => (panel = el)}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={ids.title}
            aria-describedby={`${ids.subtitle} ${ids.blast}`}
            tabindex={-1}
            class={cx(
              styles.sheet,
              presence.state() === 'closing' ? styles.sheetOut : styles.sheetIn,
            )}
            onKeyDown={onKeyDown}
          >
            {/* DSN-16: the security band no app can draw (the compositor puts it on --pl-z-secure). */}
            <div class={styles.band}>
              <span class={styles.bandMark} aria-hidden="true">
                <AtomLogo size={14} />
                <Lock size={12} stroke-width={2.4} />
              </span>
              <span class={styles.bandTitle}>
                Kernel confirmation · {local.agent} pid {local.pid}
              </span>
              <span class={styles.bandNote}>secure layer · not drawn by the app</span>
            </div>

            <div class={styles.scroll}>
              <header class={styles.header}>
                <span class={styles.warnIcon} aria-hidden="true">
                  <TriangleAlert size={18} stroke-width={2.2} />
                </span>
                <div class={styles.headings}>
                  <h2 class={styles.title} id={ids.title}>
                    Confirm destructive plan
                  </h2>
                  <p class={styles.subtitle} id={ids.subtitle}>
                    {local.agent} wants to run {plural(local.steps.length, 'step')} in one
                    transaction for <q class={styles.request}>{local.request}</q>
                  </p>
                </div>
              </header>

              <Switch>
                <Match when={status() === 'rejected'}>
                  <p class={styles.rejection} role="alert">
                    <CircleX size={16} stroke-width={2.2} aria-hidden="true" />
                    {local.rejection ?? 'Plan rejected — nothing ran'}
                  </p>
                </Match>
                <Match when={status() !== 'rejected'}>
                  {/* ---------- plan table ---------- */}
                  <div class={styles.tableWrap}>
                    <table class={styles.table}>
                      <caption class={shared.srOnly}>Plan steps</caption>
                      <thead>
                        <tr>
                          <th scope="col" class={styles.num}>
                            #
                          </th>
                          <th scope="col">Operation</th>
                          <th scope="col">Path</th>
                          <th scope="col" class={styles.effectHead}>
                            Effect
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <Show
                          when={status() !== 'loading'}
                          fallback={
                            <For each={[0, 1, 2, 3, 4]}>
                              {(i) => (
                                <tr class={styles.skeletonRow} aria-hidden="true">
                                  <td class={styles.num}>{i + 1}</td>
                                  <td>
                                    <span class={styles.skeletonBadge} />
                                  </td>
                                  <td>
                                    <span class={styles.skeletonPath} />
                                  </td>
                                  <td class={styles.effect}>
                                    <span class={styles.skeletonEffect} />
                                  </td>
                                </tr>
                              )}
                            </For>
                          }
                        >
                          <For each={local.steps}>
                            {(step, index) => (
                              <tr
                                class={styles.step}
                                style={{ '--pl-stagger-index': String(index()) }}
                              >
                                <td class={styles.num}>{index() + 1}</td>
                                <td>
                                  <Pill
                                    tone={step.tone ?? toneOfOp(step.op)}
                                    caps
                                    class={styles.op}
                                  >
                                    {step.op}
                                  </Pill>
                                </td>
                                <td class={styles.path}>
                                  <span class={styles.pathText} title={step.path}>
                                    {step.path}
                                    <Show when={step.target}>
                                      {(target) => (
                                        <>
                                          <span class={styles.arrow}> → </span>
                                          {target()}
                                        </>
                                      )}
                                    </Show>
                                    <Show when={step.args}>
                                      {(args) => <span class={styles.args}> {args()}</span>}
                                    </Show>
                                  </span>
                                  <Show when={step.flag}>
                                    {(flag) => (
                                      <span class={styles.flag}>
                                        <TriangleAlert
                                          size={11}
                                          stroke-width={2.4}
                                          aria-hidden="true"
                                        />
                                        {flag() === 'ungrounded'
                                          ? 'not in your request'
                                          : 'from file content'}
                                      </span>
                                    )}
                                  </Show>
                                </td>
                                <td class={styles.effect}>
                                  {step.effect}
                                  <Show when={step.effectNote}>
                                    {(note) => <span class={styles.effectNote}> · {note()}</span>}
                                  </Show>
                                </td>
                              </tr>
                            )}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>

                  {/* ---------- blast radius ---------- */}
                  <div class={styles.blast}>
                    <div class={styles.blastLabel}>
                      <span class={styles.blastTitle}>Blast radius</span>
                      <span class={styles.blastSub}>distinct inodes changed</span>
                    </div>
                    <BlastTile
                      value={local.blast?.inodes}
                      label="inodes"
                      tone="neutral"
                      index={0}
                    />
                    <BlastTile
                      value={local.blast?.deletions}
                      label={
                        local.blast?.recoverable === true && local.blast.deletions > 0
                          ? 'deletions · recoverable'
                          : 'deletions'
                      }
                      tone={(local.blast?.deletions ?? 0) > 0 ? 'danger' : 'neutral'}
                      index={1}
                    />
                    <BlastTile
                      value={local.blast?.overwrites}
                      label="overwrites"
                      tone={(local.blast?.overwrites ?? 0) > 0 ? 'danger' : 'success'}
                      index={2}
                    />
                    <span class={shared.srOnly} id={ids.blast}>
                      {blastText()}.
                    </span>
                  </div>

                  <div class={styles.identity}>
                    <span
                      class={cx(styles.runAs, local.runAs.elevated === true && styles.elevated)}
                    >
                      <User size={14} stroke-width={2} aria-hidden="true" />
                      <Show
                        when={local.runAs.elevated === true}
                        fallback={
                          <span>
                            Runs as <strong>{local.runAs.user}</strong> (uid {local.runAs.uid}) ·{' '}
                            {local.transactionNote ?? 'one transaction · undo token issued'}
                          </span>
                        }
                      >
                        <span>Runs as root for this plan only · secure prompt required</span>
                      </Show>
                    </span>
                    <Pill
                      tone={local.quota.ok ? 'success' : 'danger'}
                      icon={
                        local.quota.ok ? (
                          <Check size={11} stroke-width={3} />
                        ) : (
                          <TriangleAlert size={11} stroke-width={2.4} />
                        )
                      }
                      class={styles.quota}
                    >
                      {local.quota.text}
                    </Pill>
                  </div>

                  {/* ---------- why ---------- */}
                  <div class={styles.why}>
                    <button
                      type="button"
                      class={styles.disclosure}
                      aria-expanded={expanded() ? 'true' : 'false'}
                      aria-controls={ids.reasons}
                      onClick={() => setExpanded((v) => !v)}
                    >
                      <ChevronRight
                        size={14}
                        stroke-width={2.4}
                        class={styles.chevron}
                        aria-hidden="true"
                      />
                      Why this needs confirmation
                    </button>
                    <div id={ids.reasons} class={styles.reasons} hidden={!expanded()}>
                      <ul class={styles.reasonList}>
                        <For each={local.reasons}>
                          {(reason, index) => (
                            <li
                              class={styles.reason}
                              style={{ '--pl-stagger-index': String(index()) }}
                            >
                              <Dynamic
                                component={REASON_ICON[reason.kind]}
                                size={14}
                                stroke-width={2}
                                class={cx(styles.reasonIcon, styles[`reason-${reason.kind}`])}
                                aria-hidden="true"
                              />
                              <span>{reason.text}</span>
                              <code class={styles.reasonCode}>{reason.code}</code>
                            </li>
                          )}
                        </For>
                      </ul>
                      <Show when={local.policy}>
                        {(policy) => <p class={styles.policy}>Policy: {policy()}</p>}
                      </Show>
                    </div>
                  </div>
                </Match>
              </Switch>

              <Show when={local.expiresInS !== undefined && local.expiresInS <= 20}>
                <p class={styles.expiry} role="status">
                  This request will be cancelled in {local.expiresInS} seconds — nothing will run
                </p>
              </Show>
              <Show when={answerFirst.message() !== ''}>
                <p class={styles.expiry} role="status">
                  {answerFirst.message()}
                </p>
              </Show>
            </div>

            {/* ---------- actions (pinned below the scrolling plan) ---------- */}
            <div class={styles.bottom}>
              <Show
                when={status() !== 'rejected'}
                fallback={
                  <div class={styles.actions}>
                    <span class={styles.spacer} />
                    <Button
                      variant="primary"
                      size="lg"
                      data-autofocus
                      onClick={() => local.onCancel('close')}
                    >
                      Close
                    </Button>
                  </div>
                }
              >
                <div class={styles.actions}>
                  <Show when={local.onEditPlan}>
                    {(onEdit) => (
                      <Button
                        size="lg"
                        icon={<Pencil size={13} stroke-width={2.2} />}
                        aria-keyshortcuts="E"
                        disabled={status() !== 'ready'}
                        onClick={() => onEdit()()}
                      >
                        Edit plan
                      </Button>
                    )}
                  </Show>
                  <span class={styles.spacer} />
                  <span class={styles.defaultRing}>
                    <Button
                      variant="primary"
                      size="lg"
                      data-autofocus
                      class={styles.cancel}
                      onClick={() => local.onCancel('button')}
                    >
                      Cancel
                    </Button>
                  </span>
                  <Button
                    variant="danger"
                    size="lg"
                    icon={<Play size={13} stroke-width={2.4} />}
                    aria-keyshortcuts={local.modKey === '⌘' ? 'Meta+Enter' : 'Control+Enter'}
                    disabled={runBlocked()}
                    onClick={run}
                  >
                    <Show when={status() === 'running'} fallback="Run plan">
                      Running… {local.progress?.done ?? 0} of{' '}
                      {local.progress?.total ?? local.steps.length}
                    </Show>
                  </Button>
                </div>
                <Show when={status() === 'running'}>
                  <div
                    class={styles.runBar}
                    role="progressbar"
                    aria-label="Running plan"
                    aria-valuemin={0}
                    aria-valuemax={local.progress?.total ?? local.steps.length}
                    aria-valuenow={local.progress?.done ?? 0}
                  >
                    <span
                      class={styles.runFill}
                      style={{
                        '--pl-progress-ratio': String(
                          (local.progress?.done ?? 0) /
                            Math.max(1, local.progress?.total ?? local.steps.length),
                        ),
                      }}
                    />
                  </div>
                </Show>
                <div class={styles.hints}>
                  <Show when={local.onEditPlan}>
                    <span class={styles.hint}>
                      <Kbd keys={['E']} />
                      Edit plan
                    </span>
                  </Show>
                  <span class={styles.spacer} />
                  <span class={styles.hint}>
                    <Kbd keys={['↵']} />
                    Cancel (default)
                  </span>
                  <span class={styles.hint}>
                    <Kbd keys={['Esc']} />
                    Cancel
                  </span>
                  <span class={styles.hint}>
                    <Kbd keys={[local.modKey ?? 'Ctrl', '↵']} />
                    Run plan
                  </span>
                </div>
              </Show>
            </div>

            <footer class={styles.footer}>
              <Show
                when={local.onOpenLog}
                fallback={
                  <span class={styles.audit}>
                    <ShieldCheck size={13} stroke-width={2} aria-hidden="true" />
                    Audited in ai log
                  </span>
                }
              >
                {(onOpenLog) => (
                  <button type="button" class={styles.auditLink} onClick={() => onOpenLog()()}>
                    <ShieldCheck size={13} stroke-width={2} aria-hidden="true" />
                    Audited in ai log
                  </button>
                )}
              </Show>
              <span class={styles.footerMeta}>
                {[
                  local.txnState ?? 'txn pending',
                  `${local.agent} pid ${local.pid}`,
                  local.provider,
                ]
                  .filter((part) => part !== undefined && part !== '')
                  .join(' · ')}
              </span>
            </footer>
          </div>
        </div>
      </div>
    </Show>
  );
}
