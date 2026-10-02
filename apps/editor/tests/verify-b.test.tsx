// @vitest-environment happy-dom
/**
 * A regression the Wave 3 verifier (verify-b) found on the Docker build after UI-117: a new,
 * never-saved document read "saved v0 · synced" (docs/design/bug-hunt/verify/verify-b.md).
 */
import type { NetStatus } from '@plotinium/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { demoWorld } from '../../files/tests/fake-sys.ts';
import { mountView, settle, type MountedView } from '../../files/tests/view-harness.ts';
import { mount, statusOf } from '../view.tsx';

const ONLINE: NetStatus = {
  state: 'online',
  queuedOps: 0,
  lastAckAt: null,
  degraded: [],
  leaseTtlMs: 30_000,
  serverBuild: null,
};

let view: MountedView | undefined;
afterEach(() => {
  view?.dispose();
  view = undefined;
});

describe('Editor status for a document in no file yet (verify-b)', () => {
  it('UI-117 an untitled document is "not saved" with no sync state, a saved file keeps both', () => {
    expect(
      statusOf(
        {
          path: undefined,
          save: { kind: 'saved', version: 0 },
          sync: 'synced',
          conflict: undefined,
        },
        ONLINE,
      ),
    ).toEqual({ save: { kind: 'new' }, sync: { kind: 'none' } });
    expect(
      statusOf(
        { path: undefined, save: { kind: 'edited' }, sync: 'synced', conflict: undefined },
        ONLINE,
      ),
    ).toEqual({ save: { kind: 'edited' }, sync: { kind: 'none' } });
    expect(statusOf(undefined, ONLINE)).toEqual({ save: { kind: 'new' }, sync: { kind: 'none' } });
    expect(
      statusOf(
        {
          path: '/home/alice/a.md',
          save: { kind: 'saved', version: 3 },
          sync: 'synced',
          conflict: undefined,
        },
        ONLINE,
      ),
    ).toEqual({ save: { kind: 'saved', version: 3 }, sync: { kind: 'synced' } });
  });

  it('UI-117 an Editor opened from the Dock never claims "saved v0" or "synced"', async () => {
    view = mountView(mount, {
      app: 'editor',
      sys: demoWorld().alice,
      argv: [],
      extras: {
        'net.status': () => ONLINE,
        'window.setCloseGuard': () => ({}),
        'window.focus': () => ({ focused: true }),
      },
      wid: 9,
    });
    await settle(3);
    const bar = document.querySelector('footer')?.textContent ?? '';
    expect(bar).toContain('not saved');
    expect(bar).not.toContain('saved v0');
    expect(bar).not.toContain('synced');
  });
});
