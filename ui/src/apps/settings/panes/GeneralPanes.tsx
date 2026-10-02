import CloudOff from 'lucide-solid/icons/cloud-off';
import Download from 'lucide-solid/icons/download';
import HardDrive from 'lucide-solid/icons/hard-drive';
import Info from 'lucide-solid/icons/info';
import KeyRound from 'lucide-solid/icons/key-round';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Rocket from 'lucide-solid/icons/rocket';
import Trash2 from 'lucide-solid/icons/trash-2';
import UserLock from 'lucide-solid/icons/user-lock';
import UserRoundPlus from 'lucide-solid/icons/user-round-plus';
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { Avatar } from '../../../primitives/avatar/Avatar.tsx';
import { Pill, type Tone } from '../../../primitives/badge/Badge.tsx';
import { Button } from '../../../primitives/button/Button.tsx';
import { cx } from '../../../primitives/internal/cx.ts';
import { ProgressBar } from '../../../primitives/progress/ProgressBar.tsx';
import { TextField } from '../../../primitives/text-field/TextField.tsx';
import { Tooltip } from '../../../primitives/tooltip/Tooltip.tsx';
import { unavailableNote } from '../availability.ts';
import {
  Banner,
  Group,
  NavRow,
  Row,
  SelectRow,
  SliderRow,
  ToggleRow,
  ValueRow,
} from '../controls.tsx';
import type {
  NetworkModel,
  SettingChange,
  SettingsAction,
  SettingsSectionId,
  SettingValues,
  StorageModel,
  UpdatesModel,
  UsersModel,
} from '../models.ts';
import styles from './GeneralPanes.module.css';

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

