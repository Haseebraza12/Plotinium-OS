/**
 * kernel/src/core/io: the kernel's I/O layer (architecture.md §4.4; boot-and-services.md §3.3).
 *
 * `installIo(kernel, deps)` is boot step 5 of `createKernel`'s comment. It builds, for one kernel:
 *   - the REAL system services (storage, mm, vfs, login, session, auth, sync, lockd, ai.*, complete,
 *     update) over the ports of @plotinium/services/system, returned as `io.services` for the host
 *     to merge into its service registry;
 *   - the window table and its end of the compositor port (`io.attachCompositor`), the window and
 *     notification calls, view ports and display channels bound to (pid, wid);
 *   - connectivity (`net.state`, OFF-04), the sync/lock bridge, local advisory locks and the
 *     `net.status`, `sync.flush`, `lock.*` calls;
 *   - the file-system calls (registered by the `vfs` service once mounted), the proc seams that need
 *     the VFS (exec permission, fd inheritance, chdir, user info);
 *   - the system calls `bootlog`, `svc.status`, `svc.restart`, `users.list`, `shutdown`, `reboot`,
 *     `auth.logout`, `auth.lock`;
 *   - the router side of the login screen, power and the Service Worker (`io.router`).
 * Events the desktop shows: `net.state`, `svc.*`, `mem.pressure`, `update.available`,
 * `ai.predict`, `lock.lost` (batched to the compositor, one per frame) and notifications.
 *
 * Host wiring (kernel/src/host/boot-sequence.ts):
 *
 *   const io = installIo(kernel, { platform, timers, frame, post, halt, services: () => mgr, t0, … });
 *   const registry = createServiceRegistry(…);            // kernel, sched, wm, desktop
 *   for (const [name, impl] of io.services) registry.set(name, impl);
 *   // compositor.attach → io.attachCompositor(port); every IoRouterEvent → io.router(ev)
 */
import type { ServiceName, SystemPorts } from '@plotinium/services';
import { createSystemServices } from '@plotinium/services';
import type { SignalName } from '@plotinium/protocol';
import type { OutboxRec } from '@plotinium/vfs';
import { X, may } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import type { KernelFs } from '../fs/kfs.ts';
import { actorOf } from '../fs/kfs.ts';
import type { Kernel } from '../kernel.ts';
import { LocalLocks } from '../net/locks.ts';
import { LEASE_TTL_MS, NetMonitor } from '../net/monitor.ts';
import { createEngineFactory } from '../net/factory.ts';
import { registerNetSyscalls } from '../net/syscalls.ts';
import type { PCB } from '../proc/pcb.ts';
import { Windows } from '../window/service.ts';
import { registerWindowSyscalls } from '../window/syscalls.ts';
import type { ChannelFactory, DeskNotification, LayoutWindow, PortLike } from '../window/types.ts';
import { AI_SERVICE_NAMES, AiIo } from './ai.ts';
import { AuthIo } from './auth.ts';
import { BootRecorder } from './bootlog.ts';
import { CompleteIo } from './complete.ts';
import { registerEventSyscalls } from './events.ts';
import { HOME_LOOKUP_SYNC_MS, linkHome } from './home-link.ts';
import { HostRequests } from './host.ts';
import { ServerApi } from './http.ts';
import type { ConsoleSession } from './login.ts';
import { LoginIo, sessionInfoOf } from './login.ts';
import { MmIo } from './mm.ts';
import { SessionIo } from './session.ts';
import { StorageIo } from './storage.ts';
import { LockdIo, SyncIo } from './sync.ts';
import { registerSystemSyscalls } from './system.ts';
import type {
  Io,
  IoDeps,
  IoRouterEvent,
  IoToRouter,
  LoginReply,
  PowerAction,
  RebootNext,
} from './types.ts';
import { UpdateIo } from './update.ts';
import { OfflineVerifier } from './verifier.ts';
import { ConsoleUsers, VfsIo } from './vfs.ts';

