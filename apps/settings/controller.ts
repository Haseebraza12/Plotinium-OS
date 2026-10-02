/**
 * The Settings app's model and intents (ui-design-system.md §3.8.14; MEM-01, PROC-03, PRE-05,
 * BOOT-06). Framework-free, so it is testable against a fake system-call client.
 *
 * Reads: `proc.cred`, `sysctl.get`, `mem.stat`, `proc.list`, `uname`, `statfs`, `quota`,
 * `users.list`, `net.status`, and with AI: `ai.telemetry.export` (the events the Privacy pane
 * lists), `ai.predict`, `ai.index.status`, `ai.agent.log`. Writes: `sysctl.set` for kernel
 * parameters, the desktop preferences for the rest, `ai.telemetry.optin`/`clear`/`export`.
 *
 * PRE-05: nothing here calls `ai.telemetry.optin` unless the user turns sync on or off, and the
 * preference changes only after the kernel accepted the new consent.
 */
import type {
  AuditRecord,
  IndexStatus,
  KEvent,
  NetStatus,
  ProcInfo,
  Quota,
  RetOf,
  StatFs,
  TelemetryEvent as KernelTelemetryEvent,
  UnameInfo,
} from '@plotinium/protocol';
import type {
  AboutModel,
  BoundTerms,
  MemoryStatus,
  NetworkModel,
  PrivacyModel,
  SettingChange,
  SettingsAction,
  SettingsUser,
  SettingValues,
  StorageModel,
  UpdatesModel,
  UsersModel,
} from '@plotinium/ui/apps/settings';

import { systemReport, toAboutModel, unameLine } from '../about/model.ts';
import { findProcess } from '../taskmgr/model.ts';
import type { AppAgentBudget, AppEnv, AppSys } from '../src/descriptor.ts';
import { describeFailure, trySys } from '../src/descriptor.ts';
import {
  boundTerms,
  exportFileName,
  formatWhen,
  GUEST_UID,
  isPrefSetting,
  isSysctlSetting,
  MIB,
  parseTelemetry,
  SETTING_LABEL,
  SYSCTL_BINDINGS,
  SYSCTL_DEFAULTS,
  type SysctlSettingKey,
  sysctlKeyFor,
  toNetworkModel,
  toPrivacyModel,
  toStorageModel,
  toUpdatesModel,
  toUsersModel,
  valuesFromPrefs,
  valuesFromSysctl,
} from './model.ts';

/** Rows the Privacy pane lists before "View all…" (predictive-prefetch.md §3.3). */
export const TELEMETRY_ROWS = 25;
export const TELEMETRY_ROWS_ALL = 500;

export const SETTINGS_TOPICS: readonly string[] = [
  'update.available',
  'net.state',
  'mem.pressure',
  'ai.index.progress',
  'ai.model',
];

type Scalar = string | number | boolean;

/** Shown by Updates when the kernel reports the update service degraded (UI-141). */
export const UPDATE_SERVICE_DOWN =
  'The update service is not running, so Plotinium cannot check for updates right now.';

/** Verbose boot is a per-boot choice of the boot router, not a kernel parameter (yet). */
export const VERBOSE_BOOT_HINT =
  'Verbose boot is chosen for each boot: press V while the atom logo is shown, or open Plotinium with ?boot=verbose.';

export interface SettingsSnapshot {
  readonly user: SettingsUser;
  readonly values: SettingValues;
  readonly about: AboutModel;
  readonly privacy: PrivacyModel;
  readonly network: NetworkModel;
  readonly users: UsersModel;
  readonly storage: StorageModel;
  readonly updates: UpdatesModel;
  readonly memory: MemoryStatus;
  readonly bound: BoundTerms;
  readonly aiAvailable: boolean;
  readonly loading: boolean;
  readonly notice?: { readonly level: 'info' | 'error'; readonly text: string };
}

export interface SettingsDeps {
  readonly sys: AppSys;
  readonly env: AppEnv;
  readonly now: () => number;
  /** The server this desktop syncs with ("plotinium.example.org"). */
  readonly server: string;
  /** Hands a file to the user when `writeFile` is unavailable (a browser download). */
  readonly download?: (name: string, data: ArrayBuffer, type: string) => void;
  readonly copy?: (text: string) => Promise<boolean>;
  readonly launch?: (app: string, argv?: readonly string[]) => void;
}

type Listener = (snap: SettingsSnapshot) => void;

const decoder = new TextDecoder();

export class SettingsController {
  private readonly deps: SettingsDeps;
  private readonly listeners = new Set<Listener>();
  private readonly offPrefs: () => void;

