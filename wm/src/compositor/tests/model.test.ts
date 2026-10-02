import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { workArea } from '../geometry.ts';
import { MAX_WINDOWS, WindowModel } from '../model.ts';
import {
  ArrayStackOrder,
  createStackOrder,
  createWindowTable,
  HashWindowTable,
  MapWindowTable,
  ZOrderStack,
} from '../registry.ts';
import type { CoarseEvent, CompositorToKernel } from '../types.ts';

const work = workArea(1_280, 800, { top: 28, bottom: 72 });

function model() {
  const events: CoarseEvent[] = [];
  const kernel: CompositorToKernel[] = [];
  const m = new WindowModel({
    work,
    screen: { x: 0, y: 0, w: 1_280, h: 800 },
    hooks: { onEvent: (e) => events.push(e), onKernel: (k) => kernel.push(k) },
  });
  const open = (wid: number, activation = true) =>
    m.create({
      wid,
      pid: 100 + wid,
      app: `app${String(wid % 3)}`,
      title: `W${String(wid)}`,
      activation,
    });
  return { m, events, kernel, open };
}

describe('window registry and stacking structures', () => {
  it('WM-01 registry get, set and delete work the same on the Map stand-in and the hash table', () => {
    for (const table of [new MapWindowTable<string>(), createWindowTable<string>()]) {
      table.set(7, 'seven');
      expect(table.get(7)).toBe('seven');
      expect(table.has(7)).toBe(true);
      expect(table.size).toBe(1);
      expect(table.values()).toEqual(['seven']);
      expect(table.delete(7)).toBe(true);
      expect(table.get(7)).toBeUndefined();
    }
    expect(
      createWindowTable() instanceof HashWindowTable ||
        createWindowTable() instanceof MapWindowTable,
    ).toBe(true);
  });

  it('WM-02 both stacking implementations renumber identically', () => {
    for (const order of [new ArrayStackOrder(), createStackOrder()]) {
      order.insertTop(1);
      order.insertTop(2);
      order.insertTop(3);
      order.raise(1);
      order.insertBelowTop(4);
      expect(order.bottomToTop()).toEqual([2, 3, 4, 1]);
      expect(order.zOf(1)).toBe(4);
      expect(order.zOf(99)).toBeUndefined();
      expect(order.top()).toBe(1);
      expect(order.topWhere((w) => w < 4)).toBe(1);
      expect(order.topWhere((w) => w > 10)).toBeUndefined();
      order.remove(3);
      order.remove(99);
      order.raise(99);
      expect(order.bottomToTop()).toEqual([2, 4, 1]);
      expect(order.size).toBe(3);
    }
    expect(
      createStackOrder() instanceof ZOrderStack || createStackOrder() instanceof ArrayStackOrder,
    ).toBe(true);
  });
});

