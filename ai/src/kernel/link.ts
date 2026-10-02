/**
 * `createAiLink`: the ai/ side of the kernel's `IoDeps.ai` (kernel/src/core/io/types.ts `AiLink`,
 * driven by kernel/src/core/io/ai.ts; boot-and-services.md §3.3; C12).
 *
 * The kernel may not import ai/, so web's kernel-worker entry, the only module that sees both
 * packages, passes the kernel's objects in and hands the result to `installIo`:
 *
 *   import { createAiLink, AI_MANIFESTS } from '@plotinium/ai/kernel';
 *   import EmbedWorker from '@plotinium/ai/embed-worker?worker';
 *   import { may } from '@plotinium/vfs/perm';
 *   installIo(kernel, {
 *     …,
 *     ai: createAiLink({
 *       kernel: { handlers: kernel.handlers, bus: kernel.bus, makeError: (e, d, m) => new KernelError(e, d, m),
 *                 now: () => host.clock.now(), epochMs: () => host.clock.epochMs(),
 *                 log: (level, msg) => kernel.log('ai', level, msg) },
 *       may,
 *       timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
 *       fetch: (u, i) => fetch(u, { ...i, credentials: 'same-origin' }),
 *       embed: { spawn: () => new EmbedWorker({ name: 'ai.embed' }), threads: ortThreads(crossOriginIsolated, navigator.hardwareConcurrency) },
 *       spawnDaemon: (name) => …kernel.proc.spawnProcess(AI_DAEMONS[name] as the session uid)…,
 *     }),
 *   });
 *
 * `installIo` calls the returned factory lazily with its `AiLinkContext` (the kernel hooks, the
 * mounted file system once `vfs` started, the session uid, the OS session id and the network
 * state). The factory's result is the `AiInstallation`, which IS an `AiLink`: its four service
 * implementations register the `ai.*` calls and the seams when they start, and `verifyPlanToken`,
 * `onProcessExit`, `desktopInteractive` and `noteInput` are the kernel-side callbacks.
 *
 * Every type here is STRUCTURAL (ai/ may import only protocol, dsa and @plotinium/kernel/hooks,
 * architecture.md §3.7); ai/tests/kernel.link.test.ts pins the shapes against fakes, and the
 * composer's own type check pins them against the real kernel.
 */
import type { QuotaOracle } from '../agent/apply.ts';
import type { FsSnapshot, SnapNode } from '../agent/fsview.ts';
import type { Cred } from '../util/cred.ts';
import type { AgentFsDeps } from './agent-service.ts';
import { type AiFsView, type InodeLike, type LinkRef, type MayFn, vfsTreeView } from './fs-view.ts';
import { type AiInstallOptions, type AiInstallation, installAi } from './install.ts';
import type { AiKernel, HookTarget } from './types.ts';

/** A directory entry as the kernel tree lists it. */
export interface TreeEntryLike {
  readonly name: string;
  readonly ino: string;
}

/** The kernel's `InodeRec` fields the snapshot reads (null target for non-symlinks). */
export interface TreeInodeLike extends InodeLike {
  readonly mtime: number;
  readonly target: string | null;
}

/** Structural subset of the kernel's `VfsTree` (vfs/src/tree/vfs-tree.ts). */
export interface KernelTreeLike {
  readonly rootIno: string;
  inode(ino: string): TreeInodeLike | undefined;
  links(ino: string): readonly LinkRef[];
  child(dir: string, name: string): TreeInodeLike | null | 'NOT_LOADED' | 'EAGAIN';
  entries(dir: string): readonly TreeEntryLike[] | 'NOT_LOADED' | 'EAGAIN';
}

/** Who asks the kernel file system to load directories (its `FsActor`). */
export interface FsActorLike {
  readonly pid: number;
  readonly cred: { readonly uid: number; readonly gid: number; readonly groups: readonly number[] };
  readonly cls: 'user' | 'agent' | 'system';
  readonly cwdIno: string;
  readonly cwdPath: string;
  readonly umask: number;
}

/** Structural subset of the kernel's `KernelFs` (kernel/src/core/fs/kfs.ts). */
export interface KernelFsLike {
  readonly mounted: boolean;
  readonly tree: KernelTreeLike;
  readonly events: { readonly permEpoch: number };
  userName(uid: number): string;
  isBusy(ino: string): boolean;
  prefetchSubtree(actor: FsActorLike, path: string, follow: boolean): Promise<void>;
}

/** The kernel's `AiLinkContext` as the link reads it. */
export interface AiLinkContextLike {
  readonly hooks: HookTarget;
  fs(): KernelFsLike | null;
  sessionUid(): number | undefined;
  osSessionId(): string;
  online(): boolean;
}

