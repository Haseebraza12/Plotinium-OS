// @vitest-environment happy-dom
import type { KEvent } from '@plotinium/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AnimationDetail, WindowPhase } from '../../src/compositor/index.ts';
import { captureTarget, contentBox, focusInto, tokenPx, watchMedia } from '../../src/shell/dom.ts';
import type {
  AppEntry,
  KernelEnv,
  ViewContext,
  ViewSysHandlers,
  WindowBinding,
} from '../../src/shell/env.ts';
import {
  createWindowAnimator,
  FALLBACK_TOKENS,
  readMotionTokens,
  type AnimationLike,
  type AnimTarget,
  type MotionTokens,
} from '../../src/shell/motion.ts';
import { DEFAULT_PREFS } from '../../src/shell/prefs.ts';
import {
  cleanTitle,
  createViewHost,
  deniedSys,
  filterBatch,
  topicMatches,
} from '../../src/shell/views.ts';

const binding = (over: Partial<WindowBinding> = {}): WindowBinding => ({
  wid: 3,
  pid: 30,
  app: 'demo',
  viewPort: null,
  display: null,
  argv: ['x'],
  ...over,
});

function host(entry: Partial<AppEntry> | undefined, kernel: KernelEnv = {}) {
  const crashed = vi.fn();
  const setTitle = vi.fn();
  const launch = vi.fn();
  const requestClose = vi.fn();
  const apps = {
    list: () => (entry === undefined ? [] : [entry as AppEntry]),
    get: (id: string) =>
      entry !== undefined && id === 'demo'
        ? ({ id: 'demo', title: 'Demo', icon: 'atom', ...entry } as AppEntry)
        : undefined,
  };
  const h = createViewHost({
    apps,
    kernel,
    theme: () => 'dark',
    requestClose,
    crashed,
    document,
    session: { uid: 1001, user: 'student', kind: 'user' },
    prefs: () => ({
      ...DEFAULT_PREFS,
      theme: 'dark',
      reducedMotion: false,
      frameMeter: false,
      focusMode: false,
      dockMagnification: true,
    }),
    setTitle,
    launch,
  });
  return { h, crashed, setTitle, launch, requestClose };
}

