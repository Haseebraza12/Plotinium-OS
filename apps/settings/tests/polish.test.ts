// @vitest-environment happy-dom
/**
 * Settings and About fixes of the polish wave (docs/design/bug-hunt/BUGS.md,
 * fix-apps-settings-a11y): UI-042, UI-132, UI-141, UI-146, UI-162.
 */
import type { NetStatus } from '@plotinium/protocol';
import type { SettingKey } from '@plotinium/ui/apps/settings';
import { SECTIONS, UNAVAILABLE_SETTINGS } from '@plotinium/ui/apps/settings';
import { describe, expect, it } from 'vitest';

import { LICENCE_NOTICES, toAboutModel, updateStatusText } from '../../about/model.ts';
import type { AppBuildIdentity, AppEnv } from '../../src/descriptor.ts';
import { createMemoryPrefs } from '../../src/descriptor.ts';
import { FakeSys, proc, T0 } from '../../taskmgr/tests/fake-sys.ts';
import { SettingsController, UPDATE_SERVICE_DOWN } from '../controller.ts';
import { SETTINGS_SECTIONS } from '../index.ts';
import {
  isPrefSetting,
  isSysctlSetting,
  REBUILD_NOTE,
  SERVER_DELETE_NOTE,
  toNetworkModel,
  toPrivacyModel,
} from '../model.ts';

const IDENTITY: AppBuildIdentity = {
  name: 'Plotinium',
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-09-24',
  codename: 'Pu',
  abi: 1,
};

const ONLINE: NetStatus = {
  state: 'online',
  queuedOps: 0,
  lastAckAt: null,
  degraded: [],
  leaseTtlMs: 30_000,
  serverBuild: null,
};

function world(degraded: string[]): { sys: FakeSys; settings: SettingsController } {
  const net: NetStatus = { ...ONLINE, degraded };
  const sys = new FakeSys()
    .on('proc.cred', () => ({
      uid: 1101,
      gid: 100,
      groups: [100],
      user: 'bob',
      groupNames: ['users'],
      home: '/home/bob',
      ruid: 1101,
    }))
    .on('net.status', () => net)
    .on('sync.flush', () => ({ remaining: 0 }))
    .on('proc.list', () => ({
      procs: [
        proc({ pid: 2, argv: ['[sched]'], class: 'system' }),
        proc({ pid: 14, argv: ['[ai.indexer]'], class: 'system', priority: 32 }),
      ],
    }));
  const env: AppEnv = { identity: IDENTITY, prefs: createMemoryPrefs(), aiAvailable: true };
  const settings = new SettingsController({ sys, env, now: () => T0, server: 'plotinium.test' });
  return { sys, settings };
}

/**
 * Every Settings key and what applies it (UI-042). A key nothing reads is in
 * UNAVAILABLE_SETTINGS, so its control is disabled with a note. The Record type makes a new key
 * fail to compile until it is listed here.
 */
const CONSUMER: Record<SettingKey, string> = {
  'general.deviceName': 'none (disabled with a note)',
  'general.language': 'none (disabled with a note)',
  'general.clock24h': 'shell clock (UI-040, fix-desktop-shell)',
  'boot.menuNextBoot': 'sysctl boot.showMenuNextBoot and the boot router (BOOT-06)',
  'boot.verbose': 'sysctl boot.verbose',
  'appearance.theme': 'applyAppearance: <html data-theme>',
  'appearance.accent': 'applyAppearance: <html data-accent> read by tokens.css (UI-039)',
  'appearance.reduceMotion': 'applyAppearance: <html data-motion>',
  'appearance.reduceTransparency': 'applyAppearance: <html data-transparency>',
  'dock.size': 'shell Dock (UI-040, fix-desktop-shell)',
  'dock.magnification': 'shell Dock (toShellPrefs)',
  'dock.magnificationScale': 'shell Dock (UI-040, fix-desktop-shell)',
  'dock.autohide': 'shell Dock (UI-040, fix-desktop-shell)',
  'dock.showIndicators': 'shell Dock (UI-040, fix-desktop-shell)',
  'dock.showSuggestions': 'none (disabled with a note)',
  'dock.minimiseEffect': 'window manager, <html data-minimise-effect> (UI-041)',
  'windows.doubleClickTitle': 'window manager, <html data-title-dblclick> (UI-041)',
  'mm.budgetMB': 'sysctl mm.budget',
  'mm.softLimitMB': 'sysctl mm.softLimit',
  'mm.remoteOnly': 'sysctl mm.swap.tier',
  'sched.quantumMs.interactive': 'sysctl sched.quantum.interactive',
  'sched.quantumMs.normal': 'sysctl sched.quantum.normal',
  'sched.quantumMs.background': 'sysctl sched.quantum.background',
  'sched.tAgeMs': 'sysctl sched.tAge',
  'sync.files': 'none (disabled with a note)',
  'sync.swapWriteBehind': 'none (disabled with a note)',
  'telemetry.sync': 'ai.telemetry.optin (PRE-05)',
  'agent.requireConfirm': 'none: ai/src/agent/confirm.ts decides (disabled with a note)',
  'updates.auto': 'none (disabled with a note)',
  'updates.channel': 'none (disabled with a note)',
};

