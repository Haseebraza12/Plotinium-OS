/**
 * The executor bootstrap on a fake worker scope (syscall-abi.md §3.2.3; processes-and-scheduling.md
 * §3.7.1): the control port is captured BEFORE the realm is sandboxed, so `hello` and every later
 * frame still reach the kernel although `postMessage` itself now throws; program modules come from
 * the injected loaders (the program registry) and are imported only after the sandbox.
 */
import { ABI_VERSION } from '@plotinium/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { startExecutor } from '../../runtime/executor-entry.ts';
import { SANDBOX_MESSAGE } from '../../runtime/sandbox.ts';
import type { Program } from '../../runtime/sys.ts';

type Listener = (ev: { data: unknown }) => void;

interface FakeScope {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, fn: Listener): void;
}

function fakeScope(): {
  scope: FakeScope;
  sent: unknown[];
  listeners: Listener[];
  sandboxedAt: () => number;
} {
  const sent: unknown[] = [];
  const listeners: Listener[] = [];
  class Proto {
    postMessage(msg: unknown): void {
      sent.push(msg);
    }
    addEventListener(type: string, fn: Listener): void {
      if (type === 'message') listeners.push(fn);
    }
  }
  const scope: FakeScope = new Proto();
  let at = -1;
  return {
    scope,
    sent,
    listeners,
    sandboxedAt: () => {
      if (at < 0) {
        try {
          void scope.postMessage;
        } catch {
          at = sent.length;
        }
      }
      return at;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const echo: Program<{ n: number }> = {
  init: () => ({ n: 0 }),
  *run(ctx, st) {
    st.n++;
    yield ctx.tick;
    return 3;
  },
};

const g = globalThis as { self?: unknown };
const hadSelf = 'self' in g;
const savedSelf = g.self;
afterEach(() => {
  if (hadSelf) g.self = savedSelf;
  else delete g.self;
});

describe('KPS-04 executor bootstrap', () => {
  it('KPS-04 hello and every later frame reach the kernel after the sandbox made postMessage throw', async () => {
    const f = fakeScope();
    g.self = f.scope;
    let imported = false;
    startExecutor({
      loaders: {
        'test/echo': () => {
          imported = true;
          return Promise.resolve({ default: echo });
        },
      },
    });
    // The sandbox is in place: program code cannot reach the port or the network.
    expect(() => f.scope.postMessage({})).toThrow(SANDBOX_MESSAGE);
    expect(f.sandboxedAt()).toBeGreaterThanOrEqual(0);
    expect(f.sent[0]).toMatchObject({ t: 'hello', abi: ABI_VERSION });
    expect(f.sent.some((m) => (m as { t?: string }).t === 'sandbox')).toBe(false);
    expect(imported).toBe(false);

    const deliver = (data: unknown): void => {
      for (const l of f.listeners) l({ data });
    };
    deliver({ t: 'init', index: 0, ctl: null, abi: ABI_VERSION });
    deliver({
      t: 'load',
      pid: 9,
      entry: 'test/echo',
      ppid: 1,
      pgid: 9,
      sid: 9,
      uid: 1001,
      gid: 1001,
      argv: ['echo'],
      env: [],
      cwd: '/',
      tty: null,
    });
    // A dispatch that arrives while the program is still loading waits behind the load.
    deliver({ t: 'dispatch', pid: 9, sliceSeq: 1, quantumMs: 10, pendingSigs: 0 });
    await flush();
    expect(imported).toBe(true);
    expect(f.sent).toContainEqual({ t: 'loaded', pid: 9, ok: true });
    const exit = f.sent.find((m) => (m as { t?: string }).t === 'exit');
    expect(exit).toMatchObject({ t: 'exit', pid: 9, sliceSeq: 1, code: 3 });
  });

  it('KPS-04 an entry the registry does not know fails to load (the child exits 126) instead of importing a URL', async () => {
    const f = fakeScope();
    g.self = f.scope;
    startExecutor({ loaders: {} });
    for (const l of f.listeners) l({ data: { t: 'init', index: 1, ctl: null, abi: ABI_VERSION } });
    for (const l of f.listeners)
      l({
        data: {
          t: 'load',
          pid: 4,
          entry: 'https://evil.example/x.js',
          ppid: 1,
          pgid: 4,
          sid: 4,
          uid: 1001,
          gid: 1001,
          argv: [],
          env: [],
          cwd: '/',
          tty: null,
        },
      });
    await flush();
    expect(f.sent).toContainEqual({
      t: 'loaded',
      pid: 4,
      ok: false,
      error: 'no program module for https://evil.example/x.js',
    });
  });
});

describe('KPS-07 the start-up closure on the executor', () => {
  it('KPS-07 the libs of a load frame are imported in order before the program; a missing lib fails the load', async () => {
    const f = fakeScope();
    g.self = f.scope;
    const order: string[] = [];
    const lib = (id: string) => () => {
      order.push(id);
      return Promise.resolve({});
    };
    startExecutor({
      loaders: {
        'lib/dict': lib('lib/dict'),
        'lib/spell': lib('lib/spell'),
        'app/editor': () => {
          order.push('app/editor');
          return Promise.resolve({ default: echo });
        },
      },
    });
    const base = {
      ppid: 1,
      pgid: 5,
      sid: 5,
      uid: 1001,
      gid: 1001,
      argv: [],
      env: [],
      cwd: '/',
      tty: null,
    };
    for (const l of f.listeners) l({ data: { t: 'init', index: 0, ctl: null, abi: ABI_VERSION } });
    for (const l of f.listeners)
      l({
        data: { t: 'load', pid: 5, entry: 'app/editor', libs: ['lib/dict', 'lib/spell'], ...base },
      });
    await flush();
    expect(order).toEqual(['lib/dict', 'lib/spell', 'app/editor']);
    expect(f.sent).toContainEqual({ t: 'loaded', pid: 5, ok: true });
    for (const l of f.listeners)
      l({ data: { t: 'load', pid: 6, entry: 'app/editor', libs: ['lib/gone'], ...base } });
    await flush();
    expect(f.sent).toContainEqual({
      t: 'loaded',
      pid: 6,
      ok: false,
      error: 'missing lib lib/gone: no program module for lib/gone',
    });
  });
});