  private sysctl: Record<string, Scalar> = {};
  private kernelValues: Pick<SettingValues, SysctlSettingKey> = { ...SYSCTL_DEFAULTS };
  private cred: { uid: number; name: string; home: string } | null = null;
  private uname: UnameInfo | null = null;
  private memUsed = 0;
  private budgetBytes: number | null = null;
  private procs: ProcInfo[] = [];
  private statfs: StatFs | null = null;
  private quota: Quota | null = null;
  private usersList: RetOf<'users.list'> | null = null;
  private net: NetStatus | null = null;
  private events: KernelTelemetryEvent[] = [];
  private exportBytes = 0;
  private telemetryError: string | undefined;
  private rowLimit = TELEMETRY_ROWS;
  private exporting = false;
  private optinPending = false;
  private predictor: { model: string; launches: number } | null = null;
  private index: IndexStatus | null = null;
  private indexError: string | undefined;
  private audit: AuditRecord[] = [];
  private budget: AppAgentBudget | null = null;
  private update: { version: string; build: string } | null = null;
  private lastChecked = 'at startup';
  private updateState: UpdatesModel['state'] = 'idle';
  private updateError: string | undefined;
  private notice: SettingsSnapshot['notice'];
  private loading = true;
  private snap: SettingsSnapshot;

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.snap = this.build();
    this.offPrefs = deps.env.prefs.subscribe(() => {
      this.emit();
    });
  }

  snapshot(): SettingsSnapshot {
    return this.snap;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  dispose(): void {
    this.offPrefs();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  async load(): Promise<void> {
    const { sys, env } = this.deps;
    const ai = env.aiAvailable;
    const [cred, sysctl, stat, procs, uname, statfs, quota, users, net] = await Promise.all([
      trySys(sys, 'proc.cred', {}),
      trySys(sys, 'sysctl.get', {}),
      trySys(sys, 'mem.stat', {}),
      trySys(sys, 'proc.list', {}),
      trySys(sys, 'uname', {}),
      trySys(sys, 'statfs', {}),
      trySys(sys, 'quota', {}),
      trySys(sys, 'users.list', {}),
      trySys(sys, 'net.status', {}),
    ]);
    if (cred.ok) this.cred = { uid: cred.value.uid, name: cred.value.user, home: cred.value.home };
    if (sysctl.ok) this.ingestSysctl(sysctl.value.values);
    if (stat.ok) {
      this.memUsed = stat.value.accounted;
      this.budgetBytes = stat.value.budget;
    }
    if (procs.ok) {
      this.procs = procs.value.procs;
      if (!stat.ok) this.memUsed = this.procs.reduce((n, p) => n + p.residentBytes, 0);
    }
    if (uname.ok) this.uname = uname.value;
    if (statfs.ok) this.statfs = statfs.value;
    if (quota.ok) this.quota = quota.value;
    if (users.ok) this.usersList = users.value;
    if (net.ok) this.net = net.value;
    if (ai) {
      await Promise.all([this.loadTelemetry(), this.loadAi()]);
    }
    this.budget = (await env.agentBudget?.().catch(() => null)) ?? null;
    this.loading = false;
    this.emit();
  }

  private ingestSysctl(values: Readonly<Record<string, Scalar>>): void {
    this.sysctl = { ...values };
    this.kernelValues = valuesFromSysctl(values);
    this.budgetBytes ??= this.kernelValues['mm.budgetMB'] * MIB;
  }

  /** The Privacy pane's list: exported JSON Lines, parsed here (the view never sees raw bytes). */
  async loadTelemetry(): Promise<void> {
    const [exp, predict] = await Promise.all([
      trySys(this.deps.sys, 'ai.telemetry.export', {}),
      trySys(this.deps.sys, 'ai.predict', { k: 3 }),
    ]);
    if (exp.ok) {
      this.exportBytes = exp.value.byteLength;
      this.events = parseTelemetry(decoder.decode(new Uint8Array(exp.value)));
      this.telemetryError = undefined;
    } else {
      this.events = [];
      this.exportBytes = 0;
      this.telemetryError = `Telemetry is unavailable: ${exp.message}`;
    }
    this.predictor = predict.ok
      ? { model: predict.value.model, launches: predict.value.launches }
      : null;
  }

  private async loadAi(): Promise<void> {
    const [index, log] = await Promise.all([
      trySys(this.deps.sys, 'ai.index.status', {}),
      trySys(this.deps.sys, 'ai.agent.log', { limit: 20 }),
    ]);
    if (index.ok) {
      this.index = index.value;
      this.indexError = undefined;
    } else {
      this.index = null;
      this.indexError = index.message;
    }
    if (log.ok) this.audit = log.value.records;
  }

  onEvents(batch: readonly KEvent[]): void {
    let changed = false;
    // Only the topics below matter here; the rest of the KEvent union is ignored.
    for (const ev of batch) {
      if (ev.topic === 'update.available') {
        this.update = { version: ev.data.version, build: ev.data.build };
        changed = true;
      } else if (ev.topic === 'net.state') {
        this.net = ev.data;
        changed = true;
      } else if (ev.topic === 'mem.pressure') {
        this.memUsed = ev.data.accounted;
        this.budgetBytes = ev.data.budget;
        changed = true;
      } else if (ev.topic === 'ai.index.progress' && this.index !== null) {
        this.index = {
          ...this.index,
          state: ev.data.state,
          pending: ev.data.pending,
          indexedFiles: ev.data.indexedFiles,
          chunks: ev.data.chunks,
        };
        changed = true;
      } else if (ev.topic === 'ai.model' && this.index !== null) {
        const next: IndexStatus = { ...this.index, modelState: ev.data.state };
        if (ev.data.loadedBytes !== undefined) next.loadedBytes = ev.data.loadedBytes;
        if (ev.data.totalBytes !== undefined) next.totalBytes = ev.data.totalBytes;
        this.index = next;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  // -------------------------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------------------------

  private isGuest(): boolean {
    return this.deps.env.user?.guest === true || this.cred?.uid === GUEST_UID;
  }

  async change(c: SettingChange): Promise<boolean> {
    if (c.key === 'telemetry.sync') return this.setTelemetrySync(c.value);
    if (isSysctlSetting(c.key)) return this.setSysctl(c.key, c.value);
    if (isPrefSetting(c.key)) {
      try {
        await this.deps.env.prefs.set(c.key, c.value);
        return true;
      } catch (e) {
        this.say('error', `Could not save the setting: ${describeFailure(e)}`);
        return false;
      }
    }
    return false;
  }

  private async setSysctl(setting: SysctlSettingKey, value: Scalar): Promise<boolean> {
    const label = SETTING_LABEL[setting] ?? setting;
    if (this.isGuest()) {
      this.say('error', 'Guests cannot change device settings.');
      return false;
    }
    const binding = SYSCTL_BINDINGS[setting];
    const key = sysctlKeyFor(setting, this.sysctl);
    const before = this.kernelValues[setting];
    // Optimistic, then confirmed or reverted: a refused slider springs back (the pane resets its
    // draft when the value changes).
    this.kernelValues = { ...this.kernelValues, [setting]: value };
    this.emit();
    const res = await trySys(this.deps.sys, 'sysctl.set', {
      key,
      value: binding.toKernel(value, key),
    });
    if (!res.ok) {
      this.kernelValues = { ...this.kernelValues, [setting]: before };
      this.say(
        'error',
        setting === 'boot.verbose' && res.errno === 'EINVAL'
          ? VERBOSE_BOOT_HINT
          : `Could not change ${label}: ${res.message}`,
      );
      return false;
    }
    this.sysctl = { ...this.sysctl, [key]: res.value.value };
    const echoed = binding.fromKernel(res.value.value, key);
    const applied = echoed ?? value;
    this.kernelValues = { ...this.kernelValues, [setting]: applied };
    if (setting === 'mm.budgetMB') this.budgetBytes = Number(applied) * MIB;
    // The boot router reads its own one-shot copy before any kernel runs (BOOT-06).
    if (setting === 'boot.menuNextBoot')
      this.deps.env.nextBoot?.({ menuNextBoot: applied === true });
    this.emit();
    return true;
  }

  private async setTelemetrySync(on: boolean): Promise<boolean> {
    this.optinPending = true;
    this.telemetryError = undefined;
    this.emit();
    const res = await trySys(this.deps.sys, 'ai.telemetry.optin', { on });
    this.optinPending = false;
    if (!res.ok) {
      this.telemetryError = `Could not turn sync ${on ? 'on' : 'off'}: ${res.message}`;
      this.emit();
      return false;
    }
    try {
      await this.deps.env.prefs.set('telemetry.sync', res.value.on);
    } catch (e) {
      this.telemetryError = `Sync is ${res.value.on ? 'on' : 'off'}, but the preference was not saved: ${describeFailure(e)}`;
    }
    if (res.value.on && !res.value.synced)
      this.say('info', 'Telemetry sync is on. It starts when the server is reachable.');
    else this.emit();
    return true;
  }

  async action(a: SettingsAction): Promise<void> {
    switch (a) {
      case 'telemetry.viewAll':
        this.rowLimit = TELEMETRY_ROWS_ALL;
        await this.loadTelemetry();
        this.emit();
        return;
      case 'telemetry.export':
        await this.exportTelemetry();
        return;
      case 'telemetry.clear':
      case 'telemetry.clearServerToo':
        await this.clearTelemetry(a === 'telemetry.clearServerToo');
        return;
      case 'index.rebuild':
        this.say(
          'info',
          'Rebuilding the search index from Settings is not available in this build yet.',
        );
        return;
      case 'ai.openLog':
        this.deps.launch?.('taskmgr', ['ai']);
        return;
      case 'about.systemReport': {
        const ok = (await this.deps.copy?.(systemReport(this.about(), this.uname))) ?? false;
        this.say(
          ok ? 'info' : 'error',
          ok ? 'System report copied to the clipboard.' : 'Could not copy the system report.',
        );
        return;
      }
      case 'about.copyUname': {
        if (this.uname === null) {
          this.say('error', 'uname is unavailable: the kernel has not answered.');
          return;
        }
        const ok = (await this.deps.copy?.(unameLine(this.uname))) ?? false;
        this.say(ok ? 'info' : 'error', ok ? 'uname -a copied.' : 'Could not copy.');
        return;
      }
      case 'about.licences':
        this.say(
          'info',
          'Third-party licences are listed in THIRD_PARTY.md at the root of the repository.',
        );
        return;
      case 'updates.check':
        await this.checkUpdates();
        return;
      case 'updates.install': {
        const res = await trySys(this.deps.sys, 'reboot', {});
        if (!res.ok) this.say('error', `Could not restart to update: ${res.message}`);
        return;
      }
      case 'sync.now': {
        const res = await trySys(this.deps.sys, 'sync.flush', { timeoutMs: 10_000 });
        if (!res.ok) {
          this.say('error', `Sync did not finish: ${res.message}`);
          return;
        }
        // An empty outbox is not "synced" while the sync service is down (UI-141).
        const net = await trySys(this.deps.sys, 'net.status', {});
        if (net.ok) this.net = net.value;
        this.say(
          'info',
          this.net?.degraded.includes('sync') === true
            ? 'Nothing is waiting to be sent, but this device is not syncing: the sync service is not running.'
            : 'Everything is synced.',
        );
        return;
      }
      case 'storage.emptyTrash':
        this.deps.launch?.('files', [`${this.cred?.home ?? '~'}/.Trash`]);
        return;
      case 'users.add':
      case 'users.changePassword':
      case 'users.forgetDevice':
        this.say(
          'info',
          'Account changes go through the server, which this build does not expose in Settings yet.',
        );
        return;
      case 'memory.restoreDefaults':
        await this.restore(['mm.budgetMB', 'mm.softLimitMB', 'mm.remoteOnly']);
        return;
      case 'scheduler.restoreDefaults':
        await this.restore([
          'sched.quantumMs.interactive',
          'sched.quantumMs.normal',
          'sched.quantumMs.background',
          'sched.tAgeMs',
        ]);
        return;
    }
  }

  private async restore(keys: readonly SysctlSettingKey[]): Promise<void> {
    for (const key of keys) {
      if (this.kernelValues[key] === SYSCTL_DEFAULTS[key]) continue;
      if (!(await this.setSysctl(key, SYSCTL_DEFAULTS[key]))) return;
    }
    this.say('info', 'Defaults restored.');
  }

  private async exportTelemetry(): Promise<void> {
    this.exporting = true;
    this.emit();
    const res = await trySys(this.deps.sys, 'ai.telemetry.export', {});
    if (!res.ok) {
      this.exporting = false;
      this.telemetryError = `Export failed: ${res.message}`;
      this.emit();
      return;
    }
    const name = exportFileName(this.deps.now());
    const home = this.cred?.home ?? null;
    const written =
      home === null
        ? null
        : await trySys(this.deps.sys, 'writeFile', {
            path: `${home}/${name}`,
            data: res.value,
            mode: 0o600,
          });
    this.exporting = false;
    const count = parseTelemetry(decoder.decode(new Uint8Array(res.value))).length;
    if (written?.ok === true) {
      this.say('info', `Exported ${String(count)} events to ~/${name}.`);
      return;
    }
    if (this.deps.download !== undefined) {
      this.deps.download(name, res.value, 'application/x-ndjson');
      this.say('info', `Exported ${String(count)} events as ${name}.`);
      return;
    }
    this.telemetryError = `Could not save ${name}: ${written?.message ?? 'no home directory'}`;
    this.emit();
  }

  private async clearTelemetry(serverToo: boolean): Promise<void> {
    const res = await trySys(this.deps.sys, 'ai.telemetry.clear', {});
    if (!res.ok) {
      this.telemetryError = `Clear failed: ${res.message}`;
      this.emit();
      return;
    }
    await this.loadTelemetry();
    const server = serverToo ? ' Deleting the server copy is not available in this build yet.' : '';
    this.say(
      'info',
      `Cleared ${String(res.value.cleared)} events. The predictor restarts from cold start.${server}`,
    );
  }

  private async checkUpdates(): Promise<void> {
    this.updateState = 'checking';
    this.emit();
    const net = await trySys(this.deps.sys, 'net.status', {});
    if (net.ok) this.net = net.value;
    if (this.updateServiceDown()) {
      // UI-141: nothing checks for updates while the update service is degraded, so the pane
      // must not say "up to date".
      this.updateState = 'error';
      this.updateError = UPDATE_SERVICE_DOWN;
      this.emit();
      return;
    }
    this.lastChecked = formatWhen(this.deps.now());
    this.updateState = 'idle';
    this.updateError = undefined;
    if (this.update === null)
      this.say(
        'info',
        `Plotinium ${this.deps.env.identity.version} is up to date. The update service keeps checking in the background.`,
      );
    else this.emit();
  }

  dismissNotice(): void {
    this.notice = undefined;
    this.emit();
  }

  /** The kernel lists the `update` service as degraded (`net.status`). */
  private updateServiceDown(): boolean {
    return this.net?.degraded.includes('update') === true;
  }

  // -------------------------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------------------------

  private about(): AboutModel {
    const { env } = this.deps;
    return toAboutModel({
      identity: env.identity,
      ...(env.team === undefined ? {} : { team: env.team }),
      uname: this.uname,
      budgetBytes: this.budgetBytes,
      storage:
        this.statfs === null
          ? null
          : {
              localBytes: this.statfs.usageBytes,
              cloudBytes: this.quota?.source === 'server' ? this.quota.usedBytes : null,
            },
      user: this.cred === null ? (env.user ?? null) : { name: this.cred.name, uid: this.cred.uid },
      updateAvailable: this.update?.version ?? null,
      updateServiceDown: this.updateServiceDown(),
    });
  }

  private build(): SettingsSnapshot {
    const { env } = this.deps;
    const prefs = env.prefs.get();
    const values: SettingValues = { ...valuesFromPrefs(prefs), ...this.kernelValues };
    const userName = this.cred?.name ?? env.user?.name ?? 'user';
    const uid = this.cred?.uid ?? env.user?.uid ?? 0;
    const user: SettingsUser = { name: userName, uid };
    if (this.isGuest()) user.guest = true;
    if (this.net !== null && this.net.state !== 'online') user.offline = true;
    const snap: { -readonly [K in keyof SettingsSnapshot]: SettingsSnapshot[K] } = {
      user,
      values,
      about: this.about(),
      privacy: toPrivacyModel({
        aiAvailable: env.aiAvailable,
        events: this.events,
        exportBytes: this.exportBytes,
        rowLimit: this.rowLimit,
        predictor: this.predictor,
        exporting: this.exporting,
        optinPending: this.optinPending,
        ...(this.telemetryError === undefined ? {} : { telemetryError: this.telemetryError }),
        index: this.index,
        ...(this.indexError === undefined ? {} : { indexError: this.indexError }),
        // argv[0] of a kernel service is "[ai.indexer]" (UI-132: this used to find nothing).
        indexer: findProcess(this.procs, 'ai.indexer'),
        rebuilding: false,
        net: this.net,
        audit: this.audit,
        budget: this.budget,
      }),
      network: toNetworkModel(this.net, this.deps.server),
      users: toUsersModel(this.usersList, this.cred?.uid ?? null),
      storage: toStorageModel(this.statfs, this.quota),
      updates: toUpdatesModel(
        env.identity.version,
        this.update,
        this.lastChecked,
        this.updateState,
        this.updateError,
      ),
      memory: { usedBytes: this.memUsed, lowWatermark: 0.75, highWatermark: 0.85 },
      bound: boundTerms(this.procs),
      aiAvailable: env.aiAvailable,
      loading: this.loading,
    };
    if (this.notice !== undefined) snap.notice = this.notice;
    return snap;
  }

  private emit(): void {
    this.snap = this.build();
    for (const fn of this.listeners) fn(this.snap);
  }

  private say(level: 'info' | 'error', text: string): void {
    this.notice = { level, text };
    this.emit();
  }
}
