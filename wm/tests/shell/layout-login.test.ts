import { describe, expect, it, vi } from 'vitest';

import type { WinModel } from '../../src/compositor/index.ts';
import type { AuthEnv, LoginResult, SessionLayout } from '../../src/shell/env.ts';
import {
  Debounce,
  focusTarget,
  restorePlan,
  restoredRect,
  snapshotLayout,
  type Timers,
} from '../../src/shell/layout.ts';
import { DEFAULT_LOGIN_ERROR, LoginFlow, type LoginModel } from '../../src/shell/login-flow.ts';

function model(over: Partial<WinModel> & { wid: number; app: string }): WinModel {
  return {
    pid: 10 + over.wid,
    title: over.app,
    icon: over.app,
    x: 40,
    y: 60,
    w: 640,
    h: 420,
    cw: 640,
    ch: 382,
    z: over.wid,
    state: 'normal',
    prevState: 'normal',
    snap: null,
    restoreRect: null,
    focused: false,
    limits: { minW: 320, minH: 200, maxW: Infinity, maxH: Infinity },
    flags: {
      restoring: false,
      suspended: false,
      crashed: false,
      notResponding: false,
      attention: false,
      closeGuard: null,
      secureStrip: false,
      closing: false,
    },
    dirtyBits: 0,
    createdAt: over.wid,
    ...over,
  };
}

const layoutOf = (windows: SessionLayout['windows'], w = 1440, h = 900): SessionLayout => ({
  v: 1,
  osSessionId: 's',
  uid: 1001,
  savedAt: 0,
  viewport: { w, h, dpr: 1 },
  windows,
});

