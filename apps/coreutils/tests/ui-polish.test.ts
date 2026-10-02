/**
 * Coreutils fixes of the polish wave (docs/design/bug-hunt/BUGS.md): `find` and `du` without the
 * kernel's `find`/`du` calls (UI-054), clean diagnostics instead of crashes, `su` and `lsof`
 * messages (UI-125), and small output errors of `kill`, `df` and `ps` (UI-159).
 */
import { describe, expect, it } from 'vitest';

import df, { humanUnit } from '../cmd/df.ts';
import du from '../cmd/du.ts';
import find from '../cmd/find.ts';
import kill from '../cmd/kill.ts';
import lsof from '../cmd/lsof.ts';
import ps from '../cmd/ps.ts';
import su, { suError } from '../cmd/su.ts';
import stat from '../cmd/stat.ts';
import type { FindWalk } from '../lib/fs.ts';
import { walkTree } from '../lib/fs.ts';
import type { Program } from '../lib/sys.ts';
import { SysError } from '../lib/sys.ts';
import { kernel } from './harness.ts';

function tree() {
  const k = kernel();
  k.fs.addFile('/home/alice/t3/a/b/x.txt', 'x');
  k.fs.addFile('/home/alice/t3/f.txt', 'one\ntwo\n');
  k.fs.addFile('/home/alice/t3/Big.PDF', new Uint8Array(3000));
  k.fs.addDir('/home/alice/t3/empty');
  k.fs.addDir('/home/alice/t3/locked', { mode: 0o000 });
  k.fs.addLink('/home/alice/t3/up', '/home/alice');
  return k;
}

describe('UI-054 find and du on a kernel without the find and du calls', () => {
  const FIND_CASES = [
    ['find', 't3'],
    ['find', 't3', '-name', '*.txt', '-type', 'f'],
    ['find', 't3', '-maxdepth', '1', '-type', 'd'],
    ['find', 't3', '-mindepth', '3'],
    ['find', 't3/', '-type', 'l'],
    ['find', '/home/alice/t3', '-size', '+2k'],
  ];

  it('UI-054 find prints exactly what the kernel walk prints, with a clean status for unreadable folders', () => {
    for (const argv of FIND_CASES) {
      const expected = tree().run(find, argv);
      const k = tree();
      k.fail('find', 'ENOSYS', { msg: 'find: not available here' });
      const got = k.run(find, argv);
      expect(got, argv.join(' ')).toMatchObject({ out: expected.out, status: expected.status });
      expect(got.err).not.toContain('crashed');
    }
    const k = tree();
    k.fail('find', 'ENOSYS');
    expect(k.run(find, ['find', 't3'])).toMatchObject({
      status: 1,
      err: "find: 't3': Permission denied (1 directory skipped)\n",
    });
  });

  it('UI-054 du and du -sh total the same bytes without the kernel calls', () => {
    for (const argv of [
      ['du', 't3/a'],
      ['du', '-a', 't3/a'],
      ['du', '-sh', 't3/a'],
      ['du', '-s', 't3/a', 't3/f.txt'],
    ]) {
      const expected = tree().run(du, argv);
      const k = tree();
      k.fail('find', 'ENOSYS');
      k.fail('du', 'ENOSYS');
      expect(k.run(du, argv), argv.join(' ')).toMatchObject({
        out: expected.out,
        status: expected.status,
      });
    }
  });

  it('UI-054 the walk is pre-order, in code-point order, and never follows a symbolic link', () => {
    let walk: FindWalk = { hits: [], denied: 0 };
    const walker: Program<null> = {
      init: () => null,
      *run(ctx) {
        walk = yield* walkTree(ctx.sys, { path: 't3', plus: false });
        return 0;
      },
    };
    expect(tree().run(walker, ['walk']).status).toBe(0);
    expect(walk.hits.map((h) => h.path)).toEqual([
      't3/Big.PDF',
      't3/a',
      't3/a/b',
      't3/a/b/x.txt',
      't3/empty',
      't3/f.txt',
      't3/locked',
      't3/up',
    ]);
    expect(walk.denied).toBe(1);
  });

  it('UI-054 a failed call a command did not expect ends with a diagnostic and status 1, not a crash', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/n.txt', 'n');
    k.fail('lstat', 'ENOSYS', { msg: 'lstat: not available here' });
    const r = k.run(stat, ['stat', 'n.txt']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^stat: .*Function not implemented/m);
    expect(r.err).not.toContain('crashed');
  });
});

