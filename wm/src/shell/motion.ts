/**
 * Window transitions with the Web Animations API (ui-implementation-guide.md §3.5.3–§3.5.5;
 * visual-language-macos.md §3.7.3). The compositor decides WHEN a window opens, closes,
 * minimises, restores or maximises; this animator implements its `AnimationHooks.play` on the
 * window's chrome element with `transform` and `opacity` only, durations and easings resolved
 * from the motion tokens, `will-change` only while running, and no Animation at all under
 * reduced motion (the phase ends at once). Framework-free.
 *
 * Geometry is never animated through `style`: the compositor's flush writes `translate3d` on the
 * window's slot element, and the animation runs on the chrome inside it, so the two transforms
 * compose. Rule 2 of §3.5.5: the final geometry is written first (a synchronous flush), then the
 * animation plays from an offset to identity.
 */
import type { AnimationDetail, AnimationHooks, Rect, WindowPhase } from '../compositor/index.ts';
import type { BoxLike } from './genie.ts';
import { genieTarget } from './genie.ts';

export interface MotionTokens {
  /** 1, or 0 under reduced motion (`--pl-k`). */
  readonly k: number;
  readonly slowMs: number;
  readonly spring: string;
  readonly easeIn: string;
  readonly genie: string;
}

export const FALLBACK_TOKENS: MotionTokens = Object.freeze({
  k: 1,
  slowMs: 320,
  spring: 'cubic-bezier(0.34, 1.36, 0.64, 1)',
  easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
  genie: 'cubic-bezier(0.5, 0, 0.7, 0.4)',
});

/** Durations of the motion table at k = 1 (ms). */
export const WINDOW_MS = Object.freeze({ open: 360, close: 160, flip: 260 });

/** The element API the animator uses (an HTMLElement in the browser, a fake in tests). */
export interface AnimTarget {
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): AnimationLike;
  readonly style: { willChange: string; transformOrigin: string };
  readonly dataset: DOMStringMap;
}

export interface AnimationLike {
  readonly finished: Promise<unknown>;
  cancel(): void;
  finish(): void;
}

export interface AnimatorDeps {
  /** The chrome element of a window (the WindowFrame section), once mounted. */
  element(wid: number): AnimTarget | undefined;
  /** The window's current model rectangle and app (after the compositor's state change). */
  window(wid: number): { rect: Rect; app: string } | undefined;
  /** The dock icon rectangle of an app, read once at animation start (R-READ). */
  dockIcon(app: string): BoxLike | undefined;
  /** Write pending geometry now (the compositor's flush), so the animation starts on it. */
  flush(): void;
  viewportH(): number;
  tokens(): MotionTokens;
  /**
   * The minimise effect the user chose (Settings → Desktop & Dock, read at animation start):
   * `genie` (default) or `scale` (UI-041).
   */
  effect?(): MinimiseEffect;
}

export type MinimiseEffect = 'genie' | 'scale';

export interface WindowAnimator extends AnimationHooks {
  /** Drop the held end frame of a close or minimise once the new state is drawn. */
  release(wid: number): void;
  /** Finish every running animation (reduced motion switched on mid-flight). */
  finishAll(): void;
  readonly running: number;
}

function keyframesFor(
  phase: WindowPhase,
  detail: AnimationDetail,
  genie: { x: number; y: number },
  effect: MinimiseEffect,
): { frames: Keyframe[]; origin: string } {
  const g = genie;
  if (effect === 'scale' && (phase === 'minimising' || phase === 'restoring')) {
    // The Scale effect: the window shrinks straight into its dock icon, no genie warp.
    const small = {
      opacity: 0,
      transform: `translate(${String(g.x)}px, ${String(g.y)}px) scale(0.12)`,
    };
    const full = { opacity: 1, transform: 'none' };
    return { frames: phase === 'minimising' ? [full, small] : [small, full], origin: '50% 100%' };
  }
  switch (phase) {
    case 'opening':
      return {
        frames: [
          { opacity: 0, transform: 'scale(0.94) translateY(10px)' },
          { opacity: 1, transform: 'none' },
        ],
        origin: '50% 60%',
      };
    case 'closing':
      return {
        frames: [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'scale(0.96)' },
        ],
        origin: '50% 50%',
      };
    case 'minimising':
      return {
        frames: [
          { offset: 0, opacity: 1, transform: 'none' },
          {
            offset: 0.45,
            opacity: 0.8,
            transform: `translate(${String(g.x * 0.35)}px, ${String(g.y * 0.55)}px) scale(0.62, 0.8)`,
          },
          {
            offset: 1,
            opacity: 0,
            transform: `translate(${String(g.x)}px, ${String(g.y)}px) scale(0.12)`,
          },
        ],
        origin: '50% 100%',
      };
    case 'restoring':
      return {
        frames: [
          {
            offset: 0,
            opacity: 0,
            transform: `translate(${String(g.x)}px, ${String(g.y)}px) scale(0.12)`,
          },
          {
            offset: 0.55,
            opacity: 0.8,
            transform: `translate(${String(g.x * 0.35)}px, ${String(g.y * 0.45)}px) scale(0.62, 0.8)`,
          },
          { offset: 1, opacity: 1, transform: 'none' },
        ],
        origin: '50% 100%',
      };
    case 'maximising':
    case 'unmaximising': {
      const f = detail.flip ?? { x: 0, y: 0, sx: 1, sy: 1 };
      return {
        frames: [
          {
            transform: `translate(${String(f.x)}px, ${String(f.y)}px) scale(${String(f.sx)}, ${String(f.sy)})`,
          },
          { transform: 'none' },
        ],
        origin: '0 0',
      };
    }
  }
}

