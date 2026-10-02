/**
 * UI-049: `sys.subscribe` / `sys.events` exist for processes, so the AI indexer daemon (and any
 * program) can follow file changes under its home: events of its subtree only, a blocking read that
 * times out, a poll, EBADF for a bad descriptor, and nothing left behind when the process ends.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Program } from '../../../runtime/sys.ts';
import { errnoOf } from '../../../runtime/sys.ts';
import type { World } from './world.ts';
import { bootToDesktop } from './world.ts';

let world: World | null = null;
afterEach(() => {
  world?.close();
  world = null;
});

interface Out {
  fd?: number;
  poll?: number;
  timeout?: string;
  badFd?: string;
  events: { topic: string; data: unknown }[];
  err?: string;
}

const enc = new TextEncoder();

function follower(out: Out, home: string): Program<Out> {
  return {
    init: () => out,
    *run(ctx, st) {
      try {
        const sub = yield* ctx.sys['sys.subscribe']({ topics: ['vfs.*'], path: home });
        st.fd = sub.fd;
        st.poll = (yield* ctx.sys['sys.events']({ fd: sub.fd, timeoutMs: 0 })).events.length;
        try {
          yield* ctx.sys['sys.events']({ fd: sub.fd + 1, timeoutMs: 0 });
        } catch (e) {
          st.badFd = errnoOf(e) ?? String(e);
        }
        // Outside the subtree: not delivered. Inside: delivered.
        yield* ctx.sys.writeFile({ path: '/tmp/elsewhere.txt', data: enc.encode('x').buffer });
        yield* ctx.sys.writeFile({ path: `${home}/inside.txt`, data: enc.encode('y').buffer });
        const got = yield* ctx.sys['sys.events']({ fd: sub.fd, timeoutMs: 1_000 });
        st.events.push(...got.events);
        try {
          yield* ctx.sys['sys.events']({ fd: sub.fd, timeoutMs: 50 });
        } catch (e) {
          st.timeout = errnoOf(e) ?? String(e);
        }
      } catch (e) {
        st.err = `${errnoOf(e) ?? ''} ${e instanceof Error ? e.message : String(e)}`;
      }
      return 0;
    },
  };
}

describe('UI-049 event subscriptions for processes', () => {
  it('UI-049 follows vfs events of its subtree, polls, times out and rejects a bad descriptor', async () => {
    world = await bootToDesktop();
    const w = world;
    const out: Out = { events: [] };
    const p = w.lb.spawn(follower(out, '/home/guest'), { name: 'follow', uid: 65_534, gid: 100 });
    let done = false;
    void w.lb.run(p.pid).then(() => {
      done = true;
    });
    await w.until(() => done, 10_000);
    expect(out.err).toBeUndefined();
    expect(out.fd).toBeGreaterThanOrEqual(1_008);
    expect(out.fd).toBeLessThan(1_024);
    expect(out.poll).toBe(0);
    expect(out.badFd).toBe('EBADF');
    const names = out.events
      .filter((e) => e.topic === 'vfs.create')
      .map((e) => (e.data as { name: string }).name);
    expect(names).toContain('inside.txt');
    expect(names).not.toContain('elsewhere.txt');
    expect(out.timeout).toBe('ETIMEDOUT');
  });
});
