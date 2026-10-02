/**
 * RecoveryConsole (BOOT-06, BOOT-08, SVC-06; boot-and-services.md §3.8, ui-design-system.md
 * §3.8.5). A single-user console: a listbox of actions with one-key shortcuts and a one-line
 * consequence each, and a pane with the fsck checklist, a determinate bar with real counts and
 * a monospace output log. Destructive actions need a second, explicit confirmation whose
 * default button is Cancel (DSN-15). Actions are emitted as intents; the driver sends the
 * `recovery.*` messages and feeds results back through setChecklist, setProgress and output.
 */
import { docOf, h, listenKeys, nodes, q, qa, render, typing, uid } from './dom.ts';
import { glyph, type GlyphName } from './glyphs.ts';
import { createVerboseLog, type VerboseLog } from './log.ts';
import { logoSvg } from './logo.ts';
import type { BootIdentity, BootScreen, ScreenBase } from './types.ts';

export type RecoveryActionId =
  | 'fsck'
  | 'repair'
  | 'clear-cache'
  | 'reset-session'
  | 'restore-manifests'
  | 'boot-log'
  | 'diagnostics'
  | 'reboot'
  | 'safe';

export interface RecoveryAction {
  readonly id: RecoveryActionId;
  /** Single-key shortcut (boot-and-services.md §3.8). */
  readonly key: string;
  /** The full name: the pane heading, the confirmation and the option's accessible name. */
  readonly title: string;
  /** The consequence, shown under the heading in the pane. */
  readonly detail: string;
  /** The short name on one line of the action list (default: the title). */
  readonly label?: string;
  /** The one-line consequence in the action list (default: the detail). */
  readonly summary?: string;
  readonly icon: GlyphName;
  /** Present on destructive actions: the confirmation text, shown before anything runs. */
  readonly confirm?: string;
}

export const RECOVERY_ACTIONS: readonly RecoveryAction[] = [
  {
    id: 'fsck',
    key: 'F',
    icon: 'scan',
    title: 'Check file system',
    detail: 'Run fsck read-only and show the report.',
    summary: 'Read-only check and report',
  },
  {
    id: 'repair',
    key: 'Y',
    icon: 'wrench',
    title: 'Repair file system',
    detail: 'Run fsck and fix problems in one local transaction.',
    summary: 'Fixes problems on this device',
    confirm:
      'Repairs apply to this device only; the next online login re-converges from the server.',
  },
  {
    id: 'clear-cache',
    key: 'C',
    icon: 'trash',
    title: 'Clear local cache and re-sync',
    detail:
      "Export unsynced changes to a file, delete this device's local copy, download it again.",
    label: 'Clear local cache',
    summary: 'Exports the outbox, then re-syncs',
    confirm:
      "Unsynced changes are exported to a file first, then this device's local copy is deleted.",
  },
  {
    id: 'reset-session',
    key: 'S',
    icon: 'reset',
    title: 'Reset session',
    detail: 'Forget the saved window layout. Files are not affected.',
    summary: 'Clean desktop on the next boot',
    confirm: 'The saved window layout is set aside; the next boot starts a clean session.',
  },
  {
    id: 'restore-manifests',
    key: 'M',
    icon: 'file',
    title: 'Restore default service manifests',
    detail: 'Replace /system/services with the built-in manifests.',
    label: 'Restore default manifests',
    summary: 'Rewrites /system/services',
    confirm:
      'Every file in /system/services is replaced by the built-in set; extra manifests are deleted.',
  },
  {
    id: 'boot-log',
    key: 'L',
    icon: 'list',
    title: 'Boot log',
    detail: 'Show the last 20 boot records and the critical path.',
    summary: 'Last 20 boots, critical path',
  },
  {
    id: 'diagnostics',
    key: 'D',
    icon: 'download',
    title: 'Download diagnostics',
    detail: 'Save the boot log and system report as JSON.',
    summary: 'Boot record and capabilities',
  },
  {
    id: 'reboot',
    key: 'N',
    icon: 'power',
    title: 'Reboot',
    detail: 'Boot again normally with the same settings.',
    summary: 'Boot again normally',
  },
  {
    id: 'safe',
    key: 'B',
    icon: 'shield',
    title: 'Safe mode',
    detail: 'Boot without AI services, autostart apps or custom theme.',
    summary: 'No AI, autostart or custom theme',
  },
];

