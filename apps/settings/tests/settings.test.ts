/**
 * Settings against a fake system-call client (ui-design-system.md §3.8.14): telemetry privacy
 * (PRE-05), the memory budget (MEM-01), the scheduler quanta (PROC-03), appearance through the
 * desktop preferences (DSN-05), the one-shot boot menu (BOOT-06) and guest limits (SYS-01).
 */
import type {
  IndexStatus,
  KEvent,
  Quota,
  RetOf,
  StatFs,
  TelemetryEvent,
  UnameInfo,
} from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import type { AppBuildIdentity, AppEnv, AppPrefs, DesktopPrefs } from '../../src/descriptor.ts';
import { applyAppearance, createMemoryPrefs } from '../../src/descriptor.ts';
import { FakeSys, flush, MB, proc, T0 } from '../../taskmgr/tests/fake-sys.ts';
import { SettingsController, VERBOSE_BOOT_HINT } from '../controller.ts';
import {
  boundTerms,
  bucketText,
  exportFileName,
  parseTelemetry,
  sectionFromArgv,
  sectionOfCommand,
  sysctlKeyFor,
  telemetryRows,
  toStorageModel,
  toUsersModel,
  valuesFromSysctl,
} from '../model.ts';

const IDENTITY: AppBuildIdentity = {
  name: 'Plotinium',
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-09-24',
  codename: 'Pu',
  abi: 1,
};

const CRED = {
  uid: 1001,
  gid: 1001,
  groups: [1001],
  user: 'student',
  groupNames: ['student'],
  home: '/home/student',
  ruid: 1001,
};

const SESSION = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';

function tev(
  seq: number,
  app: string,
  prev: string | null,
  kind: TelemetryEvent['kind'] = 'launch',
): TelemetryEvent {
  return {
    v: 1,
    seq,
    ts: T0 + seq * 60_000,
    tzOffsetMin: 300,
    kind,
    app,
    prev,
    hourBucket: 2,
    dow: 6,
    weekend: true,
    sessionPos: seq,
    origin: 'user',
    osSessionId: SESSION,
  };
}

