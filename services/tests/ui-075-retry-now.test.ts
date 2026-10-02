/**
 * UI-075: the desktop's "Retry now" (`svc.retry`) always gets an answer. A degraded service is
 * restarted, a service degraded only through a requirement retries that requirement, a failed one
 * starts again now, and anything else reports its current state again.
 */
import { describe, expect, it } from 'vitest';

import type {
  ServiceImpl,
  ServiceManifest,
  ServiceName,
  StartResult,
  SvcEvent,
} from '../src/index.ts';
import { BUILTIN_MANIFEST_FILES, ServiceManager } from '../src/index.ts';
import { builtin, FakeTimers, flush, instant, registryOf } from './helpers.ts';

const NAMES = builtin().map((m) => m.name);

/** A service whose every start returns the next result of `results` (the last one repeats). */
function scripted(results: readonly StartResult[]): ServiceImpl & {
  readonly starts: number;
  readonly stops: string[];
} {
  const stops: string[] = [];
  const impl = {
    starts: 0,
    stops,
    start(): Promise<StartResult> {
      const r = results[Math.min(impl.starts, results.length - 1)] ?? { status: 'running' };
      impl.starts++;
      return Promise.resolve(r);
    },
    stop(_ctx: unknown, reason: string): Promise<void> {
      stops.push(reason);
      return Promise.resolve();
    },
  };
  return impl;
}

function manager(impls: Partial<Record<ServiceName, ServiceImpl>>) {
  const timers = new FakeTimers();
  const events: SvcEvent[] = [];
  const mgr = new ServiceManager({
    profile: 'normal',
    files: BUILTIN_MANIFEST_FILES,
    source: 'builtin',
    registry: registryOf(NAMES, (n) => impls[n] ?? instant()),
    timers,
    seed: 7,
    useDag: false,
    pidFor: (m: ServiceManifest) => 100 + NAMES.indexOf(m.name),
    onEvent: (e) => events.push(e),
  });
  const built = mgr.build();
  if (!built.ok) throw new Error('build failed');
  mgr.start();
  return { mgr, timers, events };
}

const DEGRADED: StartResult = { status: 'degraded', reason: 'probe failed', selfHeals: false };

describe('UI-075 svc.retry always answers', () => {
  it('UI-075 a service degraded by its own start is stopped (retry) and started again', async () => {
    const lockd = scripted([DEGRADED, { status: 'running' }]);
    const h = manager({ lockd });
    await flush();
    expect(h.mgr.stateOf('lockd')).toBe('degraded');
    const r = h.mgr.retryNow('lockd');
    expect(r).toEqual({ outcome: 'restarted', name: 'lockd' });
    await flush();
    expect(lockd.stops).toEqual(['retry']);
    expect(lockd.starts).toBe(2);
    expect(h.mgr.stateOf('lockd')).toBe('running');
    const states = h.events.filter((e) => e.name === 'lockd').map((e) => e.state);
    expect(states.slice(-3)).toEqual(['stopping', 'starting', 'running']);
  });

  it('UI-075 a service that cannot heal settles degraded again with its reason', async () => {
    const update = scripted([DEGRADED]);
    const h = manager({ update });
    await flush();
    expect(h.mgr.retryNow('update').outcome).toBe('restarted');
    await flush();
    expect(update.starts).toBe(2);
    expect(h.mgr.stateOf('update')).toBe('degraded');
    expect(h.mgr.status().find((s) => s.name === 'update')?.reason).toBe('probe failed');
  });

  it('UI-075 an inherited degradation retries the degraded requirement instead', async () => {
    const sync = scripted([DEGRADED, { status: 'running' }]);
    const h = manager({ sync });
    await flush();
    // ai.agent requires sync and is start-degraded: it inherits "requires sync".
    expect(h.mgr.status().find((s) => s.name === 'ai.agent')?.reason).toBe('requires sync');
    expect(h.mgr.retryNow('ai.agent')).toEqual({ outcome: 'restarted', name: 'sync' });
    await flush();
    expect(sync.starts).toBe(2);
    expect(h.mgr.stateOf('sync')).toBe('running');
    // The dependents that only inherited the degradation recover with it.
    expect(h.mgr.stateOf('ai.agent')).toBe('running');
    expect(h.mgr.stateOf('lockd')).toBe('running');
  });

  it('UI-075 a running service is not restarted but its state is reported again', async () => {
    const h = manager({});
    await flush();
    const before = h.events.length;
    expect(h.mgr.retryNow('vfs')).toEqual({ outcome: 'unchanged', name: 'vfs' });
    expect(h.events.slice(before)).toMatchObject([{ name: 'vfs', state: 'running' }]);
    expect(h.mgr.retryNow('nope')).toEqual({ outcome: 'unknown', name: 'nope' });
  });

  it('UI-075 a failed non-critical service starts again at once', async () => {
    let n = 0;
    const auth: ServiceImpl = {
      start: () =>
        n++ === 0 ? Promise.reject(new Error('down')) : Promise.resolve({ status: 'running' }),
      stop: () => Promise.resolve(),
    };
    const h = manager({ auth });
    await flush();
    expect(h.mgr.stateOf('auth')).toBe('retry-wait');
    expect(h.mgr.retryNow('auth').outcome).toBe('restarted');
    await flush();
    expect(h.mgr.stateOf('auth')).toBe('running');
  });
});