export type * from './types.ts';
export { AI_OFF_REASON, AI_SERVICE_NAMES, AI_UNLINKED_REASON, AiFallbackPort, AiIo } from './ai.ts';
export { AuthIo, AUTH_REQUEST_MS } from './auth.ts';
export { BootRecorder, BOOT_LOG_LINES_MAX, BOOT_RECORDS_KEPT } from './bootlog.ts';
export type { BootRecord, CriticalRow } from './bootlog.ts';
export { CompleteIo, SHELL_BUILTINS, flagsOf } from './complete.ts';
export {
  BUDGET_MAX_MB,
  BUDGET_MIN_MB,
  HostRequests,
  OUTBOX_LIST_MAX,
  SEARCH_MAX_DIRS,
  SEARCH_MAX_ENTRIES,
  opOfLabel,
} from './host.ts';
export type { HostQueuedOp, HostReplyValue, HostRequest, HostSearchHit } from './host.ts';
export type { CompleteCallName } from './complete.ts';
export { AuthMeSchema, REQUEST_TIMEOUT_MS, ServerApi } from './http.ts';
export type { AuthMe } from './http.ts';
export { DEFAULT_KNOWN_USERS, LoginIo, RESUME_TIMEOUT_MS, sessionInfoOf } from './login.ts';
export type { ConsoleSession } from './login.ts';
export { MEMORY_SWAP_CAP, MmIo } from './mm.ts';
export {
  applySeedUpgrade,
  BRANDING_FILES,
  binSeed,
  buildSeed,
  fetchSeed,
  manifestSeed,
} from './seed.ts';
export type { BuiltSeed, SeedSource, SeedUpgradeReport } from './seed.ts';
export { LAYOUT_DEBOUNCE_MS, SessionIo } from './session.ts';
export { StorageIo } from './storage.ts';
export { LockdIo, NO_ENGINE_REASON, SyncIo } from './sync.ts';
export { registerSystemSyscalls } from './system.ts';
export { UpdateIo } from './update.ts';
export { OfflineVerifier, PBKDF2_ITERATIONS } from './verifier.ts';
export { ConsoleUsers, SEED_FETCH_FIRST_MS, SEED_FETCH_LATER_MS, VfsIo } from './vfs.ts';

/** SIGTERM, then SIGKILL if the process still lives after this long (window-manager.md §3.12). */
export const CLOSE_KILL_AFTER_MS = 3_000;
/** The boot record is refreshed this long after desktop-interactive (late non-critical services). */
export const BOOT_RECORD_REFRESH_MS = 5_000;
/** Without a sync engine, the outbox is counted again this long after a commit (UI-026). */
export const OUTBOX_RECOUNT_MS = 250;
/** Distinct CSP / Trusted Types violations logged to klog per boot (UI-137). */
export const SEC_VIOLATIONS_LOGGED_MAX = 32;

/**
 * A program's code chunk is gone from the server (a redeploy under a running session, UI-136):
 * Chrome "Failed to fetch dynamically imported module", Firefox "error loading dynamically imported
 * module", Safari "Importing a module script failed".
 */
export function isStaleChunk(message: string): boolean {
  return /dynamically imported module|Importing a module script failed/i.test(message);
}

