import { describe, expect, it } from 'vitest';

import cat, { transform, visibleByte } from '../cmd/cat.ts';
import ls, { columns } from '../cmd/ls.ts';
import mkdir, { prefixes } from '../cmd/mkdir.ts';
import rmdir, { chain } from '../cmd/rmdir.ts';
import stat from '../cmd/stat.ts';
import touch, { parseDate } from '../cmd/touch.ts';
import tree from '../cmd/tree.ts';
import { SysError } from '../lib/sys.ts';
import { kernel } from './harness.ts';

function seeded() {
  const k = kernel();
  k.fs.addDir('/home/alice/reports', { mode: 0o750, gid: 1002 });
  k.fs.addFile('/home/alice/notes.md', 'hello\nworld\n');
  k.fs.addFile('/home/alice/.hidden', '');
  k.fs.addLink('/home/alice/today', '/home/alice/notes.md');
  return k;
}

describe('ls', () => {
  it('SYS-02 ls lists names in code-point order, one per line through a pipe, hiding dotfiles', () => {
    const r = seeded().run(ls, ['ls']);
    expect(r).toMatchObject({ status: 0, out: 'notes.md\nreports\ntoday\n', err: '' });
  });

  it('SYS-02 ls -a includes dotfiles and the entries . and ..', () => {
    expect(seeded().run(ls, ['ls', '-a']).out).toBe('.\n..\n.hidden\nnotes.md\nreports\ntoday\n');
  });

  it('SYS-02 ls -l prints mode, links, owner, group, size, mtime and name', () => {
    const out = seeded().run(ls, ['ls', '-l']).out.split('\n');
    expect(out[0]).toBe('-rw-r--r-- 1 alice alice   12 2026-11-14 10:12 notes.md');
    expect(out[1]).toBe('drwxr-x--- 2 alice team  4096 2026-11-14 10:12 reports');
    expect(out[2]).toBe(
      'lrwxrwxrwx 1 alice alice   20 2026-11-14 10:12 today -> /home/alice/notes.md',
    );
  });

  it('VFS-05 ls -l lists a dangling symlink with its target', () => {
    const k = kernel();
    k.fs.addLink('/home/alice/gone', 'missing.txt');
    expect(k.run(ls, ['ls', '-l', 'gone']).out).toContain('gone -> missing.txt');
  });

  it('SYS-02 ls -lh, -i, -d and -1 change the fields shown', () => {
    const k = seeded();
    k.fs.addFile('/home/alice/big', new Uint8Array(20_000));
    expect(k.run(ls, ['ls', '-lh', 'big']).out).toContain(' 20K ');
    expect(k.run(ls, ['ls', '-i', 'notes.md']).out).toBe('0192f0c1 notes.md\n');
    expect(k.run(ls, ['ls', '-d', 'reports']).out).toBe('reports\n');
    expect(k.run(ls, ['ls', '-1', 'reports', 'notes.md']).out).toBe('notes.md\n\nreports:\n');
  });

  it('SYS-02 ls -t sorts newest first and -r reverses', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/old', '', { mtime: 1 });
    k.fs.addFile('/home/alice/new', '', { mtime: 5 });
    expect(k.run(ls, ['ls', '-t']).out).toBe('new\nold\n');
    expect(k.run(ls, ['ls', '-r']).out).toBe('old\nnew\n');
  });

  it('SYS-02 ls -R heads each directory with its path', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/a/b/x.txt', '');
    expect(k.run(ls, ['ls', '-R', 'a']).out).toBe('a:\nb\n\na/b:\nx.txt\n');
  });

  it('SYS-02 ls on a terminal uses columns, classification marks and colour', () => {
    const k = seeded();
    const r = k.run(ls, ['ls'], { tty: true });
    expect(r.out).toBe('notes.md  \x1b[1;34mreports\x1b[0m/  \x1b[36mtoday\x1b[0m@\n');
    expect(k.run(ls, ['ls', '--color=never'], { tty: true }).out).toBe(
      'notes.md  reports/  today@\n',
    );
    expect(
      columns(
        [
          { text: 'a', width: 1 },
          { text: 'b', width: 1 },
          { text: 'c', width: 1 },
        ],
        4,
      ),
    ).toEqual(['a  c', 'b']);
  });

  it('SHL-13 ls replaces control and bidi characters with ? on a terminal and not through a pipe', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/evil\x1b]0;x\x07‮.txt', '');
    expect(k.run(ls, ['ls'], { tty: true }).out).toBe('evil?]0;x??.txt\n');
    expect(k.run(ls, ['ls']).out).toBe('evil\x1b]0;x\x07‮.txt\n');
  });

  it('SYS-02 ls reports a missing operand and an unreadable directory and exits 1', () => {
    const k = seeded();
    k.fs.addDir('/home/alice/secret', { mode: 0o000 });
    const r = k.run(ls, ['ls', 'nope', 'secret']);
    expect(r.status).toBe(1);
    expect(r.err).toBe(
      "ls: cannot access 'nope': No such file or directory\nls: cannot open directory 'secret': Permission denied\n",
    );
  });

  it('SHL-15 ls rejects an invalid colour and prints help from the man page', () => {
    expect(seeded().run(ls, ['ls', '--color=blue']).status).toBe(2);
    const help = seeded().run(ls, ['ls', '--help']);
    expect(help.status).toBe(0);
    expect(help.out).toContain('Usage: ls [-a]');
    expect(help.out).toContain('  -a, --all');
  });
});

