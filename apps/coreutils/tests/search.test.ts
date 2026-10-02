import { describe, expect, it } from 'vitest';

import df from '../cmd/df.ts';
import du, { sizeText } from '../cmd/du.ts';
import find, { displayPath, parseFind } from '../cmd/find.ts';
import grep, { compile, highlight } from '../cmd/grep.ts';
import quota, { quotaSize } from '../cmd/quota.ts';
import { kernel } from './harness.ts';

const DAY = 86_400_000;

function t3() {
  const k = kernel();
  k.fs.addFile('/home/alice/t3/a/b/x.txt', 'x');
  k.fs.addFile('/home/alice/t3/f.txt', 'one\ntwo\n');
  k.fs.addFile('/home/alice/t3/Big.PDF', new Uint8Array(3000));
  k.fs.addDir('/home/alice/t3/empty');
  return k;
}

describe('find', () => {
  it('SYS-02 find -name and -type print matching paths starting with the start path', () => {
    const r = t3().run(find, ['find', 't3', '-name', '*.txt', '-type', 'f']);
    expect(r).toMatchObject({ status: 0, out: 't3/a/b/x.txt\nt3/f.txt\n', err: '' });
  });

  it('SYS-02 find with no expression prints the start path and everything below in pre-order', () => {
    expect(t3().run(find, ['find', 't3/a']).out).toBe('t3/a\nt3/a/b\nt3/a/b/x.txt\n');
  });

  it('SYS-02 find supports -iname, !, -o, grouping and -print', () => {
    const k = t3();
    expect(k.run(find, ['find', 't3', '-iname', '*.pdf']).out).toBe('t3/Big.PDF\n');
    expect(k.run(find, ['find', 't3', '-type', 'f', '!', '-name', '*.txt']).out).toBe(
      't3/Big.PDF\n',
    );
    expect(
      k.run(find, ['find', 't3', '(', '-name', 'x.txt', '-o', '-name', 'empty', ')']).out,
    ).toBe('t3/a/b/x.txt\nt3/empty\n');
    expect(
      k.run(find, ['find', 't3', '-name', 'f.txt', '-print', '-o', '-name', 'nothing']).out,
    ).toBe('t3/f.txt\n');
    expect(k.run(find, ['find', 't3', '-not', '-type', 'f', '-a', '-name', 'b']).out).toBe(
      't3/a/b\n',
    );
  });

  it('SYS-02 find -maxdepth, -mindepth, -empty and -size', () => {
    const k = t3();
    expect(k.run(find, ['find', 't3', '-maxdepth', '1', '-type', 'd']).out).toBe(
      't3\nt3/a\nt3/empty\n',
    );
    expect(k.run(find, ['find', 't3', '-mindepth', '3']).out).toBe('t3/a/b/x.txt\n');
    expect(k.run(find, ['find', 't3', '-empty']).out).toBe('t3/empty\n');
    expect(k.run(find, ['find', 't3', '-type', 'f', '-size', '+2k']).out).toBe('t3/Big.PDF\n');
    expect(k.run(find, ['find', 't3', '-size', '-2', '-type', 'f']).out).toBe(
      't3/a/b/x.txt\nt3/f.txt\n',
    );
    expect(k.run(find, ['find', 't3', '-size', '8c']).out).toBe('t3/f.txt\n');
  });

  it('SYS-02 find -mtime, -mmin, -newer and -user', () => {
    const k = t3();
    k.fs.node(k.fs.resolve('t3/f.txt', k.cwd, false).ino).mtime = k.fs.clock - 10 * DAY;
    expect(k.run(find, ['find', 't3', '-type', 'f', '-mtime', '+7']).out).toBe('t3/f.txt\n');
    expect(k.run(find, ['find', 't3', '-type', 'f', '-mtime', '-7']).out).toBe(
      't3/Big.PDF\nt3/a/b/x.txt\n',
    );
    expect(k.run(find, ['find', 't3', '-type', 'f', '-mmin', '-5']).out).toBe(
      't3/Big.PDF\nt3/a/b/x.txt\n',
    );
    expect(k.run(find, ['find', 't3', '-type', 'f', '-newer', 't3/f.txt']).out).toBe(
      't3/Big.PDF\nt3/a/b/x.txt\n',
    );
    expect(k.run(find, ['find', 't3', '-user', 'bob']).out).toBe('');
    expect(k.run(find, ['find', 't3/f.txt', '-user', 'alice']).out).toBe('t3/f.txt\n');
    expect(k.run(find, ['find', 't3', '-user', 'bob2'])).toMatchObject({
      status: 1,
      err: "find: 'bob2' is not the name of a known user\n",
    });
    expect(k.run(find, ['find', 't3', '-newer', 'nope']).err).toBe(
      "find: 'nope': No such file or directory\n",
    );
  });

  it('SYS-02 find reports an invalid expression with status 2', () => {
    const r = t3().run(find, ['find', 't3', '-mtme', '-7']);
    expect(r).toMatchObject({ status: 2, err: "find: invalid expression near '-mtme'\n" });
    expect(parseFind(['-name']).problem).toBe("missing argument to '-name'");
    expect(parseFind(['-type', 'x']).problem).toBe('unknown argument to -type: x');
    expect(parseFind(['-mtime', 'soon']).problem).toBe("invalid argument 'soon' to '-mtime'");
    expect(parseFind(['(', '-empty']).problem).toBe('invalid expression near end of input');
    expect(parseFind(['-size', '3q']).problem).toBe("invalid -size type in '3q'");
    expect(parseFind(['-maxdepth', '+1']).problem).toBe("invalid argument '+1' to '-maxdepth'");
  });

  it('SYS-02 find reports a missing start path and skipped unreadable directories', () => {
    const k = t3();
    k.fs.addDir('/home/alice/t3/locked', { mode: 0o000 });
    const r = k.run(find, ['find', 'nope', 't3', '-name', 'locked']);
    expect(r.status).toBe(1);
    expect(r.out).toBe('t3/locked\n');
    expect(r.err).toBe(
      "find: 'nope': No such file or directory\nfind: 't3': Permission denied (1 directory skipped)\n",
    );
  });

  it('SHL-13 find escapes names on a terminal', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/d/a\x1bb', '');
    expect(k.run(find, ['find', 'd', '-type', 'f'], { tty: true }).out).toBe('d/a?b\n');
  });

  it('SYS-02 find shows kernel paths with the start path as typed', () => {
    expect(displayPath('/home/alice/x/y', '.', '/home/alice')).toBe('./x/y');
    expect(displayPath('/elsewhere/y', 'x', '/home/alice')).toBe('/elsewhere/y');
    expect(displayPath('x/y', 'x', '/')).toBe('x/y');
  });
});

