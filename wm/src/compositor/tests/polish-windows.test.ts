/**
 * The polish-wave window fixes in the compositor (docs/design/bug-hunt/BUGS.md, owner fix-windows):
 * default sizes and cascade, the content box after a shrink, the kernel mirror for session
 * restore, restore stacking, snap preview and restore rectangles, narrow viewports and compact
 * mode, the keyboard move/size mode, full screen and the open-animation origin.
 */
import { describe, expect, it } from 'vitest';

import type { AnimationDetail, AnimationHooks } from '../anim.ts';
import { NO_ANIMATION } from '../anim.ts';
import type { CompositorOptions } from '../compositor.ts';
import { createCompositor } from '../compositor.ts';
import { cascadeSlot, maxRect, snapRectFor, workArea } from '../geometry.ts';
import { WindowModel } from '../model.ts';
import type { CompositorToKernel, Rect, WindowPhase } from '../types.ts';
import { fakeContent, fakeFrame, FakeTarget, frameQueue, pointer } from './fakes.ts';

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function rig(extra: Partial<CompositorOptions> = {}, size = { w: 1_280, h: 800 }) {
  const frames = frameQueue();
  const sent: CompositorToKernel[] = [];
  const previews: (Rect | null)[] = [];
  const c = createCompositor({
    viewport: () => ({ w: size.w, h: size.h, dpr: 1 }),
    insets: { top: 28, bottom: 72 },
    raf: frames.raf,
    post: (m) => sent.push(m),
    snapPreview: (r) => previews.push(r),
    ...extra,
  });
  const ch = new MessageChannel();
  c.bindKernelPort(ch.port1);
  const kernelSays = async (msg: unknown): Promise<void> => {
    ch.port2.postMessage(msg);
    await new Promise((r) => setTimeout(r, 5));
  };
  const close = (): void => {
    ch.port1.close();
    ch.port2.close();
  };
  return { c, frames, sent, previews, kernelSays, close, size };
}

const geometry = (sent: CompositorToKernel[], wid: number) =>
  sent.filter(
    (m): m is Extract<CompositorToKernel, { t: 'geometry' }> => m.t === 'geometry' && m.wid === wid,
  );

const SIZES: Record<string, { w: number; h: number }> = {
  files: { w: 960, h: 600 },
  editor: { w: 900, h: 640 },
  terminal: { w: 760, h: 480 },
  taskmgr: { w: 1_160, h: 700 },
  settings: { w: 880, h: 620 },
  about: { w: 780, h: 700 },
};

function model(work: Rect, defaultSize?: (app: string) => { w: number; h: number } | undefined) {
  const kernel: CompositorToKernel[] = [];
  const m = new WindowModel({
    work,
    screen: { x: 0, y: 0, w: work.w, h: work.y + work.h + 72 },
    hooks: { onKernel: (k) => kernel.push(k) },
    ...(defaultSize === undefined ? {} : { defaultSize }),
  });
  return { m, kernel };
}