describe('UI-125 su and lsof speak to the user', () => {
  it('UI-125 su without a way to switch users says so in plain words', () => {
    expect(suError(new SysError('ENOSYS', "su is made by the app's own process"), 'root')).toBe(
      'switching users is not available in this Terminal yet',
    );
    const k = kernel();
    k.fail('su', 'ENOSYS', {
      msg: "su is made by the app's own process, and this window has no channel to it yet",
    });
    expect(k.run(su, ['su'], { tty: true })).toMatchObject({
      status: 1,
      err: 'su: switching users is not available in this Terminal yet\n',
    });
  });

  it('UI-125 lsof without a kernel handler says it is not available, without internals', () => {
    const k = kernel();
    k.fail('lsof', 'ENOSYS', { msg: 'lsof: not available here' });
    expect(k.run(lsof, ['lsof'])).toMatchObject({
      status: 1,
      err: 'lsof: listing open files is not available here yet\n',
    });
  });
});

describe('UI-159 small output errors', () => {
  it('UI-159 kill of a pid no process can have is "No such process"', () => {
    const k = kernel().on('kill', () => ({ delivered: 1 }));
    expect(k.run(kill, ['kill', '-9', '99999'])).toMatchObject({
      status: 1,
      err: 'kill: (99999) - No such process\n',
    });
    expect(k.run(kill, ['kill', '--', '-40000'])).toMatchObject({
      status: 1,
      err: 'kill: (-40000) - No such process\n',
    });
    expect(k.countCalls('kill')).toBe(0);
    expect(k.run(kill, ['kill', '42']).status).toBe(0);
  });

  it('UI-159 df -h shows a unit on sizes below 1 KiB', () => {
    expect(humanUnit(346)).toBe('346B');
    expect(humanUnit(0)).toBe('0B');
    expect(humanUnit(2048)).toBe('2.0K');
    const k = kernel()
      .on('statfs', () => ({
        fsId: 'plotinium' as const,
        usageBytes: 346,
        quotaBytes: 1_073_741_824,
        inodes: 12,
        persisted: true,
        swapBytes: { local: 0, remote: 0 },
      }))
      .on('quota', () => ({
        uid: 1001,
        usedBytes: 346,
        quotaBytes: 1_073_741_824,
        usedInodes: 3,
        quotaInodes: null,
        source: 'server' as const,
      }))
      .on('proc.cred', () => ({
        uid: 1001,
        gid: 1001,
        groups: [1001],
        user: 'alice',
        groupNames: ['alice'],
        home: '/home/alice',
        ruid: 1001,
      }));
    const out = k.run(df, ['df', '-h']).out;
    expect(out).toMatch(/plotinium \(quota\) +1\.0G +346B /);
  });

  it('UI-159 df -h rounds a size just under a unit up to 1.0 of it, never 1024 of the one below', () => {
    const justUnderGiB = 1_073_741_824 - 58;
    expect(humanUnit(justUnderGiB)).toBe('1.0G');
    expect(humanUnit(1_048_575)).toBe('1.0M');
    expect(humanUnit(1_073_741_824)).toBe('1.0G');
    expect(humanUnit(1023 * 1_048_576)).toBe('1023M');
    // Past the largest unit there is nothing to roll into.
    expect(humanUnit(1024 ** 5 - 1)).toBe('1024T');
  });

  it('UI-159 ps -p with no such process prints the header and exits 1', () => {
    const k = kernel().on('proc.list', () => ({ procs: [] }));
    const r = k.run(ps, ['ps', '-p', '99999']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/^ +PID/);
    expect(k.run(ps, ['ps', '-p', '99999', '--json'])).toMatchObject({ status: 1, out: '[]\n' });
  });
});
