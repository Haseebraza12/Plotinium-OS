/**
 * The desktop host's requests on the router port (kernel/src/core/io/host.ts):
 * UI-047 the Control Centre memory budget, UI-026 the outbox list (and its push when the count
 * changes), UI-045 file search under the user's home, UI-137 violation reports to klog.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Program } from '../../../runtime/sys.ts';
import { messageOf } from '../../klog/format.ts';
import { opOfLabel } from '../host.ts';
import type { HostRequest, IoToRouter } from '../index.ts';
import type { World } from './world.ts';
import { bootToDesktop, fakeServer } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

const MIB = 1_048_576;
let rid = 1_000;
type Reply = Extract<IoToRouter, { t: 'host.reply' }>;

async function ask(w: World, req: HostRequest): Promise<Reply> {
  const id = ++rid;
  w.io.router({ t: 'host.request', rid: id, req });
  let reply: Reply | undefined;
  await w.until(() => {
    reply = w.posted.find((p): p is Reply => p.t === 'host.reply' && p.rid === id);
    return reply !== undefined;
  });
  if (reply === undefined) throw new Error('no reply');
  return reply;
}

const alice = (): Promise<World> =>
  bootToDesktop({ server: fakeServer(), who: { user: 'alice', secret: 'alice-pass' } });

/** Write `files` (path → text) as alice (uid 1100). */
async function write(w: World, files: Readonly<Record<string, string>>): Promise<void> {
  const enc = new TextEncoder();
  const prog: Program<{ done: boolean }> = {
    init: () => ({ done: false }),
    *run(ctx, st) {
      yield* ctx.sys.mkdir({ path: '/home/alice/Projects', parents: true });
      for (const [path, text] of Object.entries(files))
        yield* ctx.sys.writeFile({ path, data: enc.encode(text).buffer });
      st.done = true;
      return 0;
    },
  };
  const p = w.lb.spawn(prog, { name: 'writer', uid: 1_100, gid: 100 });
  await w.lb.run(p.pid);
}

describe('UI-047 the memory budget from the Control Centre', () => {
  it('UI-047 sets mm.budget for the console user and answers with the applied budget', async () => {
    const w = await alice();
    worlds.push(w);
    const r = await ask(w, { op: 'mem.budget', mb: 512 });
    expect(r).toMatchObject({ ok: true, value: { op: 'mem.budget', budgetMb: 512 } });
    expect(w.lb.kernel.sysctl.get('mm.budget')).toBe(512 * MIB);
  });

  it('UI-047 refuses values outside 128 MB to 1 GB, and a guest session', async () => {
    const w = await alice();
    worlds.push(w);
    expect(await ask(w, { op: 'mem.budget', mb: 64 })).toMatchObject({
      ok: false,
      errno: 'EINVAL',
    });
    expect(await ask(w, { op: 'mem.budget', mb: 100.5 })).toMatchObject({ ok: false });
    const g = await bootToDesktop();
    worlds.push(g);
    expect(await ask(g, { op: 'mem.budget', mb: 512 })).toMatchObject({
      ok: false,
      errno: 'EPERM',
    });
  });
});

describe('UI-045 file search for the Search palette', () => {
  it('UI-045 finds files and folders by name under the home, best matches first', async () => {
    const w = await alice();
    worlds.push(w);
    await write(w, {
      '/home/alice/Projects/plan.md': '# plan',
      '/home/alice/Projects/old-plans.txt': 'x',
      '/home/alice/notes.txt': 'plan inside, not in the name',
    });
    const r = await ask(w, { op: 'search', q: 'plan' });
    if (!r.ok || r.value.op !== 'search') throw new Error('search failed');
    expect(r.value.hits.map((h) => h.path)).toEqual([
      '/home/alice/Projects/plan.md',
      '/home/alice/Projects/old-plans.txt',
    ]);
    expect(r.value.hits[0]).toMatchObject({ name: 'plan.md', type: 'f', size: 6 });
    const folder = await ask(w, { op: 'search', q: 'proj' });
    if (!folder.ok || folder.value.op !== 'search') throw new Error('search failed');
    expect(folder.value.hits[0]).toMatchObject({ path: '/home/alice/Projects', type: 'd' });
    const none = await ask(w, { op: 'search', q: '   ' });
    expect(none).toMatchObject({ ok: true, value: { hits: [], partial: false } });
  });
});

describe('UI-026 the outbox list agrees with the queued count', () => {
  it('UI-026 lists the queued operations and pushes the list when the count changes', async () => {
    const w = await alice();
    worlds.push(w);
    await write(w, { '/home/alice/a.txt': 'a', '/home/alice/b.txt': 'b' });
    await w.until(() => w.io.net.queuedOps >= 3);
    const r = await ask(w, { op: 'outbox' });
    if (!r.ok || r.value.op !== 'outbox') throw new Error('outbox failed');
    expect(r.value.ops.length).toBe(w.io.net.queuedOps);
    expect(r.value.ops.map((o) => `${o.verb} ${o.path}`)).toEqual([
      'mkdir /home/alice/Projects',
      'write /home/alice/a.txt',
      'write /home/alice/b.txt',
    ]);
    await w.until(() =>
      w.posted.some(
        (p) => p.t === 'outbox' && p.queued === w.io.net.queuedOps && p.ops.length === 3,
      ),
    );
  });

  it('UI-026 plan labels become a verb, a path and a target', () => {
    expect(opOfLabel('write /home/a/my file.txt', 'write')).toEqual({
      verb: 'write',
      path: '/home/a/my file.txt',
    });
    expect(opOfLabel('mv /home/a/x y /home/a/z', 'rename')).toEqual({
      verb: 'mv',
      path: '/home/a/x y',
      target: '/home/a/z',
    });
    expect(opOfLabel('cp -r /a /b', 'copy')).toEqual({ verb: 'cp', path: '/a', target: '/b' });
    expect(opOfLabel('rmdir /a/b', 'unlink')).toEqual({ verb: 'rm', path: '/a/b' });
    expect(opOfLabel('batch of 3', 'batch')).toEqual({ verb: 'batch of 3', path: '' });
  });
});

describe('UI-137 policy violations reach the kernel log once', () => {
  it('UI-137 each distinct violation is logged once', async () => {
    const w = await alice();
    worlds.push(w);
    const v = {
      t: 'sec.violation',
      directive: 'style-src-elem',
      disposition: 'enforce',
      sample: '.xterm { color: red }',
      source: '/assets/Terminal.js:1',
    } as const;
    w.io.router(v);
    w.io.router(v);
    w.io.router({
      ...v,
      disposition: 'report',
      directive: 'require-trusted-types-for',
      sample: 'x',
    });
    const lines = w.lb.kernel.klog
      .read()
      .map((r) => messageOf(r))
      .filter((m) => m.startsWith('blocked ') || m.startsWith('report-only '));
    expect(lines).toEqual([
      'blocked style-src-elem: .xterm { color: red } · /assets/Terminal.js:1',
      'report-only require-trusted-types-for: x · /assets/Terminal.js:1',
    ]);
  });
});