describe('du', () => {
  it('VFS-06 du -sh prints one total per operand from one du call', () => {
    const k = t3();
    const r = k.run(du, ['du', '-sh', 't3']);
    expect(r.out).toBe('3.0K\tt3\n');
    expect(k.countCalls('du')).toBe(1);
  });

  it('VFS-06 du prints directories post-order in KiB rounded up, -a adds files, -c a total', () => {
    const k = t3();
    expect(k.run(du, ['du', 't3']).out).toBe('1\tt3/a/b\n1\tt3/a\n0\tt3/empty\n3\tt3\n');
    expect(k.run(du, ['du', '-a', '-d', '1', 't3/a']).out).toBe('1\tt3/a/b\n1\tt3/a\n');
    expect(k.run(du, ['du', '-ac', 't3/a']).out).toBe(
      '1\tt3/a/b/x.txt\n1\tt3/a/b\n1\tt3/a\n1\ttotal\n',
    );
    expect(k.run(du, ['du', 't3/f.txt']).out).toBe('1\tt3/f.txt\n');
    expect(sizeText(0, false)).toBe('0');
  });

  it('VFS-06 du reports a missing operand and bad options', () => {
    const k = t3();
    expect(k.run(du, ['du', 'nope'])).toMatchObject({
      status: 1,
      err: "du: cannot access 'nope': No such file or directory\n",
    });
    expect(k.run(du, ['du', '-sa']).status).toBe(2);
    expect(k.run(du, ['du', '-d', 'x']).status).toBe(2);
    k.fs.addDir('/home/alice/t3/locked', { mode: 0o000 });
    expect(k.run(du, ['du', 't3']).err).toBe(
      "du: cannot read directory 't3': Permission denied (1 skipped)\n",
    );
  });
});

