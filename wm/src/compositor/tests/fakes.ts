/** DOM-free doubles: fake frame elements and a fake pointer-capture target. */
import type { FrameElement } from '../compositor.ts';
import type { StyleTarget } from '../flush.ts';
import type { CaptureTarget, PointerLike } from '../gestures.ts';

export function fakeFrame(): FrameElement & { classes: Set<string> } {
  const classes = new Set<string>();
  return {
    style: { transform: '', width: '', height: '', zIndex: '', willChange: '' },
    classList: {
      toggle(token: string, force?: boolean): boolean {
        const on = force ?? !classes.has(token);
        if (on) classes.add(token);
        else classes.delete(token);
        return on;
      },
    },
    classes,
  };
}

export function fakeContent(): StyleTarget {
  return { style: { transform: '', width: '', height: '', zIndex: '' } };
}

type Fn = (ev: PointerLike) => void;

export class FakeTarget implements CaptureTarget {
  captured: number[] = [];
  private readonly listeners = new Map<string, Set<Fn>>();

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  addEventListener(type: string, fn: Fn): void {
    const set = this.listeners.get(type) ?? new Set<Fn>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: Fn): void {
    this.listeners.get(type)?.delete(fn);
  }

  fire(
    type: 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
    x: number,
    y: number,
  ): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(pointer(x, y));
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export function pointer(x: number, y: number, button = 0): PointerLike {
  return { clientX: x, clientY: y, pointerId: 1, button };
}

/** A manual animation-frame queue. */
export function frameQueue(): {
  raf: (cb: () => void) => number;
  run(): number;
  readonly size: number;
} {
  const q: (() => void)[] = [];
  return {
    raf: (cb) => q.push(cb),
    run: () => {
      const n = q.length;
      for (const cb of q.splice(0)) cb();
      return n;
    },
    get size() {
      return q.length;
    },
  };
}