describe('session layout (WM-06)', () => {
  it('WM-06 snapshots every window bottom to top with argv, state and focus', () => {
    const l = snapshotLayout({
      windows: [
        model({ wid: 1, app: 'terminal' }),
        model({
          wid: 2,
          app: 'files',
          focused: true,
          state: 'maximised',
          restoreRect: { x: 1, y: 2, w: 3, h: 4 },
        }),
      ],
      argv: (wid) => (wid === 2 ? ['/home/student/notes'] : []),
      osSessionId: 'os-1',
      uid: 1001,
      now: 42,
      viewport: { w: 1440, h: 900, dpr: 2 },
    });
    expect(l).toMatchObject({ v: 1, osSessionId: 'os-1', uid: 1001, savedAt: 42 });
    expect(l.viewport).toEqual({ w: 1440, h: 900, dpr: 2 });
    expect(l.windows.map((w) => w.app)).toEqual(['terminal', 'files']);
    expect(l.windows[1]).toMatchObject({
      argv: ['/home/student/notes'],
      state: 'maximised',
      focused: true,
      restoreRect: { x: 1, y: 2, w: 3, h: 4 },
      proc: null,
    });
  });

  it('WM-06 restores in ascending saved z and keeps the same rectangles on the same viewport', () => {
    const work = { x: 0, y: 28, w: 1440, h: 788 };
    const saved = layoutOf([
      { ...snapshotRow('files', 3, { x: 72, y: 132, w: 800, h: 548 }) },
      { ...snapshotRow('terminal', 1, { x: 856, y: 60, w: 556, h: 336 }) },
    ]);
    const plan = restorePlan(saved, { w: 1440, h: 900 }, work);
    expect(plan.map((w) => w.app)).toEqual(['terminal', 'files']);
    expect(plan[1]?.rect).toEqual({ x: 72, y: 132, w: 800, h: 548 });
  });

  it('WM-06 scales rectangles to a smaller viewport and clamps them into the work area', () => {
    const saved = layoutOf(
      [snapshotRow('files', 1, { x: 1000, y: 400, w: 800, h: 400 })],
      2000,
      1000,
    );
    const work = { x: 0, y: 28, w: 1000, h: 388 };
    const [w] = restorePlan(saved, { w: 1000, h: 500 }, work);
    expect(w?.rect.w).toBe(400);
    expect(w?.rect.h).toBe(200);
    expect((w?.rect.x ?? 0) + (w?.rect.w ?? 0)).toBeLessThanOrEqual(1000 + (w?.rect.w ?? 0));
    expect(w?.rect.y).toBeGreaterThanOrEqual(28);
  });

  it('WM-06 recomputes maximised and snapped windows from the work area', () => {
    const work = { x: 0, y: 28, w: 1440, h: 788 };
    const max = {
      ...snapshotRow('files', 1, { x: 0, y: 28, w: 1440, h: 788 }),
      state: 'maximised' as const,
    };
    expect(restoredRect(max, work)).toEqual(work);
    const left = { ...snapshotRow('files', 1, { x: 0, y: 0, w: 1, h: 1 }), snap: 'left' as const };
    expect(restoredRect(left, work)).toEqual({ x: 0, y: 28, w: 720, h: 788 });
    const plain = snapshotRow('files', 1, { x: 5, y: 60, w: 400, h: 300 });
    expect(restoredRect(plain, work)).toEqual({ x: 5, y: 60, w: 400, h: 300 });
  });

  it('WM-06 focuses the saved focused window, else the top-most visible one', () => {
    const a = snapshotRow('a', 1, { x: 0, y: 40, w: 400, h: 300 });
    const b = { ...snapshotRow('b', 2, { x: 0, y: 40, w: 400, h: 300 }), focused: true };
    const c = {
      ...snapshotRow('c', 3, { x: 0, y: 40, w: 400, h: 300 }),
      state: 'minimised' as const,
    };
    expect(focusTarget([a, b, c])).toBe(1);
    expect(focusTarget([a, { ...b, focused: false }, c])).toBe(1);
    expect(focusTarget([c])).toBe(-1);
  });

  it('WM-06 debounces relaxed saves and flushes or cancels on demand', () => {
    vi.useFakeTimers();
    try {
      const timers: Timers = {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      };
      const fn = vi.fn();
      const d = new Debounce(fn, 500, timers);
      d.schedule();
      d.schedule();
      expect(d.pending).toBe(true);
      vi.advanceTimersByTime(499);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      d.schedule();
      d.flush();
      expect(fn).toHaveBeenCalledTimes(2);
      d.flush();
      expect(fn).toHaveBeenCalledTimes(2);
      d.schedule();
      d.cancel();
      vi.advanceTimersByTime(1_000);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(d.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

function snapshotRow(
  app: string,
  z: number,
  rect: { x: number; y: number; w: number; h: number },
): SessionLayout['windows'][number] {
  return {
    app,
    argv: [],
    title: app,
    rect,
    restoreRect: null,
    state: 'normal',
    prevState: 'normal',
    snap: null,
    z,
    focused: false,
    proc: null,
  };
}

// ---------------------------------------------------------------------------------------------

function auth(over: Partial<AuthEnv> = {}): AuthEnv {
  return {
    users: () => [],
    login: (_u, password, report) => {
      report('Checking password');
      return Promise.resolve<LoginResult>(
        password === 'pw'
          ? { ok: true, session: { uid: 1001, user: 'student', kind: 'user' } }
          : { ok: false },
      );
    },
    guest: (id) =>
      Promise.resolve<LoginResult>({ ok: true, session: { uid: 2000, user: id, kind: 'guest' } }),
    ...over,
  };
}

function flow(a: AuthEnv, opts: { now?: () => number; lock?: boolean } = {}) {
  const models: LoginModel[] = [];
  const signedIn = vi.fn();
  const f = new LoginFlow(
    {
      auth: a,
      now: opts.now ?? (() => 0),
      onChange: (m) => models.push(m),
      onSignedIn: signedIn,
      ...(opts.lock === undefined ? {} : { lock: opts.lock }),
    },
    'student',
  );
  return { f, models, signedIn };
}

describe('login flow (BOOT-14, OFF-03)', () => {
  it('BOOT-14 verifies with the stage text, plays the unlock transition, then signs in', async () => {
    const { f, models, signedIn } = flow(auth());
    await f.submit('student', 'pw');
    expect(models.map((m) => m.state)).toEqual(['verifying', 'verifying', 'unlocking']);
    expect(models[1]?.stage).toBe('Checking password');
    expect(f.model.stage).toBe('Loading your desktop');
    expect(signedIn).not.toHaveBeenCalled();
    f.unlocked();
    expect(signedIn).toHaveBeenCalledWith({ uid: 1001, user: 'student', kind: 'user' });
  });

  it('BOOT-14 a wrong password clears and shakes (errorKey bumps) with the generic message', async () => {
    const { f } = flow(auth());
    await f.submit('student', 'nope');
    expect(f.model.state).toBe('error');
    expect(f.model.errorKey).toBe(1);
    expect(f.model.errorText).toBe(DEFAULT_LOGIN_ERROR);
    await f.submit('student', 'nope');
    expect(f.model.errorKey).toBe(2);
    f.select('alice');
    expect(f.model).toMatchObject({ state: 'idle', selectedId: 'alice', errorText: undefined });
  });

  it('BOOT-14 a thrown verifier is reported as a failure, not a crash', async () => {
    const { f } = flow(auth({ login: () => Promise.reject(new Error('network down')) }));
    await f.submit('student', 'pw');
    expect(f.model).toMatchObject({ state: 'error', errorText: 'network down' });
  });

  it('BOOT-14 counts a rate-limit back-off down and leaves it when it ends', async () => {
    let t = 0;
    const { f } = flow(auth({ login: () => Promise.resolve({ ok: false, retryAt: 30_000 }) }), {
      now: () => t,
    });
    await f.submit('student', 'x');
    expect(f.model.state).toBe('rate-limited');
    expect(f.retryInS()).toBe(30);
    await f.submit('student', 'pw');
    expect(f.model.state).toBe('rate-limited');
    t = 29_500;
    f.tick();
    expect(f.retryInS()).toBe(1);
    t = 30_000;
    f.tick();
    expect(f.model.state).toBe('idle');
    expect(f.retryInS()).toBeUndefined();
  });

  it('BOOT-14 the Guest tile signs in without a password', async () => {
    const { f, signedIn } = flow(auth());
    await f.continueWithout('guest');
    expect(f.model.state).toBe('unlocking');
    f.unlocked();
    expect(signedIn).toHaveBeenCalledWith({ uid: 2000, user: 'guest', kind: 'guest' });
  });

  it('BOOT-14 lock mode verifies with auth.unlock and ignores a second submit while busy', async () => {
    const unlock = vi.fn((_u: string, p: string) =>
      Promise.resolve<LoginResult>(
        p === 'pw'
          ? { ok: true, session: { uid: 1001, user: 'student', kind: 'user' } }
          : { ok: false },
      ),
    );
    const login = vi.fn();
    const { f } = flow(auth({ unlock, login }), { lock: true });
    const first = f.submit('student', 'pw');
    const second = f.submit('student', 'pw');
    await Promise.all([first, second]);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
    expect(f.model.state).toBe('unlocking');
    f.unlocked();
  });

  it('BOOT-14 unlocked() before a verified session does nothing', () => {
    const { f, signedIn } = flow(auth());
    f.unlocked();
    expect(signedIn).not.toHaveBeenCalled();
  });
});
