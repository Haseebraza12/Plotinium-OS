/**
 * UI-002: a process that holds an X lease on a file can write it (the Editor's "Editing — you hold
 * the lock" then Ctrl+S); every other process still gets EBUSY while the lease is held (VFS-09,
 * virtual-file-system.md §3.16.3).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Program } from '../../../runtime/sys.ts';
import { errnoOf } from '../../../runtime/sys.ts';
import { LocalLocks } from '../../net/locks.ts';
import type { World } from './world.ts';
import { bootToDesktop } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

interface Out {
  results: Record<string, unknown>;
  errors: Record<string, string>;
}

type Sys = Parameters<Program<Out>['run']>[0]['sys'];
type Ctx = Parameters<Program<Out>['run']>[0];

function prog(
  out: Out,
  body: (ctx: Ctx, st: Out) => Generator<unknown, void, unknown>,
): Program<Out> {
  return {
    init: () => out,
    *run(ctx, st) {
      yield* body(ctx, st) as Generator<never, void, unknown>;
      return 0;
    },
  };
}

function* attempt<T>(
  st: Out,
  key: string,
  g: Generator<unknown, T, unknown>,
): Generator<unknown, void, unknown> {
  try {
    st.results[key] = yield* g;
  } catch (e) {
    st.errors[key] = errnoOf(e) ?? String(e);
  }
}

const enc = new TextEncoder();
const PATH = '/home/guest/doc.txt';
const bytes = (s: string): ArrayBuffer => enc.encode(s).buffer;

function* writeTwice(sys: Sys, st: Out, tag: string): Generator<unknown, void, unknown> {
  yield* attempt(st, `${tag}-write1`, sys.writeFile({ path: PATH, data: bytes(`${tag} 1`) }));
  yield* attempt(st, `${tag}-write2`, sys.writeFile({ path: PATH, data: bytes(`${tag} 2`) }));
  yield* attempt(st, `${tag}-open`, sys.open({ path: PATH, flags: 'w' }));
  const fd = (st.results[`${tag}-open`] as { fd?: number } | undefined)?.fd;
  if (fd !== undefined) yield* attempt(st, `${tag}-close`, sys.close({ fd }));
}

describe('UI-002 a process is never blocked by its own X lease', () => {
  it('UI-002 the lease holder saves twice in a row; another process gets EBUSY for writes and opens', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const holder: Out = { results: {}, errors: {} };
    const a = w.lb.spawn(
      prog(holder, function* (ctx, st) {
        yield* ctx.sys.writeFile({ path: PATH, data: bytes('draft') });
        yield* attempt(
          st,
          'lease',
          ctx.sys['lock.acquire']({ path: PATH, mode: 'X', wait: false }),
        );
        yield* writeTwice(ctx.sys, st, 'own');
        st.results['ready'] = true;
        // Keep the lease: this process now waits (the test's kernel timer heap never fires).
        yield* ctx.sleep(1_000_000_000);
      }),
      { name: 'editor', uid: 65_534, gid: 100 },
    );
    void w.lb.run(a.pid);
    await w.until(() => holder.results['ready'] === true);

    expect(holder.errors).toEqual({});
    expect(holder.results['lease']).toMatchObject({ scope: 'local' });
    expect(holder.results['own-write1']).toMatchObject({ version: expect.any(Number) as number });
    expect(holder.results['own-write2']).toMatchObject({ version: expect.any(Number) as number });

    const other: Out = { results: {}, errors: {} };
    const b = w.lb.spawn(
      prog(other, function* (ctx, st) {
        yield* writeTwice(ctx.sys, st, 'other');
        yield* attempt(st, 'rename', ctx.sys.rename({ from: PATH, to: '/home/guest/moved.txt' }));
        yield* attempt(st, 'read', ctx.sys.open({ path: PATH, flags: 'r' }));
      }),
      { name: 'files', uid: 65_534, gid: 100 },
    );
    await w.lb.run(b.pid);
    expect(other.errors['other-write1']).toBe('EBUSY');
    expect(other.errors['other-write2']).toBe('EBUSY');
    expect(other.errors['other-open']).toBe('EBUSY');
    expect(other.errors['rename']).toBe('EBUSY');
    // Reading is never blocked by a lease.
    expect(other.results['read']).toMatchObject({ fd: expect.any(Number) as number });
  });
});

describe('UI-002 LocalLocks.blocks (VFS §3.16.3)', () => {
  const after = (): (() => void) => () => undefined;
  const req = (pid: number, mode: 'S' | 'X') => ({
    pid,
    ino: 'i1',
    path: '/f',
    holder: `p${String(pid)}`,
    mode,
    wait: false,
  });

  it('UI-002 an X holder may write; every other pid, and a kernel-internal change, may not', async () => {
    const l = new LocalLocks({ after });
    expect(l.blocks('i1', 7)).toBe(false);
    await l.acquire(req(7, 'X'));
    expect(l.blocks('i1', 7)).toBe(false);
    expect(l.blocks('i1', 8)).toBe(true);
    expect(l.blocks('i1')).toBe(true);
    expect(l.blocks('other', 8)).toBe(false);
  });

  it('UI-002 S holders block every process that does not hold X, including one another', async () => {
    const l = new LocalLocks({ after });
    await l.acquire(req(7, 'S'));
    await l.acquire(req(8, 'S'));
    expect(l.blocks('i1', 7)).toBe(true);
    expect(l.blocks('i1', 9)).toBe(true);
    l.releaseAll(8);
    expect(l.blocks('i1', 7)).toBe(false);
    expect(l.blocks('i1', 9)).toBe(true);
  });
});
