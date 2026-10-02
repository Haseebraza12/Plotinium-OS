import Check from 'lucide-solid/icons/check';
import { createUniqueId, For, Show, splitProps, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

import { AtomLogo } from '../../icons/index.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { Checkbox } from '../../primitives/checkbox/Checkbox.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { trapTabKey } from '../../primitives/internal/focus.ts';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import { createModalLayer, createNudge, createTransientMessage } from '../internal/behaviour.ts';
import shared from '../internal/shared.module.css';
import styles from './Update.module.css';

export interface UpdateNote {
  /** Bold lead: `Faster boot`. */
  lead: string;
  /** The rest of the line; text between backticks renders as code (`` `ai explain` ``). */
  text: string;
}

export interface BuildInfo {
  version: string;
  build: string;
}

export interface RestartToUpdateDialogProps {
  open: boolean;
  current: BuildInfo;
  next: BuildInfo & { size: string };
  notes: readonly UpdateNote[];
  /** Shown instead of the notes: `Maintenance release`, `Release notes are available when online`. */
  notesMessage?: string;
  onReleaseNotes?: () => void;
  autoInstall: boolean;
  onAutoInstallChange: (on: boolean) => void;
  /** Guests cannot change it. */
  autoInstallDisabled?: boolean;
  /** Later, or Escape: the dialog closes and the menu-bar chip stays. */
  onLater: (reason: 'button' | 'escape') => void;
  /** Restart Now (or Ctrl+Enter): the caller hands off to the shutdown view (BOOT-12). */
  onRestart: () => void;
  /** Restart Now shows `Restarting…` for the hand-off. */
  restarting?: boolean;
  /** Inline error, e.g. `A restart is already in progress` (EBUSY). */
  error?: string;
  /** Client and server disagree (offline-and-sync §3.16.3 rule 4): the title says a restart is required. */
  required?: boolean;
  modKey?: 'Ctrl' | '⌘';
  /** Render inside the nearest positioned ancestor instead of a full-screen portal (gallery). */
  contained?: boolean;
  class?: string;
}

/** Splits `text` on backticks into plain and code runs. */
export function codeRuns(text: string): { text: string; code: boolean }[] {
  return text
    .split('`')
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((run) => run.text !== '');
}

/**
 * "Restart to update" (OFF-05): an alertdialog with our app icon, the version change with both
 * build hashes, What's new, the auto-install choice, and **Later as the initial focus** (the
 * safe action, ui-design-system §3.7). Restart Now is the primary button, bound to Ctrl+Enter.
 * A scrim click nudges the dialog instead of closing it.
 */
export function RestartToUpdateDialog(props: RestartToUpdateDialogProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'current',
    'next',
    'notes',
    'notesMessage',
    'onReleaseNotes',
    'autoInstall',
    'onAutoInstallChange',
    'autoInstallDisabled',
    'onLater',
    'onRestart',
    'restarting',
    'error',
    'required',
    'modKey',
    'contained',
    'class',
  ]);
  const uid = createUniqueId();
  const titleId = `pl-update-${uid}-title`;
  const bodyId = `pl-update-${uid}-body`;
  let panel: HTMLDivElement | undefined;
  const presence = createModalLayer({
    open: () => local.open,
    panel: () => panel,
    exitMs: 160,
    onEscape: () => local.onLater('escape'),
  });
  const { nudge, attr: nudgeAttr } = createNudge();
  const choose = createTransientMessage(3000);
  const restart = (): void => {
    if (local.restarting !== true) local.onRestart();
  };

  const layer = (): JSX.Element => (
    <div
      class={cx(styles.layer, local.contained === true && styles.contained, local.class)}
      data-state={presence.state()}
    >
      <div
        class={cx(
          styles.scrim,
          presence.state() === 'closing' ? 'pl-anim-scrim-out' : 'pl-anim-scrim-in',
        )}
        aria-hidden="true"
        onClick={() => {
          nudge();
          choose.show('Choose Later or Restart Now');
        }}
      />
      <div class={shared.nudge} data-nudge={nudgeAttr()}>
        <div
          ref={(el) => (panel = el)}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          tabindex={-1}
          class={cx(
            styles.dialog,
            presence.state() === 'closing' ? 'pl-anim-dialog-out' : 'pl-anim-dialog-in',
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              restart();
              return;
            }
            if (panel !== undefined) trapTabKey(event, panel);
          }}
        >
          <div class={styles.appIcon} data-theme="dark" aria-hidden="true">
            <span class={styles.appIconMark}>
              <AtomLogo size={44} />
            </span>
          </div>
          <h2 class={styles.title} id={titleId}>
            {local.required === true
              ? 'Restart to update required to sync'
              : `Plotinium ${local.next.version} is ready`}
          </h2>
          <p class={styles.versions}>
            {local.current.version} · <code>{local.current.build}</code>
            <span class={styles.arrow} aria-hidden="true">
              {' '}
              →{' '}
            </span>
            <span class={shared.srOnly}> to </span>
            {local.next.version} · <code>{local.next.build}</code> · {local.next.size} · downloaded
          </p>

          <section class={styles.notes} aria-labelledby={`${titleId}-new`}>
            <div class={styles.notesHead}>
              <h3 class={styles.notesTitle} id={`${titleId}-new`}>
                What's new
              </h3>
              <Show when={local.onReleaseNotes}>
                {(open) => (
                  <button type="button" class={styles.link} onClick={() => open()()}>
                    Full release notes
                  </button>
                )}
              </Show>
            </div>
            <Show
              when={local.notesMessage === undefined && local.notes.length > 0}
              fallback={
                <p class={styles.notesMessage}>{local.notesMessage ?? 'Maintenance release'}</p>
              }
            >
              <ul class={styles.noteList}>
                <For each={local.notes}>
                  {(note, index) => (
                    <li class={styles.note} style={{ '--pl-stagger-index': String(index()) }}>
                      <span class={styles.noteCheck} aria-hidden="true">
                        <Check size={10} stroke-width={3.4} />
                      </span>
                      <span>
                        <strong>{note.lead}:</strong>{' '}
                        <For each={codeRuns(note.text)}>
                          {(run) => (
                            <Show when={run.code} fallback={run.text}>
                              <code>{run.text}</code>
                            </Show>
                          )}
                        </For>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <p class={styles.body} id={bodyId}>
            The update installs in the background and activates on your next restart. Your windows
            and unsaved work will be restored.
          </p>
          <Checkbox
            checked={local.autoInstall}
            onChange={(on) => local.onAutoInstallChange(on)}
            label="Install updates automatically"
            disabled={local.autoInstallDisabled}
            class={styles.auto}
          />

          <div class={styles.footer}>
            <span class={styles.keyHint}>
              <Kbd keys={['Esc']} /> Later · <Kbd keys={[local.modKey ?? 'Ctrl', '↵']} /> Restart
            </span>
            <span class={styles.defaultRing}>
              <Button
                size="lg"
                data-autofocus
                class={styles.later}
                onClick={() => local.onLater('button')}
              >
                Later
              </Button>
            </span>
            <Button
              size="lg"
              variant="primary"
              aria-keyshortcuts={local.modKey === '⌘' ? 'Meta+Enter' : 'Control+Enter'}
              disabled={local.restarting === true}
              onClick={restart}
            >
              {local.restarting === true ? 'Restarting…' : 'Restart Now'}
            </Button>
          </div>
          <Show when={local.error}>
            {(error) => (
              <p class={styles.error} role="alert">
                {error()}
              </p>
            )}
          </Show>
          <Show when={choose.message() !== ''}>
            <p class={shared.srOnly} role="status">
              {choose.message()}
            </p>
          </Show>
        </div>
      </div>
    </div>
  );

  return (
    <Show when={presence.mounted()}>
      <Show when={local.contained === true} fallback={<Portal>{layer()}</Portal>}>
        {layer()}
      </Show>
    </Show>
  );
}