describe('UI-011 default window sizes', () => {
  it('UI-011 opens each app at its manifest size, cascaded and inside the 1440x900 work area', () => {
    const work = workArea(1_440, 900, { top: 28, bottom: 84 });
    const { m } = model(work, (app) => SIZES[app]);
    const apps = Object.keys(SIZES);
    apps.forEach((app, i) => m.create({ wid: i + 1, pid: i + 1, app, title: app }));
    const ws = m.windows();
    for (const w of ws) {
      expect({ w: w.w, h: w.h }).toEqual(SIZES[w.app]);
      expect(w.x).toBeGreaterThanOrEqual(work.x);
      expect(w.y).toBeGreaterThanOrEqual(work.y);
      expect(w.x + w.w).toBeLessThanOrEqual(work.x + work.w);
      expect(w.y + w.h).toBeLessThanOrEqual(work.y + work.h);
    }
    expect([ws[0]?.x, ws[0]?.y]).toEqual([40, 68]);
    const origins = new Set(ws.map((w) => `${String(w.x)},${String(w.y)}`));
    expect(origins.size).toBe(apps.length);
    m.check();
  });

  it('UI-011 an app without a size keeps 720x480, and a kernel rectangle (a restore) wins', () => {
    const work = workArea(1_280, 800, { top: 28, bottom: 72 });
    const { m } = model(work, (app) => (app === 'files' ? SIZES['files'] : undefined));
    m.create({ wid: 1, pid: 1, app: 'demo', title: 'demo' });
    m.create({
      wid: 2,
      pid: 2,
      app: 'files',
      title: 'files',
      rect: { x: 200, y: 100, w: 500, h: 300 },
    });
    expect(m.rectOf(m.get(1) ?? fail())).toMatchObject({ w: 720, h: 480 });
    expect(m.rectOf(m.get(2) ?? fail())).toEqual({ x: 200, y: 100, w: 500, h: 300 });
  });

  it('UI-011 at 1280x800 a tall window is clamped inside the work area and grows back later (UI-096)', () => {
    const r = rig({ defaultSize: (app) => SIZES[app] }, { w: 1_280, h: 800 });
    const { c } = r;
    c.model.create({ wid: 1, pid: 1, app: 'taskmgr', title: 'Task Manager' });
    const w = c.model.get(1) ?? fail();
    expect(c.model.rectOf(w)).toEqual({ x: 40, y: 28, w: 1_160, h: 700 });
    r.size.h = 700;
    c.viewportChanged();
    expect(c.model.rectOf(w)).toMatchObject({ w: 1_160, h: 600 });
    r.size.h = 900;
    c.viewportChanged();
    expect(c.model.rectOf(w)).toMatchObject({ w: 1_160, h: 700 });
    c.model.check();
    r.close();
  });
});

describe('UI-155 cascade', () => {
  it('UI-155 ten windows get ten distinct origins; the 9th and 10th do not cover the 1st and 2nd', () => {
    const work = workArea(1_280, 800, { top: 28, bottom: 72 });
    const { m } = model(work);
    for (let wid = 1; wid <= 10; wid++) m.create({ wid, pid: wid, title: `W${String(wid)}` });
    const at = (wid: number) => {
      const w = m.get(wid) ?? fail();
      return `${String(w.x)},${String(w.y)}`;
    };
    expect(new Set(Array.from({ length: 10 }, (_, i) => at(i + 1))).size).toBe(10);
    expect(at(9)).not.toBe(at(1));
    expect(at(10)).not.toBe(at(2));
    expect(at(9)).toBe('232,68');
    m.check();
  });

  it('UI-155 a closed window frees its cascade slot', () => {
    const work = workArea(1_280, 800, { top: 28, bottom: 72 });
    const { m } = model(work);
    for (let wid = 1; wid <= 4; wid++) m.create({ wid, pid: wid, title: 't' });
    const third = m.rectOf(m.get(3) ?? fail());
    m.close(3);
    m.create({ wid: 5, pid: 5, title: 't' });
    expect(m.rectOf(m.get(5) ?? fail())).toEqual(third);
  });

  it('UI-155 the slot helper restarts a series at the top, shifted right', () => {
    const work = { x: 0, y: 28, w: 1_280, h: 700 };
    expect(cascadeSlot(0, 720, 480, work)).toEqual({ x: 40, y: 68 });
    expect(cascadeSlot(7, 720, 480, work)).toEqual({ x: 208, y: 236 });
    expect(cascadeSlot(8, 720, 480, work)).toEqual({ x: 232, y: 68 });
    // A window taller than the work area has one row.
    expect(cascadeSlot(2, 720, 900, work)).toEqual({ x: 88, y: 68 });
  });
});