describe('app views in windows (WMD-23)', () => {
  it('WM-01 mounts a view with a context bound to its pid and wid', () => {
    let ctx: ViewContext | undefined;
    const dispose = vi.fn();
    const { h, setTitle, launch, requestClose } = host({
      mountView: (_c, c) => {
        ctx = c;
        return dispose;
      },
    });
    const el = document.createElement('div');
    h.mount(binding(), el);
    expect(ctx).toMatchObject({ pid: 30, wid: 3, app: 'demo', argv: ['x'], container: el });
    expect(ctx?.theme()).toBe('dark');
    expect(ctx?.session.user).toBe('student');
    expect(ctx?.prefs().theme).toBe('dark');
    ctx?.setTitle('a\u0007b');
    expect(setTitle).toHaveBeenCalledWith(3, 'ab');
    ctx?.launch('files');
    expect(launch).toHaveBeenCalledWith('files', []);
    ctx?.requestClose();
    expect(requestClose).toHaveBeenCalledWith(3);
    h.unmount(3);
    expect(dispose).toHaveBeenCalledTimes(1);
    h.unmount(3);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('WM-01 denies every call when the host gave no view-port factory', async () => {
    let ctx: ViewContext | undefined;
    const { h } = host({ mountView: (_c, c) => ((ctx = c), () => undefined) });
    h.mount(binding(), document.createElement('div'));
    await expect(ctx?.sys.call('uname', {})).rejects.toThrow(/EPERM/u);
    await expect(deniedSys('x').call('uname', {})).rejects.toThrow('EPERM: x');
  });

  it('WM-01 routes view-port events, tty output and menu commands to the view', () => {
    let handlers: ViewSysHandlers | undefined;
    const kernel: KernelEnv = {
      viewSys: (_w, hs) => {
        handlers = hs;
        return { closed: false, call: () => Promise.reject(new Error('no')) };
      },
    };
    let ctx: ViewContext | undefined;
    const { h } = host({ mountView: (_c, c) => ((ctx = c), () => undefined) }, kernel);
    h.mount(binding(), document.createElement('div'));
    const events = vi.fn();
    const tty = vi.fn();
    const closed = vi.fn();
    const menu = vi.fn();
    const offEvents = ctx?.onViewEvent('kernel.events', events);
    ctx?.onViewEvent('tty.output', tty);
    ctx?.onViewEvent('view.close', closed);
    ctx?.onMenuCommand(menu);
    const batch = [{ topic: 'proc.exit', seq: 1, t: 0, data: {} }] as unknown as KEvent[];
    handlers?.onEvents(batch);
    handlers?.onTtyOut(new ArrayBuffer(2));
    handlers?.onClose('process-exit');
    expect(events).toHaveBeenCalledWith(batch);
    expect(tty).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith('process-exit');
    offEvents?.();
    handlers?.onEvents(batch);
    expect(events).toHaveBeenCalledTimes(1);
    expect(h.menuCommand(3, 'file', 'new-window')).toBe(true);
    expect(menu).toHaveBeenCalledWith('file', 'new-window');
    expect(h.menuCommand(99, 'file', 'x')).toBe(false);
    const display = new MessageChannel().port1;
    h.attach(3, display);
    expect(ctx?.display).toBe(display);
  });

  it('WM-01 subscribe filters the host feed by topic pattern and stops after unmount', () => {
    const listeners = new Set<(b: readonly KEvent[]) => void>();
    const kernel: KernelEnv = {
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    let ctx: ViewContext | undefined;
    const { h } = host({ mountView: (_c, c) => ((ctx = c), () => undefined) }, kernel);
    h.mount(binding(), document.createElement('div'));
    const got = vi.fn();
    ctx?.subscribe(['proc.*'], got);
    const batch = [
      { topic: 'proc.exit', seq: 1, t: 0, data: {} },
      { topic: 'mem.pressure', seq: 2, t: 0, data: {} },
    ] as unknown as KEvent[];
    for (const l of listeners) l(batch);
    expect(got).toHaveBeenCalledWith([batch[0]]);
    for (const l of listeners) l([batch[1] as KEvent]);
    expect(got).toHaveBeenCalledTimes(1);
    h.dispose();
    for (const l of listeners) l(batch);
    expect(got).toHaveBeenCalledTimes(1);
  });

  it('WMD-23 a view that throws shows "<App> stopped" in its window only and tells the kernel', async () => {
    const { h, crashed } = host({
      mountView: () => {
        throw new Error('boom');
      },
    });
    const el = document.createElement('div');
    h.mount(binding(), el);
    expect(el.textContent).toContain('Demo stopped');
    expect(el.textContent).toContain('boom');
    expect(crashed).toHaveBeenCalledWith(3, 'boom');

    const late = host({ mountView: () => Promise.reject(new Error('chunk failed')) });
    const el2 = document.createElement('div');
    late.h.mount(binding(), el2);
    await Promise.resolve();
    await Promise.resolve();
    expect(el2.querySelector('[role="alert"]')?.textContent).toContain('chunk failed');

    let ctx: ViewContext | undefined;
    const reported = host({ mountView: (_c, c) => ((ctx = c), () => undefined) });
    const el3 = document.createElement('div');
    reported.h.mount(binding(), el3);
    ctx?.reportCrash('bad state');
    expect(el3.textContent).toContain('bad state');
  });

  it('WMD-23 an unknown app and a lazily loaded view unmounted before it loads are handled', async () => {
    const none = host(undefined);
    const el = document.createElement('div');
    none.h.mount(binding({ app: 'ghost' }), el);
    expect(el.textContent).toContain('No app named "ghost"');

    const dispose = vi.fn();
    let resolve: (d: () => void) => void = () => undefined;
    const lazy = host({ mountView: () => new Promise<() => void>((r) => (resolve = r)) });
    lazy.h.mount(binding(), document.createElement('div'));
    lazy.h.unmount(3);
    resolve(dispose);
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('WM-01 topic patterns and titles follow the view-port rules', () => {
    expect(topicMatches(['*'], 'x.y')).toBe(true);
    expect(topicMatches(['proc.*'], 'proc.exit')).toBe(true);
    expect(topicMatches(['proc.*'], 'process')).toBe(false);
    expect(topicMatches(['mem.pressure'], 'mem.pressure')).toBe(true);
    expect(filterBatch(['a'], [{ topic: 'b' } as unknown as KEvent])).toEqual([]);
    expect(cleanTitle('x'.repeat(300))).toHaveLength(200);
    expect(cleanTitle('tab\there')).toBe('tabhere');
  });
});

class FakeAnimation implements AnimationLike {
  finished: Promise<unknown>;
  cancelled = false;
  readonly frames: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  private done: () => void = () => undefined;
  private fail: (e: unknown) => void = () => undefined;
  constructor(frames: Keyframe[], options: KeyframeAnimationOptions) {
    this.frames = frames;
    this.options = options;
    this.finished = new Promise((res, rej) => {
      this.done = () => res(undefined);
      this.fail = rej;
    });
  }
  finish(): void {
    this.done();
  }
  cancel(): void {
    this.cancelled = true;
    this.fail(new Error('AbortError'));
  }
}

function target(): AnimTarget & { anims: FakeAnimation[] } {
  const anims: FakeAnimation[] = [];
  return {
    anims,
    style: { willChange: '', transformOrigin: '' },
    dataset: {},
    animate(frames, options) {
      const a = new FakeAnimation(frames, options);
      anims.push(a);
      return a;
    },
  };
}

function animator(
  tokens: MotionTokens,
  el = target(),
  icon = { x: 600, y: 820, width: 52, height: 52 },
) {
  const flush = vi.fn();
  const a = createWindowAnimator({
    element: () => el,
    window: () => ({ rect: { x: 100, y: 100, w: 400, h: 300 }, app: 'files' }),
    dockIcon: () => icon,
    flush,
    viewportH: () => 900,
    tokens: () => tokens,
  });
  return { a, el, flush };
}

const PROPS_ALLOWED = new Set(['opacity', 'transform', 'offset', 'easing', 'composite']);

describe('window motion with the Web Animations API (WM-03, WM-04)', () => {
  it.each<WindowPhase>([
    'opening',
    'closing',
    'minimising',
    'restoring',
    'maximising',
    'unmaximising',
  ])('WM-03 %s animates transform and opacity only, after a synchronous flush', async (phase) => {
    const { a, el, flush } = animator(FALLBACK_TOKENS);
    const detail: AnimationDetail = { flip: { x: 10, y: 20, sx: 0.5, sy: 0.5 } };
    const p = a.play(1, phase, detail);
    expect(flush).toHaveBeenCalledTimes(1);
    const anim = el.anims[0];
    if (anim === undefined) throw new Error('no animation');
    for (const f of anim.frames)
      for (const k of Object.keys(f)) expect(PROPS_ALLOWED.has(k)).toBe(true);
    expect(el.style.willChange).toBe('transform, opacity');
    expect(el.dataset['animating']).toBe('true');
    expect(Number(anim.options.duration)).toBeGreaterThan(0);
    expect(a.running).toBe(1);
    anim.finish();
    await p;
    expect(el.style.willChange).toBe('');
    expect(el.dataset['animating']).toBeUndefined();
    expect(a.running).toBe(0);
  });

  it('WM-04 minimise ends inside the dock icon, scaled about the bottom centre', async () => {
    const { a, el } = animator(FALLBACK_TOKENS);
    const p = a.play(1, 'minimising', {});
    const anim = el.anims[0];
    expect(el.style.transformOrigin).toBe('50% 100%');
    // bottom centre (300, 400) → icon centre (626, 846)
    expect(anim?.frames.at(-1)?.transform).toBe('translate(326px, 446px) scale(0.12)');
    expect(anim?.options.fill).toBe('forwards');
    anim?.finish();
    await p;
    a.release(1);
    expect(anim?.cancelled).toBe(true);
  });

  it('WM-04 restore starts from the dock icon and settles on the window', async () => {
    const { a, el } = animator(FALLBACK_TOKENS);
    const p = a.play(1, 'restoring', {});
    const anim = el.anims[0];
    expect(anim?.frames[0]?.transform).toBe('translate(326px, 446px) scale(0.12)');
    expect(anim?.frames.at(-1)?.transform).toBe('none');
    expect(anim?.options.fill).toBe('backwards');
    anim?.finish();
    await p;
  });

  it('WM-03 honours reduced motion: no Animation object at all', async () => {
    const { a, el, flush } = animator({ ...FALLBACK_TOKENS, k: 0, slowMs: 0 });
    await a.play(1, 'minimising', {});
    await a.play(1, 'opening', {});
    expect(el.anims).toHaveLength(0);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('WM-03 finishes the running animation of a window before starting the next', async () => {
    const { a, el } = animator(FALLBACK_TOKENS);
    const first = a.play(1, 'opening', {});
    const second = a.play(1, 'maximising', { flip: { x: 0, y: 0, sx: 1, sy: 1 } });
    await first;
    expect(el.anims).toHaveLength(2);
    a.finishAll();
    await second;
    expect(a.running).toBe(0);
  });

  it('WM-03 a cancelled animation still clears will-change', async () => {
    const { a, el } = animator(FALLBACK_TOKENS);
    const p = a.play(1, 'opening', {});
    el.anims[0]?.cancel();
    await p;
    expect(el.style.willChange).toBe('');
  });

  it('WM-03 falls back to a cubic-bezier when the engine rejects the easing', async () => {
    const el = target();
    let calls = 0;
    const picky: AnimTarget = {
      ...el,
      animate(frames, options) {
        calls += 1;
        if (calls === 1) throw new TypeError('bad easing');
        return el.animate(frames, options);
      },
    };
    const { a } = animator(
      { ...FALLBACK_TOKENS, spring: 'linear(0, 1)' },
      picky as AnimTarget & { anims: FakeAnimation[] },
    );
    const p = a.play(1, 'opening', {});
    expect(el.anims[0]?.options.easing).toBe(FALLBACK_TOKENS.spring);
    el.anims[0]?.finish();
    await p;
  });

  it('WM-03 reads the motion tokens from computed style, zeroed under reduced motion', () => {
    const root = document.documentElement;
    root.style.setProperty('--pl-k', '1');
    root.style.setProperty('--pl-motion-slow', '300ms');
    const t = readMotionTokens(root, false);
    expect(t.k).toBe(1);
    expect(t.slowMs).toBe(300);
    const r = readMotionTokens(root, true);
    expect(r.k).toBe(0);
    expect(r.slowMs).toBe(0);
  });
});

describe('DOM adapters', () => {
  it('WM-01 sizes the view below the title bar, or full height for unified chrome', () => {
    const view = document.createElement('div');
    const box = contentBox(view, 38);
    box.style.width = '400px';
    box.style.height = '300px';
    expect(view.style.width).toBe('400px');
    expect(view.style.height).toBe('calc(300px - 38px)');
    box.style.transform = 'translate(1px, 1px)';
    box.style.zIndex = '4';
    expect(box.style.transform).toBe('');
    expect(box.style.zIndex).toBe('');
    const unified = contentBox(view, 0);
    unified.style.height = '300px';
    expect(view.style.height).toBe('300px');
    unified.style.height = '';
    expect(view.style.height).toBe('');
  });

  it('WM-01 wraps pointer listeners so removal removes what was added', () => {
    const el = document.createElement('div');
    const add = vi.spyOn(el, 'addEventListener');
    const remove = vi.spyOn(el, 'removeEventListener');
    const t = captureTarget(el);
    const fn = vi.fn();
    t.addEventListener('pointerup', fn);
    t.removeEventListener('pointerup', fn);
    expect(add.mock.calls[0]?.[1]).toBe(remove.mock.calls[0]?.[1]);
    t.setPointerCapture(99);
  });

  it('WM-07 moves focus into a window: the last focused element, else the first control', () => {
    const section = document.createElement('section');
    const view = document.createElement('div');
    view.setAttribute('data-wm-view', '');
    const input = document.createElement('input');
    const button = document.createElement('button');
    view.append(input, button);
    section.append(view);
    document.body.append(section);
    focusInto(section, button);
    expect(document.activeElement).toBe(button);
    focusInto(section, null);
    expect(document.activeElement).toBe(input);
    view.replaceChildren();
    focusInto(section, null);
    expect(document.activeElement).toBe(section);
    section.remove();
    expect(tokenPx(document.documentElement, '--pl-nope', 28)).toBe(28);
    const m = watchMedia(window, '(prefers-color-scheme: dark)', () => undefined);
    expect(typeof m.matches).toBe('boolean');
    m.stop();
  });
});
