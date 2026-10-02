/**
 * UI-035 (WM-06 restore, kernel half): the saved layout keeps every window. The kernel's mirror
 * no longer drops a window whose geometry the compositor has not reported, it stores the snap side
 * and restore rectangle the compositor sends, and the session prefers the compositor's own layout
 * snapshot (limited to windows that still exist) over the mirror.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Program } from '../../../runtime/sys.ts';
import type { LayoutWindow } from '../../window/types.ts';
import { reconcileLayout } from '../session.ts';
import type { World } from './world.ts';
import { bootToDesktop, settle } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

function win(app: string, z: number, x = 10): LayoutWindow {
  return {
    app,
    argv: [app],
    title: app,
    rect: { x, y: 40, w: 600, h: 400 },
    restoreRect: null,
    state: 'normal',
    prevState: 'normal',
    snap: null,
    z,
    focused: false,
    proc: null,
  };
}

/** A process that opens one window (no rectangle) and keeps running. */
function opener(out: { wid?: number }): Program<{ wid?: number }> {
  return {
    init: () => out,
    *run(ctx, st) {
      const w = yield* ctx.sys['window.create']({ title: 'Terminal' });
      st.wid = w.wid;
      yield* ctx.sleep(1_000_000_000);
      return 0;
    },
  };
}

describe('UI-035 the saved layout keeps every window', () => {
  it('UI-035 a window the compositor never measured is kept, and snap and restore come from geometry', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const out: { wid?: number } = {};
    const p = w.lb.spawn(opener(out), { name: 'terminal', uid: 65_534, gid: 100 });
    void w.lb.run(p.pid);
    await w.until(() => out.wid !== undefined);
    const argvOf = (): readonly string[] => ['terminal'];
    const before = w.io.windows.layoutWindows(argvOf);
    expect(before).toHaveLength(1);
    expect(before[0]?.rect).toEqual({ x: 0, y: 0, w: 800, h: 560 });

    w.shellPort.postMessage({
      t: 'geometry',
      wid: out.wid,
      rect: { x: 0, y: 28, w: 720, h: 872 },
      state: 'normal',
      z: 4,
      snap: 'left',
      restoreRect: { x: 100, y: 100, w: 700, h: 450 },
    });
    await settle();
    const after = w.io.windows.layoutWindows(argvOf)[0];
    expect(after).toMatchObject({
      rect: { x: 0, y: 28, w: 720, h: 872 },
      snap: 'left',
      restoreRect: { x: 100, y: 100, w: 700, h: 450 },
    });
    // An older compositor sends neither field: the mirror keeps inferring the restore rectangle.
    w.shellPort.postMessage({
      t: 'geometry',
      wid: out.wid,
      rect: { x: 0, y: 28, w: 1440, h: 872 },
      state: 'maximised',
      z: 4,
    });
    await settle();
    expect(w.io.windows.layoutWindows(argvOf)[0]).toMatchObject({
      state: 'maximised',
      snap: 'left',
      restoreRect: { x: 0, y: 28, w: 720, h: 872 },
    });
  });

  it('UI-035 the compositor snapshot wins, limited to windows that still exist, plus new ones', () => {
    const snapshot = [win('terminal', 2, 11), win('files', 1, 22), win('editor', 3, 33)];
    const live = [win('files', 1, 99), win('terminal', 2, 99), win('taskmgr', 3, 99)];
    const out = reconcileLayout(snapshot, live);
    // Files and Terminal as the compositor saw them (bottom to top), the closed Editor dropped,
    // the Task Manager opened since then appended from the mirror.
    expect(out.map((w) => `${w.app}@${String(w.rect.x)}`)).toEqual([
      'files@22',
      'terminal@11',
      'taskmgr@99',
    ]);
    // Two live Terminals but one in the snapshot: the second comes from the mirror.
    expect(
      reconcileLayout([win('terminal', 1, 5)], [win('terminal', 1, 7), win('terminal', 2, 8)]).map(
        (w) => w.rect.x,
      ),
    ).toEqual([5, 8]);
    // A kernel without its own window table keeps the snapshot.
    expect(reconcileLayout(snapshot, []).map((w) => w.app)).toEqual([
      'files',
      'terminal',
      'editor',
    ]);
  });
});
