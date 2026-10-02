/**
 * UI-136: after a redeploy, a program whose code chunk is gone does not show "Could not open …:
 * Failed to fetch dynamically imported module"; the desktop offers a restart into the new version.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { isStaleChunk } from '../index.ts';
import type { World } from './world.ts';
import { bootToDesktop, settle } from './world.ts';

let world: World | null = null;
afterEach(() => {
  world?.close();
  world = null;
});

interface NotifyMsg {
  readonly t: 'notify';
  readonly n: { title: string; level: string; actions?: { id: string }[] };
}

const isNotify = (m: unknown): m is NotifyMsg =>
  typeof m === 'object' && m !== null && (m as { t?: unknown }).t === 'notify';

describe('UI-136 a stale code chunk becomes a restart offer', () => {
  it('UI-136 recognises the browsers’ chunk-load errors and nothing else', () => {
    expect(
      isStaleChunk(
        'Failed to fetch dynamically imported module: http://localhost:4718/assets/proc-D3.js',
      ),
    ).toBe(true);
    expect(isStaleChunk('error loading dynamically imported module')).toBe(true);
    expect(isStaleChunk('Importing a module script failed.')).toBe(true);
    expect(isStaleChunk('ENOENT: no such program')).toBe(false);
  });

  it('UI-136 a launch that fails on a missing chunk posts an update notice with Restart', async () => {
    world = await bootToDesktop({
      programs: [{ name: 'about', kind: 'app', entry: 'apps/about', requires: [] }],
    });
    const w = world;
    w.lb.kernel.proc.launch = () =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module: /assets/proc-old.js'),
      );
    w.interactive();
    await settle(4);
    w.shellPort.postMessage({ t: 'launch', app: 'about', argv: ['about'] });
    await w.until(() => w.compositor.some((m) => isNotify(m) && m.n.title.includes('updated')));
    const n = w.compositor.filter(isNotify).map((m) => m.n);
    expect(n.some((x) => x.title.startsWith('Could not open'))).toBe(false);
    const offer = n.find((x) => x.title === 'Plotinium was updated');
    expect(offer?.actions?.map((a) => a.id)).toEqual(['restart-update', 'later']);
  });
});
