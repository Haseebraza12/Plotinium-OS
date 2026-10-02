import { describe, expect, it } from 'vitest';

import { dockDecision, dockItems, type DockWindow } from '../../src/shell/dock-logic.ts';
import type { AppEntry } from '../../src/shell/env.ts';
import { boxOf, flipBetween, genieTarget } from '../../src/shell/genie.ts';
import {
  highlightSwitcher,
  openSwitcher,
  selectedWid,
  stepSwitcher,
  SWITCHER_HOLD_MS,
  switcherVisible,
} from '../../src/shell/switcher.ts';

const app = (id: string, pinned = true): AppEntry => ({
  id,
  title: id[0]?.toUpperCase() + id.slice(1),
  icon: 'files',
  pinned,
  mountView: () => () => undefined,
});

const win = (wid: number, a: string, over: Partial<DockWindow> = {}): DockWindow => ({
  wid,
  app: a,
  state: 'normal',
  focused: false,
  attention: false,
  z: wid,
  ...over,
});

describe('dock content and click semantics (WMD-10)', () => {
  it('WM-02 lists pinned apps in registry order, then running unpinned apps in first-launch order', () => {
    const apps = [app('files'), app('terminal'), app('about', false), app('demo', false)];
    const items = dockItems(apps, [win(1, 'demo'), win(2, 'about'), win(3, 'files')], new Set(), [
      'demo',
      'about',
    ]);
    expect(items.map((i) => i.id)).toEqual(['files', 'terminal', 'demo', 'about']);
    expect(items[0]).toMatchObject({ running: true, windows: 1 });
    expect(items[1]).toMatchObject({ running: false, windows: 0 });
  });

  it('WM-02 marks launching apps and attention on unfocused windows only', () => {
    const items = dockItems(
      [app('files'), app('terminal')],
      [
        win(1, 'files', { attention: true }),
        win(2, 'terminal', { attention: true, focused: true }),
      ],
      new Set(['terminal']),
    );
    expect(items[0]).toMatchObject({ attention: true, launching: false });
    expect(items[1]).toMatchObject({ attention: false, launching: true });
  });

  it('WM-02 launches an app without windows', () => {
    expect(dockDecision('files', [])).toEqual({ kind: 'launch' });
  });

  it('WM-02 one window: focuses it, minimises it when focused, restores it when minimised', () => {
    expect(dockDecision('files', [win(1, 'files')])).toEqual({ kind: 'focus', wid: 1 });
    expect(dockDecision('files', [win(1, 'files', { focused: true })])).toEqual({
      kind: 'minimise',
      wid: 1,
    });
    expect(dockDecision('files', [win(1, 'files', { state: 'minimised' })])).toEqual({
      kind: 'restore',
      wid: 1,
    });
  });

  it('WM-02 several windows: focuses the top one, then offers the group menu', () => {
    const ws = [win(1, 'files', { z: 1 }), win(2, 'files', { z: 3 }), win(3, 'terminal', { z: 2 })];
    expect(dockDecision('files', ws)).toEqual({ kind: 'focus', wid: 2 });
    const focused = [win(1, 'files', { z: 1 }), win(2, 'files', { z: 3, focused: true })];
    expect(dockDecision('files', focused)).toEqual({ kind: 'choose', wids: [2, 1] });
    const allMin = [
      win(1, 'files', { state: 'minimised', z: 1 }),
      win(2, 'files', { state: 'minimised', z: 2 }),
    ];
    expect(dockDecision('files', allMin)).toEqual({ kind: 'restore', wid: 2 });
  });
});

describe('genie target (visual-language-macos.md §3.7.3)', () => {
  it('WM-04 aims the window BOTTOM centre at the dock icon centre', () => {
    const w = { x: 100, y: 100, w: 400, h: 300 };
    const icon = { x: 600, y: 820, width: 52, height: 52 };
    // bottom centre (300, 400) → icon centre (626, 846)
    expect(genieTarget(w, icon, 900)).toEqual({ x: 326, y: 446 });
  });

  it('WM-04 drops straight down to the screen bottom without a dock icon', () => {
    expect(genieTarget({ x: 0, y: 100, w: 200, h: 300 }, undefined, 900)).toEqual({ x: 0, y: 500 });
    expect(genieTarget({ x: 0, y: 700, w: 200, h: 300 }, undefined, 900)).toEqual({ x: 0, y: 0 });
  });

  it('WM-04 maps the FLIP start frame back onto the old rectangle', () => {
    const from = { x: 100, y: 80, w: 400, h: 300 };
    const to = { x: 0, y: 28, w: 1440, h: 788 };
    const f = flipBetween(from, to);
    expect(f.x).toBe(100);
    expect(f.y).toBe(52);
    expect(f.sx).toBeCloseTo(400 / 1440);
    expect(f.sy).toBeCloseTo(300 / 788);
    expect(flipBetween(from, { x: 0, y: 0, w: 0, h: 0 })).toMatchObject({ sx: 1, sy: 1 });
    expect(boxOf(from)).toEqual({ x: 100, y: 80, width: 400, height: 300 });
  });
});

describe('window switcher state', () => {
  it('WM-07 needs two windows and starts on the previous one (a quick tap swaps)', () => {
    expect(openSwitcher([7], 1, 0)).toBeNull();
    const s = openSwitcher([3, 2, 1], 1, 0);
    expect(s === null ? undefined : selectedWid(s)).toBe(2);
    const back = openSwitcher([3, 2, 1], -1, 0);
    expect(back === null ? undefined : selectedWid(back)).toBe(1);
  });

  it('WM-07 steps and wraps in both directions and follows the pointer', () => {
    const s = openSwitcher([3, 2, 1], 1, 0);
    if (s === null) throw new Error('switcher');
    expect(selectedWid(stepSwitcher(s, 1))).toBe(1);
    expect(selectedWid(stepSwitcher(stepSwitcher(s, 1), 1))).toBe(3);
    expect(selectedWid(stepSwitcher(s, -1))).toBe(3);
    expect(selectedWid(highlightSwitcher(s, 1))).toBe(1);
    expect(highlightSwitcher(s, 99)).toBe(s);
  });

  it('WM-07 shows the HUD only after the modifier is held for the threshold', () => {
    const s = openSwitcher([2, 1], 1, 1_000);
    if (s === null) throw new Error('switcher');
    expect(switcherVisible(s, 1_000 + SWITCHER_HOLD_MS - 1)).toBe(false);
    expect(switcherVisible(s, 1_000 + SWITCHER_HOLD_MS)).toBe(true);
  });
});