describe('UI-019 content box after a shrink', () => {
  it('UI-019 shrinking from the se handle ends with the content box equal to the frame', () => {
    const r = rig();
    r.c.model.create({ wid: 1, pid: 10, title: 'a', rect: { x: 100, y: 100, w: 500, h: 300 } });
    const el = fakeFrame();
    const content = fakeContent();
    r.c.attach(1, el, content);
    r.frames.run();
    expect([content.style.width, content.style.height]).toEqual(['500px', '300px']);
    const handle = new FakeTarget();
    r.c.resizeStart(1, 'se', pointer(600, 400), handle);
    handle.fire('pointermove', 450, 300);
    r.frames.run();
    // During the gesture the frame shrinks and the content box stays frozen (§3.5).
    expect([el.style.width, el.style.height]).toEqual(['350px', '200px']);
    expect([content.style.width, content.style.height]).toEqual(['500px', '300px']);
    handle.fire('pointerup', 450, 300);
    r.frames.run();
    expect([content.style.width, content.style.height]).toEqual(['350px', '200px']);
    const w = r.c.model.get(1) ?? fail();
    expect([w.cw, w.ch]).toEqual([w.w, w.h]);
    r.close();
  });

  it('UI-019 growing still refits once at the end, and a gesture back to the start size changes nothing', () => {
    const r = rig();
    r.c.model.create({ wid: 1, pid: 10, title: 'a', rect: { x: 100, y: 100, w: 500, h: 300 } });
    const content = fakeContent();
    r.c.attach(1, fakeFrame(), content);
    r.frames.run();
    const handle = new FakeTarget();
    r.c.resizeStart(1, 'se', pointer(600, 400), handle);
    handle.fire('pointermove', 700, 500);
    handle.fire('pointermove', 600, 400);
    handle.fire('pointerup', 600, 400);
    r.frames.run();
    expect([content.style.width, content.style.height]).toEqual(['500px', '300px']);
    r.close();
  });
});

describe('UI-034 the kernel mirror for session restore', () => {
  it('UI-034 a window is reported when it opens, even if it is never moved', async () => {
    const r = rig();
    await r.kernelSays({ t: 'create', wid: 7, pid: 70, app: 'terminal', title: 'T', seq: 1 });
    expect(geometry(r.sent, 7).at(-1)).toMatchObject({
      state: 'normal',
      z: 1,
      snap: null,
      restoreRect: null,
      rect: { x: 40, y: 68, w: 720, h: 480 },
    });
    r.close();
  });

  it('UI-034 raising, minimising, restoring and closing report every z and state that changed', () => {
    const r = rig();
    const { c, sent } = r;
    for (let wid = 1; wid <= 3; wid++) c.model.create({ wid, pid: wid, title: 't' });
    sent.length = 0;
    c.focus(1);
    expect(geometry(sent, 1).at(-1)?.z).toBe(3);
    expect(geometry(sent, 2).at(-1)?.z).toBe(1);
    expect(geometry(sent, 3).at(-1)?.z).toBe(2);
    sent.length = 0;
    c.model.minimise(1);
    expect(geometry(sent, 1).at(-1)?.state).toBe('minimised');
    sent.length = 0;
    c.model.restore(1);
    expect(geometry(sent, 1).at(-1)).toMatchObject({ state: 'normal', z: 3 });
    sent.length = 0;
    c.model.close(2);
    expect(geometry(sent, 1).at(-1)?.z).toBe(2);
    expect(geometry(sent, 3).at(-1)?.z).toBe(1);
    r.close();
  });

  it('UI-034 a snap and a maximise report the snap flag and the rectangle a restore returns to', async () => {
    const r = rig();
    const { c, sent } = r;
    c.model.create({ wid: 1, pid: 1, title: 't', rect: { x: 100, y: 100, w: 500, h: 300 } });
    c.model.snap(1, 'left');
    c.model.reportGeometry(1);
    expect(geometry(sent, 1).at(-1)).toMatchObject({
      state: 'normal',
      snap: 'left',
      rect: { x: 0, y: 28, w: 640, h: 700 },
      restoreRect: { x: 100, y: 100, w: 500, h: 300 },
    });
    await c.toggleMaximise(1);
    expect(geometry(sent, 1).at(-1)).toMatchObject({
      state: 'maximised',
      snap: null,
      restoreRect: { x: 100, y: 100, w: 500, h: 300 },
    });
    r.close();
  });

  it('UI-034 restored windows stack in saved z order whatever order they are created in, without flashing', async () => {
    const r = rig();
    const { c, kernelSays } = r;
    // Saved: A (z 1), B (z 2, focused), C (z 3, minimised). The processes start C, A, B.
    await kernelSays({
      t: 'create',
      wid: 3,
      pid: 3,
      app: 'c',
      title: 'C',
      seq: 1,
      activation: false,
      restore: { z: 3, state: 'minimised' },
    });
    c.model.minimise(3); // the shell applies the saved state
    await kernelSays({
      t: 'create',
      wid: 1,
      pid: 1,
      app: 'a',
      title: 'A',
      seq: 2,
      activation: false,
      restore: { z: 1, state: 'normal' },
    });
    await kernelSays({
      t: 'create',
      wid: 2,
      pid: 2,
      app: 'b',
      title: 'B',
      seq: 3,
      activation: true,
      restore: { z: 2, state: 'normal' },
    });
    expect(c.layout().map((l) => l.wid)).toEqual([1, 2, 3]);
    expect(c.model.focused).toBe(2);
    expect(c.model.windows().some((w) => w.flags.attention)).toBe(false);
    c.model.check();
    r.close();
  });

  it('UI-034 a restored window never covers the focused window (WMD-09)', () => {
    const r = rig();
    const { c } = r;
    c.model.create({ wid: 1, pid: 1, title: 'mine' });
    c.model.create({ wid: 2, pid: 2, title: 'restored', activation: false, restore: { z: 5 } });
    expect(c.layout().map((l) => l.wid)).toEqual([2, 1]);
    expect(c.model.focused).toBe(1);
    c.model.check();
    r.close();
  });

  it('UI-034 a create without a usable saved z is an ordinary window', async () => {
    const r = rig();
    await r.kernelSays({ t: 'create', wid: 1, pid: 1, title: 'a', seq: 1 });
    await r.kernelSays({
      t: 'create',
      wid: 2,
      pid: 2,
      title: 'b',
      seq: 2,
      activation: false,
      restore: { z: 'x' },
    });
    expect(r.c.model.get(2)?.flags.attention).toBe(true);
    expect(r.c.layout().map((l) => l.wid)).toEqual([2, 1]);
    r.close();
  });
});

