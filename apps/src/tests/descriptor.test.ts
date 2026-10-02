/**
 * The app contract helpers (apps/src/descriptor.ts): the window-owning process of the view-driven
 * apps (window-manager.md §3.12), the desktop preference store and its bridge to the shell's own
 * preferences, the appearance switches and the failure helpers views use.
 */
import type { ProgramContext, Sys, SysGen, SysRequest } from '@plotinium/kernel/sys';
import { createSys, SysError, TICK } from '@plotinium/kernel/sys';
import { describe, expect, it } from 'vitest';

import {
  applyAppearance,
  BUILTIN_APP_IDS,
  createMemoryPrefs,
  DEFAULT_PREFS,
  describeFailure,
  errnoOfReason,
  fromShellPrefs,
  isBuiltinAppId,
  isDesktopPrefKey,
  toShellPrefs,
  trySys,
  WINDOW_ENV,
  WINDOW_OWNER_SLEEP_MS,
  windowOwnerProgram,
  type AppSys,
  type DesktopPrefs,
} from '../descriptor.ts';

function* sleepFor(sys: Sys, ms: number): SysGen<void> {
  yield* sys.sleep({ ms });
}

function context(env: Record<string, string> = {}): ProgramContext {
  const sys = createSys();
  return {
    pid: 260,
    ppid: 1,
    pgid: 260,
    sid: 260,
    uid: 1001,
    gid: 1001,
    argv: ['taskmgr'],
    env: new Map(Object.entries(env)),
    cwd: '/home/student',
    tty: null,
    restored: 'no',
    sys,
    tick: TICK,
    now: () => 0,
    sleep: (ms: number) => sleepFor(sys, ms),
    sleepUntil: () => sleepFor(sys, 0),
  };
}

function isRequest(y: unknown): y is SysRequest {
  return typeof y === 'object' && y !== null && 'call' in y;
}

const SPEC = { app: 'about', title: 'About Plotinium', icon: 'atom', width: 780, height: 700 };

