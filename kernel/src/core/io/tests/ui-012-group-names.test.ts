/**
 * UI-012: `id` names the account's supplementary groups by the server's names (`/api/auth/me`
 * groups), not `300(300)`, also when this device has no group row for them.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { RetOf } from '@plotinium/protocol';

import type { Program } from '../../../runtime/sys.ts';
import type { FakeServer, World } from './world.ts';
import { bootToDesktop, fakeServer } from './world.ts';

let world: World | null = null;
afterEach(() => {
  world?.close();
  world = null;
});

/** The auth fake, with alice also in `examiners` (300), as the server's seed has examiners. */
function withExaminers(): FakeServer {
  const s = fakeServer();
  const base = s.fetch;
  return {
    ...s,
    fetch: async (path, init) => {
      const r = await base(path, init);
      if (!r.ok || (path !== '/api/auth/me' && path !== '/api/auth/login')) return r;
      const me = (await r.json()) as { groups: { gid: number; name: string }[] };
      me.groups.push({ gid: 300, name: 'examiners' });
      return new Response(JSON.stringify(me), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

interface Out {
  list?: RetOf<'users.list'>;
}

const users = (out: Out): Program<Out> => ({
  init: () => out,
  *run(ctx, st) {
    st.list = yield* ctx.sys['users.list']({});
    return 0;
  },
});

describe('UI-012 group names come from the account when the device has none', () => {
  it('UI-012 users.list names gid 300 examiners after an online sign-in', async () => {
    world = await bootToDesktop({
      server: withExaminers(),
      who: { user: 'alice', secret: 'alice-pass' },
    });
    const out: Out = {};
    const p = world.lb.spawn(users(out), { name: 'id', uid: 1_100, gid: 100 });
    await world.lb.run(p.pid);
    expect(out.list?.groups).toContainEqual({ gid: 300, name: 'examiners' });
    expect(out.list?.groups.filter((g) => g.gid === 100)).toHaveLength(1);
  });
});
