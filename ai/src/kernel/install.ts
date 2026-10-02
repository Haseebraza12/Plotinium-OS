/**
 * `installAi`: the ONE entry point the kernel's composer calls to bring the AI subsystems up
 * (C12; boot-and-services.md §3.3 services `ai.runtime`, `ai.indexer`, `ai.predictor`, `ai.agent`).
 *
 * The kernel may not import ai/ (the AI-off litmus build removes it), so web's kernel-worker entry
 * — the only place that sees both — builds the dependencies and calls:
 *
 *   const ai = installAi({ kernel: {handlers, hooks, bus, makeError, now, epochMs, log}, fs, … });
 *   registry.set('ai.runtime', ai.services['ai.runtime']);   // and ai.indexer, ai.predictor, ai.agent
 *   registerFsSyscalls(kernel.handlers, fs, { verifyPlanToken: (c, a) => ai.verifyPlanToken(c, a) });
 *
 * Nothing is registered at install time. `ai.runtime.start()` registers the ai.* syscall table and
 * the seams (< 50 ms, no network, no weights, §3.1); `ai.agent.start()` registers the agent calls
 * and `ShellNL`; `ai.indexer` / `ai.predictor` spawn their daemons through `spawnDaemon`. Safe mode
 * starts none of them, so every ai.* call stays ENOSYS (BOOT-06).
 */
import type { ArgsOf, CallName, IndexStatus, KEvent, RetOf } from '@plotinium/protocol';

import {
  EMBED_PAGE_BYTES,
  EmbedService,
  type EmbedServiceDeps,
  type EmbedTimers,
  type ModelState,
} from './embed-service.ts';
import { AgentService, type AgentFsDeps } from './agent-service.ts';
import type { ConfirmTty } from '../agent/confirm.ts';
import type { AiFsView } from './fs-view.ts';
import { SemanticIndex } from './index-store.ts';
import { PredictService, type MemoryFacts, TelemetryService } from './predict-service.ts';
import { SearchService } from './search-service.ts';
import type { VerifyItem } from '../search/results.ts';
import { registerAiHooks } from '../hooks.ts';
import { FALLBACK, PRIMARY, modelKey } from '../embed/config.ts';
import type { AiCallImpl, AiCaller, AiKernel, HostFetch } from './types.ts';
import type { Result } from '../util/errors.ts';
import type { Cred } from '../util/cred.ts';

/** The subset of the service manager's `ServiceContext` the AI services use. */
export interface AiServiceContext {
  readonly signal: AbortSignal;
  log(level: 'info' | 'warn' | 'degraded' | 'fail', msg: string): void;
  label(text: string): void;
}

export type AiStartResult =
  | { readonly status: 'running' }
  | { readonly status: 'degraded'; readonly reason: string; readonly selfHeals: boolean };

/** Structurally a `ServiceImpl` of @plotinium/services. */
export interface AiServiceImpl {
  start(ctx: AiServiceContext): Promise<AiStartResult>;
  stop(ctx: AiServiceContext, reason: 'shutdown' | 'restart' | 'retry'): Promise<void>;
}

export type AiServiceName = 'ai.runtime' | 'ai.indexer' | 'ai.predictor' | 'ai.agent';

/** Daemons `installAi` asks the kernel to spawn (programs/index.ts has their manifests). */
export type AiDaemon = 'ai.indexer' | 'ai.predictor';

