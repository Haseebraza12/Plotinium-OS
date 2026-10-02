/**
 * Recovery-mode driver (boot-and-services.md §3.7 Recovery row, §3.8, SVC-06; BOOT-06): once the
 * recovery target (kernel, sched, storage, wm, vfs read-only) is up, the recovery console replaces
 * login and the desktop. Loaded as its own chunk: only Recovery boots need it.
 *
 * Actions are router→kernel `recovery.run` messages (no process or uid exists yet); their reports
 * arrive as klog lines, which stream into the console's output pane. Diagnostics, the boot log
 * summary and the two reboots run here on the main thread, so they work even if the kernel never
 * answers.
 *
 * The console only says what is true (UI-060): an action is "sent to the kernel"; a klog line
 * from the kernel's answer (subsystem `recovery` or the action's name, or a message starting
 * with that name) ends the wait, and without one within RECOVERY_ANSWER_MS the console says
 * that no answer came. That wait is a UI timer on the recovery console, after the boot has
 * finished; it never reads or writes boot progress.
 */
import type { KlogLine, RouterToKernel } from '@plotinium/kernel/host/main';
import type { RecoveryActionId, RecoveryConsole } from '@plotinium/ui/boot';
import { createRecoveryConsole } from '@plotinium/ui/boot';

import type { BootRecordDraft } from './record.ts';
import type { TimerApi } from './timers.ts';

/** How long the console waits for the kernel's first answer to an action. */
export const RECOVERY_ANSWER_MS = 10_000;

export type RecoveryRun = Extract<RouterToKernel, { t: 'recovery.run' }>['action'];

/** Console action → the `recovery.run` action it sends (§4.5); null = handled on the main thread. */
export const RECOVERY_RUN: Readonly<Record<RecoveryActionId, RecoveryRun | null>> = {
  fsck: 'fsck',
  repair: 'fsck-repair',
  'clear-cache': 'clear-cache',
  'reset-session': 'reset-session',
  'restore-manifests': 'restore-manifests',
  'boot-log': 'bootlog',
  diagnostics: null,
  reboot: null,
  safe: null,
};

export interface RecoveryDeps {
  readonly doc: Document;
  readonly identity: { readonly version: string; readonly build: string };
  readonly record: BootRecordDraft;
  /** Services running in this recovery boot, in start order. */
  readonly services: readonly string[];
  /** Why recovery was entered (the panic text the user came from), if known. */
  readonly reason?: string;
  readonly status: string;
  readonly post: (msg: RouterToKernel) => void;
  readonly diagnostics: () => void;
  readonly reboot: (url: string) => void;
  readonly now: () => number;
  /** The platform timers (timers.ts) for the answer wait. */
  readonly timers: TimerApi;
  /** Answer wait in ms (RECOVERY_ANSWER_MS, stretched on the dev server). */
  readonly answerMs?: number;
}

/** True when `line` is the kernel answering `run` (see the header). */
export function answersRun(line: KlogLine, run: RecoveryRun): boolean {
  const names = run === 'fsck-repair' ? [run, 'fsck'] : [run];
  return (
    line.sub === 'recovery' ||
    names.includes(line.sub) ||
    names.some((n) => line.msg.startsWith(`${n}:`) || line.msg.startsWith(`${n} `))
  );
}

export interface RecoveryHandle {
  readonly console: RecoveryConsole;
  /** klog batches from the kernel: every line after the console opened is shown. */
  klog(lines: readonly KlogLine[]): void;
}

export function openRecoveryConsole(deps: RecoveryDeps): RecoveryHandle {
  const t = (): number => deps.now();
  const answerMs = deps.answerMs ?? RECOVERY_ANSWER_MS;
  /** Actions sent and not answered yet, with their wait timers. */
  const waiting = new Map<RecoveryRun, unknown>();
  const note = (msg: string, level: KlogLine['level'] = 'info'): KlogLine => ({
    t: t(),
    sub: 'recovery',
    level,
    msg,
  });
  const rec = createRecoveryConsole({
    doc: deps.doc,
    version: deps.identity.version,
    build: deps.identity.build,
    services: deps.services,
    status: deps.status,
    ...(deps.reason === undefined ? {} : { reason: deps.reason }),
    ...(deps.record.bootId === '' ? {} : { bootId: deps.record.bootId }),
    onAction: (action) => {
      const run = RECOVERY_RUN[action];
      if (run !== null) {
        deps.post({ t: 'recovery.run', action: run });
        rec.output.append(note(`${run}: sent to the kernel, waiting for its answer`));
        const previous = waiting.get(run);
        if (previous !== undefined) deps.timers.clear(previous);
        waiting.set(
          run,
          deps.timers.set(() => {
            waiting.delete(run);
            rec.output.append(
              note(
                `${run}: no answer from the kernel after ${String(Math.round(answerMs / 1_000))} s (D diagnostics, N reboot)`,
                'warn',
              ),
            );
          }, answerMs), // boot-timer-allow: recovery-answer (the console's wait, not boot progress)
        );
        if (action === 'boot-log') {
          const r = deps.record;
          rec.output.append(
            note(
              `this boot: profile ${r.profile} · ${r.kind} · flags ${r.flags.join(',') || 'none'} · outcome ${r.outcome}`,
            ),
          );
        }
        return;
      }
      if (action === 'diagnostics') {
        deps.diagnostics();
        rec.output.append(note('diagnostics saved as JSON'));
      } else if (action === 'reboot') deps.reboot('/?boot=normal');
      else deps.reboot('/?boot=safe');
    },
  });
  rec.el.dataset['testid'] = 'recovery-console';
  rec.output.append(
    note(`recovery console ready · services: ${deps.services.join(', ') || 'none reported'}`),
  );
  deps.doc.body.append(rec.el);
  rec.focus();
  return {
    console: rec,
    klog(lines) {
      rec.output.append(...lines);
      for (const [run, timer] of waiting)
        if (lines.some((line) => answersRun(line, run))) {
          deps.timers.clear(timer);
          waiting.delete(run);
        }
    },
  };
}
