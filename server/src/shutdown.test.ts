import { describe, expect, it } from 'vitest';

import { createShutdownHandler } from './shutdown.ts';

function harness(close: () => Promise<void>) {
  const events: string[] = [];
  const timers: (() => void)[] = [];
  const handler = createShutdownHandler({
    graceMs: 10_000,
    drain: () => events.push('drain'),
    close: async () => {
      events.push('close');
      await close();
    },
    exit: (code) => events.push(`exit:${code}`),
    log: (msg) => events.push(`log:${msg}`),
    setTimer: (fn) => {
      timers.push(fn);
      return {};
    },
  });
  return { events, timers, handler };
}

describe('SRV-16 graceful shutdown (backend-api.md §3.17)', () => {
  it('SRV-16 SIGTERM drains first, closes, and exits 0', async () => {
    const h = harness(() => Promise.resolve());
    h.handler('SIGTERM');
    await new Promise((r) => setImmediate(r));
    const relevant = h.events.filter((e) => !e.startsWith('log:'));
    expect(relevant).toEqual(['drain', 'close', 'exit:0']);
  });

  it('SRV-16 work still running after the grace period exits 1', () => {
    const h = harness(() => new Promise(() => undefined));
    h.handler('SIGTERM');
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.();
    expect(h.events).toContain('exit:1');
  });

  it('SRV-16 a second signal is ignored and a third forces exit 1', () => {
    const h = harness(() => new Promise(() => undefined));
    h.handler('SIGTERM');
    h.handler('SIGTERM');
    expect(h.events.filter((e) => e === 'drain')).toHaveLength(1);
    expect(h.events).not.toContain('exit:1');
    h.handler('SIGINT');
    expect(h.events).toContain('exit:1');
  });

  it('SRV-16 a failing close exits 1', async () => {
    const h = harness(() => Promise.reject(new Error('pool end failed')));
    h.handler('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(h.events).toContain('exit:1');
  });
});
