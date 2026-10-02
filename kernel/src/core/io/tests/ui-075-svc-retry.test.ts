/**
 * UI-075: the desktop's "Retry now" posts `svc.retry` on the compositor port. The kernel always
 * answers with svc events: a degraded service is restarted (stopping → starting → its new state),
 * and a running one reports its state again, so the shell never waits for an event that never
 * comes.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { World } from './world.ts';
import { bootToDesktop, fakeServer } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

/** The state sequence of `name` since event `from` (a label update repeats a state: kept once). */
function statesOf(w: World, name: string, from: number): string[] {
  const out: string[] = [];
  for (const e of w.events.slice(from))
    if (e.name === name && out.at(-1) !== e.state) out.push(e.state);
  return out;
}

describe('UI-075 svc.retry from the desktop always answers', () => {
  it('UI-075 retrying degraded lockd restarts it and reports every step', async () => {
    const w = await bootToDesktop({
      server: fakeServer(),
      who: { user: 'alice', secret: 'alice-pass' },
    });
    worlds.push(w);
    await w.until(() => w.stateOf('lockd') === 'degraded');
    const from = w.events.length;
    w.shellPort.postMessage({ t: 'svc.retry', name: 'lockd' });
    await w.until(() => statesOf(w, 'lockd', from).includes('degraded'));
    expect(statesOf(w, 'lockd', from)).toEqual(['stopping', 'starting', 'degraded']);
  });

  it('UI-075 retrying a running service answers with its current state', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const from = w.events.length;
    w.shellPort.postMessage({ t: 'svc.retry', name: 'vfs' });
    await w.until(() => statesOf(w, 'vfs', from).length > 0);
    expect(statesOf(w, 'vfs', from)).toEqual(['running']);
    expect(w.stateOf('vfs')).toBe('running');
  });
});