describe('UI-038 snap preview', () => {
  it('UI-038 shows the target rectangle while the pointer is in a zone and hides it on leaving and at the end', () => {
    const r = rig();
    r.c.model.create({ wid: 1, pid: 1, title: 'a', rect: { x: 300, y: 200, w: 500, h: 300 } });
    const bar = new FakeTarget();
    r.c.titlePointerDown(1, pointer(400, 210), bar);
    bar.fire('pointermove', 200, 300);
    expect(r.previews).toEqual([]);
    bar.fire('pointermove', 4, 300);
    expect(r.previews.at(-1)).toEqual({ x: 0, y: 28, w: 640, h: 700 });
    bar.fire('pointermove', 300, 300);
    expect(r.previews.at(-1)).toBeNull();
    bar.fire('pointermove', 600, 30);
    expect(r.previews.at(-1)).toEqual({ x: 0, y: 28, w: 1_280, h: 700 });
    bar.fire('pointerup', 600, 30);
    expect(r.previews.at(-1)).toBeNull();
    expect(r.c.model.stateOf(1)).toBe('maximised');
    r.close();
  });

  it('UI-038 the preview of a window with a large minimum shows the widened half', () => {
    const r = rig();
    r.c.model.create({
      wid: 1,
      pid: 1,
      title: 'a',
      rect: { x: 300, y: 200, w: 800, h: 400 },
      limits: { minW: 800 },
    });
    const bar = new FakeTarget();
    r.c.titlePointerDown(1, pointer(400, 210), bar);
    bar.fire('pointermove', 1_279, 300);
    expect(r.previews.at(-1)).toEqual({ x: 480, y: 28, w: 800, h: 700 });
    bar.fire('pointerup', 1_279, 300);
    r.close();
  });
});

describe('UI-095 restore after a drag snap', () => {
  it('UI-095 a window dragged into the left half restores to where the drag started', () => {
    const r = rig();
    const start = { x: 40, y: 68, w: 500, h: 300 };
    r.c.model.create({ wid: 1, pid: 1, title: 'a', rect: start });
    const bar = new FakeTarget();
    r.c.titlePointerDown(1, pointer(100, 80), bar);
    bar.fire('pointermove', 60, 200);
    bar.fire('pointermove', 3, 300);
    bar.fire('pointerup', 3, 300);
    const w = r.c.model.get(1) ?? fail();
    expect(w.snap).toBe('left');
    expect(w.restoreRect).toEqual(start);
    r.c.model.restore(1);
    expect(r.c.model.rectOf(w)).toEqual(start);
    r.close();
  });

  it('UI-095 the same holds for the top zone, and for a snapped window dragged into the other half', () => {
    const r = rig();
    const start = { x: 200, y: 150, w: 500, h: 300 };
    r.c.model.create({ wid: 1, pid: 1, title: 'a', rect: start });
    const w = r.c.model.get(1) ?? fail();
    const bar = new FakeTarget();
    r.c.titlePointerDown(1, pointer(300, 160), bar);
    bar.fire('pointermove', 320, 100);
    bar.fire('pointermove', 330, 30);
    bar.fire('pointerup', 330, 30);
    expect(w.state).toBe('maximised');
    expect(w.restoreRect).toEqual(start);
    r.c.model.restore(1);
    r.c.model.snap(1, 'left');
    const bar2 = new FakeTarget();
    r.c.titlePointerDown(1, pointer(300, 40), bar2);
    bar2.fire('pointermove', 700, 300);
    bar2.fire('pointermove', 1_279, 300);
    bar2.fire('pointerup', 1_279, 300);
    expect(w.snap).toBe('right');
    expect(w.restoreRect).toEqual(start);
    r.close();
  });
});

