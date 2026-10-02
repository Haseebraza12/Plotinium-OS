import { describe, expect, it } from 'vitest';

import type { AnimationDetail, AnimationHooks } from '../anim.ts';
import { flipFrom, genieTo, NO_ANIMATION } from '../anim.ts';
import { createCompositor } from '../compositor.ts';
import { Flusher } from '../flush.ts';
import { WindowModel } from '../model.ts';
import type { CoarseEvent, CompositorToKernel, WindowPhase } from '../types.ts';
import { DIRTY } from '../types.ts';
import { fakeContent, fakeFrame, FakeTarget, frameQueue, pointer } from './fakes.ts';

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

function rig(anim: AnimationHooks = NO_ANIMATION) {
  const frames = frameQueue();
  const sent: CompositorToKernel[] = [];
  const hints: boolean[] = [];
  const events: CoarseEvent[] = [];
  let t = 0;
  const c = createCompositor({
    viewport: () => ({ w: 1_280, h: 800, dpr: 2 }),
    insets: { top: 28, bottom: 72 },
    raf: frames.raf,
    post: (m) => sent.push(m),
    interactive: (a) => hints.push(a),
    anim,
    dockIcon: (app) => (app === 'files' ? { x: 600, y: 770 } : null),
    now: () => t,
  });
  c.subscribe((e) => events.push(e));
  const ch = new MessageChannel();
  c.bindKernelPort(ch.port1);
  const kernelSays = async (msg: unknown): Promise<void> => {
    ch.port2.postMessage(msg);
    await new Promise((r) => setTimeout(r, 5));
  };
  return { c, frames, sent, hints, events, kernelSays, ch, tick: (ms: number) => (t += ms) };
}

describe('flush', () => {
  it('WM-01 only the flush writes geometry: translate3d, size and z-index in one batch per frame', () => {
    const frames = frameQueue();
    const f = new Flusher(frames.raf, () => 2);
    const m = new WindowModel({
      work: { x: 0, y: 0, w: 1_000, h: 700 },
      hooks: { onDirty: (w) => f.schedule(w) },
    });
    const el = fakeFrame();
    const content = fakeContent();
    const w = m.create({ wid: 1, pid: 1, title: 'a', rect: { x: 10.3, y: 20, w: 500, h: 300 } });
    if (!w) throw new Error('no window');
    f.attach(1, { el, content });
    for (let i = 0; i < 100; i++) m.moveTo(1, 10.3 + i, 20 + i);
    expect(frames.size).toBe(1);
    expect(el.style.transform).toBe('');
    frames.run();
    expect(el.style.transform).toBe('translate3d(109.5px, 119px, 0)');
    expect([el.style.width, el.style.height, el.style.zIndex]).toEqual(['500px', '300px', '1']);
    expect(content.style.width).toBe('500px');
    expect(w.dirtyBits).toBe(0);
    expect(f.stats.flushes).toBe(1);
    // A dirty window with no mounted element is skipped without error.
    const other = m.create({ wid: 2, pid: 2, title: 'b' });
    if (other) f.schedule(other);
    frames.run();
    expect(f.dirtyCount).toBe(0);
    f.detach(1);
    w.dirtyBits = DIRTY.POS;
    f.schedule(w);
    frames.run();
  });
});