describe('UI-042 every Settings key has a consumer or a disabled note', () => {
  it('UI-042 the keys without a consumer are exactly the ones with a note', () => {
    const none = Object.entries(CONSUMER)
      .filter(([, consumer]) => consumer.startsWith('none'))
      .map(([key]) => key)
      .sort();
    expect(Object.keys(UNAVAILABLE_SETTINGS).sort()).toEqual(none);
    for (const note of Object.values(UNAVAILABLE_SETTINGS)) expect(note).toMatch(/\S/u);
  });

  it('UI-042 a key said to be a kernel parameter is one, and the rest are preferences', () => {
    for (const [key, consumer] of Object.entries(CONSUMER) as [SettingKey, string][]) {
      if (consumer.startsWith('sysctl')) expect(isSysctlSetting(key), key).toBe(true);
      else expect(isPrefSetting(key), key).toBe(true);
    }
  });
});

describe('UI-141 Settings reports what it knows', () => {
  it('UI-141 Sync Now does not say "Everything is synced" while the sync service is down', async () => {
    const down = world(['sync', 'lockd']);
    await down.settings.load();
    await down.settings.action('sync.now');
    expect(down.settings.snapshot().notice?.text).toMatch(/not syncing/u);
    expect(down.settings.snapshot().network.status).toBe('degraded');
    const up = world([]);
    await up.settings.load();
    await up.settings.action('sync.now');
    expect(up.settings.snapshot().notice?.text).toBe('Everything is synced.');
    expect(up.settings.snapshot().network.status).toBe('online');
  });

  it('UI-141 Check for updates with the update service down is an error, not "up to date"', async () => {
    const { settings } = world(['update']);
    await settings.load();
    await settings.action('updates.check');
    expect(settings.snapshot().updates).toMatchObject({
      state: 'error',
      error: UPDATE_SERVICE_DOWN,
    });
    expect(settings.snapshot().notice).toBeUndefined();
    expect(settings.snapshot().about.updateStatus).toBe('update check unavailable');
  });

  it('UI-132 the Privacy pane finds "[ai.indexer]" (it showed pid 0)', async () => {
    const { settings } = world([]);
    await settings.load();
    expect(settings.snapshot().privacy.index).toMatchObject({ pid: 14, priority: 32 });
  });

  it('UI-141 a fully loaded model that is not ready yet is "starting", not "loading 100%"', () => {
    const base = {
      aiAvailable: true,
      events: [],
      exportBytes: 0,
      rowLimit: 25,
      predictor: null,
      exporting: false,
      optinPending: false,
      indexer: undefined,
      rebuilding: false,
      net: null,
      audit: [],
      budget: null,
    } as const;
    const index = {
      state: 'indexing',
      pending: 0,
      indexedFiles: 0,
      chunks: 0,
      modelKey: 'mdbr-leaf-ir',
      modelState: 'loading',
    } as const;
    const full = toPrivacyModel({
      ...base,
      index: { ...index, loadedBytes: 20, totalBytes: 20 },
    });
    expect(full.model.detail).toBe('starting');
    const part = toPrivacyModel({ ...base, index: { ...index, loadedBytes: 5, totalBytes: 20 } });
    expect(part.model.detail).toBe('loading 25%');
    // UI-146: the controls without a system call say so.
    expect(full.index.rebuildUnavailable).toBe(REBUILD_NOTE);
    expect(full.telemetry.serverDeleteUnavailable).toBe(SERVER_DELETE_NOTE);
  });

  it('UI-141 the network pane is "online" only when the sync service runs', () => {
    expect(toNetworkModel({ ...ONLINE, degraded: ['sync'] }, 's').status).toBe('degraded');
    expect(toNetworkModel({ ...ONLINE, degraded: ['lockd'] }, 's').status).toBe('online');
    expect(toNetworkModel({ ...ONLINE, state: 'offline', degraded: ['sync'] }, 's').status).toBe(
      'offline',
    );
  });
});

describe('UI-146 and UI-162 About and menus', () => {
  it('UI-146 About lists the shipped third-party software for the Licences dialog', () => {
    const model = toAboutModel({
      identity: IDENTITY,
      uname: null,
      budgetBytes: null,
      storage: null,
      user: null,
      updateAvailable: null,
    });
    expect(model.licences).toBe(LICENCE_NOTICES);
    const names = LICENCE_NOTICES.map((n) => n.name).join(' ');
    for (const expected of ['solid-js', 'xterm', 'CodeMirror', 'Inter', 'JetBrains Mono'])
      expect(names).toContain(expected);
    for (const n of LICENCE_NOTICES) expect(n.licence).toMatch(/^(MIT|ISC|Apache-2\.0|OFL-1\.1)$/u);
    expect(updateStatusText({ updateAvailable: '0.3.1', updateServiceDown: true })).toBe(
      '0.3.1 available',
    );
    expect(updateStatusText({ updateAvailable: null })).toBe('up to date on this channel');
  });

  it('UI-162 the View menu uses the sidebar words', () => {
    const sidebar = new Map(SECTIONS.map((s) => [s.id, s.label]));
    for (const section of SETTINGS_SECTIONS)
      expect(section.label, section.id).toBe(sidebar.get(section.id));
  });
});