export type CheckState = 'pending' | 'running' | 'passed' | 'failed' | 'repaired';

/** One fsck pass group (reachability, link counts, cycles, quota totals, structure). */
export interface CheckItem {
  readonly label: string;
  readonly state: CheckState;
  /** Right-aligned result, e.g. `12,408 / 12,408` or `2 orphans`. */
  readonly detail?: string;
}

export interface RecoveryConsoleOptions extends BootIdentity, ScreenBase {
  readonly actions?: readonly RecoveryAction[];
  /** Why the console is open, e.g. `Critical service "storage" failed: …`. */
  readonly reason?: string;
  /** Services running in recovery (`kernel, sched, storage, wm, vfs · ro`). */
  readonly services?: readonly string[];
  readonly bootId?: string;
  /** Right side of the top bar, e.g. `Offline · storage 412 MB used`. */
  readonly status?: string;
  readonly onAction: (action: RecoveryActionId) => void;
}

export interface RecoveryConsole extends BootScreen {
  /** The monospace output pane (role=log, polite). */
  readonly output: VerboseLog;
  readonly selected: RecoveryActionId;
  select(action: RecoveryActionId): void;
  setChecklist(items: readonly CheckItem[]): void;
  /** Real progress of the running action in [0, 1] with its caption; null hides the bar. */
  setProgress(p: number | null, caption?: string): void;
  /** Marks an action as running: destructive actions are disabled and the pane is busy. */
  setBusy(action: RecoveryActionId | null): void;
  setStatus(text: string): void;
}

const STATE_WORD: Readonly<Record<CheckState, string>> = {
  pending: 'pending',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  repaired: 'repaired',
};
const STATE_ICON: Readonly<Record<CheckState, GlyphName>> = {
  pending: 'circle',
  running: 'circle',
  passed: 'check',
  failed: 'x',
  repaired: 'wrench',
};