describe('df and quota', () => {
  const FS = {
    fsId: 'plotinium' as const,
    usageBytes: 212 * 1_048_576,
    quotaBytes: 2_254_857_830,
    inodes: 412,
    persisted: true,
    swapBytes: { local: 0, remote: 0 },
  };
  const Q = {
    uid: 1001,
    usedBytes: 18 * 1_048_576,
    quotaBytes: 100 * 1_048_576,
    usedInodes: 412,
    quotaInodes: 10_000,
    source: 'server' as const,
  };
  const CRED = {
    uid: 1001,
    gid: 1001,
    groups: [1001],
    user: 'alice',
    groupNames: ['alice'],
    home: '/home/alice',
    ruid: 1001,
  };

  function world() {
    return kernel()
      .on('statfs', () => FS)
      .on('quota', () => Q)
      .on('proc.cred', () => CRED);
  }

  it('VFS-06 df -h prints the quota row and the browser storage row', () => {
    const out = world().run(df, ['df', '-h']).out.split('\n');
    expect(out[0]).toBe('Filesystem          Size   Used  Avail Use% Mounted on');
    expect(out[1]).toBe('plotinium (quota)   100M    18M    82M  18% /home/alice');
    expect(out[2]).toBe('browser storage     2.1G   212M   1.9G  10% (this device)');
  });

  it('VFS-06 df -i shows inodes; offline and root rows are labelled', () => {
    const k = world();
    expect(k.run(df, ['df', '-i']).out.split('\n')[1]).toBe(
      'plotinium (quota)    10000    412   9588    5% /home/alice',
    );
    k.on('quota', () => ({ ...Q, quotaBytes: null, source: 'mirror' as const }));
    expect(k.run(df, ['df']).out.split('\n')[1]).toMatch(
      /^plotinium \(quota, offline\)\s+-\s+18432\s+-\s+-\s+\/home\/alice$/,
    );
    k.fail('statfs', 'ENOENT');
    expect(k.run(df, ['df', 'nope'])).toMatchObject({
      status: 1,
      err: "df: 'nope': No such file or directory\n",
    });
  });

  it('VFS-06 quota prints used and limits with the source', () => {
    const r = world().run(quota, ['quota', '-h']);
    expect(r.out).toBe(
      'Disk quotas for user alice (uid 1001):\n  bytes used     18M   of 100M\n  inodes used    412   of 10000\n  source: server\n',
    );
    expect(quotaSize(19_084_083, true)).toBe('18.2M');
    expect(quotaSize(5, false)).toBe('5');
  });

  it('VFS-06 quota -u needs root and reports unknown users', () => {
    const k = world();
    expect(k.run(quota, ['quota', '-u', 'bob2'])).toMatchObject({
      status: 1,
      err: "quota: no such user 'bob2'\n",
    });
    k.fail('quota', 'EPERM');
    expect(k.run(quota, ['quota', '-u', 'bob']).err).toBe(
      'quota: permission denied for other users\n',
    );
    k.on('quota', (a) => ({ ...Q, uid: a.uid ?? 0, source: 'mirror' as const }));
    expect(k.run(quota, ['quota', '-u', 'bob']).out).toContain(
      'Disk quotas for user bob (uid 1002):',
    );
    expect(k.run(quota, ['quota', '-u', 'bob']).out).toContain(
      'local mirror (offline; the server value may differ)',
    );
  });
});

