import AppWindow from 'lucide-solid/icons/app-window';
import Check from 'lucide-solid/icons/check';
import Copy from 'lucide-solid/icons/copy';
import Cpu from 'lucide-solid/icons/cpu';
import Database from 'lucide-solid/icons/database';
import FileText from 'lucide-solid/icons/file-text';
import ClipboardList from 'lucide-solid/icons/clipboard-list';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import Sparkles from 'lucide-solid/icons/sparkles';
import Terminal from 'lucide-solid/icons/terminal';
import UserRound from 'lucide-solid/icons/user-round';
import { createSignal, createUniqueId, For, onCleanup, Show, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { AtomLogo } from '../../../icons/index.tsx';
import { Avatar } from '../../../primitives/avatar/Avatar.tsx';
import { Button } from '../../../primitives/button/Button.tsx';
import { Dialog } from '../../../primitives/dialog/Dialog.tsx';
import { cx } from '../../../primitives/internal/cx.ts';
import type { IconComponent } from '../../../primitives/internal/icon.ts';
import type { AboutModel, SettingsAction, TeamMember } from '../models.ts';
import styles from './AboutPane.module.css';

const ROLE_ICON: Record<TeamMember['role'], IconComponent> = {
  R1: Cpu,
  R2: Database,
  R3: AppWindow,
  R4: Sparkles,
  R5: ShieldCheck,
};

const COPIED_MS = 1200;

export interface AboutPaneProps {
  about: AboutModel;
  /** Copy a value (the app writes the clipboard; the view never touches it). */
  onCopy?: (label: string, value: string) => void;
  onAction: (action: SettingsAction) => void;
}

/**
 * About (DSN-18, settings-about): the Plotinium mark, wordmark and version, the system facts as a
 * description list with copy, the team of five with their roles, System Report and Licences
 * (a dialog listing the shipped third-party software when the model carries it). The mark
 * scales in once on first show and then stays still (D-08).
 */
export function AboutPane(props: AboutPaneProps): JSX.Element {
  const [local] = splitProps(props, ['about', 'onCopy', 'onAction']);
  const uid = createUniqueId();
  const [copied, setCopied] = createSignal<string>();
  const [licencesOpen, setLicencesOpen] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const a = (): AboutModel => local.about;
  const versionText = (): string =>
    `${a().version}${a().codename === undefined ? '' : ` “${a().codename ?? ''}”`} (build ${a().build})`;

  const facts = (): { label: string; value: string; mono?: boolean }[] => [
    { label: 'Version', value: versionText() },
    { label: 'Built', value: a().builtAt },
    { label: 'Kernel', value: a().kernel, mono: true },
    { label: 'Host', value: `${a().host.browser} · ${a().host.cores} cores` },
    { label: 'Memory budget', value: a().memoryBudget },
    { label: 'Storage', value: a().storage ?? 'Storage estimate unavailable' },
    { label: 'Signed in', value: a().signedIn },
  ];

  const copy = (label: string, value: string): void => {
    local.onCopy?.(label, value);
    clearTimeout(timer);
    setCopied(label);
    setAnnouncement(`Copied ${label.toLowerCase()} to clipboard`);
    timer = setTimeout(() => setCopied(undefined), COPIED_MS);
  };

  return (
    <div class={styles.pane}>
      <div class={styles.live} role="status" aria-live="polite">
        {announcement()}
      </div>
      <header class={styles.hero}>
        <div class={styles.mark}>
          <span class={styles.glow} aria-hidden="true" />
          <AtomLogo size={120} class={styles.atom} />
        </div>
        <h2 class={styles.wordmark}>{a().name}</h2>
        <p class={styles.tagline}>{a().tagline}</p>
        <p class={styles.versionPill}>
          <span class={styles.okDot} aria-hidden="true" />
          Version {versionText()} · {a().updateStatus}
        </p>
      </header>

      <div class={styles.columns}>
        <section class={styles.column} aria-labelledby={`pl-about-sys-${uid}`}>
          <h3 class={styles.caption} id={`pl-about-sys-${uid}`}>
            System
          </h3>
          <dl class={styles.card}>
            <For each={facts()}>
              {(fact, index) => (
                <div
                  class={styles.fact}
                  style={{ '--pl-stagger-index': String(index()) }}
                  onClick={() => copy(fact.label, fact.value)}
                >
                  <dt class={styles.factLabel}>{fact.label}</dt>
                  <dd class={cx(styles.factValue, fact.mono === true && styles.mono)}>
                    <span class={styles.factText}>{fact.value}</span>
                    <button
                      type="button"
                      class={styles.copy}
                      aria-label={`Copy ${fact.label.toLowerCase()}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        copy(fact.label, fact.value);
                      }}
                    >
                      <Show
                        when={copied() === fact.label}
                        fallback={<Copy size={13} aria-hidden="true" />}
                      >
                        <span class={styles.copied}>
                          <Check size={12} aria-hidden="true" /> Copied
                        </span>
                      </Show>
                    </button>
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </section>

        <section class={styles.column} aria-labelledby={`pl-about-team-${uid}`}>
          <h3 class={styles.caption} id={`pl-about-team-${uid}`}>
            Team
          </h3>
          <ul class={styles.card} role="list">
            <For each={a().team}>
              {(member, index) => (
                <li class={styles.member} style={{ '--pl-stagger-index': String(index() + 2) }}>
                  <Show
                    when={member.name}
                    fallback={
                      // A placeholder member has no initials to show (UI-143: every avatar read R).
                      <span class={styles.tbdAvatar} aria-hidden="true">
                        <UserRound size={13} />
                      </span>
                    }
                  >
                    {(name) => <Avatar name={name()} size="sm" decorative />}
                  </Show>
                  <span class={styles.memberText}>
                    <span class={cx(styles.memberName, member.name === undefined && styles.tbd)}>
                      {member.name ?? 'Member to be announced'}
                    </span>
                    <span class={styles.memberRole}>
                      {member.role} · {member.title}
                    </span>
                  </span>
                  <span class={cx(styles.roleChip, styles[`role-${member.role}`])}>
                    <Dynamic component={ROLE_ICON[member.role]} size={12} aria-hidden="true" />
                    {member.area}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </div>

      <div class={styles.actions}>
        <Button
          icon={<ClipboardList size={14} />}
          aria-haspopup="dialog"
          onClick={() => local.onAction('about.systemReport')}
        >
          System Report…
        </Button>
        <Button
          icon={<FileText size={14} />}
          aria-haspopup={a().licences === undefined ? undefined : 'dialog'}
          onClick={() => {
            if (a().licences === undefined) local.onAction('about.licences');
            else setLicencesOpen(true);
          }}
        >
          Licences
        </Button>
        <Button icon={<Terminal size={14} />} onClick={() => local.onAction('about.copyUname')}>
          Copy uname
        </Button>
      </div>
      <footer class={styles.footer}>
        <For each={a().footer}>{(line) => <p>{line}</p>}</For>
      </footer>
      <Dialog
        open={licencesOpen()}
        size="md"
        title="Third-party software"
        description="Plotinium ships these components under their own licences."
        icon={<FileText size={26} />}
        onClose={() => setLicencesOpen(false)}
        actions={
          <Button variant="primary" data-autofocus onClick={() => setLicencesOpen(false)}>
            Done
          </Button>
        }
      >
        <table class={styles.licences}>
          <caption class={styles.live}>Third-party software and licences</caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Licence</th>
              <th scope="col">Used for</th>
            </tr>
          </thead>
          <tbody>
            <For each={a().licences ?? []}>
              {(notice) => (
                <tr>
                  <td>{notice.name}</td>
                  <td class={styles.licenceId}>{notice.licence}</td>
                  <td>{notice.use}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <p class={styles.licenceNote}>
          Versions and the full licence texts are in THIRD_PARTY.md in the Plotinium source.
        </p>
      </Dialog>
    </div>
  );
}
