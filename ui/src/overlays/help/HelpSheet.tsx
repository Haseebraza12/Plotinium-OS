import { For, Show, splitProps, type JSX } from 'solid-js';

import { AppIcon, type IconId } from '../../icons/index.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { Dialog } from '../../primitives/dialog/Dialog.tsx';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import styles from './Help.module.css';

/** One command and its keys (["Alt", "O"]). */
export interface ShortcutRow {
  id: string;
  label: string;
  keys: readonly string[];
}

/** A titled list of shortcuts ("Windows", "Desktop", "File"). */
export interface ShortcutGroup {
  id: string;
  title: string;
  rows: readonly ShortcutRow[];
}

export interface HelpSheetProps {
  open: boolean;
  onClose: () => void;
  /** "Keyboard Shortcuts", "Files Help". */
  title: string;
  /** One or two sentences under the title. */
  intro?: string;
  /** The app's icon in the header (app help). */
  app?: IconId;
  groups: readonly ShortcutGroup[];
  /** Shown when there are no groups ("Files has no keyboard shortcuts of its own."). */
  empty?: string;
  /** A second action next to Done, e.g. "All Keyboard Shortcuts". */
  secondary?: { label: string; onSelect: () => void };
}

/**
 * The shell's help sheet (UI-077): "<App> Help" lists what the app's menus can do from the
 * keyboard, "Keyboard Shortcuts" lists the desktop's own keys (window-manager.md §3.9). A modal
 * dialog: focus moves in, Escape or Done closes it and focus returns to where it was.
 */
export function HelpSheet(props: HelpSheetProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'title',
    'intro',
    'app',
    'groups',
    'empty',
    'secondary',
  ]);
  return (
    <Dialog
      open={local.open}
      onClose={() => local.onClose()}
      title={local.title}
      {...(local.intro === undefined ? {} : { description: local.intro })}
      {...(local.app === undefined
        ? {}
        : { icon: <AppIcon app={local.app} size={40} class={styles.icon} /> })}
      actions={
        <>
          <Show when={local.secondary}>
            {(secondary) => (
              <Button
                onClick={() => {
                  secondary().onSelect();
                }}
              >
                {secondary().label}
              </Button>
            )}
          </Show>
          <Button variant="primary" data-autofocus onClick={() => local.onClose()}>
            Done
          </Button>
        </>
      }
    >
      <Show
        when={local.groups.length > 0}
        fallback={<p class={styles.empty}>{local.empty ?? 'No keyboard shortcuts.'}</p>}
      >
        <div class={styles.groups}>
          <For each={local.groups}>
            {(group) => (
              <section class={styles.group} aria-labelledby={`pl-help-${group.id}`}>
                <h3 class={styles.groupTitle} id={`pl-help-${group.id}`}>
                  {group.title}
                </h3>
                <dl class={styles.rows}>
                  <For each={group.rows}>
                    {(row) => (
                      <div class={styles.row}>
                        <dt class={styles.label}>{row.label}</dt>
                        <dd class={styles.keys}>
                          <Kbd keys={row.keys} />
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
        </div>
      </Show>
    </Dialog>
  );
}

export interface AboutAppDialogProps {
  open: boolean;
  onClose: () => void;
  app: IconId;
  /** "Files". */
  name: string;
  /** "0.3.0". */
  version: string;
  /** "a1f93c2". */
  build: string;
  /** "Part of Plotinium." */
  detail?: string;
}

/** "About <App>" (UI-076): the app's icon, name and the build it ships with. */
export function AboutAppDialog(props: AboutAppDialogProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'app',
    'name',
    'version',
    'build',
    'detail',
  ]);
  return (
    <Dialog
      open={local.open}
      onClose={() => local.onClose()}
      size="sm"
      centered
      title={local.name}
      icon={<AppIcon app={local.app} size={64} class={styles.aboutIcon} />}
      description={
        <>
          <span class={styles.version}>
            Version {local.version} · build {local.build}
          </span>
          <Show when={local.detail}>
            {(detail) => <span class={styles.detail}>{detail()}</span>}
          </Show>
        </>
      }
      actions={
        <Button variant="primary" data-autofocus onClick={() => local.onClose()}>
          OK
        </Button>
      }
    />
  );
}