describe('grep', () => {
  function notes() {
    const k = kernel();
    k.fs.addFile('/home/alice/n/a.md', 'memory leak here\nnothing\nMemory Leak twice\n');
    k.fs.addFile('/home/alice/n/b.md', 'no match\n');
    k.fs.addFile('/home/alice/n/bin', new Uint8Array([0x6c, 0x65, 0x61, 0x6b, 0x00, 0x0a]));
    return k;
  }

  it('SYS-02 grep prints matching lines and exits 0, and exits 1 when nothing matches', () => {
    const k = notes();
    expect(k.run(grep, ['grep', 'leak', 'n/a.md'])).toMatchObject({
      status: 0,
      out: 'memory leak here\n',
    });
    expect(k.run(grep, ['grep', 'absent', 'n/a.md'])).toMatchObject({ status: 1, out: '' });
  });

  it('SYS-02 grep -c counts lines from stdin', () => {
    const r = kernel().run(grep, ['grep', '-c', 'o'], { stdin: 'one $HOME\ntwo\nthree\n' });
    expect(r.out).toBe('2\n');
  });

  it('SYS-02 grep -rn prefixes path and line number and reports binary files', () => {
    const r = notes().run(grep, ['grep', '-rni', 'leak', 'n']);
    expect(r.out).toBe(
      'n/a.md:1:memory leak here\nn/a.md:3:Memory Leak twice\nBinary file n/bin matches\n',
    );
  });

  it('SYS-02 grep -v, -l, -w, -F, -e, -H and -h', () => {
    const k = notes();
    expect(k.run(grep, ['grep', '-v', 'leak', 'n/a.md']).out).toBe('nothing\nMemory Leak twice\n');
    expect(k.run(grep, ['grep', '-l', 'match', 'n/a.md', 'n/b.md']).out).toBe('n/b.md\n');
    expect(k.run(grep, ['grep', '-w', 'mem', 'n/a.md']).status).toBe(1);
    expect(k.run(grep, ['grep', '-F', 'a.', 'n/a.md']).status).toBe(1);
    expect(k.run(grep, ['grep', '-e', 'nothing', '-e', 'twice', 'n/a.md']).out).toBe(
      'nothing\nMemory Leak twice\n',
    );
    expect(k.run(grep, ['grep', '-H', 'nothing', 'n/a.md']).out).toBe('n/a.md:nothing\n');
    expect(k.run(grep, ['grep', '-h', 'match', 'n/a.md', 'n/b.md']).out).toBe('no match\n');
    expect(k.run(grep, ['grep', '-c', 'leak', 'n/a.md', 'n/b.md']).out).toBe(
      'n/a.md:1\nn/b.md:0\n',
    );
  });

  it('SYS-02 grep highlights matches in bold red on a terminal', () => {
    const k = notes();
    expect(k.run(grep, ['grep', 'leak', 'n/a.md'], { tty: true }).out).toBe(
      'memory \x1b[1;31mleak\x1b[0m here\n',
    );
    expect(
      highlight(compile({ patterns: ['a*'], fixed: false, word: false, ignoreCase: false }), 'bab'),
    ).toBe('b\x1b[1;31ma\x1b[0mb');
  });

  it('SYS-02 grep exits 2 on an error, an invalid regular expression or a directory without -r', () => {
    const k = notes();
    expect(k.run(grep, ['grep', 'x', 'nope'])).toMatchObject({
      status: 2,
      err: 'grep: nope: No such file or directory\n',
    });
    expect(k.run(grep, ['grep', '(', 'n/a.md'])).toMatchObject({ status: 2 });
    expect(k.run(grep, ['grep', '(', 'n/a.md']).err).toMatch(/^grep: invalid regular expression: /);
    expect(k.run(grep, ['grep', 'x', 'n']).err).toBe('grep: n: Is a directory\n');
    expect(k.run(grep, ['grep']).status).toBe(2);
    k.fs.addDir('/home/alice/n/locked', { mode: 0o000 });
    expect(k.run(grep, ['grep', '-r', 'leak', 'n'])).toMatchObject({
      status: 2,
      err: 'grep: n/locked: Permission denied\n',
    });
  });
});
