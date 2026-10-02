/**
 * The apps registry (apps/src/registry.ts): descriptors, the program registry the kernel and the
 * executors get (`/bin/<name>.json` manifests and their loaders), and the adapter that turns a
 * descriptor into the desktop shell's app entry with a routed system-call client.
 */
import type { ArgsIn, CallName, KEvent, RetOf } from '@plotinium/protocol';
import { AppManifestSchema, lookupCall } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { SETTINGS_RELAY } from '../../settings/proc.ts';
import { TASKMGR_RELAY } from '../../taskmgr/proc.ts';
import type {
  AppEnv,
  AppHostBindings,
  AppViewContext,
  DisplayPortLike,
  ShellViewContextLike,
} from '../descriptor.ts';
import { BUILTIN_APP_IDS, createMemoryPrefs } from '../descriptor.ts';
import {
  AI_COMMANDS,
  APP_DESCRIPTORS,
  appDescriptor,
  COMMAND_NAMES,
  createShellAppRegistry,
  envFor,
  EXECUTOR_CALLS,
  mountDescriptor,
  PROGRAM_MANIFESTS,
  PROGRAM_MODULES,
  programManifests,
  programModules,
  routedSys,
  SHELL_ENTRY,
  toAppViewContext,
  topicMatches,
} from '../registry.ts';

const ENV: AppEnv = {
  identity: {
    name: 'Plotinium',
    version: '0.3.0',
    build: 'a1f93c2',
    buildDate: '2026-09-24',
    codename: 'Pu',
    abi: 1,
  },
  prefs: createMemoryPrefs(),
  aiAvailable: true,
};

async function validManifest(m: unknown): Promise<boolean> {
  const r = await AppManifestSchema['~standard'].validate(m);
  return r.issues === undefined;
}

interface FakeShell {
  ctx: ShellViewContextLike;
  viewCalls: { name: CallName; args: unknown }[];
  events: Set<(batch: readonly KEvent[]) => void>;
  menu: Set<(menuId: string, itemId: string) => void>;
  closes: number[];
  crashes: unknown[];
  titles: string[];
  launches: [string, readonly string[]][];
}

function fakeShell(opts: { display?: DisplayPortLike | null; own?: boolean } = {}): FakeShell {
  const f: Omit<FakeShell, 'ctx'> = {
    viewCalls: [],
    events: new Set(),
    menu: new Set(),
    closes: [],
    crashes: [],
    titles: [],
    launches: [],
  };
  const container = { nodeName: 'DIV' } as unknown as HTMLElement;
  const base: ShellViewContextLike = {
    pid: 42,
    wid: 7,
    app: 'taskmgr',
    argv: ['memory'],
    container,
    sys: {
      closed: false,
      call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> {
        f.viewCalls.push({ name, args });
        return Promise.resolve({ via: 'view' } as unknown as RetOf<C>);
      },
    },
    display: opts.display ?? null,
    onViewEvent(
      topic: 'kernel.events' | 'tty.output',
      cb: ((batch: readonly KEvent[]) => void) | ((data: ArrayBuffer) => void),
    ) {
      if (topic !== 'kernel.events') return () => undefined;
      const fn = cb as (batch: readonly KEvent[]) => void;
      f.events.add(fn);
      return () => {
        f.events.delete(fn);
      };
    },
    onMenuCommand(cb) {
      f.menu.add(cb);
      return () => {
        f.menu.delete(cb);
      };
    },
    reportCrash(err) {
      f.crashes.push(err);
    },
    theme: () => 'dark',
    requestClose() {
      f.closes.push(f.closes.length + 1);
    },
  };
  const ctx: ShellViewContextLike =
    opts.own === true
      ? {
          ...base,
          setTitle: (t) => {
            f.titles.push(`shell:${t}`);
          },
          launch: (app, argv = []) => {
            f.launches.push([`shell:${app}`, argv]);
          },
          subscribe: (_topics, fn) => {
            f.events.add(fn);
            return () => {
              f.events.delete(fn);
            };
          },
          session: { uid: 65_534, user: 'guest', kind: 'guest' },
        }
      : base;
  return { ...f, ctx };
}

