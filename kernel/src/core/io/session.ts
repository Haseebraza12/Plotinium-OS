/**
 * The `session` service's port: the `os_session` layout (window-manager.md §3.15, §4.6; WM-06;
 * boot-and-services.md §3.2 stage 6).
 *
 * - restore: a new OS session id; the newest stored layout of the console uid is validated with
 *   Valibot; a valid one queues its windows (ascending z) so each app's next window reopens with
 *   its saved rectangle and state, and the apps are relaunched after desktop-interactive (not in
 *   safe mode: frames only, no autostart, BOOT-06); an invalid one is kept under
 *   `<id>.recovery-<bootId>`, the user is told, and a clean session starts.
 * - save: after any coarse window change (500 ms trailing debounce, relaxed durability), and at
 *   shutdown (strict, BOOT-12). Windows still waiting to be relaunched stay in the saved layout.
 */
import type { BootProfile, KernelTimers, SessionPort, SessionRestored } from '@plotinium/services';
import { uuidv7 } from '@plotinium/protocol';
import * as v from 'valibot';

import type { FsStore } from '../fs/store.ts';
import type { Kernel } from '../kernel.ts';
import type { Windows } from '../window/service.ts';
import type { LayoutWindow, SessionLayout } from '../window/types.ts';
import { SessionLayoutSchema } from '../window/types.ts';
import type { ConsoleSession } from './login.ts';

export const LAYOUT_DEBOUNCE_MS = 500;
/** Layouts kept per uid (the newest is restored; older ones are for recovery). */
export const LAYOUTS_KEPT = 3;

export interface SessionIoDeps {
  readonly kernel: Kernel;
  readonly windows: Windows;
  readonly timers: KernelTimers;
  readonly store: () => FsStore | null;
  readonly console: () => ConsoleSession | null;
  readonly bootId: () => string;
  readonly epochMs: () => number;
  /** Relaunch an app for the console user (the spawner); absent: frames wait for a manual start. */
  readonly launch?: (app: string, argv: readonly string[]) => void;
  readonly notify: (title: string, body: string) => void;
}

/**
 * The compositor's layout snapshot `comp`, kept only for windows that still exist: per app, at
 * most as many entries as the kernel's live window table has (the snapshot is debounced, so a
 * window closed since is dropped). Live windows the snapshot does not have yet (opened since) are
 * appended from the kernel's mirror. Bottom to top. A kernel with no window table of its own
 * (`live` empty) keeps the snapshot as it is.
 */
export function reconcileLayout(
  comp: readonly LayoutWindow[],
  live: readonly LayoutWindow[],
): LayoutWindow[] {
  if (live.length === 0) return [...comp].sort((a, b) => a.z - b.z);
  const liveCount = new Map<string, number>();
  for (const w of live) liveCount.set(w.app, (liveCount.get(w.app) ?? 0) + 1);
  const used = new Map<string, number>();
  const out: LayoutWindow[] = [];
  for (const w of [...comp].sort((a, b) => a.z - b.z)) {
    const n = used.get(w.app) ?? 0;
    if (n >= (liveCount.get(w.app) ?? 0)) continue;
    used.set(w.app, n + 1);
    out.push(w);
  }
  for (const [app, count] of liveCount) {
    const have = used.get(app) ?? 0;
    if (count > have) out.push(...live.filter((w) => w.app === app).slice(have));
  }
  return out;
}

export class SessionIo implements SessionPort {
  private readonly deps: SessionIoDeps;
  private pending: LayoutWindow[] = [];
  private osSession = '';
  private profile: BootProfile = 'normal';
  private debounce: number | null = null;
  private viewport = { w: 0, h: 0, dpr: 1 };
  private started = false;
  private compositorLayout: SessionLayout | null = null;

  constructor(deps: SessionIoDeps) {
    this.deps = deps;
  }

  get osSessionId(): string {
    return this.osSession;
  }

  /** Windows still waiting for their app (restore queue). */
  get queued(): readonly LayoutWindow[] {
    return this.pending;
  }

  setViewport(w: number, h: number, dpr: number): void {
    this.viewport = { w, h, dpr };
  }