describe('UI-096 narrow viewports', () => {
  it('UI-096 snapped and maximised windows never go below their minimum size', () => {
    const work = workArea(760, 560, { top: 28, bottom: 84 });
    expect(
      snapRectFor('left', work, { minW: 560, minH: 360, maxW: Infinity, maxH: Infinity }),
    ).toEqual({
      x: 0,
      y: 28,
      w: 560,
      h: 448,
    });
    expect(
      snapRectFor('right', work, { minW: 560, minH: 360, maxW: Infinity, maxH: Infinity }),
    ).toEqual({
      x: 200,
      y: 28,
      w: 560,
      h: 448,
    });
    expect(maxRect(work, { minW: 880, minH: 620, maxW: Infinity, maxH: Infinity })).toEqual({
      x: 0,
      y: 28,
      w: 880,
      h: 620,
    });
  });

  it('UI-096 below 800 px every normal window is shown maximised and gets its rectangle and snap back after', () => {
    const r = rig({}, { w: 1_280, h: 800 });
    const { c } = r;
    const m = c.model;
    m.create({ wid: 1, pid: 1, title: 'a', rect: { x: 100, y: 100, w: 500, h: 300 } });
    m.create({ wid: 2, pid: 2, title: 'b', rect: { x: 200, y: 120, w: 520, h: 320 } });
    m.snap(2, 'left');
    m.create({ wid: 3, pid: 3, title: 'c', rect: { x: 300, y: 140, w: 540, h: 340 } });
    m.minimise(3);
    m.create({ wid: 4, pid: 4, title: 'd', rect: { x: 50, y: 60, w: 400, h: 300 } });
    m.maximise(4);
    r.sent.length = 0;
    r.size.w = 760;
    c.viewportChanged();
    expect(m.compact).toBe(true);
    expect([1, 2, 4].map((wid) => m.stateOf(wid))).toEqual(['maximised', 'maximised', 'maximised']);
    expect(m.stateOf(3)).toBe('minimised');
    expect(m.get(3)?.prevState).toBe('maximised');
    // Saved and reported as the user left them, not as compact mode shows them.
    expect(m.persisted(m.get(1) ?? fail())).toMatchObject({
      state: 'normal',
      rect: { x: 100, y: 100, w: 500, h: 300 },
    });
    expect(m.persisted(m.get(2) ?? fail())).toMatchObject({
      state: 'normal',
      snap: 'left',
      restoreRect: { x: 200, y: 120, w: 520, h: 320 },
    });
    expect(geometry(r.sent, 1).at(-1)).toMatchObject({ state: 'normal' });
    // A window opened in compact mode is maximised too.
    m.create({ wid: 5, pid: 5, title: 'e' });
    expect(m.stateOf(5)).toBe('maximised');
    m.check();
    r.size.w = 1_280;
    c.viewportChanged();
    expect(m.compact).toBe(false);
    expect(m.rectOf(m.get(1) ?? fail())).toEqual({ x: 100, y: 100, w: 500, h: 300 });
    expect(m.get(2)?.snap).toBe('left');
    expect(m.get(2)?.restoreRect).toEqual({ x: 200, y: 120, w: 520, h: 320 });
    expect(m.get(3)?.prevState).toBe('normal');
    m.restore(3);
    expect(m.rectOf(m.get(3) ?? fail())).toEqual({ x: 300, y: 140, w: 540, h: 340 });
    expect(m.stateOf(4)).toBe('maximised');
    expect(m.stateOf(5)).toBe('normal');
    m.check();
    r.close();
  });

  it('UI-096 a window larger than the compact work area gets its full size back after compact mode', () => {
    const r = rig({}, { w: 1_280, h: 800 });
    const m = r.c.model;
    const editor = { x: 40, y: 68, w: 900, h: 640 };
    m.create({ wid: 1, pid: 1, title: 'editor', rect: editor });
    m.create({ wid: 2, pid: 2, title: 'minimised', rect: { x: 60, y: 80, w: 900, h: 600 } });
    m.minimise(2);
    r.size.w = 760;
    r.size.h = 560;
    r.c.viewportChanged();
    expect(m.stateOf(1)).toBe('maximised');
    expect(m.persisted(m.get(1) ?? fail()).rect).toEqual(editor);
    // A middle size clamps it (and remembers the wanted size) ...
    r.size.w = 1_024;
    r.size.h = 700;
    r.c.viewportChanged();
    expect(m.stateOf(1)).toBe('normal');
    expect(m.rectOf(m.get(1) ?? fail())).toEqual({ x: 40, y: 68, w: 900, h: 600 });
    // ... and a large one gives it back.
    r.size.w = 1_440;
    r.size.h = 900;
    r.c.viewportChanged();
    expect(m.rectOf(m.get(1) ?? fail())).toEqual(editor);
    m.restore(2);
    expect(m.rectOf(m.get(2) ?? fail())).toEqual({ x: 60, y: 80, w: 900, h: 600 });
    m.check();
    r.close();
  });

  it('UI-096 a maximise round trip while the work area clamps a window keeps its wanted size (verify-a)', () => {
    const r = rig({}, { w: 1_440, h: 900 });
    const m = r.c.model;
    const editor = { x: 64, y: 92, w: 900, h: 640 };
    m.create({ wid: 1, pid: 1, title: 'editor', rect: editor });
    r.size.w = 1_024;
    r.size.h = 700;
    r.c.viewportChanged();
    expect(m.rectOf(m.get(1) ?? fail())).toMatchObject({ w: 900, h: 600 });
    m.maximise(1);
    m.restore(1);
    expect(m.rectOf(m.get(1) ?? fail())).toMatchObject({ w: 900, h: 600 });
    r.size.w = 1_440;
    r.size.h = 900;
    r.c.viewportChanged();
    expect(m.rectOf(m.get(1) ?? fail())).toMatchObject({ w: 900, h: 640 });
    m.check();
    r.close();
  });

  it('UI-096 a snap round trip in compact mode keeps the wanted size for when the viewport grows (verify-a)', () => {
    const r = rig({}, { w: 1_440, h: 900 });
    const m = r.c.model;
    m.create({ wid: 1, pid: 1, title: 'editor', rect: { x: 64, y: 92, w: 900, h: 640 } });
    r.size.w = 760;
    r.size.h = 560;
    r.c.viewportChanged();
    expect(m.stateOf(1)).toBe('maximised');
    m.snap(1, 'left');
    m.restore(1);
    expect(m.stateOf(1)).toBe('normal');
    r.size.w = 1_440;
    r.size.h = 900;
    r.c.viewportChanged();
    expect(m.rectOf(m.get(1) ?? fail())).toMatchObject({ w: 900, h: 640 });
    m.check();
    r.close();
  });

  it('UI-096 a window the user un-maximises in compact mode stays normal when the viewport grows', () => {
    const r = rig({}, { w: 760, h: 800 });
    const m = r.c.model;
    expect(m.compact).toBe(true);
    m.create({ wid: 1, pid: 1, title: 'a' });
    expect(m.stateOf(1)).toBe('maximised');
    m.restore(1);
    expect(m.stateOf(1)).toBe('normal');
    r.size.w = 1_280;
    r.c.viewportChanged();
    expect(m.stateOf(1)).toBe('normal');
    m.check();
    r.close();
  });

  it('UI-096 a minimised maximised window restores to the current work area', () => {
    const r = rig();
    const m = r.c.model;
    m.create({ wid: 1, pid: 1, title: 'a' });
    m.maximise(1);
    m.minimise(1);
    r.size.h = 700;
    r.c.viewportChanged();
    m.restore(1);
    expect(m.rectOf(m.get(1) ?? fail())).toEqual({ x: 0, y: 28, w: 1_280, h: 600 });
    r.close();
  });
});