describe('mkdir and rmdir', () => {
  it('SYS-02 mkdir creates a directory with 0777 masked by the umask', () => {
    const k = kernel();
    expect(k.run(mkdir, ['mkdir', 'x']).status).toBe(0);
    expect(k.fs.node(k.fs.resolve('x', k.cwd, false).ino).mode).toBe(0o755);
  });

  it('VFS-06 mkdir -p creates missing parents in one call and -v reports each', () => {
    const k = kernel();
    k.fs.addDir('/home/alice/a');
    const r = k.run(mkdir, ['mkdir', '-pv', 'a/b/c']);
    expect(r.out).toBe("mkdir: created directory 'a/b'\nmkdir: created directory 'a/b/c'\n");
    expect(k.countCalls('mkdir')).toBe(1);
    expect(prefixes('/x/y')).toEqual(['/x', '/x/y']);
  });

  it('SYS-02 mkdir -m sets the mode exactly and rejects a bad mode', () => {
    const k = kernel();
    k.run(mkdir, ['mkdir', '-m', '777', 'open']);
    expect(k.fs.node(k.fs.resolve('open', k.cwd, false).ino).mode).toBe(0o777);
    k.run(mkdir, ['mkdir', '-m', 'go-rwx', 'priv']);
    expect(k.fs.node(k.fs.resolve('priv', k.cwd, false).ino).mode).toBe(0o700);
    expect(k.run(mkdir, ['mkdir', '-m', 'u+s', 'bad'])).toMatchObject({
      status: 1,
      err: "mkdir: invalid mode 'u+s'\n",
    });
  });

  it('SYS-02 mkdir reports an existing directory and a missing parent', () => {
    const k = kernel();
    k.fs.addDir('/home/alice/x');
    const r = k.run(mkdir, ['mkdir', 'x', 'no/such']);
    expect(r.status).toBe(1);
    expect(r.err).toBe(
      "mkdir: cannot create directory 'x': File exists\nmkdir: cannot create directory 'no/such': No such file or directory\n",
    );
    expect(k.run(mkdir, ['mkdir']).status).toBe(2);
  });

  it('SYS-02 rmdir removes empty directories and -p removes emptied parents', () => {
    const k = kernel();
    k.fs.addDir('/home/alice/a/b/c');
    const r = k.run(rmdir, ['rmdir', '-pv', 'a/b/c']);
    expect(r.status).toBe(0);
    expect(r.out).toBe(
      "rmdir: removing directory, 'a/b/c'\nrmdir: removing directory, 'a/b'\nrmdir: removing directory, 'a'\n",
    );
    expect(k.fs.exists('a', k.cwd)).toBe(false);
    expect(chain('x/', false)).toEqual(['x']);
  });

  it('SYS-02 rmdir refuses a non-empty directory', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/full/f', '');
    expect(k.run(rmdir, ['rmdir', 'full'])).toMatchObject({
      status: 1,
      err: "rmdir: failed to remove 'full': Directory not empty\n",
    });
  });
});