function ev(topic: string): KEvent {
  return { topic, seq: 1, t: 0, data: {} } as unknown as KEvent;
}

// ---------------------------------------------------------------------------------------------
// Descriptors and the program registry
// ---------------------------------------------------------------------------------------------

describe('apps registry', () => {
  it('KPS-07 the built-in apps are listed in Dock order and each names its own valid /bin manifest', async () => {
    expect(APP_DESCRIPTORS.map((d) => d.id)).toEqual([...BUILTIN_APP_IDS]);
    for (const d of APP_DESCRIPTORS) {
      expect(d.manifest.name, d.id).toBe(d.id);
      expect(d.manifest.kind).toBe('app');
      expect(d.manifest.entry, d.id).toMatch(/^apps\//);
      expect(await validManifest(d.manifest), d.id).toBe(true);
      expect(appDescriptor(d.id)).toBe(d);
    }
    expect(appDescriptor('calculator')).toBeUndefined();
  });

  it('KPS-07 every /bin manifest is valid, unique and has a loader, and every loader has a manifest', async () => {
    const names = PROGRAM_MANIFESTS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of PROGRAM_MANIFESTS) expect(await validManifest(m), m.name).toBe(true);
    const entries = PROGRAM_MANIFESTS.map((m) => m.entry).filter(
      (e): e is string => e !== undefined,
    );
    expect(new Set(entries).size).toBe(entries.length);
    expect(Object.keys(PROGRAM_MODULES).sort()).toEqual([...entries].sort());
    expect(names).toContain('sh');
    for (const c of COMMAND_NAMES) expect(names).toContain(c);
    for (const d of ['burn', 'memhog', 'mktree', 'lockdemo', 'idx50k']) expect(names).toContain(d);
    expect(PROGRAM_MANIFESTS.find((m) => m.name === 'sh')?.entry).toBe(SHELL_ENTRY);
  });

  it('KPS-07 every loader resolves to a runnable program (init and run)', async () => {
    for (const [entry, load] of Object.entries(PROGRAM_MODULES)) {
      const p = await load();
      expect(typeof p.init, entry).toBe('function');
      expect(typeof p.run, entry).toBe('function');
    }
  }, 60_000);

  it('SHL-18 the AI-off build has no ai, semsearch or predict program', () => {
    const off = programManifests({ ai: false }).map((m) => m.name);
    for (const c of AI_COMMANDS) expect(off).not.toContain(c);
    expect(Object.keys(programModules({ ai: false }))).not.toContain('apps/coreutils/ai');
    const on = programManifests().map((m) => m.name);
    for (const c of AI_COMMANDS) expect(on).toContain(c);
  });

  it('SYS-01 each relayed call is executor-only and matches the process allow-list', () => {
    expect(appDescriptor('taskmgr')?.relay).toEqual(TASKMGR_RELAY);
    expect(appDescriptor('settings')?.relay).toEqual(SETTINGS_RELAY);
    for (const d of APP_DESCRIPTORS)
      for (const c of d.relay ?? []) expect(lookupCall(c)?.origin, `${d.id} relays ${c}`).toBe('E');
    expect(EXECUTOR_CALLS).toContain('kill');
    expect(EXECUTOR_CALLS).not.toContain('proc.list');
  });

  it('SYS-01 the shell registry lists the apps in Dock order with their chrome and menus', () => {
    const reg = createShellAppRegistry(APP_DESCRIPTORS, { env: () => ENV });
    expect(reg.list().map((e) => e.id)).toEqual([...BUILTIN_APP_IDS]);
    const tm = reg.get('taskmgr');
    expect(tm).toMatchObject({
      title: 'Task Manager',
      icon: 'task-manager',
      pinned: true,
      singleton: true,
    });
    expect(tm?.window.chrome).toBe('unified');
    expect(tm?.menus?.[0]?.id).toBe('view');
    expect(reg.get('about')).toMatchObject({
      pinned: false,
      window: { resizable: false, maximizable: false },
    });
    expect(reg.get('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Routing and the view context
// ---------------------------------------------------------------------------------------------

describe('apps view context', () => {
  it('SYS-01 view-origin calls go to the view port and executor calls to the host execCall as the window', async () => {
    const shell = fakeShell();
    const seen: unknown[] = [];
    const bindings: Pick<AppHostBindings, 'execCall'> = {
      execCall<C extends CallName>(
        win: { pid: number; wid: number; app: string },
        name: C,
        args: ArgsIn<C>,
      ): Promise<RetOf<C>> {
        seen.push({ win, name, args });
        return Promise.resolve({ delivered: 1 } as unknown as RetOf<C>);
      },
    };
    const sys = routedSys(shell.ctx, { pid: 42, wid: 7, app: 'taskmgr' }, bindings);
    await sys.call('proc.list', {});
    await sys.call('kill', { pid: 301, sig: 'SIGTERM' });
    expect(shell.viewCalls.map((c) => c.name)).toEqual(['proc.list']);
    expect(seen).toEqual([
      {
        win: { pid: 42, wid: 7, app: 'taskmgr' },
        name: 'kill',
        args: { pid: 301, sig: 'SIGTERM' },
      },
    ]);
  });

  it('SYS-01 without execCall an allowed executor call is relayed to the process over the display channel', async () => {
    const posted: unknown[] = [];
    const port: DisplayPortLike = {
      onmessage: null,
      postMessage(message) {
        posted.push(message);
        const m = message as { ev: { id: number } };
        queueMicrotask(() => {
          port.onmessage?.({
            data: {
              t: 'reply',
              id: m.ev.id,
              ok: true,
              value: { priority: 20, nice: 5, effPrio: 25 },
            },
          } as MessageEvent);
        });
      },
    };
    const shell = fakeShell({ display: port });
    const sys = routedSys(shell.ctx, { pid: 42, wid: 7, app: 'taskmgr' }, {}, ['setpriority']);
    await expect(sys.call('setpriority', { pid: 9, nice: 5 })).resolves.toEqual({
      priority: 20,
      nice: 5,
      effPrio: 25,
    });
    expect(posted).toEqual([
      {
        t: 'input',
        seq: 1,
        ev: { kind: 'sys', id: 1, call: 'setpriority', args: { pid: 9, nice: 5 } },
      },
    ]);
    // Not in the allow-list: refused locally with ENOSYS, nothing posted.
    await expect(sys.call('reboot', {})).rejects.toMatchObject({ errno: 'ENOSYS' });
    expect(posted).toHaveLength(1);
    sys.dispose();
    expect(port.onmessage).toBeNull();
  });

  it('SYS-01 with neither execCall nor a display channel an executor call fails with ENOSYS, never silently', async () => {
    const sys = routedSys(fakeShell().ctx, { pid: 42, wid: 7, app: 'settings' }, {});
    await expect(sys.call('sysctl.set', { key: 'mm.budget', value: 1 })).rejects.toMatchObject({
      name: 'SysError',
      errno: 'ENOSYS',
    });
  });

  it('WMD-23 the view context filters events by topic, forwards menu commands, crashes and close', async () => {
    const shell = fakeShell();
    const d = appDescriptor('taskmgr');
    if (d === undefined) throw new Error('taskmgr missing');
    const titles: string[] = [];
    const launches: string[] = [];
    const ctx: AppViewContext = toAppViewContext(d, shell.ctx, {
      env: () => ENV,
      launch: (app, argv) => launches.push(`${app} ${argv.join(' ')}`),
      setTitle: (wid, t) => titles.push(`${String(wid)}:${t}`),
    });
    expect(ctx).toMatchObject({ app: 'taskmgr', wid: 7, pid: 42, argv: ['memory'] });
    const got: string[] = [];
    const off = ctx.subscribe(['proc.*', 'mem.fault'], (b) => got.push(...b.map((e) => e.topic)));
    await Promise.resolve();
    expect(shell.viewCalls).toContainEqual({
      name: 'sys.subscribe',
      args: { topics: ['proc.*', 'mem.fault'] },
    });
    for (const fn of shell.events)
      fn([ev('proc.exit'), ev('mem.evict'), ev('mem.fault'), ev('net.state')]);
    expect(got).toEqual(['proc.exit', 'mem.fault']);
    off();
    expect(shell.events.size).toBe(0);

    const items: string[] = [];
    ctx.onMenuCommand((id) => items.push(id));
    for (const fn of shell.menu) fn('view', 'view.memory');
    expect(items).toEqual(['view.memory']);

    ctx.window.setTitle('Task Manager');
    ctx.launch('settings', { argv: ['memory'] });
    ctx.window.close();
    ctx.reportCrash(new Error('boom'));
    expect(titles).toEqual(['7:Task Manager']);
    expect(launches).toEqual(['settings memory']);
    expect(shell.closes).toEqual([1]);
    expect(shell.crashes).toHaveLength(1);
    expect(ctx.theme?.()).toBe('dark');
  });

  it('WMD-23 the shell context own title, launch and event paths win over the host bindings', () => {
    const shell = fakeShell({ own: true });
    const d = appDescriptor('settings');
    if (d === undefined) throw new Error('settings missing');
    const host: string[] = [];
    const ctx = toAppViewContext(d, shell.ctx, {
      env: () => ENV,
      launch: () => host.push('launch'),
      setTitle: () => host.push('title'),
    });
    ctx.window.setTitle('Settings');
    ctx.launch('about');
    const got: string[] = [];
    ctx.subscribe(['update.available'], (b) => got.push(...b.map((e) => e.topic)));
    for (const fn of shell.events) fn([ev('update.available'), ev('proc.spawn')]);
    expect(shell.titles).toEqual(['shell:Settings']);
    expect(shell.launches).toEqual([['shell:about', []]]);
    expect(got).toEqual(['update.available']);
    expect(host).toEqual([]);
    // The guest session reaches the apps when the host did not name the user.
    expect(ctx.env.user).toEqual({ name: 'guest', uid: 65_534, guest: true });
    expect(
      envFor({ ...ENV, user: { name: 'root', uid: 0, guest: false } }, shell.ctx).user?.name,
    ).toBe('root');
  });

  it('WMD-23 mounting loads the view chunk, and a view that throws ends its relay client', async () => {
    const shell = fakeShell();
    const d = appDescriptor('about');
    if (d === undefined) throw new Error('about missing');
    let disposed = 0;
    const ok = await mountDescriptor(
      { ...d, load: () => Promise.resolve(() => () => void disposed++) },
      shell.ctx,
      { env: () => ENV },
    );
    ok();
    expect(disposed).toBe(1);
    await expect(
      mountDescriptor(
        {
          ...d,
          load: () =>
            Promise.resolve(() => {
              throw new Error('view failed');
            }),
        },
        shell.ctx,
        { env: () => ENV },
      ),
    ).rejects.toThrow('view failed');
  });

  it('SYS-01 topic patterns match exact topics, group.* prefixes and *', () => {
    expect(topicMatches('proc.*', 'proc.exit')).toBe(true);
    expect(topicMatches('proc.*', 'process.x')).toBe(false);
    expect(topicMatches('mem.fault', 'mem.fault')).toBe(true);
    expect(topicMatches('mem.fault', 'mem.evict')).toBe(false);
    expect(topicMatches('*', 'anything')).toBe(true);
  });
});
