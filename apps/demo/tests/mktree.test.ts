import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@plotinium/protocol';
import type { Program } from '@plotinium/kernel/sys';
import { SysError } from '@plotinium/kernel/sys';

import mktree, { absPath, parseMktree } from '../cmd/mktree.ts';
import { contentOf, fixtureTree, summarize } from '../lib/tree.ts';
import { FakeKernel } from './fakesys.ts';

const program = mktree as unknown as Program<unknown>;

interface Entry {
  type: 'd' | 'f';
  mode: number;
  data: string;
}

/** A path-keyed file tree answering lstat, mkdir, writeFile and unlink (umask 022). */
function withFs(k: FakeKernel, seed: Record<string, Entry> = {}): Map<string, Entry> {
  const fs = new Map<string, Entry>([
    ['/', { type: 'd', mode: 0o755, data: '' }],
    ['/home', { type: 'd', mode: 0o755, data: '' }],
    ['/home/alice', { type: 'd', mode: 0o700, data: '' }],
    ...Object.entries(seed),
  ]);
  const parentOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')));
  const abs = (path: string): string => (path.startsWith('/') ? path : `/home/alice/${path}`);
  const dec = new TextDecoder();
  k.on('lstat', (a) => {
    const e = fs.get(abs(a.path));
    if (e === undefined) throw new SysError('ENOENT');
    return { type: e.type, mode: e.mode } as never;
  });
  k.on('mkdir', (a) => {
    const chain: string[] = [];
    for (let p = abs(a.path); !fs.has(p); p = parentOf(p)) chain.unshift(p);
    if (chain.length === 0) {
      if (a.parents === true) return { ino: 'x', created: 0 } as never;
      throw new SysError('EEXIST');
    }
    if (chain.length > 1 && a.parents !== true) throw new SysError('ENOENT');
    for (const p of chain) fs.set(p, { type: 'd', mode: (a.mode ?? 0o777) & ~0o022, data: '' });
    return { ino: 'x', created: chain.length } as never;
  });
  k.on('writeFile', (a) => {
    if (fs.get(parentOf(abs(a.path)))?.type !== 'd') throw new SysError('ENOENT');
    const data = dec.decode(new Uint8Array(a.data));
    fs.set(abs(a.path), { type: 'f', mode: (a.mode ?? 0o666) & ~0o022, data });
    return { ino: `i${String(fs.size)}`, version: 1, bytes: a.data.byteLength } as never;
  });
  k.on('unlink', (a) => {
    let removed = 0;
    for (const p of [...fs.keys()]) {
      if (p === abs(a.path) || p.startsWith(`${abs(a.path)}/`)) {
        fs.delete(p);
        removed++;
      }
    }
    return { removed, bytes: 0 } as never;
  });
  return fs;
}

describe('the tree1000 fixture (testing-and-performance.md §3.6.6)', () => {
  it('DB-02 mktree builds the tree1000 fixture of tests/fixtures/trees.ts node for node', () => {
    // Golden values computed from tests/fixtures/trees.ts `tree1000()` (seed 42).
    const nodes = fixtureTree('tree1000');
    const s = summarize(nodes);
    expect(s).toEqual({
      nodes: 1000,
      dirs: 210,
      files: 790,
      bytes: 1_609_683,
      depth: 13,
      manifestSha256: '5c9b202538d815bfdff673c46209048551e2b6fc7106c192c70f702bd495f430',
    });
    expect(nodes.slice(7, 10)).toEqual([
      { path: 'tree1000/s1/s2/s3/s4/s5/s6/s7', type: 'd', mode: 0o755, size: 0 },
      { path: 'tree1000/s1/s2/s3/s4/f8.txt', type: 'f', mode: 0o644, size: 3492 },
      { path: 'tree1000/s1/s2/s3/s4/s5/d9', type: 'd', mode: 0o755, size: 0 },
    ]);
    expect(nodes.at(-1)).toEqual({
      path: 'tree1000/s1/s2/d30/d583/d931/f999.txt',
      type: 'f',
      mode: 0o644,
      size: 1949,
    });
    const content = nodes
      .filter((n) => n.type === 'f')
      .map((n) => contentOf(n.path, n.size))
      .join('');
    expect(sha256Hex(content)).toBe(
      'cb3a9dab7c13a1e7552ef580454e043d1796f4246263b02ed477cc47b4e9c971',
    );
  });

  it('DB-02 the fixture is at least 6 levels deep for any seed, and smaller trees keep the spine first', () => {
    for (const seed of [1, 7, 42, 1234])
      expect(summarize(fixtureTree('t', 1000, seed)).depth).toBeGreaterThanOrEqual(6);
    expect(fixtureTree('small', 3).map((n) => n.path)).toEqual([
      'small',
      'small/s1',
      'small/s1/s2',
    ]);
    expect(fixtureTree('one', 1)).toHaveLength(1);
  });
});