describe('UI-094 keyboard move, size and full screen', () => {
  it('UI-094 Move steps the window under the clamp rule; Enter keeps it and reports it', () => {
    const r = rig();
    const m = r.c.model;
    m.create({ wid: 1, pid: 1, title: 'a', rect: { x: 100, y: 100, w: 500, h: 300 } });
    const g = r.c.keyboard(1, 'move') ?? fail();
    expect(g.step(16, 0)).toMatchObject({ x: 116, y: 100 });
    expect(g.step(0, -1)).toMatchObject({ x: 116, y: 99 });
    expect(g.step(0, -500)).toMatchObject({ y: 28 });
    expect(r.c.keyboard(1, 'size')).toBeNull(); // one mode at a time
    r.sent.length = 0;
    g.commit();
    expect(g.done).toBe(true);
    expect(geometry(r.sent, 1).at(-1)?.rect).toMatchObject({ x: 116, y: 28 });
    expect(r.c.keyboard(1, 'size')).not.toBeNull();
    r.close();
  });

  it('UI-094 Size moves the right and bottom edges within the limits; Esc restores the start', () => {
    const r = rig();
    const m = r.c.model;
    const start = { x: 100, y: 100, w: 500, h: 300 };
    m.create({ wid: 1, pid: 1, title: 'a', rect: start });
    const g = r.c.keyboard(1, 'size') ?? fail();
    expect(g.step(16, 16)).toEqual({ x: 100, y: 100, w: 516, h: 316 });
    expect(g.step(-1_000, -1_000)).toEqual({ x: 100, y: 100, w: 320, h: 200 });
    g.cancel();
    expect(m.rectOf(m.get(1) ?? fail())).toEqual(start);
    r.close();
  });

  it('UI-094 a snapped window leaves its snap while moving, and Esc snaps it back', () => {
    const r = rig();
    const m = r.c.model;
    const start = { x: 100, y: 100, w: 500, h: 300 };
    m.create({ wid: 1, pid: 1, title: 'a', rect: start });
    m.snap(1, 'right');
    const g = r.c.keyboard(1, 'move') ?? fail();
    expect(m.get(1)?.snap).toBeNull();
    g.step(-16, 0);
    g.cancel();
    expect(m.get(1)?.snap).toBe('right');
    expect(m.get(1)?.restoreRect).toEqual(start);
    m.maximise(1);
    expect(r.c.keyboard(1, 'move')).toBeNull();
    r.close();
  });

  it('UI-094 Full Screen covers the whole viewport and the same command leaves it', async () => {
    const r = rig();
    const m = r.c.model;
    const start = { x: 100, y: 100, w: 500, h: 300 };
    m.create({ wid: 1, pid: 1, title: 'a', rect: start });
    await r.c.toggleFullscreen(1);
    expect(m.stateOf(1)).toBe('fullscreen');
    expect(m.rectOf(m.get(1) ?? fail())).toEqual({ x: 0, y: 0, w: 1_280, h: 800 });
    await r.c.toggleFullscreen(1);
    expect(m.stateOf(1)).toBe('normal');
    expect(m.rectOf(m.get(1) ?? fail())).toEqual(start);
    await r.c.toggleFullscreen(99);
    r.close();
  });
});

