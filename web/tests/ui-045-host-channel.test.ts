import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RouterToKernel } from '@plotinium/kernel/host/main';

import type { HostSearchHit } from '../src/desktop/host-channel.ts';
import {
  editedMeta,
  fileKindOf,
  fileResults,
  fileSearch,
  HostChannel,
  launchFor,
  queuedOps,
  tildePath,
  violationMessage,
} from '../src/desktop/host-channel.ts';

/** A fake router port: records posts; `deliver` plays a kernel message to the listeners. */
function port() {
  const posted: RouterToKernel[] = [];
  const listeners = new Set<(m: unknown) => void>();
  return {
    posted,
    post: (m: RouterToKernel) => {
      posted.push(m);
    },
    onMessage: (fn: (m: unknown) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    deliver: (m: unknown) => {
      for (const fn of [...listeners]) fn(m);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UI-047 / UI-045 the desktop host channel', () => {
  it('UI-047 a request is answered by the reply with its rid; errors carry the errno', async () => {
    const p = port();
    const chan = new HostChannel(p);
    const ok = chan.request({ op: 'mem.budget', mb: 512 });
    const bad = chan.request({ op: 'mem.budget', mb: 64 });
    const [a, b] = p.posted as Extract<RouterToKernel, { t: 'host.request' }>[];
    expect(a?.req).toEqual({ op: 'mem.budget', mb: 512 });
    p.deliver({ t: 'host.reply', rid: b?.rid, ok: false, errno: 'EINVAL', error: 'too small' });
    p.deliver({
      t: 'host.reply',
      rid: a?.rid,
      ok: true,
      value: { op: 'mem.budget', budgetMb: 512 },
    });
    await expect(ok).resolves.toEqual({ op: 'mem.budget', budgetMb: 512 });
    await expect(bad).rejects.toMatchObject({ errno: 'EINVAL', message: 'too small' });
  });

  it('UI-047 an unanswered request times out instead of hanging', async () => {
    vi.useFakeTimers();
    const chan = new HostChannel(port());
    const r = chan.request({ op: 'outbox' }, 1_000);
    vi.advanceTimersByTime(1_001);
    await expect(r).rejects.toMatchObject({ errno: 'ETIMEDOUT' });
  });

  it('UI-026 the pushed outbox list becomes the popover rows (parked = rejected)', () => {
    const p = port();
    const chan = new HostChannel(p);
    expect(chan.outbox).toEqual([]);
    const at = new Date(2026, 8, 27, 14, 29).getTime();
    p.deliver({
      t: 'outbox',
      queued: 2,
      ops: [
        { id: 'a', verb: 'write', path: '/home/alice/a.txt', at, state: 'queued' },
        { id: 'b', verb: 'mv', path: '/x', target: '/y', at, state: 'parked' },
      ],
    });
    expect(queuedOps(chan.outbox)).toEqual([
      { id: 'a', verb: 'write', path: '/home/alice/a.txt', time: '14:29', state: 'queued' },
      {
        id: 'b',
        verb: 'mv',
        path: '/x',
        target: '/y',
        time: '14:29',
        state: 'rejected',
        rejection: 'rejected by the server · kept on this device',
      },
    ]);
  });

  it('UI-045 file hits become Search rows with a ~ citation, kind and date', () => {
    const hit: HostSearchHit = {
      path: '/home/alice/Projects/plan.md',
      name: 'plan.md',
      type: 'f',
      size: 6,
      mtime: new Date(2026, 8, 18, 16, 20).getTime(),
    };
    expect(
      fileResults([hit, { ...hit, path: '/srv/x', name: 'x', owner: 'bob' }], '/home/alice'),
    ).toEqual([
      {
        id: 'file:/home/alice/Projects/plan.md',
        group: 'top',
        kind: 'file',
        title: 'plan.md',
        citation: '~/Projects/plan.md',
        meta: 'Edited 18 Sep',
        fileKind: 'document',
      },
      {
        id: 'file:/srv/x',
        group: 'top',
        kind: 'file',
        title: 'x',
        citation: '/srv/x',
        meta: 'Edited 18 Sep',
        fileKind: 'other',
        owner: 'bob',
      },
    ]);
    expect(editedMeta({ ...hit, type: 'd' })).toBe('Folder · edited 18 Sep');
    expect(tildePath('/home/alice', '/home/alice')).toBe('~');
    expect(fileKindOf('a.CSV', 'f')).toBe('spreadsheet');
    expect(fileKindOf('k.ts', 'f')).toBe('code');
    expect(fileKindOf('p.png', 'f')).toBe('image');
    expect(fileKindOf('Projects', 'd')).toBe('folder');
  });

  it('UI-045 opening a result: text in the Editor, folders and others in Files, reveal = parent', () => {
    expect(launchFor('/h/a/plan.md', 'document', 'open')).toEqual({
      app: 'editor',
      argv: ['/h/a/plan.md'],
    });
    expect(launchFor('/h/a/Makefile', 'other', 'open')).toEqual({
      app: 'editor',
      argv: ['/h/a/Makefile'],
    });
    expect(launchFor('/h/a/p.png', 'image', 'open')).toEqual({ app: 'files', argv: ['/h/a'] });
    expect(launchFor('/h/a/x.zip', 'other', 'open')).toEqual({ app: 'files', argv: ['/h/a'] });
    expect(launchFor('/h/a/Projects', 'folder', 'open')).toEqual({
      app: 'files',
      argv: ['/h/a/Projects'],
    });
    expect(launchFor('/h/a/plan.md', 'document', 'reveal')).toEqual({
      app: 'files',
      argv: ['/h/a'],
    });
  });

  it('UI-045 the provider queries the kernel and launches through the host', async () => {
    const p = port();
    const chan = new HostChannel(p);
    const launched: string[] = [];
    const search = fileSearch(
      chan,
      () => '/home/alice',
      (app, argv) => launched.push(`${app} ${argv.join(' ')}`),
    );
    const q = search.query('plan', new AbortController().signal);
    const req = p.posted[0] as Extract<RouterToKernel, { t: 'host.request' }>;
    expect(req.req).toEqual({ op: 'search', q: 'plan', limit: 20 });
    p.deliver({
      t: 'host.reply',
      rid: req.rid,
      ok: true,
      value: {
        op: 'search',
        partial: false,
        hits: [{ path: '/home/alice/plan.md', name: 'plan.md', type: 'f', size: 1, mtime: 0 }],
      },
    });
    const r = await q;
    expect(r.results.map((x) => x.citation)).toEqual(['~/plan.md']);
    expect(r.stats?.source).toBe('file names');
    const first = r.results[0];
    if (first === undefined) throw new Error('no result');
    search.open?.(first, 'open');
    search.open?.(first, 'reveal');
    expect(launched).toEqual(['editor /home/alice/plan.md', 'files /home/alice']);
  });

  it('UI-137 a violation event becomes one short kernel-log message', () => {
    expect(
      violationMessage({
        effectiveDirective: 'style-src-attr',
        disposition: 'enforce',
        sample: 'color: red',
        sourceFile: 'http://localhost:4718/assets/Dock-abc.js',
        lineNumber: 12,
      }),
    ).toEqual({
      t: 'sec.violation',
      directive: 'style-src-attr',
      disposition: 'enforce',
      sample: 'color: red',
      source: '/assets/Dock-abc.js:12',
    });
  });
});
