/**
 * UI-036 (contract C4, WMD-12): the kernel side of `window.setCloseGuard`: the owner's guard reaches
 * the compositor as `{t: 'closeGuard', wid, reason}` (null clears it); another process gets EPERM,
 * an unknown window or an over-long reason EINVAL. The last case makes the real system call
 * through the dispatcher, as the Editor does (apps/editor/lib/close-guard.ts).
 */
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';

import { WindowSetCloseGuardArgs } from '@plotinium/protocol';

import type { Program } from '../../../runtime/sys.ts';
import { errnoOf } from '../../../runtime/sys.ts';
import type { Caller } from '../../ipc/ports.ts';
import { setCloseGuard } from '../../window/syscalls.ts';
import type { World } from './world.ts';
import { bootToDesktop, settle } from './world.ts';

let world: World | null = null;
afterEach(() => {
  world?.close();
  world = null;
});

function opener(out: { wid?: number }): Program<{ wid?: number }> {
  return {
    init: () => out,
    *run(ctx, st) {
      st.wid = (yield* ctx.sys['window.create']({ title: 'Doc' })).wid;
      // Keep the window: this process waits (the test's kernel timer heap never fires it).
      yield* ctx.sleep(1_000_000_000);
      return 0;
    },
  };
}

const guards = (w: World): unknown[] =>
  w.compositor.filter((m) => (m as { t?: string }).t === 'closeGuard');

function errno(f: () => unknown): string | undefined {
  try {
    f();
    return undefined;
  } catch (e) {
    return errnoOf(e) ?? String(e);
  }
}

describe('UI-036 close guards reach the compositor', () => {
  it('UI-036 the owner sets and clears a guard; others get EPERM; unknown windows EINVAL', async () => {
    world = await bootToDesktop();
    const w = world;
    const out: { wid?: number } = {};
    const p = w.lb.spawn(opener(out), { name: 'editor', uid: 65_534, gid: 100 });
    void w.lb.run(p.pid);
    await w.until(() => out.wid !== undefined);
    const wid = out.wid ?? 0;
    const owner: Caller = { pcb: p, origin: 'E', wid: null };
    setCloseGuard(w.io.windows, owner, { wid, reason: 'kernel.ts has unsaved changes' });
    setCloseGuard(w.io.windows, owner, { wid, reason: null });
    await settle();
    expect(guards(w)).toEqual([
      { t: 'closeGuard', wid, reason: 'kernel.ts has unsaved changes' },
      { t: 'closeGuard', wid, reason: null },
    ]);

    const other = w.lb.spawn(opener({}), { name: 'other', uid: 65_534, gid: 100 });
    const stranger: Caller = { pcb: other, origin: 'E', wid: null };
    expect(errno(() => setCloseGuard(w.io.windows, stranger, { wid, reason: 'x' }))).toBe('EPERM');
    expect(errno(() => w.io.windows.setCloseGuard(wid + 999, 'x'))).toBe('EINVAL');
    expect(errno(() => w.io.windows.setCloseGuard(wid, 'x'.repeat(257)))).toBe('EINVAL');
  });

  it('UI-036 a program sets its guard with the window.setCloseGuard system call', async () => {
    world = await bootToDesktop();
    const w = world;
    const out: { wid?: number; done?: boolean } = {};
    const guarded: Program<typeof out> = {
      init: () => out,
      *run(ctx, st) {
        const wid = (yield* ctx.sys['window.create']({ title: 'Doc' })).wid;
        st.wid = wid;
        yield* ctx.sys['window.setCloseGuard']({ wid, reason: 'notes.md has unsaved changes' });
        st.done = true;
        yield* ctx.sleep(1_000_000_000);
        return 0;
      },
    };
    const p = w.lb.spawn(guarded, { name: 'editor', uid: 65_534, gid: 100 });
    void w.lb.run(p.pid);
    await w.until(() => out.done === true);
    await settle();
    expect(guards(w)).toEqual([
      { t: 'closeGuard', wid: out.wid, reason: 'notes.md has unsaved changes' },
    ]);
  });

  it('UI-036 the wire schema of the call (contract C4): wid and a reason of at most 256 or null', () => {
    const ok = (a: unknown): boolean => v.safeParse(WindowSetCloseGuardArgs, a).success;
    expect(ok({ wid: 3, reason: null })).toBe(true);
    expect(ok({ wid: 3, reason: 'x'.repeat(256) })).toBe(true);
    expect(ok({ wid: 3, reason: 'x'.repeat(257) })).toBe(false);
  });
});