function timingFor(
  phase: WindowPhase,
  t: MotionTokens,
  effect: MinimiseEffect,
): { duration: number; easing: string } {
  switch (phase) {
    case 'opening':
      return { duration: WINDOW_MS.open * t.k, easing: t.spring };
    case 'closing':
      return { duration: WINDOW_MS.close * t.k, easing: t.easeIn };
    case 'minimising':
      return { duration: t.slowMs, easing: effect === 'scale' ? t.easeIn : t.genie };
    case 'restoring':
      return { duration: t.slowMs, easing: t.spring };
    case 'maximising':
    case 'unmaximising':
      return { duration: WINDOW_MS.flip * t.k, easing: t.spring };
  }
}

/** Close and minimise hold their last frame until the new state is drawn (no flash back). */
const HOLDS: ReadonlySet<WindowPhase> = new Set<WindowPhase>(['closing', 'minimising']);

export function createWindowAnimator(deps: AnimatorDeps): WindowAnimator {
  const current = new Map<number, AnimationLike>();
  const held = new Map<number, AnimationLike>();

  const start = (
    el: AnimTarget,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): AnimationLike => {
    try {
      return el.animate(frames, options);
    } catch {
      // An easing this engine cannot parse (for example `linear()` in an older browser).
      return el.animate(frames, { ...options, easing: FALLBACK_TOKENS.spring });
    }
  };

  const animator: WindowAnimator = {
    get running(): number {
      return current.size;
    },
    async play(wid, phase, detail) {
      // At most one running animation per window (rule 1): the end state is always valid.
      current.get(wid)?.finish();
      held.get(wid)?.cancel();
      held.delete(wid);
      deps.flush();
      const el = deps.element(wid);
      const tokens = deps.tokens();
      const effect = deps.effect?.() ?? 'genie';
      const timing = timingFor(phase, tokens, effect);
      if (el === undefined || timing.duration <= 0) return; // reduced motion: no Animation (I-DS4)
      const win = deps.window(wid);
      const genie =
        win === undefined
          ? { x: 0, y: deps.viewportH() }
          : genieTarget(win.rect, deps.dockIcon(win.app), deps.viewportH());
      const { frames, origin } = keyframesFor(phase, detail, genie, effect);
      // Open from the dock icon when the Dock launched the window (§3.5.3, UI-156): the point
      // is relative to the frame, whose final geometry the flush above has just written.
      const from = phase === 'opening' ? detail.origin : undefined;
      el.style.transformOrigin =
        from === undefined || win === undefined
          ? origin
          : `${String(Math.round(from.x - win.rect.x))}px ${String(Math.round(from.y - win.rect.y))}px`;
      el.style.willChange = 'transform, opacity';
      el.dataset['animating'] = 'true';
      const anim = start(el, frames, {
        duration: timing.duration,
        easing: timing.easing,
        fill: HOLDS.has(phase) ? 'forwards' : 'backwards',
      });
      current.set(wid, anim);
      try {
        await anim.finished;
      } catch {
        // cancelled: the next command took over
      } finally {
        if (current.get(wid) === anim) current.delete(wid);
        el.style.willChange = '';
        delete el.dataset['animating'];
        if (HOLDS.has(phase)) held.set(wid, anim);
      }
    },
    release(wid) {
      held.get(wid)?.cancel();
      held.delete(wid);
    },
    finishAll() {
      for (const a of current.values()) a.finish();
    },
  };
  return animator;
}

/** Resolve the motion tokens from computed style (once per animation start; cheap). */
export function readMotionTokens(root: Element, reduced: boolean): MotionTokens {
  const cs = root.ownerDocument.defaultView?.getComputedStyle(root);
  if (cs === undefined) return reduced ? { ...FALLBACK_TOKENS, k: 0, slowMs: 0 } : FALLBACK_TOKENS;
  const read = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v === '' ? fallback : v;
  };
  const kRaw = Number.parseFloat(read('--pl-k', '1'));
  const k = reduced ? 0 : Number.isFinite(kRaw) ? kRaw : 1;
  const slow = Number.parseFloat(read('--pl-motion-slow', '320ms'));
  return {
    k,
    slowMs: k === 0 ? 0 : Number.isFinite(slow) ? slow : FALLBACK_TOKENS.slowMs,
    spring: read('--pl-ease-spring', FALLBACK_TOKENS.spring),
    easeIn: read('--pl-ease-in', FALLBACK_TOKENS.easeIn),
    genie: read('--pl-ease-genie', FALLBACK_TOKENS.genie),
  };
}