describe('UI-040 the work area follows the Dock reserve', () => {
  it('UI-040 insets given as a function are read again on viewportChanged: maximised and snapped windows clear a larger Dock', () => {
    const insets = { top: 28, bottom: 84 };
    const r = rig({ insets: () => ({ ...insets }) }, { w: 1_440, h: 900 });
    const m = r.c.model;
    m.create({ wid: 1, pid: 1, title: 'a', rect: { x: 100, y: 100, w: 500, h: 300 } });
    m.maximise(1);
    m.create({ wid: 2, pid: 2, title: 'b', rect: { x: 200, y: 120, w: 500, h: 300 } });
    m.snap(2, 'right');
    m.create({ wid: 3, pid: 3, title: 'c', rect: { x: 300, y: 500, w: 500, h: 300 } });
    expect(m.rectOf(m.get(1) ?? fail())).toEqual({ x: 0, y: 28, w: 1_440, h: 788 });
    // Settings > Desktop & Dock > Size 80 px: the reserve grows to 112 px.
    insets.bottom = 112;
    r.c.viewportChanged();
    expect(m.work).toEqual({ x: 0, y: 28, w: 1_440, h: 760 });
    expect(m.rectOf(m.get(1) ?? fail())).toEqual({ x: 0, y: 28, w: 1_440, h: 760 });
    expect(m.rectOf(m.get(2) ?? fail())).toEqual({ x: 720, y: 28, w: 720, h: 760 });
    // A normal window keeps its title bar reachable above the Dock (I-WM3).
    const c = m.get(3) ?? fail();
    expect(c.y).toBeLessThanOrEqual(28 + 760 - 38);
    m.check();
    // Automatically hide: only the edge margin stays reserved.
    insets.bottom = 8;
    r.c.viewportChanged();
    expect(m.rectOf(m.get(1) ?? fail())).toMatchObject({ h: 864 });
    m.check();
    r.close();
  });

  it('UI-040 a plain insets object still works and a missing one keeps the 44 px default', () => {
    const r = rig({ insets: { top: 28, bottom: 72 } });
    expect(r.c.model.work).toEqual({ x: 0, y: 28, w: 1_280, h: 700 });
    r.close();
    const frames = frameQueue();
    const bare = createCompositor({
      viewport: () => ({ w: 1_000, h: 700, dpr: 1 }),
      raf: frames.raf,
    });
    expect(bare.model.work).toEqual({ x: 0, y: 0, w: 1_000, h: 656 });
  });
});