describe('window model', () => {
  it('WM-02 clicking a background window raises it and z-indices are exactly 1..n afterwards', () => {
    const { m, open, kernel } = model();
    for (let wid = 1; wid <= 4; wid++) open(wid);
    expect(m.focused).toBe(4);
    expect(m.focus(2)).toBe(true);
    expect(m.windows().map((w) => w.wid)).toEqual([1, 3, 4, 2]);
    expect(m.windows().map((w) => w.z)).toEqual([1, 2, 3, 4]);
    expect(m.get(2)?.focused).toBe(true);
    expect(m.get(4)?.focused).toBe(false);
    expect(kernel.filter((k) => k.t === 'focused').at(-1)).toMatchObject({ t: 'focused', wid: 2 });
    expect(m.focus(2)).toBe(true);
    expect(m.focus(99)).toBe(false);
    m.check();
  });

  it('WMD-09 a window created without user activation opens unfocused below the focused window and flashes', () => {
    const { m, open, events } = model();
    open(1);
    open(2, false);
    expect(m.focused).toBe(1);
    expect(m.windows().map((w) => w.wid)).toEqual([2, 1]);
    expect(m.get(2)?.flags.attention).toBe(true);
    expect(events).toContainEqual({ type: 'attention', wid: 2, on: true });
    m.focus(2);
    expect(m.get(2)?.flags.attention).toBe(false);
    m.attention(2, true);
    expect(m.get(2)?.flags.attention).toBe(false);
    m.attention(1, true);
    expect(m.get(1)?.flags.attention).toBe(true);
  });

  it('WM-04 minimise moves focus to the top-most visible window and restore brings the window back focused', () => {
    const { m, open, kernel } = model();
    open(1);
    open(2);
    expect(m.minimise(2)).toBe(true);
    expect(m.minimise(2)).toBe(false);
    expect(m.focused).toBe(1);
    expect(kernel.some((k) => k.t === 'minimised' && k.wid === 2)).toBe(true);
    m.minimise(1);
    expect(m.focused).toBeNull();
    expect(m.focus(2)).toBe(true);
    expect(m.stateOf(2)).toBe('normal');
    expect(m.focused).toBe(2);
    expect(kernel.some((k) => k.t === 'restored' && k.wid === 2)).toBe(true);
    m.check();
  });

  it('WM-04 double-clicking the title bar maximises and double-clicking again restores the previous rectangle', () => {
    const { m, open } = model();
    const w = open(1);
    if (!w) throw new Error('no window');
    const before = m.rectOf(w);
    expect(m.toggleMaximise(1)).toBe(true);
    expect(m.stateOf(1)).toBe('maximised');
    expect(m.rectOf(w)).toEqual(work);
    expect(m.toggleMaximise(1)).toBe(true);
    expect(m.rectOf(w)).toEqual(before);
    m.minimise(1);
    expect(m.toggleMaximise(1)).toBe(false);
    expect(m.restore(1)).toBe(true);
    expect(m.restore(1)).toBe(false);
    expect(m.toggleMaximise(99)).toBe(false);
  });

  it('WM-04 a minimised maximised window restores to maximised; full screen covers the dock and exits to normal', () => {
    const { m, open } = model();
    const w = open(1);
    if (!w) throw new Error('no window');
    m.maximise(1);
    m.minimise(1);
    m.restore(1);
    expect(m.stateOf(1)).toBe('maximised');
    expect(m.fullscreen(1)).toBe(true);
    expect(m.rectOf(w)).toEqual({ x: 0, y: 0, w: 1_280, h: 800 });
    expect(m.fullscreen(1)).toBe(false);
    m.restore(1);
    expect(m.stateOf(1)).toBe('normal');
    expect(m.maximise(99)).toBe(false);
  });

  it('WM-04 snapping to halves saves the rectangle, maximise via the top zone, and unsnap restores normal', () => {
    const { m, open, events } = model();
    const w = open(1);
    if (!w) throw new Error('no window');
    const before = m.rectOf(w);
    expect(m.snap(1, 'left')).toBe(true);
    expect(m.rectOf(w)).toEqual({ x: 0, y: 28, w: 640, h: 700 });
    expect(w.snap).toBe('left');
    m.snap(1, 'right');
    expect(m.rectOf(w).x).toBe(640);
    expect(m.restore(1)).toBe(true);
    expect(m.rectOf(w)).toEqual(before);
    m.snap(1, 'max');
    expect(m.stateOf(1)).toBe('maximised');
    m.snap(1, 'left');
    expect(m.stateOf(1)).toBe('normal');
    expect(w.snap).toBe('left');
    m.unsnapTo(1, { x: 200, y: 100, w: 500, h: 300 });
    expect(m.rectOf(w)).toEqual({ x: 200, y: 100, w: 500, h: 300 });
    expect(events.filter((e) => e.type === 'snap').length).toBeGreaterThan(2);
    m.unsnapTo(1, { x: 0, y: 0, w: 1, h: 1 });
    expect(m.rectOf(w)).toEqual({ x: 200, y: 100, w: 500, h: 300 });
    expect(m.snap(99, 'left')).toBe(false);
  });

  it('WM-04 a viewport resize re-clamps normal windows and recomputes maximised and snapped ones', () => {
    const { m } = model();
    m.create({ wid: 1, pid: 1, title: 'a', rect: { x: 1_000, y: 600, w: 600, h: 400 } });
    m.create({ wid: 2, pid: 2, title: 'b' });
    m.create({ wid: 3, pid: 3, title: 'c' });
    m.create({ wid: 4, pid: 4, title: 'd' });
    m.maximise(2);
    m.snap(3, 'right');
    m.fullscreen(4);
    const small = workArea(900, 600, { top: 28, bottom: 72 });
    m.setWorkArea(small, { x: 0, y: 0, w: 900, h: 600 });
    expect(m.work).toEqual(small);
    expect(m.rectOf(m.get(2) ?? fail())).toEqual(small);
    expect(m.rectOf(m.get(3) ?? fail())).toEqual({ x: 450, y: 28, w: 450, h: 500 });
    expect(m.rectOf(m.get(4) ?? fail())).toEqual({ x: 0, y: 0, w: 900, h: 600 });
    m.check();
  });

  it('WM-04 moving and resizing apply only to normal windows, and the magnet settles a drag', () => {
    const { m, open } = model();
    const w = open(1);
    if (!w) throw new Error('no window');
    m.moveTo(1, 5, 31);
    m.settle(1);
    expect([w.x, w.y]).toEqual([0, 28]);
    m.setRect(1, { x: 10, y: 40, w: 500, h: 300 }, { cw: 720, ch: 480 });
    expect([w.w, w.cw]).toEqual([500, 720]);
    m.maximise(1);
    m.moveTo(1, 300, 300);
    m.setRect(1, { x: 1, y: 1, w: 400, h: 400 });
    m.settle(1);
    expect(m.rectOf(w)).toEqual(work);
    m.setTitle(1, 'Renamed');
    expect(w.title).toBe('Renamed');
    m.setTitle(99, 'x');
    m.reportGeometry(99);
  });

  it('WM-02 the secure prompt freezes focus', () => {
    const { m, open } = model();
    open(1);
    open(2);
    m.secureOpen = true;
    expect(m.focus(1)).toBe(false);
    open(3);
    expect(m.focused).toBe(2);
    m.secureOpen = false;
  });

  it('WM-01 more than 64 windows or a duplicate wid are refused', () => {
    const { m, open } = model();
    for (let wid = 1; wid <= MAX_WINDOWS; wid++) expect(open(wid)).not.toBeNull();
    expect(open(MAX_WINDOWS + 1)).toBeNull();
    const { m: m2, open: open2 } = model();
    open2(1);
    expect(m2.create({ wid: 1, pid: 1, title: 'dup' })).toBeNull();
    expect(m.size).toBe(MAX_WINDOWS);
  });

  it('WM-02 after 1,000 random open, close, focus, minimise and restore operations z is a permutation of 1..n and at most one window is focused', () => {
    const op = fc.oneof(
      fc.record({
        k: fc.constant('open' as const),
        wid: fc.integer({ min: 1, max: 12 }),
        act: fc.boolean(),
      }),
      fc.record({
        k: fc.constantFrom(
          'close' as const,
          'focus' as const,
          'min' as const,
          'restore' as const,
          'max' as const,
          'snap' as const,
        ),
        wid: fc.integer({ min: 1, max: 12 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 1_000 }), (ops) => {
        const { m } = model();
        for (const o of ops) {
          if (o.k === 'open') m.create({ wid: o.wid, pid: o.wid, title: 't', activation: o.act });
          else if (o.k === 'close') m.close(o.wid);
          else if (o.k === 'focus') m.focus(o.wid);
          else if (o.k === 'min') m.minimise(o.wid);
          else if (o.k === 'restore') m.restore(o.wid);
          else if (o.k === 'max') m.toggleMaximise(o.wid);
          else m.snap(o.wid, 'left');
          m.check();
        }
      }),
      { numRuns: 60 },
    );
  });
});

function fail(): never {
  throw new Error('missing window');
}
