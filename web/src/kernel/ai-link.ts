/**
 * The AI link of the kernel worker (C12; ai/README.md "Kernel wiring"). The kernel never imports
 * ai/, so this module, which sees both, builds the `IoDeps.ai` factory: installIo calls it when
 * the first AI service starts, with the link context (hooks, the live file system, the console
 * user). Everything the AI runtime needs from the kernel is passed structurally here.
 *
 * - `ai.runtime` registers the `ai.*` calls and the three kernel seams (registerAiHooks).
 * - `ai.indexer` / `ai.predictor` spawn their daemons as the SESSION user (a kernel-initiated
 *   system spawn, `daemon: true`), never as root.
 * - The embedding model runs in its own module worker (`ai.embed`), nested in this one; the
 *   model and the ONNX runtime come from the same origin (/models, /ort), never the Hub.
 */
import type {
  AiDaemon,
  AiInstallation,
  AiLinkContextLike,
  EmbedWorkerLike,
} from '@plotinium/ai/kernel';
import { AI_DAEMONS, createAiLink, ortThreads, prefetchArgv } from '@plotinium/ai/kernel';
import EmbedWorker from '@plotinium/ai/embed-worker?worker';
import type { Kernel } from '@plotinium/kernel';
import { KernelError, may } from '@plotinium/kernel';

/** The kernel, once the boot sequence built it (`startKernelWorker({ onKernel })`). */
export interface KernelRef {
  current(): Kernel | null;
}

interface WorkerScopeLike {
  readonly crossOriginIsolated: boolean;
  readonly navigator: { readonly hardwareConcurrency: number };
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** The pre-fetch job's lifetime cap: it exits on its own long before this. */
const PREFETCH_MAX_MS = 30_000;

type FromEmbedWorker = Parameters<NonNullable<EmbedWorkerLike['onmessage']>>[0]['data'];

/** The `ai.embed` module worker behind the runtime's structural worker type. */
function spawnEmbedWorker(): EmbedWorkerLike {
  const w = new EmbedWorker({ name: 'ai.embed' });
  const like: EmbedWorkerLike = {
    postMessage: (msg) => {
      w.postMessage(msg);
    },
    terminate: () => {
      w.terminate();
    },
    onmessage: null,
    onerror: null,
  };
  w.onmessage = (ev: MessageEvent<FromEmbedWorker>) => {
    like.onmessage?.({ data: ev.data });
  };
  w.onerror = (ev) => {
    like.onerror?.(ev);
  };
  return like;
}

function need(ref: KernelRef): Kernel {
  const k = ref.current();
  if (k === null) throw new KernelError('EAGAIN', undefined, 'the kernel is not up yet');
  return k;
}

/** The console user's credentials, for the daemons (never root). */
function sessionCred(ctx: AiLinkContextLike): {
  uid: number;
  gid: number;
  groups: number[];
  ruid: number;
} {
  const uid = ctx.sessionUid();
  if (uid === undefined) throw new KernelError('EAGAIN', undefined, 'nobody is signed in');
  return { uid, gid: uid, groups: [], ruid: uid };
}

/** `IoDeps.ai` for `startKernelWorker({ io: { ai } })`. */
export function aiLinkFactory(
  ref: KernelRef,
  scope: WorkerScopeLike,
): (ctx: AiLinkContextLike) => AiInstallation {
  return (ctx) => {
    const k = need(ref);
    const spawnAs = async (
      name: string,
      argv: readonly string[],
      priority: number,
      nice?: number,
    ): Promise<{ pid: number }> => {
      const pcb = await k.proc.spawnProcess({
        parent: k.init,
        name,
        argv,
        cred: sessionCred(ctx),
        priority,
        ...(nice === undefined ? {} : { nice }),
        tty: null,
        setsid: true,
        daemon: true,
      });
      return { pid: pcb.pid };
    };
    return createAiLink({
      kernel: {
        handlers: k.handlers,
        bus: k.bus,
        makeError: (errno, detail, msg) => new KernelError(errno, detail, msg),
        now: () => k.host.clock.now(),
        epochMs: () => k.host.clock.epochMs(),
        log: (level, msg) => {
          k.log('ai', level, msg);
        },
      },
      may,
      timers: {
        set: (fn, ms) => scope.setTimeout(fn, ms),
        clear: (h) => {
          scope.clearTimeout(h);
        },
      },
      fetch: async (url, init) => {
        const r = await fetch(url, { ...init, credentials: 'same-origin' });
        return { ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> };
      },
      embed: {
        spawn: spawnEmbedWorker,
        threads: ortThreads(scope.crossOriginIsolated, scope.navigator.hardwareConcurrency),
      },
      uidOf: (pid) => k.procs.get(pid)?.cred.ruid,
      userName: (uid) => k.users.nameOf(uid),
      spawnDaemon: (name: AiDaemon) => {
        const d = AI_DAEMONS[name];
        return spawnAs(d.manifest, d.argv, d.priority, d.nice);
      },
      spawnPrefetch: async (app) => {
        const { pid } = await spawnAs('prefetch', prefetchArgv(app), 39);
        // The job exits on its own (EAGAIN included); wait for that, bounded.
        return new Promise<{ wasted: boolean }>((resolve) => {
          const started = k.host.clock.now();
          const poll = (): void => {
            const p = k.procs.get(pid);
            if (p === undefined || p.state === 'TERMINATED') {
              resolve({ wasted: false });
              return;
            }
            if (k.host.clock.now() - started > PREFETCH_MAX_MS) {
              resolve({ wasted: true });
              return;
            }
            scope.setTimeout(poll, 250);
          };
          poll();
        });
      },
    })(ctx);
  };
}