describe('UI-083 focusing the bare desktop', () => {
  it('UI-083 focusDesktop leaves no window focused, keeps the stacking, and tells the kernel', () => {
    const r = rig();
    const events: unknown[] = [];
    r.c.subscribe((e) => events.push(e));
    const m = r.c.model;
    m.create({ wid: 1, pid: 1, title: 'a' });
    m.create({ wid: 2, pid: 2, title: 'b' });
    const order = r.c.layout().map((l) => l.wid);
    r.sent.length = 0;
    r.c.focusDesktop();
    expect(m.focused).toBeNull();
    expect(m.windows().some((w) => w.focused)).toBe(false);
    expect(r.c.layout().map((l) => l.wid)).toEqual(order);
    expect(events.at(-1)).toEqual({ type: 'focused', wid: null });
    expect(r.sent.at(-1)).toMatchObject({ t: 'focused', wid: null });
    m.check();
    // A click on the top window focuses it again without changing the order.
    r.c.focus(2);
    expect(m.focused).toBe(2);
    expect(r.c.layout().map((l) => l.wid)).toEqual(order);
    m.check();
    r.close();
  });

  it('UI-083 focusDesktop does nothing while the secure prompt is open or with nothing focused', () => {
    const r = rig();
    const m = r.c.model;
    r.c.focusDesktop();
    expect(m.focused).toBeNull();
    m.create({ wid: 1, pid: 1, title: 'a' });
    m.secureOpen = true;
    r.c.focusDesktop();
    expect(m.focused).toBe(1);
    r.close();
  });
});

describe('UI-156 open animation origin', () => {
  it('UI-156 a window opens from the point the shell gives (its dock icon), restored windows from the default', async () => {
    const played: { phase: WindowPhase; detail: AnimationDetail }[] = [];
    const anim: AnimationHooks = {
      play: (_wid, phase, detail) => {
        played.push({ phase, detail });
        return NO_ANIMATION.play(_wid, phase, detail);
      },
    };
    const r = rig({
      anim,
      openOrigin: (app) => (app === 'files' ? { x: 600, y: 770 } : null),
    });
    await r.kernelSays({ t: 'create', wid: 1, pid: 1, app: 'files', title: 'F', seq: 1 });
    await r.kernelSays({ t: 'create', wid: 2, pid: 2, app: 'terminal', title: 'T', seq: 2 });
    await r.kernelSays({
      t: 'create',
      wid: 3,
      pid: 3,
      app: 'files',
      title: 'F2',
      seq: 3,
      restore: { z: 1 },
    });
    await flushMicro();
    expect(played.filter((p) => p.phase === 'opening').map((p) => p.detail)).toEqual([
      { origin: { x: 600, y: 770 } },
      {},
      {},
    ]);
    r.close();
  });
});

function fail(): never {
  throw new Error('missing value');
}
