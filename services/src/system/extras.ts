/**
 * The non-critical services after the desktop: `ai.runtime`, `ai.indexer`, `ai.predictor`,
 * `ai.agent`, `complete` and `update` (boot-and-services.md §3.3). AI degrades cleanly: a build
 * without AI, or one whose ai/ provider is not linked, starts these DEGRADED with the reason
 * (C12 litmus: the desktop still boots and every non-AI feature works).
 */
import type { ServiceImpl, StartResult } from '../types.ts';
import type {
  AiPort,
  AiServiceName,
  CompletePort,
  SwEvent,
  SwOutcome,
  UpdatePort,
} from './ports.ts';

const RUNNING: StartResult = { status: 'running' };

export function aiService(name: AiServiceName, port: AiPort): ServiceImpl {
  return {
    start: async (ctx) => {
      ctx.label(`${name}: starting`);
      const r = await port.start(name, ctx.profile);
      if (r.status === 'running') {
        ctx.log('info', r.detail);
        return RUNNING;
      }
      return r;
    },
    stop: () => port.stop(name),
  };
}

export function completeService(port: CompletePort): ServiceImpl {
  return {
    start: async (ctx) => {
      ctx.label('complete: loading the completion trie');
      const s = await port.start();
      ctx.log(
        'info',
        `trie ready · cmd ${String(s.cmd)} · flag ${String(s.flag)} · hist ${String(s.hist)} · path ${String(s.path)}`,
      );
      return RUNNING;
    },
    stop: () => port.stop(),
  };
}

/** How long `update` waits for the registration before reporting it pending (timeout is 10 s). */
export const SW_WAIT_MS = 8_000;

export function updateService(port: UpdatePort): ServiceImpl {
  let unsubscribe: (() => void) | null = null;
  return {
    start: async (ctx) => {
      if (!port.supported())
        return {
          status: 'degraded',
          reason: 'no Service Worker: offline boot unavailable',
          selfHeals: false,
        };
      ctx.label('update: registering the Service Worker');
      const outcome = await new Promise<SwOutcome | 'pending'>((resolve) => {
        let timer: number | null = null;
        const off = port.onEvent((e) => {
          if (e !== 'registered' && e !== 'activated' && e !== 'error') return;
          off();
          if (timer !== null) ctx.timers.cancel(timer);
          resolve(e === 'error' ? 'error' : 'registered');
        });
        timer = ctx.timers.at(ctx.timers.now() + SW_WAIT_MS, () => {
          off();
          resolve('pending');
        });
        port.register();
      });
      unsubscribe?.();
      unsubscribe = port.onEvent((e: SwEvent) => {
        if (e === 'registered' || e === 'activated') ctx.recovered();
        else if (e === 'waiting') ctx.log('info', 'a new version is ready: reload to update');
        else ctx.degraded('Service Worker error');
      });
      switch (outcome) {
        case 'registered':
          ctx.log('info', 'Service Worker registered · offline-ready');
          return RUNNING;
        case 'error':
          return {
            status: 'degraded',
            reason: 'Service Worker registration failed',
            selfHeals: false,
          };
        case 'pending':
          return {
            status: 'degraded',
            reason: 'Service Worker not registered yet',
            selfHeals: true,
          };
        case 'unsupported':
          return {
            status: 'degraded',
            reason: 'no Service Worker: offline boot unavailable',
            selfHeals: false,
          };
      }
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
      return Promise.resolve();
    },
  };
}
