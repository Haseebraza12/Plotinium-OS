import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import {
  createMemo,
  createSignal,
  createUniqueId,
  Match,
  Show,
  splitProps,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { IconButton } from '../../primitives/icon-button/IconButton.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import type {
  AboutModel,
  BoundTerms,
  MemoryStatus,
  NetworkModel,
  PrivacyModel,
  SettingChange,
  SettingsAction,
  SettingsSectionId,
  SettingsUser,
  SettingValues,
  StorageModel,
  UpdatesModel,
  UsersModel,
} from './models.ts';
import { AboutPane } from './panes/AboutPane.tsx';
import { AppearancePane } from './panes/AppearancePane.tsx';
import {
  DesktopDockPane,
  formatSize,
  GeneralPane,
  NetworkPane,
  StoragePane,
  UpdatesPane,
  UsersPane,
} from './panes/GeneralPanes.tsx';
import { PrivacyPane } from './panes/PrivacyPane.tsx';
import { MemoryPane, SchedulerPane } from './panes/SystemPanes.tsx';
import { sectionMeta } from './sections.ts';
import { SettingsSidebar } from './SettingsSidebar.tsx';
import styles from './SettingsView.module.css';

const SUBTITLE: Partial<Record<SettingsSectionId, string>> = {
  privacy:
    'Control what Plotinium records, what stays on this device, and what the AI agent may do.',
  memory: 'How much memory processes may hold, and where paged-out memory goes.',
  scheduler: 'How the CPU is shared between processes, and the longest any of them can wait.',
  network: 'Your connection to the Plotinium server and what syncs through it.',
};

export interface SettingsViewProps {
  /** Selected section (controlled); without it the view keeps its own, starting at `initial`. */
  section?: SettingsSectionId;
  initialSection?: SettingsSectionId;
  onSectionChange?: (id: SettingsSectionId) => void;
  user: SettingsUser;
  values: SettingValues;
  about: AboutModel;
  privacy: PrivacyModel;
  network: NetworkModel;
  users: UsersModel;
  storage: StorageModel;
  updates: UpdatesModel;
  memory: MemoryStatus;
  bound: BoundTerms;
  /** AI-off build: the section reads "Privacy" and the AI groups are hidden. */
  aiAvailable?: boolean;
  onChange: (change: SettingChange) => void;
  onAction: (action: SettingsAction) => void;
  onCopy?: (label: string, value: string) => void;
  class?: string;
}

/**
 * The Settings window content (System Settings layout, unified chrome, fixed size): the
 * sidebar with search and the user card, a toolbar with back/forward and the pane title, and
 * the pane. Pane changes crossfade with a 6 px rise; Ctrl+F searches, Ctrl+[ and Ctrl+] go
 * back and forward.
 */