export interface AiInstallOptions {
  readonly kernel: AiKernel;
  /** The live tree + `vfs/perm` (fs-view.ts `vfsTreeView(fs.tree, may)`); absent → no search. */
  readonly fs?: AiFsView;
  /** The kernel's permission epoch (bumped on chmod/chown/rename/unlink/group change). */
  readonly permEpoch?: () => number;
  /** The `ai.embed` worker; absent → keyword search only (RAG-06). */
  readonly embed?: Pick<EmbedServiceDeps, 'spawn' | 'threads' | 'model'>;
  /** Platform timers (setTimeout/clearTimeout of the kernel worker). */
  readonly timers: EmbedTimers;
  /** Same-origin fetch with the session cookie (verify, the LLM gateway). */
  readonly fetch?: HostFetch;
  readonly online?: () => boolean;
  /** RRF of vector + BM25 (on only if the evaluation showed a gain). */
  readonly hybrid?: boolean;
  /** Spawn a daemon as the session uid; resolves with its pid once it is running. */
  readonly spawnDaemon?: (name: AiDaemon) => Promise<{ pid: number }>;
  /** Spawn `prefetch:<app>` at PRI 39; resolves when it exits. */
  readonly spawnPrefetch?: (app: string, uid: number) => Promise<{ wasted: boolean }>;
  /** Warm the top result files (inode + first chunk as speculative pages, AIN-A4). */
  readonly warm?: (inos: readonly string[]) => void;
  /** The login uid of a process (telemetry is per login uid). */
  readonly uidOf?: (pid: number) => number | undefined;
  /** The desktop session's login uid (idle pre-fetch), undefined before login. */
  readonly sessionUid?: () => number | undefined;
  readonly osSessionId: () => string;
  /** Local UTC offset in minutes (east positive) at an instant. */
  readonly tzOffsetMin?: (epochMs: number) => number;
  /** IANA time zone of the session. */
  readonly timeZone?: () => string;
  readonly userName?: (uid: number) => string;
  readonly groupNames?: (gids: readonly number[]) => string[];
  readonly memory?: () => MemoryFacts | undefined;
  readonly declaredBytes?: (app: string) => number;
  /** The agent's validator view of the file system; absent → `ai.agent.submit` is EAIUNAVAIL. */
  readonly agentFs?: AgentFsDeps;
  /** The kernel-owned TTY of a caller (confirmation); absent → ENOTTY. */
  readonly tty?: (caller: AiCaller) => ConfirmTty | undefined;
  readonly safeMode?: boolean;
}

export interface AiInstallation {
  readonly index: SemanticIndex;
  readonly embed: EmbedService | null;
  readonly search: SearchService | null;
  readonly telemetry: TelemetryService;
  readonly predict: PredictService;
  readonly agent: AgentService;
  readonly services: Readonly<Record<AiServiceName, AiServiceImpl>>;
  /** For `registerFsSyscalls(…, {verifyPlanToken})`: the agent `batch` gate (AGT-03). */
  verifyPlanToken(
    caller: AiCaller,
    args: {
      ops: ArgsOf<'batch'>['ops'];
      token?: string | undefined;
      planId?: string | undefined;
      txnId?: string | undefined;
    },
  ): Error | null;
  /** The kernel's kill/exit path (AGT-09). */
  onProcessExit(pid: number): void;
  /** Router input (throttle + idle facts). */
  noteInput(): void;
  /** desktop-interactive: the model loads after 2 s more of idle (BOOT-10, I-A8). */
  desktopInteractive(): void;
  /** Memory pressure: evict the model (MEM-06). */
  evictModel(): boolean;
  /** Bytes the model page holds now (free / Task Manager, MEM-07). */
  modelBytes(): number;
  uninstall(): void;
}

const INTERACTIVE_LOAD_DELAY_MS = 2_000;
const ACTIVE_WINDOW_MS = 1_000;
const PROGRESS_MIN_INTERVAL_MS = 1_000;
const VERIFY_TIMEOUT_MS = 1_500;

function credOf(c: AiCaller): Cred {
  return { uid: c.pcb.cred.uid, gid: c.pcb.cred.gid, groups: c.pcb.cred.groups };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** `POST /api/index/verify` with a 1.5 s deadline; undefined on any failure (§3.5 step 7). */
function serverVerify(fetch: HostFetch, timers: EmbedTimers) {
  return async (
    key: string,
    items: ReadonlyArray<{ ino: string; seq: number; inodeVersion: number }>,
  ): Promise<VerifyItem[] | undefined> => {
    const abort = new AbortController();
    const t = timers.set(() => abort.abort(), VERIFY_TIMEOUT_MS);
    try {
      const res = await fetch('/api/index/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelKey: key, items }),
        signal: abort.signal,
      });
      if (!res.ok) return undefined;
      const body = await res.json();
      if (!isRecord(body) || !Array.isArray(body['items'])) return undefined;
      return body['items'].filter(isRecord).map((it) => {
        const v: VerifyItem = {
          ino: typeof it['ino'] === 'string' ? it['ino'] : '',
          seq: typeof it['seq'] === 'number' ? it['seq'] : -1,
          readable: it['readable'] === true,
        };
        if (typeof it['path'] === 'string') v.path = it['path'];
        if (typeof it['inodeVersion'] === 'number') v.inodeVersion = it['inodeVersion'];
        if (typeof it['snippet'] === 'string') v.snippet = it['snippet'];
        return v;
      });
    } catch {
      return undefined;
    } finally {
      timers.clear(t);
    }
  };
}

