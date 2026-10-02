/**
 * App views in their windows (window-manager.md §3.1, §3.13; WMD-23): each window's view is
 * mounted into that window's content element in its own root, with a `ViewContext` whose system
 * calls go through the view port bound to (pid, wid). A view that throws (synchronously, from
 * its chunk import or through `reportCrash`) is replaced by "<App> stopped" in that window only.
 * Framework-free: the view brings its own framework root.
 */
import type { KEvent } from '@plotinium/protocol';

import type {
  AppRegistry,
  KernelEnv,
  Prefs,
  Session,
  ViewContext,
  ViewEventData,
  ViewSysClient,
  WindowBinding,
} from './env.ts';

export interface ViewHost {
  /** Mount the app view of `binding` into `container`. */
  mount(binding: WindowBinding, container: HTMLElement): void;
  unmount(wid: number): void;
  /** A menu command for the focused window's view. */
  menuCommand(wid: number, menuId: string, itemId: string): boolean;
  /** Deliver a new display channel after page-in (`attach`). */
  attach(wid: number, display: MessagePort): void;
  dispose(): void;
}

export interface ViewHostDeps {
  readonly apps: AppRegistry;
  readonly kernel: KernelEnv;
  readonly theme: () => 'light' | 'dark';
  readonly requestClose: (wid: number) => void;
  /** Tell the kernel a view crashed (`viewCrashed`). */
  readonly crashed: (wid: number, message: string) => void;
  /** Build the "stopped" message DOM (text nodes only). */
  readonly document: Document;
  readonly session: Session;
  readonly prefs: () => Prefs;
  readonly setTitle: (wid: number, title: string) => void;
  readonly launch: (app: string, argv: readonly string[]) => void;
}

/** Whether `topic` matches one of `patterns` (`'proc.*'` is a prefix, `'*'` matches all). */
export function topicMatches(patterns: readonly string[], topic: string): boolean {
  return patterns.some(
    (p) => p === '*' || p === topic || (p.endsWith('.*') && topic.startsWith(p.slice(0, -1))),
  );
}

/** Keep the events of a batch whose topic matches. */
export function filterBatch(patterns: readonly string[], batch: readonly KEvent[]): KEvent[] {
  return batch.filter((e) => topicMatches(patterns, e.topic));
}

/** A title as the shell draws it: no control characters, at most 200 characters (§4.5). */
export function cleanTitle(title: string): string {
  let out = '';
  for (const ch of title) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    out += ch;
  }
  return out.slice(0, 200);
}

interface Mounted {
  dispose: (() => void) | null;
  disposed: boolean;
  container: HTMLElement;
  title: string;
  listeners: Map<keyof ViewEventData, Set<(data: never) => void>>;
  menu: Set<(menuId: string, itemId: string) => void>;
  display: MessagePort | null;
}

/** A client that refuses every call: used when the host gave no view-port factory. */
export function deniedSys(reason: string): ViewSysClient {
  return {
    closed: false,
    call: () => Promise.reject(new Error(`EPERM: ${reason}`)),
  };
}

export function createViewHost(deps: ViewHostDeps): ViewHost {
  const views = new Map<number, Mounted>();

  const emit = <T extends keyof ViewEventData>(
    wid: number,
    topic: T,
    data: ViewEventData[T],
  ): void => {
    const set = views.get(wid)?.listeners.get(topic);
    if (set === undefined) return;
    for (const fn of set) (fn as (d: ViewEventData[T]) => void)(data);
  };

  const showStopped = (wid: number, message: string): void => {
    const v = views.get(wid);
    if (v === undefined) return;
    try {
      v.dispose?.();
    } catch {
      // the view is already broken
    }
    v.dispose = null;
    const doc = deps.document;
    const box = doc.createElement('div');
    box.setAttribute('role', 'alert');
    box.dataset['plStopped'] = 'true';
    const title = doc.createElement('p');
    title.textContent = `${v.title} stopped`;
    const detail = doc.createElement('p');
    detail.textContent = message;
    box.append(title, detail);
    v.container.replaceChildren(box);
    deps.crashed(wid, message);
  };

  const host: ViewHost = {
    mount(binding, container) {
      const entry = deps.apps.get(binding.app);
      const m: Mounted = {
        dispose: null,
        disposed: false,
        container,
        title: entry?.title ?? binding.app,
        listeners: new Map(),
        menu: new Set(),
        display: binding.display,
      };
      views.set(binding.wid, m);
      if (entry === undefined) {
        showStopped(binding.wid, `No app named "${binding.app}" is installed.`);
        return;
      }
      const sys =
        deps.kernel.viewSys?.(binding, {
          onEvents: (batch: readonly KEvent[]) => emit(binding.wid, 'kernel.events', batch),
          onTtyOut: (data: ArrayBuffer) => emit(binding.wid, 'tty.output', data),
          onClose: (reason: string) => emit(binding.wid, 'view.close', reason),
        }) ?? deniedSys('no view port for this window');
      const onViewEvent: ViewContext['onViewEvent'] = (topic, cb) => {
        let set = m.listeners.get(topic);
        if (set === undefined) {
          set = new Set();
          m.listeners.set(topic, set);
        }
        const fn = cb as (data: never) => void;
        set.add(fn);
        return () => {
          set.delete(fn);
        };
      };
      const ctx: ViewContext = {
        pid: binding.pid,
        wid: binding.wid,
        app: binding.app,
        argv: binding.argv,
        container,
        sys,
        get display(): MessagePort | null {
          return m.display;
        },
        onViewEvent,
        onMenuCommand(cb) {
          m.menu.add(cb);
          return () => {
            m.menu.delete(cb);
          };
        },
        reportCrash(err) {
          showStopped(binding.wid, err instanceof Error ? err.message : String(err));
        },
        theme: deps.theme,
        requestClose: () => deps.requestClose(binding.wid),
        session: deps.session,
        prefs: deps.prefs,
        setTitle: (title) => deps.setTitle(binding.wid, cleanTitle(title)),
        launch: (app, argv = []) => deps.launch(app, argv),
        subscribe(topics, fn) {
          const deliver = (batch: readonly KEvent[]): void => {
            if (m.disposed) return;
            const mine = filterBatch(topics, batch);
            if (mine.length > 0) fn(mine);
          };
          const feed = deps.kernel.subscribe;
          if (feed !== undefined) return feed(deliver);
          return onViewEvent('kernel.events', deliver);
        },
      };
      try {
        const out = entry.mountView(container, ctx);
        if (typeof out === 'function') m.dispose = out;
        else
          out.then(
            (dispose) => {
              if (m.disposed) dispose();
              else m.dispose = dispose;
            },
            (err: unknown) => {
              if (!m.disposed)
                showStopped(binding.wid, err instanceof Error ? err.message : String(err));
            },
          );
      } catch (err) {
        showStopped(binding.wid, err instanceof Error ? err.message : String(err));
      }
    },
    unmount(wid) {
      const v = views.get(wid);
      if (v === undefined) return;
      views.delete(wid);
      v.disposed = true;
      try {
        v.dispose?.();
      } catch {
        // disposing a crashed view must not break the shell
      }
    },
    menuCommand(wid, menuId, itemId) {
      const v = views.get(wid);
      if (v === undefined || v.menu.size === 0) return false;
      for (const fn of v.menu) fn(menuId, itemId);
      return true;
    },
    attach(wid, display) {
      const v = views.get(wid);
      if (v !== undefined) v.display = display;
    },
    dispose() {
      for (const wid of [...views.keys()]) host.unmount(wid);
    },
  };
  return host;
}