export function createRecoveryConsole(opts: RecoveryConsoleOptions): RecoveryConsole {
  const doc = docOf(opts.doc);
  const id = uid('plb-r');
  const actions = opts.actions ?? RECOVERY_ACTIONS;
  const root = render(
    h(
      'div',
      { class: 'plb plb-rec' },
      h(
        'header',
        { class: 'plb-top' },
        logoSvg({ size: 16, id }),
        h('b', null, 'Plotinium Recovery Console'),
        h('span', null, `· ${opts.version} (${opts.build})`),
        h(
          'span',
          { class: 'plb-pill' },
          glyph('lock', 13),
          'Recovery mode — read-only file system',
        ),
        h('span', { class: 'plb-net' }, opts.status ?? ''),
      ),
      h(
        'div',
        { class: 'plb-win' },
        h(
          'nav',
          { class: 'plb-side', 'aria-label': 'Recovery actions' },
          // D-19: no traffic lights; there is no window manager in recovery.
          h('h2', { class: 'plb-sec', id: `${id}a` }, 'Actions'),
          h(
            'div',
            { class: 'plb-lb', role: 'listbox', tabindex: 0, 'aria-labelledby': `${id}a` },
            actions.map((a, i) =>
              h(
                'div',
                {
                  class: 'plb-opt',
                  role: 'option',
                  id: `${id}o${i}`,
                  'data-i': i,
                  'aria-selected': 'false',
                  'aria-label': a.title,
                  'aria-describedby': `${id}d${i}`,
                  'aria-keyshortcuts': a.key,
                },
                glyph(a.icon, 18),
                h('span', { class: 'plb-ot', title: a.title }, a.label ?? a.title),
                h('span', { class: 'plb-od', id: `${id}d${i}` }, a.summary ?? a.detail),
                h('kbd', { 'aria-hidden': 'true' }, a.key),
              ),
            ),
          ),
          h(
            'div',
            { class: 'plb-svc' },
            h('h2', { class: 'plb-sec' }, 'Services running'),
            h(
              'ul',
              null,
              (opts.services ?? ['kernel', 'sched', 'storage', 'wm', 'vfs · ro']).map((name) =>
                h('li', null, name),
              ),
            ),
            h('p', null, `?boot=recovery · boot ${opts.bootId ?? 'pending'} · uid — (none)`),
          ),
        ),
        h(
          'main',
          { class: 'plb-pane', 'aria-labelledby': `${id}h` },
          opts.reason !== undefined &&
            h('p', { class: 'plb-reason', role: 'alert' }, glyph('alert', 16), opts.reason),
          h('h1', { class: 'plb-ph', id: `${id}h` }),
          h('p', { class: 'plb-pd' }),
          h(
            'div',
            {
              class: 'plb-confirm',
              role: 'alertdialog',
              'aria-labelledby': `${id}c`,
              hidden: true,
            },
            h('p', { id: `${id}c` }),
            h('button', { type: 'button', class: 'plb-btn', 'data-c': 'no' }, 'Cancel'),
            h('button', { type: 'button', class: 'plb-btn plb-danger', 'data-c': 'yes' }),
          ),
          h('ol', { class: 'plb-check', 'aria-label': 'fsck passes', hidden: true }),
          h(
            'div',
            { class: 'plb-prog', hidden: true },
            h(
              'div',
              {
                class: 'plb-pbar',
                role: 'progressbar',
                'aria-label': 'Recovery progress',
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': 0,
              },
              h('i'),
            ),
            h('p'),
          ),
          h('div', { class: 'plb-outw' }),
          h(
            'footer',
            { class: 'plb-pf' },
            h(
              'span',
              { class: 'plb-keys' },
              '↑ ↓ choose · Enter run · letter keys run directly · repairs are local-only until next login',
            ),
            h('button', { type: 'button', class: 'plb-btn plb-primary', 'data-run': true }),
          ),
        ),
      ),
    ),
    doc,
  );
  const list = q(root, '.plb-lb');
  const opts$ = qa(list, '.plb-opt');
  const pane = q(root, '.plb-pane');
  const heading = q(root, '.plb-ph');
  const desc = q(root, '.plb-pd');
  const confirmBox = q(root, '.plb-confirm');
  const confirmText = q(confirmBox, 'p');
  const confirmYes = q<HTMLButtonElement>(confirmBox, '[data-c="yes"]');
  const confirmNo = q<HTMLButtonElement>(confirmBox, '[data-c="no"]');
  const checklist = q(root, '.plb-check');
  const prog = q(root, '.plb-prog');
  const pbar = q(prog, '.plb-pbar');
  const runBtn = q<HTMLButtonElement>(root, '[data-run]');
  const netText = q(root, '.plb-net');
  const output = createVerboseLog({
    doc,
    label: 'Recovery output',
    live: 'polite',
    empty: 'Run a check to see its report here.',
  });
  q(root, '.plb-outw').append(output.el);

  let index = 0;
  let busy: RecoveryActionId | null = null;
  let confirming: RecoveryAction | null = null;

  const disabled = (a: RecoveryAction): boolean =>
    busy !== null &&
    a.id !== busy &&
    (a.confirm !== undefined || a.id === 'reboot' || a.id === 'safe');

  const paint = (): void => {
    const a = actions[index];
    list.setAttribute('aria-activedescendant', `${id}o${index}`);
    opts$.forEach((o, i) => {
      o.setAttribute('aria-selected', String(i === index));
      const action = actions[i];
      if (action !== undefined && disabled(action)) o.setAttribute('aria-disabled', 'true');
      else o.removeAttribute('aria-disabled');
    });
    if (a === undefined) return;
    heading.textContent = a.title;
    desc.textContent = a.detail;
    runBtn.textContent = a.title;
    if (disabled(a) || busy === a.id) runBtn.setAttribute('aria-disabled', 'true');
    else runBtn.removeAttribute('aria-disabled');
  };

  const closeConfirm = (): void => {
    confirming = null;
    confirmBox.hidden = true;
    list.focus();
  };

  const run = (a: RecoveryAction | undefined, confirmed = false): void => {
    if (a === undefined || disabled(a) || busy === a.id) return;
    if (a.confirm !== undefined && !confirmed) {
      confirming = a;
      confirmText.textContent = `${a.title}? ${a.confirm}`;
      confirmYes.textContent = `Yes, ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`;
      confirmBox.hidden = false;
      confirmNo.focus();
      return;
    }
    opts.onAction(a.id);
  };

  list.addEventListener('keydown', (e) => {
    const n = actions.length;
    let handled = true;
    if (e.key === 'ArrowDown') index = Math.min(n - 1, index + 1);
    else if (e.key === 'ArrowUp') index = Math.max(0, index - 1);
    else if (e.key === 'Home') index = 0;
    else if (e.key === 'End') index = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') run(actions[index]);
    else handled = false;
    if (handled) {
      e.preventDefault();
      paint();
      // The list scrolls inside the sidebar on short screens: keep the selection in view.
      opts$[index]?.scrollIntoView({ block: 'nearest' });
    }
  });
  list.addEventListener('click', (e) => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('.plb-opt') : null;
    if (row === null) return;
    index = Number(row.dataset.i);
    paint();
    list.focus();
  });
  list.addEventListener('dblclick', () => run(actions[index]));
  runBtn.addEventListener('click', () => run(actions[index]));
  confirmNo.addEventListener('click', closeConfirm);
  confirmYes.addEventListener('click', () => {
    const a = confirming;
    closeConfirm();
    run(a ?? undefined, true);
  });
  confirmBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirm();
    }
  });
  const unlisten = listenKeys(doc, (e) => {
    // Esc cancels a confirmation wherever focus went (a click outside moves it to the body).
    if (confirming !== null && e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      closeConfirm();
      return;
    }
    if (typing(e) || e.repeat || confirming !== null) return;
    const i = actions.findIndex((a) => a.key === e.key.toUpperCase());
    if (i < 0) return;
    e.preventDefault();
    index = i;
    paint();
    run(actions[i]);
  });

  paint();
  return {
    el: root,
    output,
    get selected() {
      return actions[index]?.id ?? 'fsck';
    },
    select(action) {
      const i = actions.findIndex((a) => a.id === action);
      if (i >= 0) {
        index = i;
        paint();
      }
    },
    setChecklist(items) {
      checklist.hidden = items.length === 0;
      checklist.replaceChildren(
        ...nodes(
          items.map((it) =>
            h(
              'li',
              { 'data-s': it.state },
              glyph(STATE_ICON[it.state], 14, 'plb-ci'),
              h(
                'span',
                { class: 'plb-cl' },
                it.label,
                h('span', { class: 'plb-sr' }, `, ${STATE_WORD[it.state]}`),
              ),
              h('span', { class: 'plb-cv' }, it.detail ?? STATE_WORD[it.state]),
            ),
          ),
          doc,
        ),
      );
    },
    setProgress(p, caption) {
      prog.hidden = p === null;
      if (p === null) return;
      const v = Math.min(1, Math.max(0, p));
      pbar.style.setProperty('--plb-p', String(v));
      pbar.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      pbar.setAttribute('aria-valuetext', caption ?? `${Math.round(v * 100)} percent`);
      q(prog, 'p').textContent = caption ?? '';
    },
    setBusy(action) {
      busy = action;
      pane.setAttribute('aria-busy', String(action !== null));
      paint();
    },
    setStatus(text) {
      netText.textContent = text;
    },
    focus() {
      list.focus();
    },
    destroy() {
      unlisten();
      output.destroy();
      root.remove();
    },
  };
}