export function installAi(opts: AiInstallOptions): AiInstallation {
  const k = opts.kernel;
  const log = (level: 'info' | 'warn' | 'degraded' | 'fail', msg: string): void => {
    k.log(level, msg);
  };
  const primaryKey = modelKey(opts.embed?.model === 'fallback' ? FALLBACK : PRIMARY);
  const index = new SemanticIndex(primaryKey);
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  const publishModel = (
    state: ModelState,
    info: { loadedBytes?: number; totalBytes?: number },
  ): void => {
    const data: { state: ModelState; bytes?: number; loadedBytes?: number; totalBytes?: number } = {
      state,
    };
    if (state === 'ready') data.bytes = EMBED_PAGE_BYTES;
    if (info.loadedBytes !== undefined) data.loadedBytes = info.loadedBytes;
    if (info.totalBytes !== undefined) data.totalBytes = info.totalBytes;
    k.bus.publish('ai.model', data);
  };
  const embed =
    opts.embed === undefined
      ? null
      : new EmbedService({
          ...opts.embed,
          now: () => k.now(),
          timers: opts.timers,
          onState: publishModel,
          log: (level, msg) => {
            log(level, msg);
          },
        });

  const fetch = opts.fetch;
  const fs = opts.fs;
  const search =
    fs === undefined
      ? null
      : new SearchService({
          index,
          embed,
          fs,
          permEpoch: () => opts.permEpoch?.() ?? 0,
          hybrid: opts.hybrid ?? false,
          online: () => opts.online?.() ?? false,
          ...(fetch === undefined ? {} : { verify: serverVerify(fetch, opts.timers) }),
          ...(opts.warm === undefined ? {} : { warm: opts.warm }),
          now: () => k.now(),
        });

  const telemetry = new TelemetryService({
    now: () => k.now(),
    epochMs: () => k.epochMs(),
    tzOffsetMin: opts.tzOffsetMin ?? ((ms) => -new Date(ms).getTimezoneOffset()),
    uidOf: opts.uidOf ?? (() => undefined),
    osSessionId: opts.osSessionId,
  });
  const predict = new PredictService({
    now: () => k.now(),
    epochMs: () => k.epochMs(),
    publish: (uid, predictions) =>
      k.bus.publish('ai.predict', { uid, predictions: [...predictions] }),
    sessionUid: opts.sessionUid ?? (() => undefined),
    running: (uid) => telemetry.running(uid),
    ...(opts.memory === undefined ? {} : { memory: opts.memory }),
    ...(opts.declaredBytes === undefined ? {} : { declaredBytes: opts.declaredBytes }),
    ...(opts.spawnPrefetch === undefined ? {} : { spawnPrefetch: opts.spawnPrefetch }),
    safeMode: opts.safeMode ?? false,
    log: (msg) => {
      log('info', msg);
    },
  });
  const agent = new AgentService({
    makeError: k.makeError,
    ...(fetch === undefined ? {} : { fetch }),
    now: () => k.now(),
    epochMs: () => k.epochMs(),
    timeZone: opts.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    userName: opts.userName ?? ((uid) => `user${String(uid)}`),
    groupNames: opts.groupNames ?? ((gids) => gids.map(String)),
    osSessionId: opts.osSessionId,
    ...(opts.agentFs === undefined ? {} : { fs: opts.agentFs }),
    ...(opts.tty === undefined ? {} : { tty: opts.tty }),
    touched: () => {
      // AIN-B4: the indexer re-reads touched files through its own vfs events.
    },
  });

  const fail = (
    errno: Parameters<typeof k.makeError>[0],
    reason?: string,
    message?: string,
  ): Error => k.makeError(errno, reason === undefined ? undefined : { reason }, message);
  const unwrap = <T>(r: Result<T>): T => {
    if (r.ok) return r.value;
    throw fail(
      r.error.errno,
      r.error.reason !== undefined && /^[a-z][a-z0-9-]{0,39}$/.test(r.error.reason)
        ? r.error.reason
        : undefined,
      r.error.message,
    );
  };

  const indexState = (): IndexStatus['state'] => {
    if (embed?.state === 'failed') return 'degraded';
    if (embed?.pinned === true) return 'paused';
    if (k.now() - lastInputAt < ACTIVE_WINDOW_MS) return 'throttled';
    return embed?.state === 'loading' ? 'indexing' : 'idle';
  };
  const modelState = (): IndexStatus['modelState'] => embed?.state ?? 'absent';
  const publishProgress = (force = false): void => {
    const now = k.now();
    if (!force && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
    lastProgressAt = now;
    k.bus.publish('ai.index.progress', {
      pending: 0,
      indexedFiles: index.indexedFiles,
      chunks: index.chunkCount,
      state: indexState(),
    });
  };

  const register = <C extends CallName>(name: C, impl: AiCallImpl<C>): void => {
    k.handlers.register(name, impl);
  };
  const handler = <C extends CallName>(
    fn: (c: AiCaller, a: ArgsOf<C>) => RetOf<C> | Promise<RetOf<C>>,
  ): AiCallImpl<C> => ({ handle: fn });

  let runtimeUp = false;
  let agentUp = false;
  let unhook: (() => void) | null = null;
  const subscriptions: unknown[] = [];

  /** Register the seams of whatever is up; HookRegistry.register merges partial sets. */
  const refreshHooks = (): void => {
    unhook = registerAiHooks(k.hooks, {
      ...(runtimeUp
        ? {
            predict,
            searchAvailable: () =>
              search === null ? 'none' : embed?.availability() === 'ready' ? 'semantic' : 'keyword',
          }
        : {}),
      ...(agentUp ? { agentAvailable: () => fetch !== undefined } : {}),
    });
  };

  const registerRuntime = (): void => {
    if (runtimeUp) return;
    runtimeUp = true;
    // Subsystem A
    if (search !== null) {
      register(
        'ai.semsearch',
        handler<'ai.semsearch'>(async (c, a) =>
          unwrap(await search.semsearch(credOf(c), c.pcb.cwdPath, a)),
        ),
      );
    }
    register(
      'ai.search.focus',
      handler<'ai.search.focus'>((_c, a) => {
        embed?.focus(a.on);
        return {};
      }),
    );
    register(
      'ai.index.status',
      handler<'ai.index.status'>((_c, a) => {
        const st: IndexStatus = {
          state: indexState(),
          pending: 0,
          indexedFiles: index.indexedFiles,
          chunks: index.chunkCount,
          modelKey: index.modelKey,
          modelState: modelState(),
        };
        if (embed !== null) {
          const p = embed.progress;
          if (p.totalBytes > 0) {
            st.loadedBytes = p.loadedBytes;
            st.totalBytes = p.totalBytes;
          }
          if (p.lastError !== undefined) st.lastError = p.lastError;
        }
        if (a.files === true) st.files = index.fileList();
        return st;
      }),
    );
    register(
      'ai.index.lookup',
      handler<'ai.index.lookup'>((_c, a) => ({ known: index.lookup(a.hashes) })),
    );
    register(
      'ai.index.embed',
      handler<'ai.index.embed'>(async (_c, a) => {
        if (embed === null) throw fail('EIO', 'model', 'no embedding model in this build');
        const v = unwrap(await embed.embed('doc', a.header, a.text));
        return v as RetOf<'ai.index.embed'>;
      }),
    );
    register(
      'ai.index.put',
      handler<'ai.index.put'>((c, a) => {
        const node = fs?.node(a.ino);
        const r = index.put(a, {
          uid: c.pcb.cred.uid,
          current:
            node === undefined || node.type !== 'f'
              ? undefined
              : { owner: node.uid, version: node.version },
          now: k.epochMs(),
        });
        const out = unwrap(r);
        publishProgress();
        return out;
      }),
    );
    register(
      'ai.index.drop',
      handler<'ai.index.drop'>((_c, a) => {
        const rows = index.drop(a.inos);
        publishProgress();
        return { rows };
      }),
    );
    // Subsystem C
    register(
      'ai.predict',
      handler<'ai.predict'>((c, a) => predict.query(c.pcb.cred.ruid, a.k ?? 3)),
    );
    register(
      'ai.predict.publish',
      handler<'ai.predict.publish'>((c, a) => {
        predict.publish(c.pcb.cred.ruid, a);
        return {};
      }),
    );
    register(
      'ai.telemetry.read',
      handler<'ai.telemetry.read'>((c, a) => telemetry.read(c.pcb.cred.ruid, a.since, a.limit)),
    );
    register(
      'ai.telemetry.clear',
      handler<'ai.telemetry.clear'>((c) => ({ cleared: telemetry.clear(c.pcb.cred.ruid) })),
    );
    register(
      'ai.telemetry.export',
      handler<'ai.telemetry.export'>((c) => {
        const bytes = new TextEncoder().encode(telemetry.exportJsonl(c.pcb.cred.ruid));
        const out = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(out).set(bytes);
        return out;
      }),
    );
    register(
      'ai.telemetry.optin',
      handler<'ai.telemetry.optin'>((c, a) => telemetry.optIn(c.pcb.cred.ruid, a.on)),
    );

    // The telemetry tap and the chown text rule (I-A3), as root on the kernel bus.
    subscriptions.push(
      k.bus.subscribe(['wm.create', 'wm.focus', 'wm.close'], {
        cred: { uid: 0, gid: 0, groups: [0] },
        onReady: (sub) => {
          for (const ev of sub.take().events) telemetry.tap(ev);
        },
      }),
      k.bus.subscribe(['vfs.chown'], {
        cred: { uid: 0, gid: 0, groups: [0] },
        onReady: (sub) => {
          for (const ev of sub.take().events) onChown(ev);
        },
      }),
    );
    refreshHooks();
    log(
      'info',
      `ai.runtime: syscalls and seams registered (model ${index.modelKey}; search ${search === null ? 'off' : 'on'})`,
    );
  };

  const onChown = (ev: KEvent): void => {
    if (ev.topic !== 'vfs.chown' || ev.data.uid === undefined) return;
    for (const ino of ev.data.inos) index.dropOwnerText(ino, ev.data.uid);
  };

  const registerAgent = (): void => {
    if (agentUp) return;
    agentUp = true;
    register(
      'ai.agent.plan',
      handler<'ai.agent.plan'>((c, a) => agent.plan(c, a)),
    );
    register(
      'ai.agent.submit',
      handler<'ai.agent.submit'>((c, a) => agent.submit(c, a)),
    );
    register(
      'ai.agent.confirm',
      handler<'ai.agent.confirm'>(async (c, a) => agent.confirm(c, a.planId)),
    );
    register(
      'ai.agent.log',
      handler<'ai.agent.log'>((c, a) => agent.log(c, a)),
    );
    refreshHooks();
  };

  const daemons = new Map<AiDaemon, number>();
  const daemonService = (name: AiDaemon): AiServiceImpl => ({
    start: async (ctx) => {
      if (opts.spawnDaemon === undefined)
        return { status: 'degraded', reason: 'daemon spawning not wired', selfHeals: false };
      ctx.label(`${name}: spawning`);
      const { pid } = await opts.spawnDaemon(name);
      daemons.set(name, pid);
      ctx.log('info', `${name} running as pid ${String(pid)}`);
      return { status: 'running' };
    },
    stop: () => {
      daemons.delete(name);
      return Promise.resolve();
    },
  });

  let loadTimer: number | null = null;

  const services: Record<AiServiceName, AiServiceImpl> = {
    'ai.runtime': {
      start: (ctx) => {
        registerRuntime();
        if (embed === null)
          return Promise.resolve({
            status: 'degraded',
            reason: 'no embedding model: keyword search only',
            selfHeals: false,
          });
        ctx.log(
          'info',
          `model ${index.modelKey} loads after desktop-interactive (never on the boot path)`,
        );
        return Promise.resolve({ status: 'running' });
      },
      stop: () => {
        embed?.stop();
        return Promise.resolve();
      },
    },
    'ai.indexer': daemonService('ai.indexer'),
    'ai.predictor': daemonService('ai.predictor'),
    'ai.agent': {
      start: () => {
        registerAgent();
        if (fetch === undefined)
          return Promise.resolve({
            status: 'degraded',
            reason: 'no gateway fetch',
            selfHeals: false,
          });
        if (opts.agentFs === undefined)
          return Promise.resolve({
            status: 'degraded',
            reason: 'plan validator not wired (submit unavailable)',
            selfHeals: false,
          });
        return Promise.resolve({ status: 'running' });
      },
      stop: () => Promise.resolve(),
    },
  };

  return {
    index,
    embed,
    search,
    telemetry,
    predict,
    agent,
    services,
    verifyPlanToken: (caller, args) => agent.verifyPlanToken(caller, args),
    onProcessExit: (pid) => {
      agent.onProcessExit(pid);
    },
    noteInput: () => {
      lastInputAt = k.now();
      predict.noteInput(lastInputAt);
    },
    desktopInteractive: () => {
      if (embed === null || loadTimer !== null) return;
      loadTimer = opts.timers.set(() => {
        loadTimer = null;
        embed.ensureLoaded('desktop-interactive + idle');
      }, INTERACTIVE_LOAD_DELAY_MS);
    },
    evictModel: () => embed?.evict() ?? false,
    modelBytes: () => embed?.residentBytes ?? 0,
    uninstall: () => {
      if (loadTimer !== null) opts.timers.clear(loadTimer);
      embed?.stop();
      unhook?.();
      unhook = null;
    },
  };
}
