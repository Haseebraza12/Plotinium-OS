/**
 * The network-facing services `auth`, `sync` and `lockd` (boot-and-services.md §3.2.2, §3.3, §3.5;
 * offline-and-sync.md). None is critical: offline they start DEGRADED with the tray reason and heal
 * themselves on the back-off schedule, or at once on the router's `online` event (OFF-04).
 */
import type { ServiceContext, ServiceImpl, StartResult } from '../types.ts';
import type { Healer } from './heal.ts';
import { selfHeal } from './heal.ts';
import type { AuthCheck, AuthPort, LockdPort, SyncPort, SyncProbe } from './ports.ts';

const RUNNING: StartResult = { status: 'running' };

/** The server session slides at most once an hour (security-model.md §3.7), so refresh hourly. */
export const AUTH_REFRESH_MS = 3_600_000;

function degraded(reason: string, selfHeals: boolean): StartResult {
  return { status: 'degraded', reason, selfHeals };
}

/** The tray reason and whether retrying can help, for a failed auth check. */
function authVerdict(c: AuthCheck): { reason: string; selfHeals: boolean } | null {
  switch (c.status) {
    case 'ok':
      return null;
    case 'local':
      return { reason: `local session (${c.why}) · sign in to sync`, selfHeals: false };
    case 'offline':
      return { reason: 'offline', selfHeals: true };
    case 'foreign-server':
      return { reason: 'foreign-server', selfHeals: false };
    case 'auth-required':
      return { reason: 'auth-required · sign in to sync', selfHeals: false };
  }
}

export function authService(port: AuthPort): ServiceImpl {
  let healer: Healer | null = null;
  let unsubscribe: (() => void) | null = null;
  let refresh: number | null = null;

  const heal = (ctx: ServiceContext): void => {
    healer?.cancel();
    healer = selfHeal(ctx, async () => (await port.check()).status === 'ok');
  };

  const armRefresh = (ctx: ServiceContext): void => {
    if (ctx.signal.aborted) return;
    refresh = ctx.timers.at(ctx.timers.now() + AUTH_REFRESH_MS, () => {
      refresh = null;
      void port.check().then(
        (c) => {
          const v = authVerdict(c);
          if (v !== null) {
            ctx.degraded(v.reason);
            if (v.selfHeals) heal(ctx);
          }
          armRefresh(ctx);
        },
        () => {
          armRefresh(ctx);
        },
      );
    });
  };

  return {
    start: async (ctx) => {
      ctx.label('auth: validating the server session');
      const c = await port.check();
      unsubscribe?.();
      unsubscribe = port.onOnline(() => {
        healer?.kick();
      });
      ctx.signal.addEventListener('abort', () => {
        if (refresh !== null) ctx.timers.cancel(refresh);
        refresh = null;
      });
      armRefresh(ctx);
      if (c.status === 'ok') {
        ctx.log('info', `server session valid (${c.username})`);
        if (c.newer !== null)
          ctx.log('info', `version ${c.newer.version} (${c.newer.build}) is available`);
        return RUNNING;
      }
      const v = authVerdict(c);
      if (v === null) return RUNNING;
      if (v.selfHeals) heal(ctx);
      return degraded(v.reason, v.selfHeals);
    },
    stop: () => {
      healer?.cancel();
      healer = null;
      unsubscribe?.();
      unsubscribe = null;
      return Promise.resolve();
    },
  };
}

export function syncService(port: SyncPort): ServiceImpl {
  let healer: Healer | null = null;
  let unsubscribe: (() => void) | null = null;

  const heal = (ctx: ServiceContext): void => {
    healer?.cancel();
    healer = selfHeal(ctx, async () => (await port.retry()).live);
  };

  const onChange = (ctx: ServiceContext, p: SyncProbe): void => {
    if (p.live) {
      healer?.cancel();
      healer = null;
      ctx.recovered();
      return;
    }
    ctx.degraded(p.reason);
    if (p.selfHeals && healer?.active !== true) heal(ctx);
  };

  return {
    start: async (ctx) => {
      ctx.label('sync: connecting to the server');
      const p = await port.start();
      unsubscribe?.();
      unsubscribe = port.onChange((next) => {
        onChange(ctx, next);
      });
      if (p.live) return RUNNING;
      if (p.selfHeals) heal(ctx);
      return degraded(p.reason, p.selfHeals);
    },
    stop: async () => {
      healer?.cancel();
      healer = null;
      unsubscribe?.();
      unsubscribe = null;
      await port.stop();
    },
  };
}

export const LOCAL_LOCKS_REASON = 'local advisory locks only';

export function lockdService(port: LockdPort): ServiceImpl {
  let unsubscribe: (() => void) | null = null;
  return {
    start: async (ctx) => {
      ctx.label('lockd: preparing the lease table');
      const { server } = await port.start();
      unsubscribe?.();
      unsubscribe = port.onServer((up) => {
        if (up) ctx.recovered();
        else ctx.degraded(LOCAL_LOCKS_REASON);
      });
      return server ? RUNNING : degraded(LOCAL_LOCKS_REASON, true);
    },
    stop: async () => {
      unsubscribe?.();
      unsubscribe = null;
      await port.stop();
    },
  };
}