describe('app contract', () => {
  it('WM-03 the window owner creates its window with a bounded minimum size, then sleeps without timers', () => {
    const program = windowOwnerProgram(SPEC);
    const st = program.init([]);
    const gen = program.run(context(), st);
    const first = gen.next();
    expect(isRequest(first.value) && first.value.call).toBe('window.create');
    expect(isRequest(first.value) && first.value.args).toEqual({
      title: 'About Plotinium',
      icon: 'atom',
      minSize: { w: 320, h: 240 },
      restoreKey: 'about',
    });
    const second = gen.next({ wid: 9, rect: { x: 0, y: 0, w: 780, h: 700 } });
    expect(st.wid).toBe(9);
    expect(isRequest(second.value) && second.value).toEqual({
      call: 'sleep',
      args: { ms: WINDOW_OWNER_SLEEP_MS },
    });
    gen.next(undefined);
    expect(st.wakes).toBe(1);
    // A caught signal cancels the sleep (ECANCELED): the owner keeps its window and sleeps again.
    const again = gen.throw(new SysError('ECANCELED'));
    expect(isRequest(again.value) && again.value.call).toBe('sleep');
    expect(st.wakes).toBe(2);
    // Anything else ends the process (the window closes with it).
    expect(() => gen.throw(new SysError('EIO'))).toThrow(SysError);
  });

  it('WM-03 a window the host already bound (PLT_WINDOW) is adopted, and a refused window.create is recorded', () => {
    const program = windowOwnerProgram(SPEC);
    const bound = program.init([]);
    const g1 = program.run(context({ [WINDOW_ENV]: '14' }), bound);
    const r1 = g1.next();
    expect(isRequest(r1.value) && r1.value.call).toBe('sleep');
    expect(bound.wid).toBe(14);

    const refused = program.init([]);
    const g2 = program.run(context(), refused);
    g2.next();
    const r2 = g2.throw(new SysError('ENOSYS', 'window system calls are not wired'));
    expect(isRequest(r2.value) && r2.value.call).toBe('sleep');
    expect(refused.wid).toBeNull();
    expect(refused.windowError).toBe('window system calls are not wired (ENOSYS)');
    expect(program.checkpointable).toBe(true);
  });

  it('DSN-05 the preference store applies before it commits, and notifies after', async () => {
    const applied: string[] = [];
    const prefs = createMemoryPrefs({ 'dock.size': 60 }, (_p, key) => {
      applied.push(key);
    });
    const seen: DesktopPrefs[] = [];
    const off = prefs.subscribe((p) => seen.push(p));
    expect(prefs.get()['dock.size']).toBe(60);
    await prefs.set('appearance.accent', 'green');
    expect(prefs.get()['appearance.accent']).toBe('green');
    expect(applied).toEqual(['appearance.accent']);
    expect(seen).toHaveLength(1);
    off();
    await prefs.set('appearance.accent', 'blue');
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(prefs.get())).toBe(true);
    expect(isDesktopPrefKey('telemetry.sync')).toBe(true);
    expect(isDesktopPrefKey('mm.budgetMB')).toBe(false);
    expect(DEFAULT_PREFS['telemetry.sync']).toBe(false);
  });

  it('DSN-05 appearance sets data-theme, data-motion, data-transparency and data-accent', () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    applyAppearance(root, {
      ...DEFAULT_PREFS,
      'appearance.theme': 'light',
      'appearance.reduceMotion': 'always',
      'appearance.reduceTransparency': 'always',
      'appearance.accent': 'pink',
    });
    expect(root.dataset).toEqual({
      theme: 'light',
      motion: 'reduce',
      transparency: 'reduce',
      accent: 'pink',
    });
    applyAppearance(root, DEFAULT_PREFS);
    expect(root.dataset).toEqual({ accent: 'violet' });
  });

  it('DSN-05 the shell preference bridge round-trips theme, reduced motion and magnification', () => {
    const shell = toShellPrefs({
      ...DEFAULT_PREFS,
      'appearance.theme': 'dark',
      'appearance.reduceMotion': 'always',
    });
    expect(shell).toEqual({
      theme: 'dark',
      reducedMotion: true,
      dockMagnification: true,
      clock24h: true,
      dockSize: 52,
      dockMagnifiedScale: 1.45,
      dockAutoHide: false,
      dockIndicators: true,
      titleDoubleClick: 'zoom',
      minimiseEffect: 'genie',
    });
    expect(fromShellPrefs(shell, DEFAULT_PREFS)).toEqual({
      'appearance.theme': 'dark',
      'appearance.reduceMotion': 'always',
    });
    expect(
      fromShellPrefs(
        { theme: 'system', reducedMotion: false, dockMagnification: false },
        DEFAULT_PREFS,
      ),
    ).toEqual({
      'dock.magnification': false,
    });
  });

  it('SYS-01 failures keep their errno and text; trySys never rejects', async () => {
    expect(errnoOfReason(new SysError('EPERM'))).toBe('EPERM');
    expect(errnoOfReason({ errno: 3 })).toBeUndefined();
    expect(errnoOfReason('boom')).toBeUndefined();
    expect(describeFailure(new SysError('EACCES', 'permission denied'))).toBe(
      'permission denied (EACCES)',
    );
    expect(describeFailure({ errno: 'ENOSYS', message: '' })).toBe('ENOSYS');
    expect(describeFailure(new Error('plain'))).toBe('plain');
    const sys: AppSys = {
      call: (name) =>
        name === 'uname'
          ? Promise.reject(new SysError('ENOSYS'))
          : Promise.resolve({ pid: 7 } as never),
    };
    expect(await trySys(sys, 'uname', {})).toMatchObject({ ok: false, errno: 'ENOSYS' });
    expect(await trySys(sys, 'getpid', {})).toEqual({ ok: true, value: { pid: 7 } });
    expect(BUILTIN_APP_IDS.every(isBuiltinAppId)).toBe(true);
    expect(isBuiltinAppId('calculator')).toBe(false);
  });
});
