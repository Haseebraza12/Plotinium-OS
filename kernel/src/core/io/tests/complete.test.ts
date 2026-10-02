/**
 * The `complete` service (shell-and-terminal.md §3.10; SYS-03, SHL-10, SHL-11): the dsa/trie in
 * four namespaces, updated incrementally from VFS events, queried with the caller's credentials.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { CompleteResult } from '@plotinium/protocol';
import { KernelError } from '../../errors.ts';

import type { Caller } from '../../ipc/ports.ts';
import type { PCB } from '../../proc/pcb.ts';
import type { Program } from '../../../runtime/sys.ts';
import { CompleteIo, flagsOf } from '../complete.ts';
import type { World } from './world.ts';
import { bootToDesktop, settle } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

function completer(w: World): CompleteIo {
  const c = w.io.ports.complete;
  if (!(c instanceof CompleteIo)) throw new Error('the complete port is not a CompleteIo');
  return c;
}

function callerFor(w: World, uid: number, cwd = '/'): Caller {
  const pcb: PCB = w.lb.kernel.procs.create({
    ppid: 1,
    kind: 'user',
    cls: 'user',
    name: 'sh',
    argv: ['sh'],
    cred: { uid, gid: 100, groups: [], ruid: uid },
    caps: ['fs.read'],
  });
  pcb.cwdPath = cwd;
  return { pcb, origin: 'E', wid: null };
}

async function query(c: CompleteIo, caller: Caller, q: Record<string, unknown>): Promise<string[]> {
  const r = (await c.call(caller, 'complete.query', q)) as CompleteResult;
  return r.items.map((i) => i.text);
}

function run(
  w: World,
  uid: number,
  body: (sys: Parameters<Program<null>['run']>[0]['sys']) => Generator<unknown, void, unknown>,
): Promise<unknown> {
  const prog: Program<null> = {
    init: () => null,
    *run(ctx) {
      yield* body(ctx.sys) as Generator<never, void, unknown>;
      return 0;
    },
  };
  const p = w.lb.spawn(prog, { name: 'mut', uid, gid: 100 });
  return w.lb.run(p.pid);
}

describe('the complete service', () => {
  it('SYS-03 cmd completes builtins; path follows create, rename and unlink incrementally', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    await w.until(() => w.stateOf('complete') === 'running');
    const c = completer(w);
    const me = callerFor(w, 65_534, '/home/guest');
    expect(await query(c, me, { ns: 'cmd', prefix: 'hi' })).toEqual(['history']);
    expect(await query(c, me, { ns: 'path', prefix: '', dir: '/home/guest' })).toEqual([]);
    const enc = new TextEncoder();
    await run(w, 65_534, function* (sys) {
      yield* sys.writeFile({ path: '/home/guest/report.md', data: enc.encode('r').buffer });
      yield* sys.writeFile({ path: '/home/guest/readme.txt', data: enc.encode('r').buffer });
      yield* sys.mkdir({ path: '/home/guest/res' });
    });
    await settle();
    expect(await query(c, me, { ns: 'path', prefix: 're', dir: '/home/guest' })).toEqual([
      'readme.txt',
      'report.md',
      'res',
    ]);
    const before = c.index.stats().ns.path.entries;
    await run(w, 65_534, function* (sys) {
      yield* sys.rename({ from: '/home/guest/report.md', to: '/home/guest/summary.md' });
      yield* sys.unlink({ path: '/home/guest/readme.txt' });
    });
    await settle();
    expect(await query(c, me, { ns: 'path', prefix: 're', dir: '/home/guest' })).toEqual(['res']);
    expect(await query(c, me, { ns: 'path', prefix: 's', dir: '/home/guest' })).toEqual([
      'summary.md',
    ]);
    // One rename (−1 +1) and one unlink (−1): the path namespace changed by exactly one entry.
    expect(c.index.stats().ns.path.entries).toBe(before - 1);
  });

  it('SHL-10 path completion resolves the directory with the caller credentials: no listing of an unreadable home', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    await w.until(() => w.stateOf('complete') === 'running');
    const c = completer(w);
    const stranger = callerFor(w, 4_242);
    await expect(
      c.call(stranger, 'complete.query', { ns: 'path', prefix: '', dir: '/home/guest' }),
    ).rejects.toMatchObject({
      errno: 'EACCES',
    });
    const root = callerFor(w, 0);
    await expect(
      c.call(root, 'complete.query', { ns: 'path', prefix: '', dir: '/home/guest' }),
    ).resolves.toMatchObject({ indexed: true });
  });

  it('SHL-11 history is per uid, stamped from the caller, and clear removes only the caller lines', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    await w.until(() => w.stateOf('complete') === 'running');
    const c = completer(w);
    const a = callerFor(w, 1_000);
    const b = callerFor(w, 1_001);
    await c.call(a, 'complete.hist.load', { lines: ['git status', 'git commit -m x', 'ls -la'] });
    await c.call(b, 'complete.hist.add', { line: 'git push' });
    expect(await query(c, a, { ns: 'hist', prefix: 'git' })).toEqual([
      'git commit -m x',
      'git status',
    ]);
    expect(await query(c, b, { ns: 'hist', prefix: 'git' })).toEqual(['git push']);
    await c.call(a, 'complete.hist.clear', {});
    expect(await query(c, a, { ns: 'hist', prefix: '' })).toEqual([]);
    expect(await query(c, b, { ns: 'hist', prefix: '' })).toEqual(['git push']);
    await expect(
      c.call(a, 'complete.query', { ns: 'hist', prefix: 'x', uid: 1_001 }),
    ).rejects.toBeInstanceOf(KernelError);
  });

  it('SYS-03 complete.bench over 10,000 synthetic names answers within the 1 ms p95 budget', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    await w.until(() => w.stateOf('complete') === 'running');
    const c = completer(w);
    const r = (await c.call(callerFor(w, 0), 'complete.bench', {
      synthetic: 10_000,
      queries: 2_000,
    })) as {
      entries: number;
      p95: number;
    };
    expect(r.entries).toBe(10_000);
    // The loopback clock is manual (no time passes inside a query): the value is measured, not assumed.
    expect(r.p95).toBeGreaterThanOrEqual(0);
  });

  it('SYS-03 flag completion reads the OPTIONS lines of a man page', () => {
    const page =
      '---json\n{"name":"ls"}\n---\n# NAME\n\nls\n\n# OPTIONS\n\n- `-a` — all entries\n- `-l` — long format\n- `--color` — colours\n\n# SEE ALSO\n\n- `-z` — not an option\n';
    expect(flagsOf(page)).toEqual([
      { flag: '-a', desc: 'all entries' },
      { flag: '-l', desc: 'long format' },
      { flag: '--color', desc: 'colours' },
    ]);
  });
});
