import { describe, expect, it } from 'vitest';

import type { PlatformMessage, PlatformWindow } from '../src/boot/platform.ts';
import { forwardPlatformEvents, swEvents } from '../src/boot/platform.ts';
import type { UpdateState } from '../src/sw/update.ts';

function fakeWindow(): PlatformWindow & {
  fire(type: string): void;
  fireDoc(type: string): void;
  frame(): void;
  visibility: DocumentVisibilityState;
  size(w: number, h: number, dpr: number): void;
  listeners(): number;
} {
  const on = new Map<string, Set<() => void>>();
  const onDoc = new Map<string, Set<() => void>>();
  const frames: (() => void)[] = [];
  const add = (m: Map<string, Set<() => void>>, t: string, fn: () => void): void => {
    const set = m.get(t) ?? new Set();
    set.add(fn);
    m.set(t, set);
  };
  const state = { w: 1440, h: 900, dpr: 2, visibility: 'visible' as DocumentVisibilityState };
  const win = {
    get innerWidth() {
      return state.w;
    },
    get innerHeight() {
      return state.h;
    },
    get devicePixelRatio() {
      return state.dpr;
    },
    document: {
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: (t: string, fn: () => void) => {
        add(onDoc, t, fn);
      },
      removeEventListener: (t: string, fn: () => void) => {
        onDoc.get(t)?.delete(fn);
      },
      dispatchEvent: () => true,
    },
    addEventListener: (t: string, fn: () => void) => {
      add(on, t, fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      on.get(t)?.delete(fn);
    },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    fire: (t: string) => {
      for (const fn of on.get(t) ?? []) fn();
    },
    fireDoc: (t: string) => {
      for (const fn of onDoc.get(t) ?? []) fn();
    },
    frame: () => {
      for (const fn of frames.splice(0)) fn();
    },
    get visibility() {
      return state.visibility;
    },
    set visibility(v: DocumentVisibilityState) {
      state.visibility = v;
    },
    size: (w: number, h: number, dpr: number) => {
      state.w = w;
      state.h = h;
      state.dpr = dpr;
    },
    listeners: () => [...on.values(), ...onDoc.values()].reduce((n, set) => n + set.size, 0),
  };
  return win;
}

describe('platform events forwarded to the kernel (SYN-15)', () => {
  it('SYN-15 online, offline, visibility and pagehide are forwarded as router messages', () => {
    const win = fakeWindow();
    const sent: PlatformMessage[] = [];
    forwardPlatformEvents(win, (m) => sent.push(m));
    win.fire('offline');
    win.fire('online');
    win.visibility = 'hidden';
    win.fireDoc('visibilitychange');
    win.visibility = 'visible';
    win.fireDoc('visibilitychange');
    win.fire('pagehide');
    expect(sent).toEqual([
      { t: 'net.offline' },
      { t: 'net.online' },
      { t: 'visibility', state: 'hidden' },
      { t: 'visibility', state: 'visible' },
      { t: 'pagehide' },
    ]);
  });

  it('SYN-15 the viewport is sent when asked, then at most once per frame and only when it changed', () => {
    const win = fakeWindow();
    const sent: PlatformMessage[] = [];
    const fwd = forwardPlatformEvents(win, (m) => sent.push(m));
    fwd.viewport();
    expect(sent).toEqual([{ t: 'viewport', w: 1440, h: 900, dpr: 2 }]);
    win.size(1280, 800, 1);
    win.fire('resize');
    win.fire('resize');
    win.fire('resize');
    expect(sent).toHaveLength(1);
    win.frame();
    expect(sent.at(-1)).toEqual({ t: 'viewport', w: 1280, h: 800, dpr: 1 });
    win.fire('resize');
    win.frame();
    expect(sent).toHaveLength(2);
  });

  it('SYN-15 dispose removes every listener', () => {
    const win = fakeWindow();
    const fwd = forwardPlatformEvents(win, () => undefined);
    expect(win.listeners()).toBe(5);
    fwd.dispose();
    expect(win.listeners()).toBe(0);
  });
});

describe('Service Worker lifecycle for the update service (OFF-05)', () => {
  const base: UpdateState = { phase: 'idle', offlineReady: false, waiting: null, error: null };

  it('OFF-05 each transition is reported once: registered, activated, waiting, error', () => {
    const active: UpdateState = { ...base, phase: 'active', offlineReady: true };
    expect(swEvents(base, { ...base, phase: 'registering' })).toEqual([]);
    expect(swEvents({ ...base, phase: 'registering' }, active)).toEqual([
      'registered',
      'activated',
    ]);
    expect(swEvents(active, active)).toEqual([]);
    const waiting = { ...active, waiting: { version: '0.2.0', build: 'b2', date: '' } };
    expect(swEvents(active, waiting)).toEqual(['waiting']);
    expect(swEvents(waiting, waiting)).toEqual([]);
    expect(swEvents(base, { ...base, phase: 'error', error: 'SecurityError' })).toEqual(['error']);
  });
});