  async restore(profile: BootProfile): Promise<SessionRestored> {
    this.profile = profile;
    const user = this.deps.console();
    const store = this.deps.store();
    this.osSession = uuidv7();
    this.deps.kernel.osSessionId = this.osSession;
    this.started = true;
    if (user === null || store === null)
      return { osSessionId: this.osSession, windows: 0, recovered: false, source: 'clean' };
    const rows = await store.getByIndex<unknown>('os_sessions', 'by_uid', user.uid);
    const candidates = rows
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .filter((r) => r['recoveryOf'] === undefined)
      .sort((a, b) => Number(b['savedAt'] ?? 0) - Number(a['savedAt'] ?? 0));
    const newest = candidates[0];
    if (newest === undefined)
      return { osSessionId: this.osSession, windows: 0, recovered: false, source: 'clean' };
    const parsed = v.safeParse(SessionLayoutSchema, newest);
    if (!parsed.success) {
      const old = typeof newest['osSessionId'] === 'string' ? newest['osSessionId'] : 'unknown';
      const kept = {
        ...newest,
        osSessionId: `${old}.recovery-${this.deps.bootId()}`,
        recoveryOf: old,
        uid: user.uid,
      };
      await store.tx(
        ['os_sessions'],
        'strict',
        (t) => {
          t.put('os_sessions', kept);
          if (old !== 'unknown') t.del('os_sessions', old);
        },
        { label: 'layout kept for recovery' },
      );
      this.deps.notify(
        'Your previous desktop could not be restored',
        'It was kept for recovery. A clean session was started.',
      );
      return { osSessionId: this.osSession, windows: 0, recovered: true, source: 'clean' };
    }
    this.pending = [...parsed.output.windows].sort((a, b) => a.z - b.z);
    return {
      osSessionId: this.osSession,
      windows: this.pending.length,
      recovered: false,
      source: 'layout',
    };
  }

  /**
   * The saved window an app's next window reopens as (WM-06); taken once. A `restoreKey` matches a
   * saved window of the same title first, else the app's lowest saved window.
   */
  restoreFor(app: string, restoreKey: string | undefined): LayoutWindow | undefined {
    const byKey =
      restoreKey === undefined
        ? -1
        : this.pending.findIndex((w) => w.app === app && w.title === restoreKey);
    const i = byKey >= 0 ? byKey : this.pending.findIndex((w) => w.app === app);
    if (i < 0) return undefined;
    const [w] = this.pending.splice(i, 1);
    return w;
  }

  /** After desktop-interactive: relaunch the restored apps (never in safe mode). */
  relaunch(): number {
    if (this.profile === 'safe' || this.deps.launch === undefined) return 0;
    const apps = [...this.pending];
    for (const w of apps) this.deps.launch(w.app, w.argv);
    return apps.length;
  }

  /** A coarse window event: save within 500 ms (relaxed). */
  persistSoon(): void {
    if (!this.started || this.debounce !== null) return;
    const t = this.deps.timers;
    this.debounce = t.at(t.now() + LAYOUT_DEBOUNCE_MS, () => {
      this.debounce = null;
      void this.save('relaxed').catch((e: unknown) => {
        this.deps.kernel.log(
          'session',
          'warn',
          `layout not saved: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    });
  }

  /** The compositor's own debounced layout (window-manager.md §3.15). */
  fromCompositor(layout: SessionLayout): void {
    const user = this.deps.console();
    if (user === null || layout.uid !== user.uid) return;
    this.compositorLayout = layout;
    this.viewport = layout.viewport;
    this.persistSoon();
  }

  private current(): SessionLayout | null {
    const user = this.deps.console();
    if (user === null || this.osSession === '') return null;
    const argvOf = (pid: number): readonly string[] => this.deps.kernel.procs.get(pid)?.argv ?? [];
    const live = this.deps.windows.layoutWindows(argvOf);
    const fromComp = this.compositorLayout?.windows ?? [];
    // The compositor's snapshot is complete (rects, restore rectangles, snap, z); the kernel's
    // mirror only knows what geometry messages told it. Prefer the snapshot, limited to the
    // windows that still exist, plus any window it has not seen yet (UI-035).
    const windows = [
      ...(fromComp.length === 0 ? live : reconcileLayout(fromComp, live)),
      ...this.pending,
    ]
      .slice(0, 64)
      .map((w, i) => ({ ...w, z: i + 1 }));
    return {
      v: 1,
      osSessionId: this.osSession,
      uid: user.uid,
      savedAt: Math.floor(this.deps.epochMs()),
      viewport: this.viewport,
      windows,
    };
  }

  async save(durability: 'strict' | 'relaxed'): Promise<void> {
    if (this.debounce !== null) this.deps.timers.cancel(this.debounce);
    this.debounce = null;
    const store = this.deps.store();
    const layout = this.current();
    if (store === null || layout === null) return;
    const older = (
      await store.getByIndex<{ osSessionId?: unknown; savedAt?: unknown; recoveryOf?: unknown }>(
        'os_sessions',
        'by_uid',
        layout.uid,
      )
    )
      .filter((r) => r.recoveryOf === undefined && r.osSessionId !== layout.osSessionId)
      .sort((a, b) => Number(b.savedAt ?? 0) - Number(a.savedAt ?? 0))
      .slice(LAYOUTS_KEPT - 1)
      .map((r) => r.osSessionId)
      .filter((id): id is string => typeof id === 'string');
    await store.tx(
      ['os_sessions'],
      durability,
      (t) => {
        t.put('os_sessions', layout);
        for (const id of older) t.del('os_sessions', id);
      },
      { label: 'session layout' },
    );
  }
}