/** `GET /api/blobs/{sha}` (backend-api.md §3.6): the bytes, or null when not given. */
export function blobFetch(
  fetchFn: NonNullable<IoDeps['platform']>['fetch'] & object,
): (sha: string) => Promise<Uint8Array | null> {
  return async (sha) => {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    try {
      const r = await fetchFn(`/api/blobs/${sha}`, { cache: 'no-store' });
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
}

const noChannel: ChannelFactory = () => {
  throw new KernelError('EAGAIN', { reason: 'no-channel' }, 'this host cannot create windows');
};

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function installIo(kernel: Kernel, deps: IoDeps): Io {
  const platform = deps.platform ?? {};
  const timers = deps.timers;
  const identity = kernel.host.identity;
  const now = (): number => kernel.host.clock.now();
  const epochMs = (): number => kernel.host.clock.epochMs();
  const post = (msg: IoToRouter): void => {
    deps.post?.(msg);
  };
  const frame = deps.frame ?? ((cb: () => void): void => queueMicrotask(cb));
  const after = (ms: number, fn: () => void): (() => void) => {
    const h = timers.at(timers.now() + Math.max(0, ms), fn);
    return () => {
      timers.cancel(h);
    };
  };
  const log = (sub: string, level: 'info' | 'warn' | 'fail', msg: string, pid?: number): void => {
    kernel.log(sub, level, msg, pid);
  };
  const services = deps.services ?? ((): null => null);

  let fsRef: KernelFs | null = null;
  const mountedCbs = new Set<(fs: KernelFs) => void>();
  let interactive = false;
  const afterInteractive: (() => void)[] = [];
  const runAfterInteractive = (fn: () => void): void => {
    if (interactive) fn();
    else afterInteractive.push(fn);
  };

  // -- connectivity, the boot record, the server ---------------------------------------------
  const net = new NetMonitor(kernel.bus);
  if (platform.online === false) net.setReachable('offline');
  const api = new ServerApi(platform.fetch, timers);
  const recorder = new BootRecorder({
    klog: kernel.klog,
    identity,
    epochAtZero: kernel.epochAtZero,
    t0: deps.t0 ?? ((): number => kernel.epochAtZero),
    services,
    now,
  });

  // -- storage --------------------------------------------------------------------------------
  const storage = new StorageIo({
    indexedDB: platform.indexedDB ?? null,
    storage: platform.storage,
    ...(deps.store === undefined ? {} : { store: deps.store }),
    recorder,
    flags: () => deps.bootFlags ?? [],
    verbose: deps.verbose ?? false,
  });

  // -- windows, notifications -----------------------------------------------------------------
  let sessionRef: SessionIo | null = null;
  let loginRef: LoginIo | null = null;
  let mmRef: MmIo | null = null;
  const consoleUser = (): ConsoleSession | null => loginRef?.session ?? null;

  const notify = (n: Omit<DeskNotification, 'id' | 'at'>): void => {
    windows.notify(n);
  };

  const signal = (pid: number, sig: 'SIGTERM' | 'SIGKILL'): void => {
    if (deps.proc?.signal !== undefined) {
      deps.proc.signal(pid, sig);
      return;
    }
    // Kernel authority (never init or a kernel thread); SIGKILL follows if the window stays.
    if (!kernel.proc.signalPid(pid, sig satisfies SignalName, 0) || sig === 'SIGKILL') return;
    after(CLOSE_KILL_AFTER_MS, () => {
      const q = kernel.procs.get(pid);
      if (q !== undefined && q.state !== 'TERMINATED' && q.windows.size > 0)
        kernel.proc.signalPid(pid, 'SIGKILL', 0);
    });
  };

  const launch = (app: string, argv: readonly string[]): void => {
    const s = consoleUser();
    if (s === null) {
      log('wm', 'warn', `launch ${app}: nobody is signed in`);
      return;
    }
    if (deps.proc?.launch !== undefined) {
      deps.proc.launch(app, argv, { uid: s.uid, gid: s.gid });
      return;
    }
    if (kernel.programs.manifest(app) === undefined) {
      notify({
        level: 'error',
        title: `Could not open ${app}`,
        body: 'No such app is installed.',
        source: { svc: 'wm' },
      });
      return;
    }
    const full = argv[0] === app ? [...argv] : [app, ...argv];
    kernel.proc
      .launch(
        app,
        full,
        { uid: s.uid, gid: s.gid, groups: s.groups },
        {
          cwd: s.home,
          env: new Map([
            ['HOME', s.home],
            ['USER', s.username],
            ['LOGNAME', s.username],
            ['PATH', '/bin'],
            ['SHELL', '/bin/sh.json'],
          ]),
        },
      )
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log('wm', 'warn', `launch ${app}: ${msg}`);
        if (isStaleChunk(msg)) {
          // A redeploy replaced the app's code under a running session (UI-136): the fix is a
          // restart into the new version, not an error about the app.
          kernel.bus.publish('update.available', { version: 'new', build: 'deployed' });
          notify({
            level: 'info',
            title: 'Plotinium was updated',
            body: `${app} needs the new version. Restart to update; your windows are restored.`,
            actions: [
              { id: 'restart-update', label: 'Restart' },
              { id: 'later', label: 'Later' },
            ],
            source: { app },
          });
          return;
        }
        notify({
          level: 'error',
          title: `Could not open ${app}`,
          body: msg.slice(0, 200),
          source: { app },
        });
      });
  };

  const power = (kind: PowerAction, next: RebootNext): void => {
    void io.shutdown(kind === 'poweroff' ? 'poweroff' : 'reboot').finally(() => {
      if (deps.halt !== undefined) deps.halt(kind, next);
      else log('kernel', 'warn', `${kind}: no host to halt`);
    });
  };

  const logout = async (): Promise<void> => {
    try {
      await sessionRef?.save('strict');
    } catch (e) {
      log(
        'session',
        'warn',
        `layout not saved at logout: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Say goodbye on the socket first: the server releases the session's leases at once and
    // closes with the reason `logout` (UI-166).
    await syncIo.stop('logout').catch(() => undefined);
    await loginRef?.logout();
    windows.setUser(null, kernel.osSessionId);
    post({ t: 'login.loggedOut' });
  };

  const windows = new Windows({
    bus: kernel.bus,
    now,
    epochMs,
    log: (level, msg, pid) => {
      log('wm', level, msg, pid);
    },
    viewMessage: (port, msg) => {
      kernel.viewMessage(port, msg);
    },
    channel: platform.channel ?? noChannel,
    frame,
    restoreFor: (app, key) => sessionRef?.restoreFor(app, key),
    hooks: {
      signal,
      launch: (app, argv) => {
        launch(app, argv);
      },
      power: (action) => {
        switch (action) {
          case 'lock':
            post({ t: 'login.lock' });
            return;
          case 'logout':
            void logout();
            return;
          case 'reboot':
            power('reboot', 'normal');
            return;
          case 'shutdown':
            power('poweroff', 'normal');
            return;
        }
      },
      focusChanged: (pid) => {
        if (deps.proc?.focus !== undefined) deps.proc.focus(pid);
        else kernel.proc.focusOwner(pid);
      },
      minimised: (pid, on) => {
        mmRef?.minimised(pid, on);
      },
      input: (pid) => {
        if (deps.proc?.input !== undefined) deps.proc.input(pid);
        else kernel.proc.onInput(pid);
        ai.noteInput();
      },
      layoutChanged: () => {
        sessionRef?.persistSoon();
      },
      layout: (l) => {
        sessionRef?.fromCompositor(l);
      },
      notifyAction: (id, action) => {
        log('wm', 'info', `notification ${id}: ${action}`);
      },
      retryService: (name) => {
        // "Retry now" always gets an answer (UI-075): a restart, a retry of the degraded
        // requirement, or the service's current state reported again as an svc.* event.
        const mgr = services();
        const known = mgr?.status().some((s) => s.name === name) === true;
        const r = known ? mgr?.retryNow(name) : undefined;
        if (r === undefined || r.outcome === 'unknown')
          log('svc', 'warn', `retry ${name}: no such service`);
        else if (r.outcome === 'restarted')
          log(
            'svc',
            'info',
            `retry ${name}: ${r.name === name ? 'restarting' : `retrying ${r.name}`}`,
          );
        else log('svc', 'info', `retry ${name}: nothing to retry (${mgr?.stateOf(name) ?? '?'})`);
      },
      retryNetwork: () => {
        auth.online();
        void syncIo.retry();
      },
    },
  });

  // -- network, locks -------------------------------------------------------------------------
  const localLocks = new LocalLocks({
    after,
    onChange: (kind, l) => {
      const payload = {
        ino: l.ino,
        mode: l.mode,
        holder: l.holder,
        ...(l.fence === undefined ? {} : { fence: l.fence }),
      };
      kernel.bus.publish(
        kind === 'granted' ? 'lock.granted' : kind === 'queued' ? 'lock.queued' : 'lock.released',
        payload,
      );
    },
  });

  const queuedOps = async (): Promise<number> => {
    const store = storage.store;
    if (store === null) return 0;
    let n = 0;
    await store.scan<OutboxRec>('outbox', null, (r) => {
      if (r.state === 'pending' || r.state === 'parked') n++;
    });
    return n;
  };

  // The sync and lock engines (UI-006): the host's, or the default ones over the host's socket.
  // A `nosync` boot flag keeps the device standalone (the kill switch; test builds reach it with
  // `?bootflags=nosync`, which the router records as `test:nosync`).
  const noSync = (deps.bootFlags ?? []).some((f) => f === 'nosync' || f.endsWith(':nosync'));
  const defaultEngines =
    deps.engines === undefined &&
    platform.socket !== undefined &&
    platform.fetch !== undefined &&
    platform.origin !== undefined &&
    !noSync
      ? createEngineFactory({
          store: () => storage.store,
          fetch: platform.fetch,
          socket: platform.socket,
          identity,
          ...(platform.locks === undefined ? {} : { locks: platform.locks }),
          online: () => net.reachability !== 'offline',
          ...(platform.timeZone === undefined ? {} : { timeZone: platform.timeZone }),
          applied: (effect) => {
            fsRef?.applyExternal({ writes: effect.writes, events: [] }, 0);
          },
          warn: (msg) => {
            log('sync', 'warn', msg);
          },
          lockEvent: (ev) => {
            const payload = {
              ino: ev.ino,
              mode: ev.mode,
              ...(ev.holder === undefined ? {} : { holder: ev.holder }),
              ...(ev.fence === undefined ? {} : { fence: ev.fence }),
            };
            kernel.bus.publish(ev.topic, payload);
          },
        })
      : undefined;
  const engines = deps.engines ?? defaultEngines;

  const syncIo = new SyncIo({
    kernel,
    net,
    engines,
    origin: platform.origin,
    ...(defaultEngines === undefined
      ? {}
      : {
          link: (s: ConsoleSession) => {
            const fs = fsRef;
            if (fs === null)
              return Promise.resolve({
                linked: false as const,
                reason: 'file system not mounted',
                selfHeals: true,
              });
            return linkHome({
              kernel,
              fs,
              api,
              uid: s.uid,
              username: s.username,
              ...(s.serverHomeIno === undefined ? {} : { serverIno: s.serverHomeIno }),
              timeoutMs: HOME_LOOKUP_SYNC_MS,
            });
          },
        }),
    console: consoleUser,
    epoch: () => storage.epoch,
    queued: queuedOps,
    notify: (title, body, level) => {
      notify({ level, title, body, source: { svc: 'sync' } });
    },
  });
  const lockd = new LockdIo(syncIo);

  const netCalls = registerNetSyscalls(kernel.handlers, {
    monitor: net,
    locks: localLocks,
    fs: () => fsRef,
    sync: () => syncIo.syncEngine,
    lockEngine: () => syncIo.lockEngine,
    holder: (uid) => `${kernel.users.nameOf(uid)}@${identity.name.toLowerCase()}`,
    epochMs,
    after,
    leaseTtlMs: LEASE_TTL_MS,
  });
  registerWindowSyscalls(kernel.handlers, windows);
  // `sys.subscribe` / `sys.events` for processes (the AI indexer daemon, UI-049).
  const eventCalls = registerEventSyscalls(kernel.handlers, {
    bus: kernel.bus,
    fs: () => fsRef,
    after,
  });

  // -- AI ------------------------------------------------------------------------------------
  const ai = new AiIo({
    enabled: deps.aiEnabled ?? true,
    link: deps.ai,
    ctx: {
      hooks: kernel.hooks,
      fs: () => fsRef,
      sessionUid: () => consoleUser()?.uid,
      osSessionId: () => kernel.osSessionId,
      online: () => net.reachability === 'online',
    },
    log: (msg) => {
      log('ai', 'warn', msg);
    },
  });

  // -- vfs ------------------------------------------------------------------------------------
  // The kernel's own uid → name directory when it is bindable (createKernel's default), so `id`,
  // `whoami`, `ps` and every `proc.cred` answer from the VFS users mirror (UI-012).
  const consoleUsers =
    kernel.users instanceof ConsoleUsers ? kernel.users : new ConsoleUsers(kernel.users);
  const vfs = new VfsIo({
    kernel,
    storage,
    recorder,
    seed: deps.seed,
    standalone: deps.engines === undefined,
    users: consoleUsers,
    onCommit: (info) => {
      if (!info.synced) return;
      if (syncIo.syncEngine !== null) syncIo.kick();
      // Without an engine nothing drains the outbox. Count the commit at once, then count the
      // records again shortly after (a write coalesced into a pending record adds no record), so
      // the tray's count and the popover's list agree (UI-026).
      else {
        net.setQueued(net.queuedOps + 1);
        recountSoon();
      }
    },
    swapBytes: () => {
      const s = mmRef?.manager?.summary();
      return { local: s?.swapLocal.bytes ?? 0, remote: s?.swapRemote.bytes ?? 0 };
    },
    busy: (ino, pid) => localLocks.blocks(ino, pid),
    ...(platform.fetch === undefined ? {} : { fetchBlob: blobFetch(platform.fetch) }),
    fsOptions: { verifyPlanToken: ai.verifyPlanToken() },
    timers,
    mounted: (fs) => {
      fsRef = fs;
      installProcSeams(
        kernel,
        fs,
        services,
        (gid) => consoleUser()?.me?.groups.find((g) => g.gid === gid)?.name,
      );
      for (const cb of [...mountedCbs]) cb(fs);
    },
  });

  // -- mm ------------------------------------------------------------------------------------
  const mmIo = new MmIo({
    kernel,
    link: deps.memory,
    keep: async () => {
      const store = storage.store;
      if (store === null) return [];
      const keep: { uid: number; osSession: string }[] = [];
      await store.scan<{ uid?: unknown; osSessionId?: unknown }>('os_sessions', null, (r) => {
        if (typeof r.uid === 'number' && typeof r.osSessionId === 'string')
          keep.push({ uid: r.uid, osSession: r.osSessionId });
      });
      return keep;
    },
    notice: (text) => {
      notify({ level: 'warning', title: 'Memory is tight', body: text, source: { svc: 'mm' } });
    },
  });
  mmRef = mmIo;

  // -- login, session -------------------------------------------------------------------------
  const verifier = new OfflineVerifier({
    store: () => storage.store,
    subtle: platform.subtle,
    random: platform.randomBytes ?? defaultRandom,
    now: epochMs,
    ...(deps.verifierIterations === undefined ? {} : { iterations: deps.verifierIterations }),
  });

  const login = new LoginIo({
    kernel,
    api,
    verifier,
    net,
    fs: () => fsRef,
    options: deps.login ?? {},
    post,
    epochMs,
    afterInteractive: runAfterInteractive,
    serverHomes: defaultEngines !== undefined,
    prompted: () => {
      void recorder.loginReady().catch(() => undefined);
    },
    established: (s) => {
      windows.setUser(
        { uid: s.uid, username: s.username, kind: s.kind, home: s.home, mode: s.mode },
        kernel.osSessionId,
        { uid: s.uid, gid: s.gid, groups: s.groups },
      );
      post({ t: 'login.session', session: sessionInfoOf(s), osSessionId: kernel.osSessionId });
    },
  });
  loginRef = login;

  const session = new SessionIo({
    kernel,
    windows,
    timers,
    store: () => storage.store,
    console: consoleUser,
    bootId: () => recorder.current?.bootId ?? 'boot',
    epochMs,
    launch: (app, argv) => {
      launch(app, argv);
    },
    notify: (title, body) => {
      notify({ level: 'warning', title, body, source: { svc: 'session' } });
    },
  });
  sessionRef = session;

  // -- auth, complete, update -----------------------------------------------------------------
  const auth = new AuthIo({
    api,
    net,
    identity,
    console: consoleUser,
    newer: (v) => {
      kernel.bus.publish('update.available', {
        version: v.version.slice(0, 32),
        build: v.build.slice(0, 32),
      });
    },
  });

  // -- the desktop host's requests, the outbox list, violation reports (./host.ts) -----------
  const hostRequests = new HostRequests({
    kernel,
    console: consoleUser,
    fs: () => fsRef,
    store: () => storage.store,
  });
  /** Push the outbox list to the router whenever the queued count changes (UI-026). */
  let lastQueued = -1;
  const pushOutbox = (): void => {
    void hostRequests.outbox().then(
      (ops) => {
        post({ t: 'outbox', ops, queued: net.queuedOps });
      },
      () => undefined,
    );
  };
  const unNet = net.onChange((st) => {
    if (st.queuedOps === lastQueued) return;
    lastQueued = st.queuedOps;
    pushOutbox();
  });
  let recountArmed = false;
  const recountSoon = (): void => {
    if (recountArmed) return;
    recountArmed = true;
    after(OUTBOX_RECOUNT_MS, () => {
      recountArmed = false;
      void queuedOps().then(
        (n) => {
          net.setQueued(n);
        },
        () => undefined,
      );
    });
  };
  const violations = new Set<string>();
  let violationsLogged = 0;
  const noteViolation = (ev: Extract<IoRouterEvent, { t: 'sec.violation' }>): void => {
    const key = `${ev.directive}|${ev.sample}`;
    if (violations.has(key)) return;
    violations.add(key);
    violationsLogged++;
    if (violationsLogged > SEC_VIOLATIONS_LOGGED_MAX) {
      if (violationsLogged === SEC_VIOLATIONS_LOGGED_MAX + 1)
        log('sec', 'warn', 'more policy violations: not logged (see the browser console)');
      return;
    }
    log(
      'sec',
      ev.disposition === 'enforce' ? 'warn' : 'info',
      `${ev.disposition === 'enforce' ? 'blocked' : 'report-only'} ${ev.directive.slice(0, 64)}: ${ev.sample.slice(0, 80)}${ev.source === '' ? '' : ` · ${ev.source.slice(0, 120)}`}`,
    );
  };

  const complete = new CompleteIo({
    fs: () => fsRef,
    catalog: kernel.programs,
    home: () => consoleUser()?.home ?? null,
    log: (level, msg) => {
      log('complete', level, msg);
    },
    now,
  });

  const update = new UpdateIo({
    supported: platform.serviceWorker === true,
    requestRegister: deps.requestSwRegister,
    waiting: () => {
      kernel.bus.publish('update.available', { version: 'new', build: 'waiting' });
      notify({
        level: 'info',
        title: 'A new version is ready',
        body: 'Restart to update.',
        source: { svc: 'update' },
      });
    },
  });

  // -- the ports and the services -------------------------------------------------------------
  const ports: SystemPorts = {
    storage,
    vfs,
    mm: mmIo,
    login,
    session: {
      restore: async (profile) => {
        const r = await session.restore(profile);
        const s = consoleUser();
        if (s !== null) {
          windows.setUser(
            { uid: s.uid, username: s.username, kind: s.kind, home: s.home, mode: s.mode },
            r.osSessionId,
            { uid: s.uid, gid: s.gid, groups: s.groups },
          );
          post({ t: 'login.session', session: sessionInfoOf(s), osSessionId: r.osSessionId });
        }
        return r;
      },
      save: (d) => session.save(d),
    },
    auth,
    sync: syncIo,
    lockd,
    ai: ai.port,
    complete,
    update,
  };
  const serviceMap = createSystemServices(ports);
  for (const name of AI_SERVICE_NAMES) serviceMap.set(name, ai.service(name));

  // -- process exit: windows, locks, AI -------------------------------------------------------
  const unTerminate = kernel.procs.onTerminate((pcb: PCB) => {
    windows.closeAllOf(pcb);
    localLocks.releaseAll(pcb.pid);
    netCalls.releaseAll(pcb.pid);
    eventCalls.releaseAll(pcb.pid);
    ai.processExit(pcb.pid);
  });

  // -- desktop notices from the bus -----------------------------------------------------------
  const noticeSub = kernel.bus.subscribe(['svc.failed', 'lock.lost'], {
    cred: { uid: 0, gid: 0, groups: [0] },
    onReady: (sub) => {
      for (const e of sub.take().events) {
        if (e.topic === 'svc.failed' && !e.data.critical)
          notify({
            level: 'warning',
            title: `${e.data.name} stopped`,
            body: e.data.error ?? 'It will be retried.',
            source: { svc: e.data.name },
          });
        else if (e.topic === 'lock.lost')
          notify({
            level: 'error',
            title: 'A file lock was lost',
            body:
              e.data.holder === undefined
                ? 'Another session took it over.'
                : `Now held by ${e.data.holder}.`,
            source: { svc: 'lockd' },
          });
      }
    },
  });

  registerSystemSyscalls(kernel.handlers, {
    recorder,
    services,
    fs: () => fsRef,
    console: consoleUser,
    epochMs,
    now,
    after: (ms, fn) => {
      after(ms, fn);
    },
    power,
    logout,
    lock: () => {
      post({ t: 'login.lock' });
    },
  });

  // -- the router -----------------------------------------------------------------------------
  const reply = (rid: number, r: LoginReply): void => {
    post({ t: 'login.result', rid, ...r });
  };

  const onInteractive = (): void => {
    if (interactive) return;
    interactive = true;
    kernel.proc.setDesktopInteractive(true);
    for (const fn of afterInteractive.splice(0)) {
      try {
        fn();
      } catch (e) {
        log(
          'kernel',
          'warn',
          `after-interactive task failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    syncIo.connect();
    const n = session.relaunch();
    if (n > 0) log('session', 'info', `relaunching ${String(n)} apps of the saved layout`);
    ai.desktopInteractive();
    void recorder.interactive().catch(() => undefined);
    after(BOOT_RECORD_REFRESH_MS, () => {
      void recorder.refresh().catch(() => undefined);
    });
  };

  const router = (ev: IoRouterEvent): void => {
    switch (ev.t) {
      case 'online':
        net.setReachable('online');
        auth.online();
        syncIo.setOnline(true);
        return;
      case 'offline':
        net.setReachable('offline');
        syncIo.setOnline(false);
        return;
      case 'visibility':
        if (ev.state === 'visible') syncIo.onVisible();
        else void session.save('relaxed').catch(() => undefined);
        return;
      case 'desktop.interactive':
        onInteractive();
        return;
      case 'sw':
        update.event(ev.event);
        return;
      case 'persist': {
        // One line per boot (UI-063): the storage service reports it, this only a later change.
        const line = storage.notePersist(ev.persisted);
        if (line !== null) log('storage', line.level, line.msg);
        return;
      }
      case 'pagehide':
        void io.shutdown('pagehide');
        return;
      case 'viewport':
        session.setViewport(ev.w, ev.h, ev.dpr);
        return;
      case 'login.hello':
        void login.sendState();
        return;
      case 'login.submit':
        void login.submit(ev.user, ev.secret).then((r) => {
          reply(ev.rid, r);
        });
        return;
      case 'login.guest':
        void login.submit('guest', 'guest').then((r) => {
          reply(ev.rid, r);
        });
        return;
      case 'login.unlock':
        void login.unlock(ev.user, ev.secret).then((r) => {
          reply(ev.rid, r);
        });
        return;
      case 'login.logout':
        void logout();
        return;
      case 'host.request': {
        const rid = ev.rid;
        hostRequests.handle(ev.req).then(
          (value) => {
            post({ t: 'host.reply', rid, ok: true, value });
          },
          (e: unknown) => {
            post({
              t: 'host.reply',
              rid,
              ok: false,
              errno: e instanceof KernelError ? e.errno : 'EIO',
              error: e instanceof Error ? e.message.slice(0, 256) : String(e).slice(0, 256),
            });
          },
        );
        return;
      }
      case 'sec.violation':
        noteViolation(ev);
        return;
    }
  };

  const io: Io = {
    ports,
    services: serviceMap,
    windows,
    net,
    fs: () => fsRef,
    onMounted: (cb) => {
      if (fsRef !== null) cb(fsRef);
      mountedCbs.add(cb);
      return () => mountedCbs.delete(cb);
    },
    bootId: () => recorder.current?.bootId ?? null,
    attachCompositor: (port: PortLike) => {
      windows.attach(port);
    },
    router,
    shutdown: async (kind) => {
      try {
        if (consoleUser() !== null) await session.save(kind === 'pagehide' ? 'relaxed' : 'strict');
      } catch (e) {
        log('session', 'warn', `layout not saved: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        await recorder.shutdown(kind);
      } catch {
        // The boot record is diagnostic; a failed write must not block the shutdown.
      }
    },
    dispose: () => {
      unTerminate();
      unNet();
      kernel.bus.unsubscribe(noticeSub);
      windows.dispose();
      net.dispose();
      void complete.stop();
    },
  };
  return io;
}

/** Restore data a `launch {restore}` carried, re-exported for hosts. */
export type { LayoutWindow };

/**
 * The proc seams that need the VFS (core/proc/system.ts `ProcHooks`): exec permission on the
 * manifest, file-descriptor inheritance, `chdir` resolution, user info and service health.
 * Hooks another subsystem installed first (the TTY layer's fd inheritance) keep running.
 */
export function installProcSeams(
  kernel: Kernel,
  fs: KernelFs,
  services: () => { stateOf(name: ServiceName): string | undefined } | null,
  /** Group names the server gave the console user's account (`/api/auth/me` groups). */
  accountGroupName?: (gid: number) => string | undefined,
): void {
  const hooks = kernel.proc.hooks;
  hooks.checkExec = async (caller, path) => {
    const actor = actorOf(caller);
    try {
      const r = await fs.resolvePath(actor, path, { follow: true });
      const node = r.node;
      if (node === null) return null;
      if (node.type !== 'f') return new KernelError('EACCES', { path }, 'not a program manifest');
      return may(actor.cred, node, 4 | X)
        ? null
        : new KernelError('EACCES', { path }, 'permission denied');
    } catch (e) {
      // A manifest the catalog knows but the volume does not hold (a volume made before /bin was
      // seeded) is served from the catalog; any other resolution error is the caller's.
      if (e instanceof KernelError && e.errno === 'ENOENT') return null;
      return e instanceof KernelError ? e : new KernelError('EIO', undefined, 'exec check failed');
    }
  };
  const prevInherit = hooks.inheritFds?.bind(hooks);
  hooks.inheritFds = (parent, child, fds) => {
    prevInherit?.(parent, child, fds);
    fs.fds.inherit(parent, child);
    if (fds === undefined) return;
    for (const to of [0, 1, 2] as const) {
      const from = fds[to];
      if (from === undefined || from === to || !fs.fds.has(parent.pid, from)) continue;
      fs.fds.dup2(child, from, to);
    }
  };
  hooks.resolveDir = async (pcb, path) => {
    const actor = actorOf(pcb);
    const r = await fs.resolvePath(actor, path, { follow: true });
    const node = r.node;
    if (node === null) throw new KernelError('ENOENT', { path }, 'no such directory');
    if (node.type !== 'd') throw new KernelError('ENOTDIR', { path }, 'not a directory');
    if (!may(actor.cred, node, X)) throw new KernelError('EACCES', { path }, 'permission denied');
    return { path: r.path, ino: node.ino };
  };
  hooks.userInfo = (uid) => {
    const u = fs.tree.user(uid);
    if (u === undefined) return uid === 0 ? { home: '/root' } : undefined;
    return { home: uid === 0 ? '/root' : `/home/${u.username}` };
  };
  hooks.groupName = (gid) => {
    const name = fs.groupName(gid) ?? accountGroupName?.(gid);
    // Only names the protocol accepts (`Username`); anything else falls back to `g<gid>`.
    return name !== undefined && /^[a-z_][a-z0-9_-]{0,31}$/.test(name) ? name : undefined;
  };
  hooks.serviceState = (name) => {
    const st = services()?.stateOf(name);
    if (st === undefined || st === 'running') return 'running';
    return st === 'degraded' || st === 'blocked' ? 'degraded' : 'down';
  };
}