describe('touch', () => {
  it('SYS-02 touch creates an empty file and updates times of an existing one', () => {
    const k = kernel();
    expect(k.run(touch, ['touch', 'notes.md']).status).toBe(0);
    expect(k.fs.text('notes.md', k.cwd)).toBe('');
    k.fs.clock += 60_000;
    k.run(touch, ['touch', 'notes.md']);
    expect(k.argsOf('utimes')).toEqual([{ path: 'notes.md', atime: 'now', mtime: 'now' }]);
  });

  it('SYS-02 touch -c does not create and -d sets a local date', () => {
    const k = kernel();
    k.run(touch, ['touch', '-c', 'ghost']);
    expect(k.fs.exists('ghost', k.cwd)).toBe(false);
    k.run(touch, ['touch', '-m', '-d', '2026-01-02T03:04', 'f']);
    expect(k.argsOf('utimes')).toEqual([{ path: 'f', mtime: Date.UTC(2026, 0, 1, 22, 4) }]);
    expect(parseDate('2026-02-30', 0)).toBeNull();
    expect(parseDate('2026-13-01', 0)).toBeNull();
    expect(k.run(touch, ['touch', '-d', 'tomorrow', 'f'])).toMatchObject({
      status: 1,
      err: "touch: invalid date format 'tomorrow'\n",
    });
  });

  it('SYS-02 touch reports a missing parent', () => {
    const r = kernel().run(touch, ['touch', 'no/f']);
    expect(r).toMatchObject({
      status: 1,
      err: "touch: cannot touch 'no/f': No such file or directory\n",
    });
  });
});

describe('cat', () => {
  it('SYS-02 cat concatenates files and stdin for -', () => {
    const k = seeded();
    const r = k.run(cat, ['cat', 'notes.md', '-'], { stdin: 'from stdin\n' });
    expect(r).toMatchObject({ status: 0, out: 'hello\nworld\nfrom stdin\n' });
    expect(k.run(cat, ['cat'], { stdin: 'x' }).out).toBe('x');
  });

  it('SYS-02 cat -n numbers lines across files and -v shows control characters', () => {
    const k = seeded();
    k.fs.addFile('/home/alice/ctl', new Uint8Array([0x01, 0x7f, 0xc3, 0xa9, 0x09, 0x7a, 0x0a]));
    expect(k.run(cat, ['cat', '-n', 'notes.md', 'notes.md']).out).toBe(
      '     1\thello\n     2\tworld\n     3\thello\n     4\tworld\n',
    );
    expect(k.run(cat, ['cat', '-v', 'ctl']).out).toBe('^A^?M-CM-)\tz\n');
    expect(visibleByte(0x9b)).toBe('M-^[');
    const num = { line: 0, atStart: true };
    expect(
      new TextDecoder().decode(
        transform(
          new TextEncoder().encode('a\nb'),
          { number: true, visible: false, files: [] },
          num,
        ),
      ),
    ).toBe('     1\ta\n     2\tb');
  });

  it('SYS-02 cat reports a directory and a missing file and exits 1', () => {
    const r = seeded().run(cat, ['cat', 'reports', 'nope', 'notes.md']);
    expect(r.status).toBe(1);
    expect(r.err).toBe('cat: reports: Is a directory\ncat: nope: No such file or directory\n');
    expect(r.out).toBe('hello\nworld\n');
  });

  it('SHL-07 cat into a closed pipe ends quietly with 141', () => {
    const k = seeded();
    k.on('write', (a) => {
      if (a.fd === 1) throw new SysError('EPIPE');
      return { bytes: a.data.byteLength };
    });
    expect(k.run(cat, ['cat', 'notes.md'])).toMatchObject({ status: 141, err: '' });
  });
});

