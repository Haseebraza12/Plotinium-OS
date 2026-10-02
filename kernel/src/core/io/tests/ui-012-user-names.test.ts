/**
 * UI-012: the signed-in user's account name (not `u<uid>`) everywhere the kernel names a uid:
 * `proc.cred` (whoami, id, the Terminal prompt, Settings, About), `proc.list` (Task Manager, ps)
 * and lock holders; group names resolved from the groups mirror.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { RetOf } from '@plotinium/protocol';

import type { Program } from '../../../runtime/sys.ts';
import { MemStore } from '../../fs/mem-store.ts';
import { ConsoleUsers } from '../vfs.ts';
import type { World } from './world.ts';
import { bootToDesktop, bootWorld, fakeServer, loginWaiting } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

interface Out {
  cred?: RetOf<'proc.cred'>;
  list?: RetOf<'proc.list'>;
}

const whoami = (out: Out): Program<Out> => ({
  init: () => out,
  *run(ctx, st) {
    st.cred = yield* ctx.sys['proc.cred']({});
    st.list = yield* ctx.sys['proc.list']({});
    return 0;
  },
});

describe('UI-012 account names instead of u<uid>', () => {
  it('UI-012 proc.cred and proc.list name the signed-in user and its groups', async () => {
    const server = fakeServer();
    const w = await bootToDesktop({ server, who: { user: 'alice', secret: 'alice-pass' } });
    worlds.push(w);
    expect(w.lb.kernel.users).toBeInstanceOf(ConsoleUsers);
    expect(w.lb.kernel.users.nameOf(1_100)).toBe('alice');
    expect(w.lb.kernel.users.nameOf(0)).toBe('root');
    const out: Out = {};
    const p = w.lb.spawn(whoami(out), { name: 'whoami', uid: 1_100, gid: 100 });
    p.cred = { ...p.cred, groups: [100] };
    await w.lb.run(p.pid);
    expect(out.cred).toMatchObject({ uid: 1_100, user: 'alice', home: '/home/alice' });
    expect(out.cred?.groupNames).toEqual(['users']);
    const mine = out.list?.procs.find((x) => x.pid === p.pid);
    expect(mine?.user).toBe('alice');
  });

  it('UI-012 the name survives a reload that resumes the cookie session', async () => {
    const server = fakeServer();
    const store = new MemStore();
    const first = await bootToDesktop({
      server,
      store,
      who: { user: 'alice', secret: 'alice-pass' },
    });
    first.close();
    // Second boot on the same device: the server still has the cookie session, so login resumes.
    const w = await bootWorld({ server, store });
    worlds.push(w);
    await w.until(() => w.stateOf('login') === 'running' || loginWaiting(w));
    expect(w.stateOf('login')).toBe('running');
    await w.until(() => w.stateOf('desktop') === 'starting');
    w.interactive();
    await w.until(() => w.stateOf('desktop') === 'running');
    const out: Out = {};
    const p = w.lb.spawn(whoami(out), { name: 'whoami', uid: 1_100, gid: 100 });
    await w.lb.run(p.pid);
    expect(out.cred?.user).toBe('alice');
  });

  it('UI-012 a gid with no known name reads g<gid>, never a user name', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const out: Out = {};
    const p = w.lb.spawn(whoami(out), { name: 'id', uid: 65_534, gid: 100 });
    p.cred = { ...p.cred, groups: [100, 4_242] };
    await w.lb.run(p.pid);
    expect(out.cred?.groupNames).toEqual(['users', 'g4242']);
  });
});