export function SettingsView(props: SettingsViewProps): JSX.Element {
  const [local] = splitProps(props, [
    'section',
    'initialSection',
    'onSectionChange',
    'user',
    'values',
    'about',
    'privacy',
    'network',
    'users',
    'storage',
    'updates',
    'memory',
    'bound',
    'aiAvailable',
    'onChange',
    'onAction',
    'onCopy',
    'class',
  ]);
  const uid = createUniqueId();
  const [own, setOwn] = createSignal<SettingsSectionId>(
    untrack(() => local.initialSection) ?? 'about',
  );
  const [back, setBack] = createSignal<SettingsSectionId[]>([]);
  const [forward, setForward] = createSignal<SettingsSectionId[]>([]);
  const [query, setQuery] = createSignal('');
  let search: HTMLInputElement | undefined;

  const section = (): SettingsSectionId => local.section ?? own();
  const readOnly = (): boolean => local.user.guest === true;
  const labelOf = (id: SettingsSectionId): string =>
    id === 'privacy' && local.aiAvailable === false ? 'Privacy' : sectionMeta(id).label;
  const meta = createMemo(() => sectionMeta(section()));

  const go = (id: SettingsSectionId, record = true): void => {
    if (id === section()) return;
    if (record) {
      setBack((b) => [...b, section()]);
      setForward([]);
    }
    setOwn(id);
    local.onSectionChange?.(id);
  };
  const goBack = (): void => {
    const stack = back();
    const prev = stack[stack.length - 1];
    if (prev === undefined) return;
    setBack(stack.slice(0, -1));
    setForward((f) => [section(), ...f]);
    go(prev, false);
  };
  const goForward = (): void => {
    const [next, ...rest] = forward();
    if (next === undefined) return;
    setForward(rest);
    setBack((b) => [...b, section()]);
    go(next, false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      search?.focus();
      search?.select();
    } else if (event.key === '[') {
      event.preventDefault();
      goBack();
    } else if (event.key === ']') {
      event.preventDefault();
      goForward();
    }
  };

  return (
    <div class={cx(styles.view, local.class)} data-testid="settings" onKeyDown={onKeyDown}>
      <SettingsSidebar
        selected={section()}
        onSelect={(id) => go(id)}
        user={local.user}
        query={query()}
        onQuery={setQuery}
        badges={{ updates: local.updates.available === undefined ? 0 : 1 }}
        labels={local.aiAvailable === false ? { privacy: 'Privacy' } : undefined}
        searchRef={(el) => (search = el)}
      />
      <div class={styles.main}>
        <header class={styles.toolbar} data-pl-drag-region>
          <div class={styles.history}>
            <IconButton
              label="Back"
              icon={<ChevronLeft size={16} />}
              disabled={back().length === 0}
              aria-keyshortcuts="Control+["
              onClick={goBack}
            />
            <IconButton
              label="Forward"
              icon={<ChevronRight size={16} />}
              disabled={forward().length === 0}
              aria-keyshortcuts="Control+]"
              onClick={goForward}
            />
          </div>
          <Show keyed when={section()}>
            {(id) => (
              <div class={styles.heading}>
                <span
                  class={cx(styles.tile, styles[`tint-${sectionMeta(id).tint}`])}
                  aria-hidden="true"
                >
                  <Dynamic component={sectionMeta(id).icon} size={14} stroke-width={2.2} />
                </span>
                <h1 class={styles.title} id={`pl-set-${uid}`}>
                  {labelOf(id)}
                </h1>
              </div>
            )}
          </Show>
        </header>
        <main class={styles.content} aria-labelledby={`pl-set-${uid}`}>
          <Show keyed when={meta()}>
            {(current) => (
              <div class={cx(styles.pane, current.id === 'about' && styles.paneWide)}>
                {/* The section's description opens the pane, where it can wrap (UI-163: in the
                    toolbar it was cut off with no way to read it). */}
                <Show when={SUBTITLE[current.id]}>
                  {(text) => <p class={styles.lede}>{text()}</p>}
                </Show>
                <Switch>
                  <Match when={current.id === 'general'}>
                    <GeneralPane
                      values={local.values}
                      version={local.about.version}
                      updateSummary={
                        local.updates.available === undefined
                          ? 'Up to date'
                          : `${local.updates.available.version} available`
                      }
                      storageSummary={`${formatSize(local.storage.usedBytes)} of ${formatSize(local.storage.quotaBytes)}`}
                      readOnly={readOnly()}
                      onChange={(c) => local.onChange(c)}
                      onSection={(id) => go(id)}
                    />
                  </Match>
                  <Match when={current.id === 'appearance'}>
                    <AppearancePane values={local.values} onChange={(c) => local.onChange(c)} />
                  </Match>
                  <Match when={current.id === 'desktop'}>
                    <DesktopDockPane values={local.values} onChange={(c) => local.onChange(c)} />
                  </Match>
                  <Match when={current.id === 'memory'}>
                    <MemoryPane
                      values={local.values}
                      status={local.memory}
                      readOnly={readOnly()}
                      onChange={(c) => local.onChange(c)}
                      onAction={(a) => local.onAction(a)}
                    />
                  </Match>
                  <Match when={current.id === 'scheduler'}>
                    <SchedulerPane
                      values={local.values}
                      bound={local.bound}
                      readOnly={readOnly()}
                      onChange={(c) => local.onChange(c)}
                      onAction={(a) => local.onAction(a)}
                    />
                  </Match>
                  <Match when={current.id === 'network'}>
                    <NetworkPane
                      network={local.network}
                      values={local.values}
                      onChange={(c) => local.onChange(c)}
                      onAction={(a) => local.onAction(a)}
                      onSection={(id) => go(id)}
                    />
                  </Match>
                  <Match when={current.id === 'privacy'}>
                    <PrivacyPane
                      privacy={local.privacy}
                      syncTelemetry={local.values['telemetry.sync']}
                      requireConfirm={local.values['agent.requireConfirm']}
                      aiAvailable={local.aiAvailable}
                      onChange={(c) => local.onChange(c)}
                      onAction={(a) => local.onAction(a)}
                    />
                  </Match>
                  <Match when={current.id === 'users'}>
                    <UsersPane
                      users={local.users}
                      guest={local.user.guest}
                      onAction={(a) => local.onAction(a)}
                    />
                  </Match>
                  <Match when={current.id === 'storage'}>
                    <StoragePane storage={local.storage} onAction={(a) => local.onAction(a)} />
                  </Match>
                  <Match when={current.id === 'updates'}>
                    <UpdatesPane
                      updates={local.updates}
                      values={local.values}
                      onChange={(c) => local.onChange(c)}
                      onAction={(a) => local.onAction(a)}
                    />
                  </Match>
                  <Match when={current.id === 'about'}>
                    <AboutPane
                      about={local.about}
                      onCopy={local.onCopy}
                      onAction={(a) => local.onAction(a)}
                    />
                  </Match>
                </Switch>
                <Show when={current.id !== 'about'}>
                  <p class={styles.build}>
                    Plotinium {local.about.version} · build {local.about.build}
                  </p>
                </Show>
              </div>
            )}
          </Show>
        </main>
      </div>
    </div>
  );
}