export interface AiLinkDeps extends Omit<
  AiInstallOptions,
  'kernel' | 'fs' | 'permEpoch' | 'agentFs' | 'sessionUid' | 'osSessionId' | 'online'
> {
  /** The kernel services (`hooks` comes from the link context). */
  readonly kernel: Omit<AiKernel, 'hooks'>;
  /** `may` of `@plotinium/vfs/perm` (the kernel's ONE permission function); absent: no search. */
  readonly may?: MayFn;
  /** Quota facts for the plan validator; absent: unlimited (the kernel's `batch` still checks). */
  readonly quota?: QuotaOracle;
}

const EMPTY_TREE: KernelTreeLike = {
  rootIno: '',
  inode: () => undefined,
  links: () => [],
  child: () => null,
  entries: () => [],
};

/** The mounted tree, or an empty one before `vfs` started (the runtime starts before it). */
function treeOf(ctx: AiLinkContextLike): KernelTreeLike {
  const fs = ctx.fs();
  return fs?.mounted === true ? fs.tree : EMPTY_TREE;
}

/** A view that always reads the CURRENT tree (I-A1): nothing is copied. */
export function lazyFsView(ctx: AiLinkContextLike, may: MayFn): AiFsView {
  const live = {
    get rootIno(): string {
      return treeOf(ctx).rootIno;
    },
    inode: (ino: string) => treeOf(ctx).inode(ino),
    links: (ino: string) => treeOf(ctx).links(ino),
    child: (dir: string, name: string) => treeOf(ctx).child(dir, name),
  };
  return vfsTreeView(live, may);
}

/** A read snapshot of the live tree for the validator's overlay (agentic-shell.md §3.11). */
export function treeSnapshot(tree: KernelTreeLike, generation: number): FsSnapshot {
  return {
    rootIno: tree.rootIno,
    generation,
    node(ino: string): SnapNode | undefined {
      const rec = tree.inode(ino);
      if (rec === undefined) return undefined;
      const base = {
        ino: rec.ino,
        type: rec.type,
        uid: rec.uid,
        gid: rec.gid,
        mode: rec.mode,
        version: rec.version,
        size: rec.size,
        mtime: rec.mtime,
      };
      if (rec.type === 'l' && rec.target !== null) return { ...base, target: rec.target };
      if (rec.type !== 'd') return base;
      const list = tree.entries(ino);
      if (typeof list === 'string') return base;
      return { ...base, children: new Map(list.map((e) => [e.name, e.ino])) };
    },
  };
}

const UNLIMITED: QuotaOracle = {
  quota: () => ({ usedBytes: 0, quotaBytes: null, usedInodes: 0, quotaInodes: null }),
};

/** The plan validator's view of the kernel file system (`ai.agent.submit`). */
export function agentFsFrom(
  ctx: AiLinkContextLike,
  may: MayFn,
  quota: QuotaOracle = UNLIMITED,
): AgentFsDeps {
  const view = lazyFsView(ctx, may);
  let generation = 0;
  return {
    snapshot: () => treeSnapshot(treeOf(ctx), ++generation),
    oracle: view.oracle,
    quota,
    leases: (ino) => ctx.fs()?.isBusy(ino) ?? false,
    home: (uid) => {
      const fs = ctx.fs();
      if (uid === 0) return '/root';
      return `/home/${fs === null ? `user${String(uid)}` : fs.userName(uid)}`;
    },
    prepare: async (cred: Cred, paths: readonly string[]) => {
      const fs = ctx.fs();
      if (fs === null || !fs.mounted) return;
      const actor: FsActorLike = {
        pid: 1,
        cred,
        cls: 'agent',
        cwdIno: '',
        cwdPath: '/',
        umask: 0o022,
      };
      for (const p of [...new Set(paths)]) await fs.prefetchSubtree(actor, p, true);
    },
  };
}

/** The factory `IoDeps.ai` takes: builds the AI runtime on first use with the kernel's context. */
export function createAiLink(deps: AiLinkDeps): (ctx: AiLinkContextLike) => AiInstallation {
  return (ctx) => {
    const { kernel, may, quota, ...rest } = deps;
    const opts: AiInstallOptions = {
      ...rest,
      kernel: { ...kernel, hooks: ctx.hooks },
      osSessionId: () => ctx.osSessionId(),
      sessionUid: () => ctx.sessionUid(),
      online: () => ctx.online(),
      permEpoch: () => ctx.fs()?.events.permEpoch ?? 0,
      ...(may === undefined
        ? {}
        : { fs: lazyFsView(ctx, may), agentFs: agentFsFrom(ctx, may, quota) }),
    };
    return installAi(opts);
  };
}
