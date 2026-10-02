/**
 * The router's Window-only Service Worker calls (offline-and-sync.md §3.16.2–§3.16.3, OFF-05,
 * SYN-15): register `/sw.js` after desktop-interactive plus an idle callback, report "Offline-ready"
 * once the worker is active, notice a waiting new version ("Restart to update v…"), and at reboot
 * post SKIP_WAITING and reload on `controllerchange` (or after 5 s regardless).
 *
 * Plain data plus a subscription, so the desktop tray (`offline-ready`, `restart-to-update` test
 * ids) and Settings can render it without owning any Service Worker logic.
 */
import type { SwVersion } from './routes.ts';

export interface UpdateState {
  /** `off`: dev server or no Service Worker support; `error`: registration failed. */
  readonly phase: 'off' | 'idle' | 'registering' | 'active' | 'error';
  /** The active worker controls a complete precache: an offline reboot works (BOOT-09). */
  readonly offlineReady: boolean;
  /** A new version installed and waiting for the next reboot. */
  readonly waiting: SwVersion | null;
  readonly error: string | null;
}

export interface UpdateController {
  state(): UpdateState;
  subscribe(fn: (s: UpdateState) => void): () => void;
  /** Registers after an idle callback; idempotent. */
  register(): Promise<void>;
  /** `registration.update()` now (also run at registration and every 60 minutes). */
  check(): Promise<void>;
  /**
   * Reboot path: activate a waiting worker (SKIP_WAITING), then `location.replace(url)` on
   * `controllerchange`, or after 5 s if it never arrives. Without a waiting worker, replaces now.
   */
  activateAndReload(url: string): void;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
}

export interface UpdateDeps {
  readonly container: ServiceWorkerContainer | null;
  readonly replace: (url: string) => void;
  readonly idle: (fn: () => void) => void;
  readonly timers: Timers;
  readonly enabled: boolean;
  readonly swUrl?: string;
}

const HOUR_MS = 60 * 60 * 1_000;
const RELOAD_FALLBACK_MS = 5_000;

/** Ask a (waiting) worker for its identity over a MessageChannel. */
function versionOf(worker: ServiceWorker, timers: Timers): Promise<SwVersion | null> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    let done = false;
    const finish = (v: SwVersion | null): void => {
      if (done) return;
      done = true;
      ch.port1.close();
      resolve(v);
    };
    ch.port1.onmessage = (ev: MessageEvent<unknown>) => {
      const v = ev.data as Partial<SwVersion> | null;
      finish(
        v !== null && typeof v.version === 'string' && typeof v.build === 'string'
          ? { version: v.version, build: v.build, date: typeof v.date === 'string' ? v.date : '' }
          : null,
      );
    };
    worker.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    timers.set(() => {
      finish(null);
    }, 2_000);
  });
}

export function createUpdateController(deps: UpdateDeps): UpdateController {
  const { container } = deps;
  const listeners = new Set<(s: UpdateState) => void>();
  let state: UpdateState = {
    phase: deps.enabled && container !== null ? 'idle' : 'off',
    offlineReady: false,
    waiting: null,
    error: null,
  };
  let reg: ServiceWorkerRegistration | null = null;
  let registering: Promise<void> | null = null;
  let reloading = false;

  const set = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
  };

  const watchWaiting = (r: ServiceWorkerRegistration): void => {
    const note = (w: ServiceWorker | null): void => {
      // A waiting worker next to an active one is an update; the very first install has none.
      if (w === null || r.active === null) return;
      void versionOf(w, deps.timers).then((v) => {
        set({ waiting: v ?? { version: 'new version', build: '', date: '' } });
      });
    };
    note(r.waiting);
    r.addEventListener('updatefound', () => {
      const w = r.installing;
      if (w === null) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed') note(w);
        if (w.state === 'activated' && r.active === w) set({ offlineReady: true });
      });
    });
  };

  const register = (): Promise<void> => {
    if (state.phase === 'off') return Promise.resolve();
    if (registering !== null) return registering;
    registering = new Promise<void>((resolve) => {
      deps.idle(() => {
        set({ phase: 'registering' });
        const c = container as ServiceWorkerContainer;
        c.register(deps.swUrl ?? '/sw.js', { scope: '/', updateViaCache: 'none' })
          .then(async (r) => {
            reg = r;
            watchWaiting(r);
            const ready = await c.ready;
            set({ phase: 'active', offlineReady: ready.active?.state === 'activated' });
            if (ready.active !== null && ready.active.state !== 'activated') {
              const active = ready.active;
              active.addEventListener('statechange', () => {
                if (active.state === 'activated') set({ offlineReady: true });
              });
            }
            await r.update().catch(() => undefined);
            deps.timers.set(function hourly() {
              void r.update().catch(() => undefined);
              deps.timers.set(hourly, HOUR_MS);
            }, HOUR_MS);
          })
          .catch((e: unknown) => {
            set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
          })
          .finally(resolve);
      });
    });
    return registering;
  };

  return {
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    register,
    async check() {
      await reg?.update().catch(() => undefined);
    },
    activateAndReload(url) {
      if (reloading) return;
      reloading = true;
      const waiting = reg?.waiting ?? null;
      if (waiting === null || container === null) {
        deps.replace(url);
        return;
      }
      let gone = false;
      const go = (): void => {
        if (gone) return;
        gone = true;
        deps.replace(url);
      };
      container.addEventListener('controllerchange', go, { once: true });
      waiting.postMessage({ type: 'SKIP_WAITING' });
      deps.timers.set(go, RELOAD_FALLBACK_MS);
    },
  };
}