describe('compositor', () => {
  it('WM-01 the compositor accepts window commands only on the kernel port it was bound to once', async () => {
    const r = rig();
    expect(() => {
      r.c.bindKernelPort(new MessageChannel().port1);
    }).toThrow(/bound once/);
    await r.kernelSays({ t: 'create', wid: 7, pid: 70, app: 'files', title: 'Files', seq: 1 });
    await r.kernelSays({ t: 'create', wid: -1, pid: 1, title: 'bad', seq: 2 });
    await r.kernelSays('noise');
    expect(r.c.layout().map((l) => l.wid)).toEqual([7]);
    expect(r.events.some((e) => e.type === 'opened' && e.wid === 7)).toBe(true);
    await r.kernelSays({ t: 'setTitle', wid: 7, title: 'Files — home' });
    await r.kernelSays({ t: 'attention', wid: 7, level: 'info' });
    await r.kernelSays({ t: 'restoring', wid: 7, doneBytes: 1, totalBytes: 2 });
    await r.kernelSays({ t: 'focus', wid: 7, seq: 3 });
    expect(r.c.model.get(7)?.title).toBe('Files — home');
    expect(r.events.some((e) => e.type === 'restoring')).toBe(true);
    await r.kernelSays({ t: 'close', wid: 7, seq: 4 });
    await r.kernelSays({ t: 'close', wid: 7, seq: 5 });
    expect(r.c.layout()).toEqual([]);
    r.ch.port1.close();
    r.ch.port2.close();
  });

  it('WMD-05 a drag posts interactive true and false exactly once, toggles dragging, and reports final geometry', () => {
    const r = rig();
    r.c.model.create({ wid: 1, pid: 10, title: 'a', rect: { x: 300, y: 200, w: 500, h: 300 } });
    const el = fakeFrame();
    r.c.attach(1, el, fakeContent());
    const bar = new FakeTarget();
    r.c.titlePointerDown(1, pointer(400, 210), bar);
    expect(bar.captured).toEqual([1]);
    bar.fire('pointermove', 401, 211); // below the 4 px threshold
    expect(r.hints).toEqual([]);
    bar.fire('pointermove', 450, 260);
    bar.fire('pointermove', 500, 300);
    expect(r.hints).toEqual([true]);
    expect(el.classes.has('dragging')).toBe(true);
    expect(el.style.willChange).toBe('transform');
    bar.fire('pointerup', 500, 300);
    bar.fire('pointerup', 500, 300);
    expect(r.hints).toEqual([true, false]);
    expect(el.classes.has('dragging')).toBe(false);
    expect(bar.count('pointermove')).toBe(0);
    expect(r.sent.at(-1)).toEqual({
      t: 'geometry',
      wid: 1,
      rect: { x: 400, y: 290, w: 500, h: 300 },
      state: 'normal',
      z: 1,
      snap: null,
      restoreRect: null,
    });
    r.frames.run();
    expect(el.style.transform).toBe('translate3d(400px, 290px, 0)');
  });

  it('WM-04 dragging to the left edge snaps to the left half and dragging away restores the pre-snap size under the pointer', () => {
    const r = rig();
    r.c.model.create({ wid: 1, pid: 10, title: 'a', rect: { x: 300, y: 200, w: 500, h: 300 } });
    const bar = new FakeTarget();
    r.c.titlePointerDown(1, pointer(400, 210), bar);
    bar.fire('pointermove', 100, 210);
    bar.fire('pointermove', 3, 400);
    bar.fire('pointerup', 3, 400);
    const w = r.c.model.get(1);
    expect(w?.snap).toBe('left');
    expect(r.c.layout()[0]).toMatchObject({ x: 0, y: 28, w: 640, h: 700 });
    const bar2 = new FakeTarget();
    r.c.titlePointerDown(1, pointer(320, 40), bar2);
    bar2.fire('pointermove', 600, 300);
    bar2.fire('lostpointercapture', 600, 300);
    expect(w?.snap).toBeNull();
    expect(r.c.layout()[0]).toMatchObject({ w: 500, h: 300 });
    // The top zone maximises; a right-button press does nothing.
    const bar3 = new FakeTarget();
    r.c.titlePointerDown(1, pointer(600, 300), bar3);
    bar3.fire('pointermove', 640, 30);
    bar3.fire('pointercancel', 640, 30);
    expect(w?.state).toBe('maximised');
    r.c.titlePointerDown(1, pointer(600, 300, 2), new FakeTarget());
    expect(r.c.gestures.current).toBeNull();
  });

  it('WM-04 resizing from the se handle freezes content until the gesture ends and never goes below the minimum', () => {
    const r = rig();
    r.c.model.create({ wid: 1, pid: 10, title: 'a', rect: { x: 100, y: 100, w: 500, h: 300 } });
    const handle = new FakeTarget();
    r.c.resizeStart(1, 'se', pointer(600, 400), handle);
    handle.fire('pointermove', 400, 250);
    const w = r.c.model.get(1);
    expect([w?.w, w?.cw]).toEqual([320, 500]);
    handle.fire('pointermove', 700, 500);
    expect([w?.w, w?.h, w?.cw, w?.ch]).toEqual([600, 400, 600, 400]);
    handle.fire('pointerup', 700, 500);
    expect(r.hints).toEqual([true, false]);
    r.c.model.maximise(1);
    r.c.resizeStart(1, 'nw', pointer(0, 0), new FakeTarget());
    expect(r.c.gestures.current).toBeNull();
    const idle = new FakeTarget();
    r.c.model.restore(1);
    r.c.resizeStart(1, 'n', pointer(10, 10), idle);
    idle.fire('pointerup', 10, 10);
    expect(r.hints).toEqual([true, false, true, false]);
  });

  it('WM-04 title-bar double-click maximises with a FLIP start frame and double-clicking again restores', async () => {
    const played: { wid: number; phase: WindowPhase; detail: AnimationDetail }[] = [];
    const r = rig({
      play: (wid, phase, detail) => {
        played.push({ wid, phase, detail });
        return Promise.resolve();
      },
    });
    r.c.model.create({
      wid: 1,
      pid: 10,
      app: 'files',
      title: 'a',
      rect: { x: 100, y: 100, w: 640, h: 350 },
    });
    r.c.titleDoubleClick(1);
    await flushMicro();
    expect(r.c.model.stateOf(1)).toBe('maximised');
    expect(played.at(-1)).toMatchObject({
      phase: 'maximising',
      detail: { flip: { x: 100, y: 72, sx: 0.5, sy: 0.5 } },
    });
    r.c.titleDoubleClick(1);
    await flushMicro();
    expect(r.c.model.stateOf(1)).toBe('normal');
    expect(played.at(-1)?.phase).toBe('unmaximising');
    await r.c.minimise(1);
    expect(played.at(-1)).toMatchObject({
      phase: 'minimising',
      detail: { genie: { x: 600 - 420, y: 770 - 275 } },
    });
    await r.c.minimise(1);
    await r.c.restore(1);
    expect(played.at(-1)?.phase).toBe('restoring');
    await r.c.toggleMaximise(1);
    await r.c.restore(1);
    expect(played.at(-1)?.phase).toBe('unmaximising');
    await r.c.restore(1);
    await r.c.restore(99);
    await r.c.minimise(99);
    await r.c.toggleMaximise(99);
    expect(r.events.filter((e) => e.type === 'phase' && e.phase === null).length).toBe(
      played.length,
    );
  });

  it('WMD-12 the close button asks the kernel, and input is reported at most once per 100 ms per window', () => {
    const r = rig();
    r.c.model.create({ wid: 1, pid: 10, title: 'a' });
    r.c.requestClose(1);
    r.c.requestClose(99);
    expect(r.sent.filter((m) => m.t === 'closeRequested')).toHaveLength(1);
    r.c.input(1);
    r.c.input(1);
    r.tick(150);
    r.c.input(1);
    expect(r.sent.filter((m) => m.t === 'input')).toHaveLength(2);
    r.c.focus(1);
    r.c.viewportChanged();
    expect(r.c.model.work).toEqual({ x: 0, y: 28, w: 1_280, h: 700 });
  });

  it('WM-04 animation helpers compute FLIP and genie start frames', () => {
    expect(flipFrom({ x: 0, y: 0, w: 100, h: 50 }, { x: 10, y: 20, w: 200, h: 100 })).toEqual({
      x: -10,
      y: -20,
      sx: 0.5,
      sy: 0.5,
    });
    expect(flipFrom({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 0 })).toEqual({
      x: 0,
      y: 0,
      sx: 1,
      sy: 1,
    });
    expect(genieTo({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 500 })).toEqual({ x: 0, y: 450 });
    expect(genieTo({ x: 0, y: 0, w: 100, h: 100 }, null)).toBeUndefined();
  });
});