describe('tree and stat', () => {
  it('SYS-02 tree draws the hierarchy and prints the summary', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/t3/a/b/x.txt', '');
    k.fs.addFile('/home/alice/t3/f.txt', '');
    k.fs.addLink('/home/alice/t3/l', 'f.txt');
    const r = k.run(tree, ['tree', 't3']);
    expect(r.out).toBe(
      't3\n├── a\n│   └── b\n│       └── x.txt\n├── f.txt\n└── l -> f.txt\n\n2 directories, 3 files\n',
    );
  });

  it('SYS-02 tree -L, -d, -a, --noreport and an unreadable directory', () => {
    const k = kernel();
    k.fs.addFile('/home/alice/t/a/deep.txt', '');
    k.fs.addFile('/home/alice/t/.dot', '');
    k.fs.addDir('/home/alice/t/locked', { mode: 0o000 });
    expect(k.run(tree, ['tree', '-L', '1', 't']).out).toBe(
      't\n├── a\n└── locked\n\n2 directories, 0 files\n',
    );
    expect(k.run(tree, ['tree', '-a', '--noreport', 't']).out).toBe(
      't\n├── .dot\n├── a\n│   └── deep.txt\n└── locked  [error opening dir]\n',
    );
    expect(k.run(tree, ['tree', '-d', 't']).out).toContain('\n2 directories\n');
    expect(k.run(tree, ['tree', 'nope'])).toMatchObject({
      status: 1,
      err: "tree: 'nope': No such file or directory\n",
    });
    expect(k.run(tree, ['tree', '-L', '0']).status).toBe(2);
  });

  it('SYS-02 stat prints the exact layout', () => {
    const k = seeded();
    const out = k.run(stat, ['stat', 'notes.md']).out.split('\n');
    expect(out).toEqual([
      '  File: notes.md',
      '  Type: regular file        Size: 12           Links: 1',
      ` Inode: ${k.fs.resolve('notes.md', k.cwd, false).ino}   Version: 1   Sync: -`,
      'Access: (0644/-rw-r--r--)   Uid: ( 1001/   alice)   Gid: ( 1001/   alice)',
      'Access: 2026-11-14 10:12:05.123 +0500',
      'Modify: 2026-11-14 10:12:05.123 +0500',
      'Change: 2026-11-14 10:12:05.123 +0500',
      '',
    ]);
  });

  it('VFS-05 stat shows a symlink itself and stat -L its target', () => {
    const k = seeded();
    expect(k.run(stat, ['stat', 'today']).out).toContain(
      '  File: today -> /home/alice/notes.md\n  Type: symbolic link',
    );
    expect(k.run(stat, ['stat', '-L', 'today']).out).toContain('  Type: regular file');
    expect(k.run(stat, ['stat', '-t', 'notes.md']).out).toMatch(
      /^notes\.md 12 0644 1001 1001 \S+ 1 \d+ \d+ \d+ 1 f\n$/,
    );
  });

  it('SYS-02 stat reports a missing file and shows the sync state when the kernel gives it', () => {
    const k = seeded();
    expect(k.run(stat, ['stat', 'nope'])).toMatchObject({
      status: 1,
      err: "stat: cannot stat 'nope': No such file or directory\n",
    });
    k.on('lstat', () => ({
      ...k.fs.stat(k.fs.node(k.fs.resolve('notes.md', k.cwd, false).ino)),
      sync: 'pending-offline',
    }));
    expect(k.run(stat, ['stat', 'notes.md']).out).toContain('Sync: pending (offline)');
  });
});