export function formatSize(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MB`;
  return `${Math.round(bytes / KIB)} KB`;
}

// ---------------------------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------------------------

export interface GeneralPaneProps {
  values: Pick<
    SettingValues,
    | 'general.deviceName'
    | 'general.language'
    | 'general.clock24h'
    | 'boot.menuNextBoot'
    | 'boot.verbose'
  >;
  version: string;
  updateSummary: string;
  storageSummary: string;
  readOnly?: boolean;
  onChange: (change: SettingChange) => void;
  onSection: (id: SettingsSectionId) => void;
}

/** General: device name, the About/Storage/Updates shortcuts, language and time, startup. */
export function GeneralPane(props: GeneralPaneProps): JSX.Element {
  const [local] = splitProps(props, [
    'values',
    'version',
    'updateSummary',
    'storageSummary',
    'readOnly',
    'onChange',
    'onSection',
  ]);
  const [name, setName] = createSignal('');
  const [nameError, setNameError] = createSignal<string>();
  createEffect(() => setName(local.values['general.deviceName']));
  const nameNote = (): string | undefined => unavailableNote('general.deviceName');
  const commitName = (): void => {
    const next = name().trim();
    // UI-163: an empty name is refused and the saved one comes back, with a reason.
    if (next === '') {
      setName(local.values['general.deviceName']);
      setNameError('The device needs a name. The previous name was kept.');
      return;
    }
    setNameError(undefined);
    if (next !== local.values['general.deviceName'])
      local.onChange({ key: 'general.deviceName', value: next });
  };
  return (
    <div class={styles.pane}>
      <Group title="This device" index={0}>
        <Row
          title="Name"
          description={nameNote()}
          hideTextFromAT={nameNote() === undefined}
          control={
            <TextField
              label="Device name"
              hideLabel
              value={name()}
              disabled={nameNote() !== undefined}
              error={nameError()}
              onInput={setName}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitName();
              }}
              class={styles.nameField}
            />
          }
        />
        <NavRow
          title="About"
          value={`Plotinium ${local.version}`}
          icon={<Info size={14} />}
          onClick={() => local.onSection('about')}
        />
        <NavRow
          title="Storage"
          value={local.storageSummary}
          icon={<HardDrive size={14} />}
          onClick={() => local.onSection('storage')}
        />
        <NavRow
          title="Updates"
          value={local.updateSummary}
          icon={<Download size={14} />}
          onClick={() => local.onSection('updates')}
        />
      </Group>
      <Group title="Language & time" index={1}>
        <SelectRow
          label="Language"
          value={local.values['general.language']}
          options={[
            { value: 'en-GB', label: 'English (UK)' },
            { value: 'en-US', label: 'English (US)' },
            { value: 'ur-PK', label: 'اردو (Urdu)' },
          ]}
          unavailable={unavailableNote('general.language')}
          onChange={(value) => local.onChange({ key: 'general.language', value })}
        />
        <ToggleRow
          label="24-hour time"
          description="The menu bar clock and file times."
          checked={local.values['general.clock24h']}
          onChange={(value) => local.onChange({ key: 'general.clock24h', value })}
        />
      </Group>
      <Group title="Startup" index={2}>
        <ToggleRow
          label="Show the boot menu on next boot"
          description="Once only: Normal, Safe mode, Verbose or Recovery."
          checked={local.values['boot.menuNextBoot']}
          disabled={local.readOnly}
          onChange={(value) => local.onChange({ key: 'boot.menuNextBoot', value })}
        />
        <ToggleRow
          label="Verbose boot by default"
          description="Show the service log instead of the splash."
          checked={local.values['boot.verbose']}
          disabled={local.readOnly}
          onChange={(value) => local.onChange({ key: 'boot.verbose', value })}
        />
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Desktop & Dock
// ---------------------------------------------------------------------------------------------

export interface DesktopDockPaneProps {
  values: Pick<
    SettingValues,
    | 'dock.size'
    | 'dock.magnification'
    | 'dock.magnificationScale'
    | 'dock.autohide'
    | 'dock.showIndicators'
    | 'dock.showSuggestions'
    | 'dock.minimiseEffect'
    | 'windows.doubleClickTitle'
  >;
  onChange: (change: SettingChange) => void;
}

/** Desktop & Dock: dock size and magnification, hiding, indicators, windows. */
export function DesktopDockPane(props: DesktopDockPaneProps): JSX.Element {
  const [local] = splitProps(props, ['values', 'onChange']);
  const [size, setSize] = createSignal(52);
  const [scale, setScale] = createSignal(1.45);
  createEffect(() => setSize(local.values['dock.size']));
  createEffect(() => setScale(local.values['dock.magnificationScale']));
  return (
    <div class={styles.pane}>
      <Group title="Dock" index={0}>
        <SliderRow
          label="Size"
          value={size()}
          min={40}
          max={80}
          format={(v) => `${v} px`}
          onInput={setSize}
          onCommit={(value) => local.onChange({ key: 'dock.size', value })}
        />
        <ToggleRow
          label="Magnification"
          description="Icons grow under the pointer. Off when motion is reduced."
          checked={local.values['dock.magnification']}
          onChange={(value) => local.onChange({ key: 'dock.magnification', value })}
        />
        <SliderRow
          label="Magnified size"
          value={scale()}
          min={1.1}
          max={1.8}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          disabled={!local.values['dock.magnification']}
          onInput={setScale}
          onCommit={(value) => local.onChange({ key: 'dock.magnificationScale', value })}
        />
        <SelectRow
          label="Minimise windows using"
          value={local.values['dock.minimiseEffect']}
          options={[
            { value: 'genie', label: 'Genie effect' },
            { value: 'scale', label: 'Scale effect' },
          ]}
          onChange={(value) => local.onChange({ key: 'dock.minimiseEffect', value })}
        />
        <ToggleRow
          label="Automatically hide and show the Dock"
          checked={local.values['dock.autohide']}
          onChange={(value) => local.onChange({ key: 'dock.autohide', value })}
        />
        <ToggleRow
          label="Show indicators for open apps"
          checked={local.values['dock.showIndicators']}
          onChange={(value) => local.onChange({ key: 'dock.showIndicators', value })}
        />
        <ToggleRow
          label="Show suggested apps in the Dock"
          description="From Predictions; suggestions never launch anything by themselves."
          unavailable={unavailableNote('dock.showSuggestions')}
          checked={local.values['dock.showSuggestions']}
          onChange={(value) => local.onChange({ key: 'dock.showSuggestions', value })}
        />
      </Group>
      <Group title="Windows" index={1}>
        <SelectRow
          label="Double-click a window’s title bar to"
          value={local.values['windows.doubleClickTitle']}
          options={[
            { value: 'zoom', label: 'Zoom' },
            { value: 'minimise', label: 'Minimise' },
          ]}
          onChange={(value) => local.onChange({ key: 'windows.doubleClickTitle', value })}
        />
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Network & Sync
// ---------------------------------------------------------------------------------------------

const NET: Record<NetworkModel['status'], { tone: Tone; label: (m: NetworkModel) => string }> = {
  online: { tone: 'success', label: () => 'Online' },
  degraded: { tone: 'warning', label: () => 'Sync unavailable' },
  syncing: { tone: 'info', label: (m) => `Syncing ${m.queued} ${m.queued === 1 ? 'op' : 'ops'}` },
  offline: { tone: 'warning', label: (m) => `Offline · ${m.queued} queued` },
  auth: { tone: 'warning', label: () => 'Sign in to sync' },
};

/**
 * The Status row's description. Before the server has acknowledged anything from this device
 * the model says `lastSync: 'never'`; "Last synced never" beside a green Online and the
 * "Everything is synced" notice contradicted itself (UI-141), so say what is true instead.
 */
export function networkDescription(n: NetworkModel): string {
  if (n.status === 'offline') return 'Changes are queued and replay when the connection returns.';
  if (n.lastSync === 'never') {
    switch (n.status) {
      case 'online':
        return 'Connected. Nothing from this device has needed syncing yet.';
      case 'syncing':
        return 'Sending the first changes from this device.';
      case 'degraded':
        return 'Nothing has synced: the sync service is not running.';
      case 'auth':
        return 'Sign in again to sync changes from this device.';
    }
  }
  return `Last synced ${n.lastSync}${n.latencyMs === undefined ? '' : ` · ${n.latencyMs} ms`}`;
}

export interface NetworkPaneProps {
  network: NetworkModel;
  values: Pick<SettingValues, 'sync.files' | 'sync.swapWriteBehind' | 'telemetry.sync'>;
  onChange: (change: SettingChange) => void;
  onAction: (action: SettingsAction) => void;
  onSection: (id: SettingsSectionId) => void;
}

/** Network & Sync: connection state, the server, file sync and swap write-behind. */
export function NetworkPane(props: NetworkPaneProps): JSX.Element {
  const [local] = splitProps(props, ['network', 'values', 'onChange', 'onAction', 'onSection']);
  const n = (): NetworkModel => local.network;
  return (
    <div class={styles.pane}>
      <Group title="Connection" index={0}>
        <Row
          title="Status"
          description={networkDescription(n())}
          control={
            <>
              <Pill
                tone={NET[n().status].tone}
                dot
                icon={n().status === 'offline' ? <CloudOff size={11} /> : undefined}
              >
                {NET[n().status].label(n())}
              </Pill>
              <Button
                size="sm"
                icon={<RefreshCw size={13} />}
                disabled={n().status === 'offline'}
                onClick={() => local.onAction('sync.now')}
              >
                Sync now
              </Button>
            </>
          }
        />
        <ValueRow title="Server" value={n().server} mono />
      </Group>
      <Group title="Sync" index={1}>
        <ToggleRow
          label="Sync files"
          description="Your home folder syncs to the server; offline edits replay in order."
          unavailable={unavailableNote('sync.files')}
          checked={local.values['sync.files']}
          onChange={(value) => local.onChange({ key: 'sync.files', value })}
        />
        <ToggleRow
          label="Write paged-out memory to the server"
          description="Write-behind swap: every page-out is also uploaded, so a session can restore anywhere."
          unavailable={unavailableNote('sync.swapWriteBehind')}
          checked={local.values['sync.swapWriteBehind']}
          onChange={(value) => local.onChange({ key: 'sync.swapWriteBehind', value })}
        />
        <NavRow
          title="Telemetry sync"
          value={local.values['telemetry.sync'] ? 'On' : 'Off'}
          onClick={() => local.onSection('privacy')}
        />
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Users & Groups
// ---------------------------------------------------------------------------------------------

export interface UsersPaneProps {
  users: UsersModel;
  guest?: boolean;
  onAction: (action: SettingsAction) => void;
}

/** Why the account buttons are disabled: no account call reaches the server from Settings. */
export const ACCOUNTS_NOTE =
  'Accounts are changed on the Plotinium server. This build cannot change them from Settings yet.';

/** Users & Groups: accounts with their role and groups, password and device actions. */
export function UsersPane(props: UsersPaneProps): JSX.Element {
  const [local] = splitProps(props, ['users', 'guest', 'onAction']);
  const uid = createUniqueId();
  const noteId = `pl-users-note-${uid}`;
  // UI-146: every account action only explained that it is not possible, so they are disabled
  // with that reason (the buttons stay focusable and are described by it).
  const addButton = (): JSX.Element => (
    <Button
      size="sm"
      icon={<UserRoundPlus size={13} />}
      disabled
      aria-describedby={noteId}
      onClick={() => local.onAction('users.add')}
    >
      Add user…
    </Button>
  );
  return (
    <div class={styles.pane}>
      <Show when={local.guest === true}>
        <Banner tone="warning" icon={<UserLock size={14} />}>
          Guest session: nothing you change here is kept.
        </Banner>
      </Show>
      <Group
        title="Users"
        index={0}
        footer={
          <>
            <span>Accounts live on the server; this device keeps an offline verifier.</span>
            <Tooltip
              content={local.users.canAdmin ? ACCOUNTS_NOTE : 'Only an administrator can add users'}
            >
              {addButton()}
            </Tooltip>
          </>
        }
      >
        <For each={local.users.users}>
          {(user) => (
            <Row
              title={
                <span class={styles.user}>
                  <Avatar name={user.name} size="sm" decorative />
                  <span class={styles.userText}>
                    <span>{user.name}</span>
                    <span class={styles.userMeta}>
                      {user.role === 'admin'
                        ? 'Administrator'
                        : user.role === 'guest'
                          ? 'Guest'
                          : 'Standard'}{' '}
                      · uid {user.uid} · {user.groups.join(', ')}
                    </span>
                  </span>
                </span>
              }
              control={
                <Show when={user.current === true}>
                  <Pill tone="accent">You</Pill>
                </Show>
              }
            />
          )}
        </For>
      </Group>
      <Group title="Groups" index={1}>
        <For each={local.users.groups}>
          {(group) => (
            <Row
              title={group.name}
              description={`gid ${group.gid}`}
              control={<span class={styles.members}>{group.members.join(', ')}</span>}
            />
          )}
        </For>
      </Group>
      <div class={styles.footerActions}>
        <p class={styles.footerNote} id={noteId}>
          {ACCOUNTS_NOTE}
        </p>
        <Button
          size="sm"
          icon={<KeyRound size={13} />}
          disabled
          aria-describedby={noteId}
          onClick={() => local.onAction('users.changePassword')}
        >
          Change password…
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled
          aria-describedby={noteId}
          onClick={() => local.onAction('users.forgetDevice')}
        >
          Forget this device
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

export interface StoragePaneProps {
  storage: StorageModel;
  onAction: (action: SettingsAction) => void;
}

/** Storage: the origin quota by category, the cloud tier and the Trash. */
export function StoragePane(props: StoragePaneProps): JSX.Element {
  const [local] = splitProps(props, ['storage', 'onAction']);
  const s = (): StorageModel => local.storage;
  const share = (bytes: number): number => Math.min(1, bytes / Math.max(1, s().quotaBytes));
  return (
    <div class={styles.pane}>
      <Group title="This device" index={0}>
        <div class={styles.storageHead}>
          <p class={styles.storageFigure}>
            <strong>{formatSize(s().usedBytes)}</strong> of {formatSize(s().quotaBytes)} used
          </p>
          <div
            class={styles.stack}
            role="meter"
            aria-label="Storage used"
            aria-valuemin={0}
            aria-valuemax={Math.round(s().quotaBytes / MIB)}
            aria-valuenow={Math.round(s().usedBytes / MIB)}
            aria-valuetext={`${formatSize(s().usedBytes)} of ${formatSize(s().quotaBytes)} used`}
          >
            <For each={s().categories}>
              {(category) => (
                <span
                  class={cx(styles.stackPart, styles[`tint-${category.tint}`])}
                  style={{ 'flex-grow': String(share(category.bytes)) }}
                />
              )}
            </For>
            <span
              class={styles.stackFree}
              style={{ 'flex-grow': String(1 - share(s().usedBytes)) }}
            />
          </div>
          <ul class={styles.legend} role="list">
            <For each={s().categories}>
              {(category) => (
                <li>
                  <span
                    class={cx(styles.legendDot, styles[`tint-${category.tint}`])}
                    aria-hidden="true"
                  />
                  {category.label} <strong>{formatSize(category.bytes)}</strong>
                </li>
              )}
            </For>
          </ul>
        </div>
        <Row
          title="Trash"
          description="Items in the Trash still count against the quota."
          control={
            <>
              <span class={styles.members}>{formatSize(s().trashBytes)}</span>
              <Button
                size="sm"
                icon={<Trash2 size={13} />}
                disabled={s().trashBytes === 0}
                onClick={() => local.onAction('storage.emptyTrash')}
              >
                Empty Trash
              </Button>
            </>
          }
        />
      </Group>
      <Group title="Cloud" index={1}>
        <Row
          title="Server storage"
          description="Synced files and remote swap."
          control={
            <span class={styles.members}>
              {formatSize(s().cloudBytes)} of {formatSize(s().cloudQuotaBytes)}
            </span>
          }
        >
          <ProgressBar
            label="Server storage used"
            hideLabel
            size="sm"
            value={s().cloudBytes}
            max={s().cloudQuotaBytes}
            valueText={`${formatSize(s().cloudBytes)} of ${formatSize(s().cloudQuotaBytes)}`}
          />
        </Row>
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------

export interface UpdatesPaneProps {
  updates: UpdatesModel;
  values: Pick<SettingValues, 'updates.auto' | 'updates.channel'>;
  onChange: (change: SettingChange) => void;
  onAction: (action: SettingsAction) => void;
}

/** Updates: the available release with its notes, restart to update, channel and checking. */
export function UpdatesPane(props: UpdatesPaneProps): JSX.Element {
  const [local] = splitProps(props, ['updates', 'values', 'onChange', 'onAction']);
  const uid = createUniqueId();
  const u = (): UpdatesModel => local.updates;
  return (
    <div class={styles.pane}>
      <Show
        when={u().available}
        fallback={
          <div class={styles.upToDate}>
            <Rocket size={28} aria-hidden="true" class={styles.rocket} />
            {/* UI-141: "up to date" only when a check could run; an error says it could not. */}
            <Show
              when={u().state !== 'error'}
              fallback={
                <>
                  <p class={styles.updateTitle}>Plotinium {u().current}</p>
                  <p class={styles.updateMeta}>Updates cannot be checked right now</p>
                </>
              }
            >
              <p class={styles.updateTitle}>Plotinium {u().current} is up to date</p>
              <p class={styles.updateMeta}>Last checked {u().lastChecked}</p>
            </Show>
          </div>
        }
      >
        {(available) => (
          <section class={styles.updateCard} aria-labelledby={`pl-upd-${uid}`}>
            <div class={styles.updateHead}>
              <span class={styles.updateIcon} aria-hidden="true">
                <Download size={18} />
              </span>
              <div class={styles.updateText}>
                <h2 class={styles.updateTitle} id={`pl-upd-${uid}`}>
                  Plotinium {available().version} is available
                </h2>
                <p class={styles.updateMeta}>
                  {formatSize(available().sizeBytes)} · released {available().releasedOn} · you have{' '}
                  {u().current}
                </p>
              </div>
              <Button
                variant="primary"
                disabled={u().state === 'downloading'}
                onClick={() => local.onAction('updates.install')}
              >
                {u().state === 'ready'
                  ? 'Restart to update'
                  : u().state === 'downloading'
                    ? 'Downloading…'
                    : 'Update now'}
              </Button>
            </div>
            <Show when={u().state === 'downloading'}>
              <ProgressBar
                label="Downloading update"
                size="sm"
                value={u().progress ?? 0}
                max={1}
                valueText={`${Math.round((u().progress ?? 0) * 100)}% downloaded`}
                showValue
              />
            </Show>
            <ul class={styles.notes}>
              <For each={available().notes}>{(note) => <li>{note}</li>}</For>
            </ul>
          </section>
        )}
      </Show>
      <Show when={u().error}>{(error) => <Banner tone="danger">{error()}</Banner>}</Show>
      <Group title="Settings" index={1}>
        <ToggleRow
          label="Install updates automatically"
          description="Updates download in the background and apply at the next restart."
          unavailable={unavailableNote('updates.auto')}
          checked={local.values['updates.auto']}
          onChange={(value) => local.onChange({ key: 'updates.auto', value })}
        />
        <SelectRow
          label="Channel"
          value={local.values['updates.channel']}
          options={[
            { value: 'stable', label: 'Stable' },
            { value: 'beta', label: 'Beta' },
          ]}
          unavailable={unavailableNote('updates.channel')}
          onChange={(value) => local.onChange({ key: 'updates.channel', value })}
        />
      </Group>
      <div class={styles.footerActions}>
        <Button
          size="sm"
          icon={<RefreshCw size={13} />}
          disabled={u().state === 'checking'}
          onClick={() => local.onAction('updates.check')}
        >
          {u().state === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>
    </div>
  );
}