function jsonl(events: readonly TelemetryEvent[]): ArrayBuffer {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

interface World {
  sys: FakeSys;
  prefs: AppPrefs;
  env: AppEnv;
  settings: SettingsController;
  ring: TelemetryEvent[];
  downloads: { name: string; bytes: number; type: string }[];
  nextBoot: boolean[];
}

function world(
  opts: { ai?: boolean; guest?: boolean; sysctl?: Record<string, string | number | boolean> } = {},
): World {
  const ring: TelemetryEvent[] = [
    tev(1, 'files', null),
    tev(2, 'editor', 'files'),
    tev(3, 'terminal', 'editor'),
  ];
  const sysctl: Record<string, string | number | boolean> = opts.sysctl ?? {
    'mm.budget': 256 * MB,
    'mm.softLimit': 64 * MB,
    'mm.swap.tier': 'auto',
    'sched.quantum.interactive': 5,
    'sched.quantum.normal': 10,
    'sched.quantum.background': 20,
    'sched.tAge': 100,
  };
  const sys = new FakeSys()
    .on('proc.cred', () =>
      opts.guest === true ? { ...CRED, uid: 65_534, user: 'guest', home: '/home/guest' } : CRED,
    )
    .on('sysctl.get', () => ({ values: { ...sysctl } }))
    .on('sysctl.set', (a) => {
      const old = sysctl[a.key] ?? null;
      sysctl[a.key] = a.value;
      return { old, value: a.value };
    })
    .on('proc.list', () => ({
      procs: [
        proc({ pid: 1, argv: ['/sbin/init'] }),
        proc({ pid: 40, argv: ['ai.indexer'], priority: 32 }),
      ],
    }))
    .on('ai.telemetry.export', () => jsonl(ring))
    .on('ai.telemetry.clear', () => {
      const cleared = ring.length;
      ring.length = 0;
      return { cleared };
    })
    .on('ai.predict', () => ({
      predictions: [],
      model: 'mfu',
      launches: ring.length,
      updatedAt: T0,
    }));
  const prefs = createMemoryPrefs();
  const nextBoot: boolean[] = [];
  const env: AppEnv = {
    identity: IDENTITY,
    prefs,
    aiAvailable: opts.ai !== false,
    nextBoot: (f) => {
      nextBoot.push(f.menuNextBoot);
    },
    ...(opts.guest === true ? { user: { name: 'guest', uid: 65_534, guest: true } } : {}),
  };
  const downloads: World['downloads'] = [];
  const settings = new SettingsController({
    sys,
    env,
    now: () => T0,
    server: 'plotinium.test',
    download: (name, data, type) => {
      downloads.push({ name, bytes: data.byteLength, type });
    },
    copy: () => Promise.resolve(true),
  });
  return { sys, prefs, env, settings, ring, downloads, nextBoot };
}

// ---------------------------------------------------------------------------------------------
// PRE-05 telemetry
// ---------------------------------------------------------------------------------------------

describe('Settings Privacy & AI', () => {
  it('PRE-05 telemetry sync is off by default and opening Settings never calls ai.telemetry.optin', async () => {
    const { sys, prefs, settings } = world();
    await settings.load();
    expect(prefs.get()['telemetry.sync']).toBe(false);
    expect(settings.snapshot().values['telemetry.sync']).toBe(false);
    expect(sys.count('ai.telemetry.optin')).toBe(0);
  });

  it('PRE-05 turning sync on calls ai.telemetry.optin and changes the preference only after the kernel accepted', async () => {
    const { sys, prefs, settings } = world();
    let accept: (v: { on: boolean; synced: boolean }) => void = () => undefined;
    sys.on('ai.telemetry.optin', () => new Promise((resolve) => (accept = resolve)));
    await settings.load();
    const done = settings.change({ key: 'telemetry.sync', value: true });
    await flush();
    expect(sys.calls('ai.telemetry.optin')).toEqual([{ on: true }]);
    expect(prefs.get()['telemetry.sync']).toBe(false);
    expect(settings.snapshot().privacy.telemetry.pending).toBe(true);
    accept({ on: true, synced: false });
    expect(await done).toBe(true);
    expect(prefs.get()['telemetry.sync']).toBe(true);
    expect(settings.snapshot().privacy.telemetry.pending).toBeUndefined();
    expect(settings.snapshot().notice?.text).toContain('starts when the server is reachable');
  });

  it('PRE-05 a refused opt-in leaves sync off and shows the errno', async () => {
    const { sys, prefs, settings } = world();
    sys.fail('ai.telemetry.optin', 'EACCES');
    await settings.load();
    expect(await settings.change({ key: 'telemetry.sync', value: true })).toBe(false);
    expect(prefs.get()['telemetry.sync']).toBe(false);
    expect(settings.snapshot().privacy.telemetry.error).toMatch(/Could not turn sync on: .*EACCES/);
  });

  it('PRE-05 Settings Privacy lists the events and Clear empties the ring and resets the model to cold start', async () => {
    const { sys, settings } = world();
    await settings.load();
    const t = settings.snapshot().privacy.telemetry;
    expect(t.count).toBe(3);
    expect(t.rows.map((r) => r.app)).toEqual(['terminal', 'editor', 'files']);
    expect(t.rows[0]).toMatchObject({
      event: 'launch',
      previousApp: 'editor',
      bucket: '08:00–12:00 weekend',
    });
    expect(t.predictor).toBe('cold start 3/50 launches');

    await settings.action('telemetry.clear');
    expect(sys.count('ai.telemetry.clear')).toBe(1);
    expect(settings.snapshot().privacy.telemetry.count).toBe(0);
    expect(settings.snapshot().privacy.telemetry.rows).toEqual([]);
    expect(settings.snapshot().notice?.text).toContain('Cleared 3 events');
    expect(settings.snapshot().notice?.text).toContain('cold start');
  });

  it('PRE-05 telemetry events contain no file names, paths or content', async () => {
    const { settings } = world();
    await settings.load();
    for (const row of settings.snapshot().privacy.telemetry.rows) {
      for (const key of Object.keys(row))
        expect(['id', 'at', 'event', 'app', 'bucket', 'previousApp']).toContain(key);
      expect(row.app).not.toContain('/');
    }
  });

  it('PRE-05 Export writes the JSON Lines into the home directory with mode 0600', async () => {
    const { sys, settings } = world();
    sys.on('writeFile', (a) => ({
      ino: '0192f3a4-5b6c-7d8e-9f01-000000000090',
      version: 1,
      bytes: a.data.byteLength,
      opId: '0192f3a4-5b6c-7d8e-9f01-000000000005',
      sync: 'pending',
    }));
    await settings.load();
    await settings.action('telemetry.export');
    const [args] = sys.calls('writeFile') as { path: string; data: ArrayBuffer; mode: number }[];
    expect(args?.path).toBe(`/home/student/${exportFileName(T0)}`);
    expect(args?.mode).toBe(0o600);
    expect(parseTelemetry(new TextDecoder().decode(args?.data ?? new ArrayBuffer(0)))).toHaveLength(
      3,
    );
    expect(settings.snapshot().notice?.text).toBe(`Exported 3 events to ~/${exportFileName(T0)}.`);
  });

  it('PRE-05 Export falls back to a browser download when the process cannot write the file', async () => {
    const { settings, downloads } = world();
    await settings.load();
    await settings.action('telemetry.export');
    expect(downloads).toEqual([
      {
        name: exportFileName(T0),
        bytes: jsonl([
          tev(1, 'files', null),
          tev(2, 'editor', 'files'),
          tev(3, 'terminal', 'editor'),
        ]).byteLength,
        type: 'application/x-ndjson',
      },
    ]);
    expect(settings.snapshot().privacy.telemetry.exporting).toBeUndefined();
  });

  it('PRE-05 the AI-off build makes no AI or telemetry calls and shows the model off', async () => {
    const { sys, settings } = world({ ai: false });
    await settings.load();
    expect(sys.log.filter((c) => c.name.startsWith('ai.'))).toEqual([]);
    expect(settings.snapshot().privacy.model.state).toBe('off');
    expect(settings.snapshot().privacy.telemetry.predictor).toBe('off');
  });

  it('PRE-05 exported JSON Lines parse in sequence order and a torn last line is skipped', () => {
    const text = `${JSON.stringify(tev(2, 'editor', 'files'))}\n${JSON.stringify(tev(1, 'files', null))}\n{"seq":3,`;
    expect(parseTelemetry(text).map((e) => e.seq)).toEqual([1, 2]);
    expect(telemetryRows(parseTelemetry(text), 1)).toHaveLength(1);
    expect(bucketText({ hourBucket: 0, weekend: false })).toBe('00:00–04:00 weekday');
  });

  it('PRE-06 the agent budget comes from the host and the index state from ai.index.status', async () => {
    const { sys, env } = world();
    const status: IndexStatus = {
      state: 'indexing',
      pending: 5,
      indexedFiles: 15,
      chunks: 120,
      modelKey: 'minilm-l6-v2',
      modelState: 'ready',
    };
    sys.on('ai.index.status', () => status);
    const settings = new SettingsController({
      sys,
      env: {
        ...env,
        agentBudget: () => Promise.resolve({ usedCents: 42, capCents: 500, resetsOn: '1 Oct' }),
      },
      now: () => T0,
      server: 'plotinium.test',
    });
    await settings.load();
    const p = settings.snapshot().privacy;
    expect(p.agent).toMatchObject({ usedCents: 42, capCents: 500, resetsOn: '1 Oct' });
    expect(p.index).toMatchObject({ state: 'indexing', indexed: 15, total: 20, pid: 40 });
    expect(p.model).toMatchObject({ name: 'minilm-l6-v2', state: 'ready' });
  });
});

// ---------------------------------------------------------------------------------------------
// MEM-01, PROC-03 kernel parameters
// ---------------------------------------------------------------------------------------------

describe('Settings kernel parameters', () => {
  it('MEM-01 changing the memory budget in Settings sets mm.budget in bytes without a reboot', async () => {
    const { sys, settings } = world();
    await settings.load();
    expect(settings.snapshot().values['mm.budgetMB']).toBe(256);
    expect(await settings.change({ key: 'mm.budgetMB', value: 512 })).toBe(true);
    expect(sys.calls('sysctl.set')).toEqual([{ key: 'mm.budget', value: 512 * MB }]);
    expect(settings.snapshot().values['mm.budgetMB']).toBe(512);
    expect(settings.snapshot().about.memoryBudget).toBe('512 MB');
    expect(sys.count('reboot')).toBe(0);
  });

  it('MEM-01 a kernel that reports mm.budgetMB is written in MB', async () => {
    const { sys, settings } = world({ sysctl: { 'mm.budgetMB': 256 } });
    await settings.load();
    await settings.change({ key: 'mm.budgetMB', value: 384 });
    expect(sys.calls('sysctl.set')).toEqual([{ key: 'mm.budgetMB', value: 384 }]);
    expect(sysctlKeyFor('mm.budgetMB', {})).toBe('mm.budget');
  });

  it('MEM-01 a refused budget change springs back and says why', async () => {
    const { sys, settings } = world();
    await settings.load();
    sys.fail('sysctl.set', 'EINVAL', 'budget below the kernel floor');
    expect(await settings.change({ key: 'mm.budgetMB', value: 8 })).toBe(false);
    expect(settings.snapshot().values['mm.budgetMB']).toBe(256);
    expect(settings.snapshot().notice).toEqual({
      level: 'error',
      text: 'Could not change the memory budget: budget below the kernel floor (EINVAL)',
    });
  });

  it('MEM-01 a memory manager that is not running (mm.budget 0) shows the default, not 0 MB', () => {
    expect(valuesFromSysctl({ 'mm.budget': 0, 'mm.softLimit': 0 })).toMatchObject({
      'mm.budgetMB': 256,
      'mm.softLimitMB': 64,
    });
    expect(valuesFromSysctl({ 'mm.swap.tier': 'remote' })['mm.remoteOnly']).toBe(true);
  });

  it('PROC-03 changing the normal-band quantum in Settings sets sched.quantum.normal', async () => {
    const { sys, settings } = world();
    await settings.load();
    expect(await settings.change({ key: 'sched.quantumMs.normal', value: 4 })).toBe(true);
    expect(sys.calls('sysctl.set')).toEqual([{ key: 'sched.quantum.normal', value: 4 }]);
    expect(settings.snapshot().values['sched.quantumMs.normal']).toBe(4);
  });

  it('PROC-03 Restore Defaults resets only the scheduler keys that differ', async () => {
    const { sys, settings } = world({
      sysctl: {
        'sched.quantum.interactive': 5,
        'sched.quantum.normal': 4,
        'sched.quantum.background': 20,
        'sched.tAge': 250,
      },
    });
    await settings.load();
    await settings.action('scheduler.restoreDefaults');
    expect(sys.calls('sysctl.set')).toEqual([
      { key: 'sched.quantum.normal', value: 10 },
      { key: 'sched.tAge', value: 100 },
    ]);
    expect(settings.snapshot().notice?.text).toBe('Defaults restored.');
  });

  it('PROC-04 the bound terms grow N with the live runnable count', () => {
    const many = Array.from({ length: 60 }, (_, i) => proc({ pid: 100 + i, state: 'READY' }));
    expect(boundTerms([])).toEqual({ p: 39, n: 51, e: 1, deltaMs: 1, hKillMs: 400 });
    expect(boundTerms(many).n).toBe(60);
  });

  it('SYS-01 guests cannot change device settings and no sysctl.set is made', async () => {
    const { sys, settings } = world({ guest: true });
    await settings.load();
    expect(await settings.change({ key: 'mm.budgetMB', value: 512 })).toBe(false);
    expect(sys.count('sysctl.set')).toBe(0);
    expect(settings.snapshot().user.guest).toBe(true);
    expect(settings.snapshot().notice?.text).toBe('Guests cannot change device settings.');
  });

  it('BOOT-06 showing the boot menu on next boot sets boot.showMenuNextBoot and the router flag', async () => {
    const { sys, settings, nextBoot } = world();
    await settings.load();
    await settings.change({ key: 'boot.menuNextBoot', value: true });
    expect(sys.calls('sysctl.set')).toEqual([{ key: 'boot.showMenuNextBoot', value: true }]);
    expect(nextBoot).toEqual([true]);
  });

  it('BOOT-06 verbose boot, which is not a kernel parameter, explains how to choose it', async () => {
    const { sys, settings } = world();
    await settings.load();
    sys.fail('sysctl.set', 'EINVAL', 'unknown key boot.verbose');
    expect(await settings.change({ key: 'boot.verbose', value: true })).toBe(false);
    expect(settings.snapshot().values['boot.verbose']).toBe(false);
    expect(settings.snapshot().notice?.text).toBe(VERBOSE_BOOT_HINT);
  });
});

// ---------------------------------------------------------------------------------------------
// Appearance, users, storage, navigation
// ---------------------------------------------------------------------------------------------

describe('Settings appearance and panes', () => {
  it('DSN-05 theme and reduced motion change through the desktop preferences, which set data-theme and data-motion', async () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    const applied: (keyof DesktopPrefs)[] = [];
    const prefs = createMemoryPrefs({}, (p, key) => {
      applied.push(key);
      applyAppearance(root, p);
    });
    const { sys } = world();
    const settings = new SettingsController({
      sys,
      env: { identity: IDENTITY, prefs, aiAvailable: true },
      now: () => T0,
      server: 'plotinium.test',
    });
    await settings.load();
    const seen: string[] = [];
    settings.subscribe((s) => seen.push(s.values['appearance.theme']));
    await settings.change({ key: 'appearance.theme', value: 'dark' });
    await settings.change({ key: 'appearance.reduceMotion', value: 'always' });
    expect(applied).toEqual(['appearance.theme', 'appearance.reduceMotion']);
    expect(root.dataset).toMatchObject({ theme: 'dark', motion: 'reduce', accent: 'violet' });
    expect(seen).toContain('dark');
    expect(settings.snapshot().values['appearance.reduceMotion']).toBe('always');
    expect(sys.count('sysctl.set')).toBe(0);

    await settings.change({ key: 'appearance.theme', value: 'system' });
    await settings.change({ key: 'appearance.reduceMotion', value: 'system' });
    expect(root.dataset['theme']).toBeUndefined();
    expect(root.dataset['motion']).toBeUndefined();
    settings.dispose();
  });

  it('DSN-05 a preference the host refuses is reported, not silently dropped', async () => {
    const { sys } = world();
    const prefs = createMemoryPrefs({}, () =>
      Promise.reject(Object.assign(new Error('read-only'), { errno: 'EACCES' })),
    );
    const settings = new SettingsController({
      sys,
      env: { identity: IDENTITY, prefs, aiAvailable: true },
      now: () => T0,
      server: 's',
    });
    expect(await settings.change({ key: 'dock.autohide', value: true })).toBe(false);
    expect(settings.snapshot().notice?.text).toBe('Could not save the setting: read-only (EACCES)');
    expect(prefs.get()['dock.autohide']).toBe(false);
    expect(settings.snapshot().values['dock.autohide']).toBe(false);
  });

  it('SYS-01 users and groups come from users.list; only root may administer', () => {
    const list: RetOf<'users.list'> = {
      users: [
        { uid: 0, gid: 0, groups: [0], name: 'root', home: '/root' },
        { uid: 1001, gid: 1001, groups: [1001, 10], name: 'student', home: '/home/student' },
        { uid: 65_534, gid: 65_534, groups: [], name: 'guest', home: '/home/guest' },
      ],
      groups: [
        { gid: 0, name: 'root' },
        { gid: 10, name: 'wheel' },
        { gid: 1001, name: 'student' },
      ],
    };
    const m = toUsersModel(list, 1001);
    expect(m.canAdmin).toBe(false);
    expect(m.users.map((u) => [u.name, u.role])).toEqual([
      ['root', 'admin'],
      ['student', 'admin'],
      ['guest', 'guest'],
    ]);
    expect(m.users.find((u) => u.name === 'student')).toMatchObject({
      current: true,
      groups: ['student', 'wheel'],
    });
    expect(toUsersModel(null, 0).canAdmin).toBe(true);
  });

  it('VFS-06 storage splits statfs usage into files, swap and system', () => {
    const statfs: StatFs = {
      fsId: 'plotinium',
      usageBytes: 300 * MB,
      quotaBytes: 2048 * MB,
      inodes: 1200,
      persisted: true,
      swapBytes: { local: 100 * MB, remote: 0 },
    };
    const quota: Quota = {
      uid: 1001,
      usedBytes: 150 * MB,
      quotaBytes: 1024 * MB,
      usedInodes: 900,
      quotaInodes: null,
      source: 'server',
    };
    const m = toStorageModel(statfs, quota);
    expect(m.usedBytes).toBe(300 * MB);
    expect(m.categories.map((c) => [c.id, c.bytes])).toEqual([
      ['files', 150 * MB],
      ['swap', 100 * MB],
      ['system', 50 * MB],
    ]);
    expect(m.cloudBytes).toBe(150 * MB);
  });

  it('WM-05 a launch argument or a View-menu command opens a section', () => {
    expect(sectionFromArgv(['memory'])).toBe('memory');
    expect(sectionFromArgv(['privacy-ai'])).toBe('privacy');
    expect(sectionFromArgv(['nope'])).toBeUndefined();
    expect(sectionFromArgv([])).toBeUndefined();
    expect(sectionOfCommand('go.scheduler')).toBe('scheduler');
    expect(sectionOfCommand('view.refresh')).toBeUndefined();
  });

  it('DSN-18 Settings About copies uname -a from the kernel answer', async () => {
    const { sys } = world();
    const uname: UnameInfo = {
      sysname: 'Plotinium',
      version: '0.3.0',
      build: 'a1f93c2',
      buildDate: '2026-09-24',
      codename: 'Pu',
      browser: { brand: 'Chrome', major: 154 },
      cores: 8,
      uid: 1001,
      user: 'student',
    };
    sys.on('uname', () => uname);
    const copied: string[] = [];
    const settings = new SettingsController({
      sys,
      env: { identity: IDENTITY, prefs: createMemoryPrefs(), aiAvailable: true },
      now: () => T0,
      server: 's',
      copy: (t) => {
        copied.push(t);
        return Promise.resolve(true);
      },
    });
    await settings.load();
    await settings.action('about.copyUname');
    expect(copied).toEqual([
      'Plotinium 0.3.0 (kernel 0.3.0-a1f93c2, built 2026-09-24) · Chrome 154 · 8 cores · uid=1001(student)',
    ]);
    expect(settings.snapshot().about).toMatchObject({
      kernel: 'plotinium 0.3.0-a1f93c2',
      host: { browser: 'Chrome 154', cores: 8 },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Events and the remaining actions
// ---------------------------------------------------------------------------------------------

describe('Settings events and actions', () => {
  function launcher(): { calls: string[]; settings: SettingsController; sys: FakeSys } {
    const { sys, env } = world();
    const calls: string[] = [];
    const settings = new SettingsController({
      sys,
      env,
      now: () => T0,
      server: 'plotinium.test',
      copy: () => Promise.resolve(true),
      launch: (app, argv) => calls.push([app, ...(argv ?? [])].join(' ')),
    });
    return { calls, settings, sys };
  }

  it('SVC-09 update, network and memory-pressure events update the panes live', async () => {
    const { sys, settings } = world();
    const status: IndexStatus = {
      state: 'idle',
      pending: 0,
      indexedFiles: 10,
      chunks: 80,
      modelKey: 'minilm-l6-v2',
      modelState: 'loading',
    };
    sys.on('ai.index.status', () => status);
    await settings.load();
    const events: KEvent[] = [
      { topic: 'update.available', seq: 1, t: T0, data: { version: '0.3.1', build: 'b2c3d4e' } },
      {
        topic: 'net.state',
        seq: 2,
        t: T0,
        data: {
          state: 'offline',
          queuedOps: 3,
          lastAckAt: null,
          degraded: ['sync'],
          leaseTtlMs: 0,
          serverBuild: null,
        },
      },
      {
        topic: 'mem.pressure',
        seq: 3,
        t: T0,
        data: { level: 'reclaim', accounted: 230 * MB, budget: 256 * MB },
      },
      {
        topic: 'ai.index.progress',
        seq: 4,
        t: T0,
        data: { state: 'indexing', pending: 4, indexedFiles: 12, chunks: 96 },
      },
      {
        topic: 'ai.model',
        seq: 5,
        t: T0,
        data: { state: 'loading', loadedBytes: 5 * MB, totalBytes: 20 * MB },
      },
    ];
    settings.onEvents(events);
    const s = settings.snapshot();
    expect(s.updates.available?.version).toBe('0.3.1');
    expect(s.about.updateStatus).toBe('0.3.1 available');
    expect(s.network).toMatchObject({ status: 'offline', queued: 3, lastSync: 'never' });
    expect(s.user.offline).toBe(true);
    expect(s.memory.usedBytes).toBe(230 * MB);
    expect(s.privacy.index).toMatchObject({ state: 'indexing', indexed: 12, total: 16 });
    expect(s.privacy.model).toMatchObject({ state: 'loading', detail: 'loading 25%' });
  });

  it('PRE-05 View all widens the list; index rebuild and server-side delete say they are not available yet', async () => {
    const { sys, settings } = world();
    await settings.load();
    const before = sys.count('ai.telemetry.export');
    await settings.action('telemetry.viewAll');
    expect(sys.count('ai.telemetry.export')).toBe(before + 1);
    await settings.action('index.rebuild');
    expect(settings.snapshot().notice?.text).toContain('not available in this build yet');
    await settings.action('telemetry.clearServerToo');
    expect(settings.snapshot().notice?.text).toContain('Deleting the server copy is not available');
    settings.dismissNotice();
    expect(settings.snapshot().notice).toBeUndefined();
  });

  it('PRE-05 a failing export or clear is shown in the Privacy pane', async () => {
    const { sys, settings } = world();
    await settings.load();
    sys.fail('ai.telemetry.clear', 'EPERM');
    await settings.action('telemetry.clear');
    expect(settings.snapshot().privacy.telemetry.error).toMatch(/Clear failed: .*EPERM/);
    sys.fail('ai.telemetry.export', 'EPERM');
    await settings.action('telemetry.export');
    expect(settings.snapshot().privacy.telemetry.error).toMatch(/Export failed: .*EPERM/);
    expect(settings.snapshot().privacy.telemetry.exporting).toBeUndefined();
  });

  it('WM-05 Settings opens the Task Manager AI tab, the Trash in Files and copies the system report', async () => {
    const { calls, settings } = launcher();
    await settings.load();
    await settings.action('ai.openLog');
    await settings.action('storage.emptyTrash');
    expect(calls).toEqual(['taskmgr ai', 'files /home/student/.Trash']);
    await settings.action('about.systemReport');
    expect(settings.snapshot().notice?.text).toBe('System report copied to the clipboard.');
    await settings.action('about.licences');
    expect(settings.snapshot().notice?.text).toContain('THIRD_PARTY.md');
    await settings.action('about.copyUname');
    expect(settings.snapshot().notice).toEqual({
      level: 'error',
      text: 'uname is unavailable: the kernel has not answered.',
    });
    await settings.action('users.add');
    expect(settings.snapshot().notice?.text).toContain('Account changes go through the server');
  });

  it('SVC-09 Check for Updates, Restart to Update and Sync Now report their outcome', async () => {
    const { sys, settings } = world();
    await settings.load();
    await settings.action('updates.check');
    expect(settings.snapshot().updates.state).toBe('idle');
    expect(settings.snapshot().notice?.text).toBe(
      'Plotinium 0.3.0 is up to date. The update service keeps checking in the background.',
    );
    sys.fail('reboot', 'EPERM');
    await settings.action('updates.install');
    expect(settings.snapshot().notice?.text).toMatch(/Could not restart to update: .*EPERM/);
    sys.on('sync.flush', () => ({ remaining: 0 }));
    await settings.action('sync.now');
    expect(settings.snapshot().notice).toEqual({ level: 'info', text: 'Everything is synced.' });
    sys.fail('sync.flush', 'ETIMEDOUT');
    await settings.action('sync.now');
    expect(settings.snapshot().notice?.level).toBe('error');
  });

  it('MEM-01 Restore Defaults puts the memory budget, soft limit and swap tier back', async () => {
    const { sys, settings } = world({
      sysctl: { 'mm.budget': 512 * MB, 'mm.softLimit': 64 * MB, 'mm.swap.tier': 'remote' },
    });
    await settings.load();
    expect(settings.snapshot().values['mm.remoteOnly']).toBe(true);
    await settings.action('memory.restoreDefaults');
    expect(sys.calls('sysctl.set')).toEqual([
      { key: 'mm.budget', value: 256 * MB },
      { key: 'mm.swap.tier', value: 'auto' },
    ]);
    expect(settings.snapshot().values).toMatchObject({
      'mm.budgetMB': 256,
      'mm.remoteOnly': false,
    });
  });
});
