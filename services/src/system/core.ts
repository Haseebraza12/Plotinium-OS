/**
 * The critical storage-side services: `storage`, `vfs`, `mm`, `login` and `session`
 * (boot-and-services.md §3.3). Each start resolves exactly when its "started means" column is true;
 * a rejection is a critical failure and ends on the BOOT-08 recovery screen.
 */
import type { ServiceContext, ServiceImpl, StartResult } from '../types.ts';
import type { LoginMode, LoginPort, MmPort, SessionPort, StoragePort, VfsPort } from './ports.ts';

const RUNNING: StartResult = { status: 'running' };

const MIB = 1_048_576;

/** Memory-manager tick (memory-and-paging.md §3.7) and the desktop statistics period. */
export const MM_TICK_MS = 1_000;
export const MM_PUBLISH_MS = 2_000;

export function storageService(port: StoragePort): ServiceImpl {
  return {
    start: async (ctx) => {
      ctx.label('storage: opening IndexedDB plotinium');
      const o = await port.open(ctx.profile);
      if (o.backend === 'memory') {
        ctx.log(
          'warn',
          `IndexedDB unavailable (${o.fallback ?? 'no factory'}): files live in memory until reload`,
        );
      } else {
        ctx.log(
          'info',
          `IndexedDB plotinium v${String(o.schemaVersion)} open · fencing epoch ${String(o.epoch)}` +
            (o.firstBoot ? ' · first boot' : ''),
        );
      }
      if (o.persisted === false)
        ctx.log('warn', 'persistent storage not granted: the browser may evict local data');
      return RUNNING;
    },
    stop: () => port.close(),
  };
}

export function vfsService(port: VfsPort): ServiceImpl {
  return {
    start: async (ctx) => {
      ctx.label('vfs: mounting /');
      const m = await port.mount(ctx.profile);
      if (m.mkfs)
        ctx.log('info', `mkfs: standard hierarchy created · ${String(m.seeded)} seeded files`);
      if (m.tmpCleared > 0) ctx.log('info', `/tmp cleared (${String(m.tmpCleared)} entries)`);
      if (m.readOnly) ctx.log('warn', 'mounted read-only (recovery mode)');
      if (m.standalone)
        ctx.log('info', 'standalone mount: the local store is authoritative until sync is live');
      if (m.backend === 'memory') ctx.log('warn', 'memory store: nothing survives a reload');
      return RUNNING;
    },
    stop: () => port.unmount(),
  };
}

/** Re-arm `fn` every `periodMs` on the kernel timer heap until `ctx.signal` aborts. */
function every(ctx: ServiceContext, periodMs: number, fn: () => void): () => void {
  let handle: number | null = null;
  const arm = (): void => {
    if (ctx.signal.aborted) return;
    handle = ctx.timers.at(ctx.timers.now() + periodMs, () => {
      handle = null;
      try {
        fn();
      } catch (e) {
        ctx.log('warn', `periodic task failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      arm();
    });
  };
  const cancel = (): void => {
    if (handle !== null) ctx.timers.cancel(handle);
    handle = null;
  };
  ctx.signal.addEventListener('abort', cancel);
  arm();
  return cancel;
}

export function mmService(port: MmPort): ServiceImpl {
  let cancelTick: (() => void) | null = null;
  let cancelPublish: (() => void) | null = null;
  return {
    start: async (ctx) => {
      ctx.label('mm: loading the memory budget');
      const s = await port.start(ctx.profile);
      const swept =
        s.swept === null
          ? ''
          : ` · sweep ${String(s.swept.files)} files (${(s.swept.bytes / MIB).toFixed(1)} MiB)`;
      ctx.log(
        'info',
        `budget ${String(Math.round(s.budgetBytes / MIB))} MiB · swap ${s.swap}${swept}`,
      );
      if (s.note !== null) ctx.log('warn', s.note);
      cancelTick = every(ctx, MM_TICK_MS, () => {
        port.tick();
      });
      cancelPublish = every(ctx, MM_PUBLISH_MS, () => {
        port.publish();
      });
      port.publish();
      return RUNNING;
    },
    stop: async () => {
      cancelTick?.();
      cancelPublish?.();
      await port.stop();
    },
  };
}

const MODE_TEXT: Readonly<Record<LoginMode, string>> = {
  cached: 'saved server session',
  online: 'password (online)',
  offline: 'offline verifier',
  guest: 'guest',
  local: 'local session',
};

export function loginService(port: LoginPort): ServiceImpl {
  return {
    start: async (ctx) => {
      ctx.label('login: checking the saved session');
      let o = await port.resume();
      if (o === null) {
        ctx.label('login: waiting for the user');
        o = await ctx.userWait(port.prompt(ctx.pid));
      }
      ctx.label(`login: signing in ${o.username}`);
      const { home } = await port.establish(o);
      ctx.log(
        'info',
        `session uid ${String(o.uid)} (${o.username}) · ${MODE_TEXT[o.mode]} · home ${home}`,
      );
      return RUNNING;
    },
    stop: () => port.stop(),
  };
}

export function sessionService(port: SessionPort): ServiceImpl {
  return {
    start: async (ctx) => {
      ctx.label('session: restoring the layout');
      const r = await port.restore(ctx.profile);
      if (r.recovered)
        ctx.log('warn', 'previous layout unreadable: kept for recovery, clean session started');
      const frames = ctx.profile === 'safe' ? ' (frames only, safe mode)' : '';
      ctx.log(
        'info',
        `os session ${r.osSessionId.slice(-8)} · ${String(r.windows)} windows restored${frames}`,
      );
      return RUNNING;
    },
    stop: (_ctx, reason) => port.save(reason === 'retry' ? 'relaxed' : 'strict'),
  };
}
