/**
 * Mounts a Files or Editor view the way the desktop does, for DOM tests (happy-dom): inside a
 * window frame that is a non-modal `<section role="dialog">` (window-manager.md §3.4), with an
 * `AppViewContext` whose system calls go to the in-memory kernel double (fake-sys.ts), plus any
 * calls the double does not know (`net.status`, `window.focus`, `window.setCloseGuard`).
 */
import type { ArgsIn, CallName, RetOf } from '@plotinium/protocol';

import type { AppBuildIdentity, AppMount, AppSys, AppViewContext } from '../../src/descriptor.ts';
import { createMemoryPrefs } from '../../src/descriptor.ts';
import type { FakeSys } from './fake-sys.ts';

const IDENTITY: AppBuildIdentity = {
  name: 'Plotinium',
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-09-30',
  codename: 'Pu',
  abi: 1,
};

/** Answers for calls the kernel double does not implement, by call name. */
export type ExtraCalls = Record<string, (args: unknown) => unknown>;

export interface MountedView {
  readonly frame: HTMLElement;
  readonly container: HTMLElement;
  readonly launched: { app: string; argv: readonly string[] }[];
  readonly titles: string[];
  /** Calls made through `extras`, in order. */
  readonly extraCalls: { name: string; args: unknown }[];
  /** Runs a menu-bar command as the desktop would. */
  menu(id: string): void;
  dispose(): void;
}

/** The kernel double, with `extras` answered first (a rejecting extra throws its error). */
export function withExtras(
  base: FakeSys,
  extras: ExtraCalls,
  log: { name: string; args: unknown }[],
): AppSys {
  return {
    call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> {
      const extra = extras[name];
      if (extra === undefined) return base.call(name, args);
      log.push({ name, args });
      try {
        return Promise.resolve(extra(args) as RetOf<C>);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}

export function mountView(
  mount: AppMount,
  opts: {
    readonly app: 'files' | 'editor';
    readonly sys: FakeSys;
    readonly argv?: readonly string[];
    readonly wid?: number;
    readonly extras?: ExtraCalls;
  },
): MountedView {
  const frame = document.createElement('section');
  frame.setAttribute('role', 'dialog');
  frame.setAttribute('aria-modal', 'false');
  frame.setAttribute('aria-label', opts.app);
  const container = document.createElement('div');
  frame.append(container);
  document.body.append(frame);
  const launched: MountedView['launched'] = [];
  const titles: string[] = [];
  const extraCalls: MountedView['extraCalls'] = [];
  const menuHandlers = new Set<(id: string) => void>();
  const ctx: AppViewContext = {
    app: opts.app,
    wid: opts.wid ?? 7,
    pid: 42,
    argv: opts.argv ?? [],
    container,
    sys: withExtras(opts.sys, opts.extras ?? {}, extraCalls),
    env: {
      identity: IDENTITY,
      prefs: createMemoryPrefs(),
      aiAvailable: true,
      user: { name: opts.sys.user.name, uid: opts.sys.user.uid, guest: false },
    },
    window: {
      setTitle: (title) => titles.push(title),
      close: () => undefined,
    },
    launch: (app, launch) => launched.push({ app, argv: launch?.argv ?? [] }),
    subscribe: () => () => undefined,
    onMenuCommand: (fn) => {
      menuHandlers.add(fn);
      return () => menuHandlers.delete(fn);
    },
    reportCrash: (err) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
  };
  const dispose = mount(ctx);
  return {
    frame,
    container,
    launched,
    titles,
    extraCalls,
    menu: (id) => {
      for (const fn of menuHandlers) fn(id);
    },
    dispose: () => {
      dispose();
      frame.remove();
    },
  };
}

/** Lets pending promise chains and zero-delay timers run (the double answers at once). */
export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
}
