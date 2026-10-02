/**
 * UI-134: `ai.predictor` spawns a process that needs `svc:ai.runtime`, but its manifest (spec
 * §3.3) does not require `ai.runtime`. When `login` settles before `ai.runtime` (a resumed
 * session, a slow `mm`), the predictor now waits for the runtime to settle instead of failing with
 * "service ai.runtime is down" (the "ai.predictor stopped" notice on every boot).
 */
import type { ServiceContext, ServiceImpl, ServiceState, StartResult } from '@plotinium/services';
import { afterEach, describe, expect, it } from 'vitest';

import { AI_RUNTIME_WAIT_MS, aiRuntimeSettled } from '../ai.ts';
import type { AiLink } from '../types.ts';
import type { World } from './world.ts';
import { bootToDesktop } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

const stop = (): Promise<void> => Promise.resolve();

/** An AI link whose runtime takes `runtimeMs` of kernel time to start. */
function slowRuntimeLink(runtimeMs: number, seen: ServiceState[]): AiLink {
  const runtime: ServiceImpl = {
    start: (ctx) =>
      new Promise<StartResult>((resolve) => {
        ctx.timers.at(ctx.timers.now() + runtimeMs, () => {
          resolve({ status: 'running' });
        });
      }),
    stop,
  };
  const predictor: ServiceImpl = {
    start: (ctx) => {
      seen.push(ctx.depState('ai.runtime'));
      return Promise.resolve({ status: 'running' });
    },
    stop,
  };
  return { services: { 'ai.runtime': runtime, 'ai.predictor': predictor } };
}

describe('UI-134 ai.predictor waits for ai.runtime', () => {
  it('UI-134 the predictor starts only once the runtime has settled, and both run', async () => {
    const seen: ServiceState[] = [];
    const w = await bootToDesktop({ io: { ai: slowRuntimeLink(600, seen), aiEnabled: true } });
    worlds.push(w);
    await w.until(() => seen.length > 0 && w.stateOf('ai.runtime') === 'running');
    expect(seen).toEqual(['running']);
    expect(w.stateOf('ai.predictor')).toBe('running');
    expect(w.events.some((e) => e.name === 'ai.predictor' && e.state === 'failed')).toBe(false);
  });

  it('UI-134 the wait is bounded: a runtime that never settles does not hold the predictor', async () => {
    let state: ServiceState = 'starting';
    let now = 0;
    const armed: { at: number; fn: () => void }[] = [];
    const ctx = {
      depState: () => state,
      signal: new AbortController().signal,
      timers: {
        now: () => now,
        at: (at: number, fn: () => void) => {
          armed.push({ at, fn });
          return armed.length;
        },
        cancel: () => true,
      },
    } as unknown as ServiceContext;
    let done = false;
    void aiRuntimeSettled(ctx).then(() => {
      done = true;
    });
    const run = async (untilMs: number): Promise<void> => {
      while (armed.length > 0 && (armed[0]?.at ?? Infinity) <= untilMs) {
        const next = armed.shift();
        if (next === undefined) break;
        now = next.at;
        next.fn();
        await Promise.resolve();
      }
    };
    await run(AI_RUNTIME_WAIT_MS - 50);
    expect(done).toBe(false);
    await run(AI_RUNTIME_WAIT_MS + 50);
    await Promise.resolve();
    expect(done).toBe(true);
    // A runtime that is already settled never waits.
    state = 'degraded';
    await expect(aiRuntimeSettled(ctx)).resolves.toBeUndefined();
  });
});