describe('mktree', () => {
  it('VFS-07 mktree creates ~/fixtures/tree1000 with one mkdir per directory and one writeFile per file', () => {
    const k = new FakeKernel();
    const fs = withFs(k);
    const r = k.run(program, ['mktree']);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(k.callsOf('mkdir')).toHaveLength(1 + 210);
    expect(k.callsOf('mkdir')[0]).toEqual({
      path: '/home/alice/fixtures',
      parents: true,
      mode: 0o755,
    });
    expect(k.callsOf('writeFile')).toHaveLength(790);
    expect(fs.get('/home/alice/fixtures/tree1000/s1/s2/s3/s4/f8.txt')).toEqual({
      type: 'f',
      mode: 0o644,
      data: contentOf('tree1000/s1/s2/s3/s4/f8.txt', 3492),
    });
    expect(fs.get('/home/alice/fixtures/tree1000/s1/s2/s3/s4/s5/s6/s7')?.mode).toBe(0o755);
    expect(
      [...fs.keys()].filter((p) => p.startsWith('/home/alice/fixtures/tree1000')),
    ).toHaveLength(1000);
    expect(r.out).toMatch(
      /^mktree: created \/home\/alice\/fixtures\/tree1000: 1,000 nodes \(210 directories, 790 files, 1,609,683 bytes\), depth 13, manifest sha256:5c9b202538d815bf… in \d+\.\d s\n$/,
    );
  });

  it('DB-02 an existing DIR is refused without -f and replaced with -f', () => {
    const k = new FakeKernel();
    const fs = withFs(k, {
      '/tmp': { type: 'd', mode: 0o1777, data: '' },
      '/tmp/t20': { type: 'd', mode: 0o755, data: '' },
      '/tmp/t20/old': { type: 'f', mode: 0o644, data: 'x' },
    });
    const refused = k.run(program, ['mktree', '-n', '20', '/tmp/t20']);
    expect(refused.status).toBe(1);
    expect(refused.err).toBe(
      "mktree: cannot create '/tmp/t20': File exists (use -f to replace it)\n",
    );
    const r = k.run(program, ['mktree', '-f', '-q', '-n', '20', '/tmp/t20']);
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
    expect(k.callsOf('unlink')).toEqual([{ path: '/tmp/t20', recursive: true }]);
    expect(fs.has('/tmp/t20/old')).toBe(false);
    expect([...fs.keys()].filter((p) => p.startsWith('/tmp/t20'))).toHaveLength(20);
  });

  it('VFS-07 a failing call names the node and how many nodes were created', () => {
    const k = new FakeKernel();
    withFs(k);
    let files = 0;
    const write = k.handlers.get('writeFile');
    k.on('writeFile', (a, p, kk) => {
      files++;
      if (files === 5) throw new SysError('EDQUOT');
      return (write as (x: typeof a, y: typeof p, z: typeof kk) => never)(a, p, kk);
    });
    const r = k.run(program, ['mktree', '-n', '50', '--seed', '3']);
    expect(r.status).toBe(1);
    const nodes = fixtureTree('tree50', 50, 3);
    const failed = nodes.filter((n) => n.type === 'f')[4];
    const index = nodes.indexOf(failed ?? nodes[0]!);
    expect(r.err).toBe(
      `mktree: cannot create '/home/alice/fixtures/${failed?.path ?? ''}': Disk quota exceeded (${String(index)} of 50 nodes created)\n`,
    );
  });

  it('VFS-07 --json prints the summary with the seed and the directory', () => {
    const k = new FakeKernel();
    withFs(k);
    const r = k.run(program, ['mktree', '--json', '-n', '100', '--seed', '9', 'fx']);
    expect(r.status).toBe(0);
    const s = JSON.parse(r.out) as Record<string, unknown>;
    expect(s).toMatchObject({ dir: 'fx', seed: 9, ...summarize(fixtureTree('fx', 100, 9)) });
    expect(s['nodes']).toBe(100);
    // A relative DIR: the nodes are created relative to the working directory.
    expect((k.callsOf('mkdir')[0] as { path: string }).path).toBe('fx');
  });

  it('VFS-07 on a terminal the progress counter goes to stderr', () => {
    const k = new FakeKernel();
    withFs(k);
    const r = k.run(program, ['mktree', '-n', '120', '/home/alice/t'], { tty: true });
    expect(r.status).toBe(0);
    expect(r.err).toBe('\rmktree: 50/120 nodes\rmktree: 100/120 nodes\rmktree: 120/120 nodes\n');
  });

  it('VFS-07 SIGINT stops mktree between two nodes with status 130', () => {
    const k = new FakeKernel();
    withFs(k);
    const p = k.start(program, ['mktree', '-n', '500']);
    k.runUntil(() => k.callsOf('writeFile').length >= 10);
    k.signal(p, 'SIGINT');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(130);
    expect(p.err).toMatch(/^mktree: interrupted by SIGINT \(\d+ of 500 nodes created\)\n$/);
  });

  it('SYS-02 mktree rejects bad options with the usage and status 2', () => {
    const k = new FakeKernel();
    for (const argv of [
      ['mktree', '-n', '0'],
      ['mktree', 'a', 'b'],
      ['mktree', '--seed', '-1'],
    ]) {
      const r = k.run(program, argv);
      expect(r.status).toBe(2);
      expect(r.err).toContain('Usage: mktree [-n N]');
    }
    expect(parseMktree([])).toEqual({
      dir: null,
      nodes: 1000,
      seed: 42,
      force: false,
      quiet: false,
      json: false,
    });
  });

  it('VFS-07 absPath places the tree next to DIR', () => {
    expect(absPath('/home/alice/fixtures/tree1000', 'tree1000/s1')).toBe(
      '/home/alice/fixtures/tree1000/s1',
    );
    expect(absPath('/tree', 'tree/a')).toBe('/tree/a');
    expect(absPath('rel', 'rel/a')).toBe('rel/a');
  });
});
