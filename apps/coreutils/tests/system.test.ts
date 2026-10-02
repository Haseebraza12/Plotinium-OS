import { describe, expect, it } from 'vitest';

import bootlog, { parseBoot } from '../cmd/bootlog.ts';
import debug, { parseDebug } from '../cmd/debug.ts';
import fsck from '../cmd/fsck.ts';
import help from '../cmd/help.ts';
import lsof, { fileType } from '../cmd/lsof.ts';
import man, { apropos, findLine, keyAction, parseIndex, splitKeys } from '../cmd/man.ts';
import reboot from '../cmd/reboot.ts';
import shutdown, { delayMs, parseWhen } from '../cmd/shutdown.ts';
import su, { parseSu } from '../cmd/su.ts';
import svcctl, { editRequires, parseSvcctl, statusLines } from '../cmd/svcctl.ts';
import swapctl, { benchLine, parseSize, parseSwapctl } from '../cmd/swapctl.ts';
import type { SysError } from '../lib/sys.ts';
import type { FakeKernel } from './harness.ts';
import { kernel } from './harness.ts';

const NOW = Date.UTC(2026, 10, 14, 5, 12, 5, 123);
const UNAME = {
  sysname: 'Plotinium' as const,
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-11-02',
  codename: null,
  browser: { brand: 'Chrome' as const, major: 154 },
  cores: 8,
  uid: 1001,
  user: 'alice',
};

describe('su', () => {
  function suWorld(): FakeKernel {
    const k = kernel();
    k.fs.addFile('/bin/sh.json', '{}');
    return k
      .on('su', () => ({ pid: 900, uid: 0, grantExpiresAt: NOW + 900_000 }))
      .on('wait', () => ({ pid: 900, status: { kind: 'exited' as const, code: 0 } }));
  }

  it('SYS-02 su -c runs one command as root through the su call and returns its status', () => {
    const k = suWorld();
    k.on('wait', () => ({ pid: 900, status: { kind: 'exited' as const, code: 3 } }));
    expect(k.run(su, ['su', '-c', 'id -u'], { tty: true }).status).toBe(3);
    expect(k.argsOf('su')[0]).toMatchObject({
      user: 'root',
      spawn: {
        path: '/bin/sh.json',
        argv: ['sh', '-c', 'id -u'],
        env: { HOME: '/root', USER: 'root', LOGNAME: 'root', PATH: '/bin' },
      },
    });
  });

  it('SYS-02 su - starts a login shell with a reset environment', () => {
    const k = suWorld();
    k.run(su, ['su', '-', 'bob'], { tty: true, env: { SECRET: 'x' } });
    const args = k.argsOf('su')[0] as {
      user: string;
      spawn: { argv: string[]; env: Record<string, string> };
    };
    expect(args.user).toBe('bob');
    expect(args.spawn.argv).toEqual(['-sh']);
    expect(args.spawn.env).not.toHaveProperty('SECRET');
    expect(parseSu(['-l'])).toEqual({ login: true, command: null, user: 'root' });
  });

  it('SYS-02 su needs a terminal and reports authentication outcomes', () => {
    const k = suWorld();
    expect(k.run(su, ['su'])).toMatchObject({
      status: 1,
      err: 'su: must be run from a terminal\n',
    });
    expect(k.run(su, ['su', 'bob2'], { tty: true }).err).toBe('su: user bob2 does not exist\n');
    const cases: [SysError['errno'], Record<string, unknown> | undefined, string][] = [
      ['EACCES', undefined, 'Authentication failure'],
      ['ECANCELED', undefined, 'authentication cancelled'],
      ['EAGAIN', { reason: 'offline' }, 'authentication unavailable offline'],
      ['EAGAIN', { reason: 'rate' }, 'too many attempts, try again in 5 min'],
      ['EPERM', { reason: 'guest' }, 'guests cannot use su'],
      ['EPERM', undefined, 'Operation not permitted'],
      ['EINVAL', undefined, 'user root does not exist'],
      ['ENOTTY', undefined, 'must be run from a terminal'],
      ['EIO', undefined, 'Input/output error'],
    ];
    for (const [errno, detail, text] of cases) {
      k.fail('su', errno, detail === undefined ? {} : { detail });
      expect(k.run(su, ['su'], { tty: true }).err).toBe(`su: ${text}\n`);
    }
    expect(k.run(su, ['su', 'a', 'b'], { tty: true }).status).toBe(2);
  });
});

describe('bootlog', () => {
  const LOG = {
    entries: [
      { t: 0, sub: 'kernel', level: 'info' as const, msg: 'start' },
      { t: 0.002, sub: 'kernel', level: 'info' as const, msg: 'ready' },
      { t: 0.06, sub: 'storage', level: 'info' as const, msg: 'open' },
      { t: 0.122, sub: 'storage', level: 'info' as const, msg: 'ready' },
      { t: 0.2, sub: 'sync', level: 'degraded' as const, msg: 'offline' },
      { t: 0.402, sub: 'desktop', level: 'info' as const, msg: 'mount' },
      { t: 0.731, sub: 'desktop', level: 'info' as const, msg: 'interactive' },
    ],
    criticalPath: ['kernel', 'storage', 'desktop'],
    totalMs: 731,
  };

  it('BOOT-11 bootlog --critical-path prints the chain from kernel to desktop with durations', () => {
    const k = kernel().on('bootlog', () => LOG);
    const lines = k.run(bootlog, ['bootlog', '--critical-path']).out.split('\n');
    expect(lines[0]).toBe('boot · current · 0.731 s to desktop-interactive');
    expect(lines[1]).toBe('svc    kernel      0.000 → 0.002     2 ms');
    expect(lines[2]).toBe('svc    storage     0.060 → 0.122    62 ms   gated by kernel');
    expect(lines[3]).toMatch(/^svc {4}desktop\s+\d/);
    expect(k.argsOf('bootlog')).toEqual([{ criticalPath: true, verbose: false, boot: 'current' }]);
  });

  it('BOOT-11 bootlog prints per-service timings, the degraded services, -v and --json', () => {
    const k = kernel().on('bootlog', () => LOG);
    const out = k.run(bootlog, ['bootlog']).out;
    expect(out).toContain(
      'SERVICE START   END DURATION STATUS\nkernel  0.000 0.002     2 ms info\n',
    );
    expect(out).toContain('degraded: sync\n');
    expect(k.run(bootlog, ['bootlog', '-v']).out).toContain('[     0.060] storage: open\n');
    expect(JSON.parse(k.run(bootlog, ['bootlog', '--json']).out)).toMatchObject({ totalMs: 731 });
    expect(k.run(bootlog, ['bootlog', '--critical-path', '--boot', 'previous']).out).toContain(
      'boot · previous',
    );
  });

  it('BOOT-11 bootlog --list prints one line per stored boot, newest first (UI-135)', () => {
    const at = Date.UTC(2026, 8, 30, 5, 0);
    const boot = {
      profile: 'normal' as const,
      build: '7f28aa7',
      reachedLogin: true,
      current: false,
    };
    const k = kernel().on('bootlog', () => ({
      entries: [],
      totalMs: 0,
      boots: [
        { ...boot, seq: 38, at, outcome: 'interactive' as const, bootMs: 731, current: true },
        { ...boot, seq: 37, at, outcome: 'panic' as const, bootMs: null, reachedLogin: false },
        { ...boot, seq: 36, at, outcome: 'incomplete' as const, bootMs: null, profile: 'safe' },
      ],
    }));
    const r = k.run(bootlog, ['bootlog', '--list']);
    expect(r.status).toBe(0);
    expect(r.out.split('\n')).toEqual([
      '#38  2026-09-30 10:00  normal  0.73 s  ok  (this boot)',
      '#37  2026-09-30 10:00  normal       -  panic',
      '#36  2026-09-30 10:00  safe         -  at login',
      '',
    ]);
    expect(k.argsOf('bootlog')).toEqual([{ list: true }]);
    expect(JSON.parse(k.run(bootlog, ['bootlog', '--list', '--json']).out)).toHaveLength(3);
  });

  it('BOOT-11 bootlog --list says so when the kernel has no stored boots', () => {
    const k = kernel().on('bootlog', () => ({ entries: [], totalMs: 0 }));
    expect(k.run(bootlog, ['bootlog', '--list']).out).toBe('no stored boots\n');
  });

  it('BOOT-11 bootlog reports what the kernel cannot answer yet', () => {
    const k = kernel().on('bootlog', () => ({ entries: [], totalMs: 0 }));
    expect(k.run(bootlog, ['bootlog', '--critical-path']).out).toBe(
      'boot · current · 0.000 s to desktop-interactive\n',
    );
    expect(k.run(bootlog, ['bootlog', '--boot', '99']).status).toBe(2);
    expect(parseBoot('-1')).toBe('previous');
    expect(k.run(bootlog, ['bootlog', 'x']).status).toBe(2);
    k.fail('bootlog', 'ENOENT');
    expect(k.run(bootlog, ['bootlog', '--boot', 'previous']).err).toBe(
      'bootlog: no boot previous\n',
    );
    k.fail('bootlog', 'EIO');
    expect(k.run(bootlog, ['bootlog']).err).toBe('bootlog: Input/output error\n');
    expect(
      kernel()
        .on('bootlog', () => ({ ...LOG, criticalPath: ['ghost'] }))
        .run(bootlog, ['bootlog', '--critical-path']).out,
    ).toContain('svc    ghost       -');
  });
});

describe('fsck', () => {
  const CLEAN = {
    inodes: 12_408,
    orphans: 0,
    parentless: 0,
    unreachable: 0,
    nlinkErrors: 0,
    quotaDrift: 0,
    cycles: 0,
    danglingLinks: 0,
    durationMs: 410,
  };

  it('VFS-11 fsck -n reports a clean tree with the exact layout', () => {
    const r = kernel()
      .on('fsck', () => CLEAN)
      .run(fsck, ['fsck', '-n', '/home/demo']);
    expect(r.status).toBe(0);
    expect(r.out).toBe(
      'fsck: checked 12,408 inodes in 0.41 s\nfsck: unreachable 0 · wrong link counts 0 · directory cycles 0 · dangling dentries 0\nfsck: quota totals consistent\nfsck: clean\n',
    );
  });

  it('VFS-11 fsck finds problems with status 1 and -y repairs them', () => {
    const k = kernel().on('fsck', (a) =>
      a.repair === true
        ? { ...CLEAN, orphans: 1, quotaDrift: 1, repaired: 2 }
        : { ...CLEAN, orphans: 1, quotaDrift: 1 },
    );
    const r = k.run(fsck, ['fsck']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('fsck: quota totals differ for 1 users\n');
    expect(r.out).toContain('fsck: 2 problems found (run fsck -y as root to repair)\n');
    expect(k.run(fsck, ['fsck', '-y']).out).toContain('fsck: repaired 2 problems\n');
  });

  it('DB-02 fsck --checksum prints the tree checksum and --server the server one', () => {
    const k = kernel().on('fsck', () => ({
      ...CLEAN,
      inodes: 1000,
      checksum: 'a'.repeat(64),
      serverChecksum: 'b'.repeat(64),
    }));
    const out = k.run(fsck, ['fsck', '--checksum', '--server', '~/fixtures/tree1000']).out;
    expect(out).toContain(`sha256:${'a'.repeat(64)}  ~/fixtures/tree1000 (1,000 nodes)\n`);
    expect(out).toContain(`server sha256:${'b'.repeat(64)}\n`);
    expect(k.argsOf('fsck')).toEqual([{ repair: false, checksum: true, scope: 'both' }]);
  });

  it('VFS-11 fsck errors exit 2', () => {
    const k = kernel().fail('fsck', 'EPERM');
    expect(k.run(fsck, ['fsck', '-y'])).toMatchObject({
      status: 2,
      err: 'fsck: repair requires root\n',
    });
    k.fail('fsck', 'EAGAIN');
    expect(k.run(fsck, ['fsck', '--server']).err).toBe('fsck: --server needs a connection\n');
    k.fail('fsck', 'EIO');
    expect(k.run(fsck, ['fsck']).err).toBe('fsck: Input/output error\n');
    expect(k.run(fsck, ['fsck', '-n', '-y']).status).toBe(2);
    expect(k.run(fsck, ['fsck', 'a', 'b']).status).toBe(2);
  });
});

describe('lsof', () => {
  const PROCS = [
    { pid: 214, argv: ['editor'] },
    { pid: 198, argv: ['/bin/sh'] },
  ].map((p) => ({
    ppid: 1,
    pgid: p.pid,
    uid: 1001,
    user: 'alice',
    state: 'BLOCKED' as const,
    class: 'user' as const,
    waitingOn: null,
    priority: 20,
    nice: 0,
    effPrio: 20,
    cpuPct: 0,
    cpuTimeMs: 0,
    residentBytes: 0,
    swappedBytes: 0,
    faults: 0,
    hitRatio: 1,
    speculative: false,
    executor: 1,
    windows: [],
    startedAt: NOW,
    ...p,
  }));

  it('VFS-09 lsof shows open files, the TTY and lease holders with a countdown', () => {
    const k = kernel()
      .on('proc.list', () => ({ procs: PROCS }))
      .on('lsof', () => ({
        open: [
          { pid: 214, uid: 1001, fd: 3, path: '/home/shared/plan.md', flags: 'rw' },
          { pid: 198, uid: 1001, fd: 0, path: 'tty2', flags: 'rw' },
          { pid: 230, uid: 1001, fd: 3, path: 'pipe:[41]', flags: 'r' },
        ],
        leases: [
          {
            path: '/home/shared/plan.md',
            holder: 'alice@lab-pc-3',
            mode: 'X' as const,
            expiresAt: NOW + 12_000,
            scope: 'server' as const,
          },
          {
            path: '/home/shared/plan.md',
            holder: 'bob@lab-pc-4',
            mode: 'S' as const,
            expiresAt: NOW + 3_000,
            scope: 'server' as const,
          },
        ],
      }));
    const lines = k.run(lsof, ['lsof']).out.split('\n');
    expect(lines[0]).toMatch(/^COMMAND +PID +USER +FD +TYPE +MODE +NAME +LEASE$/);
    expect(lines[1]).toMatch(
      /^editor +214 +alice +3 +REG +rw +\/home\/shared\/plan\.md +X · expires in 12 s$/,
    );
    expect(lines[2]).toMatch(/^sh +198 +alice +0 +TTY +rw +tty2 +-$/);
    expect(lines[3]).toMatch(/^\? +230 .*PIPE/);
    expect(lines[4]).toMatch(
      /^- +- +bob +- +REG +- +\/home\/shared\/plan\.md +S · expires in 3 s$/,
    );
    expect(k.run(lsof, ['lsof', '-u', 'bob']).out.split('\n')).toHaveLength(3);
    expect(fileType('/x')).toBe('REG');
  });

  it('VFS-09 lsof reports a missing process or path', () => {
    const k = kernel().fail('lsof', 'ESRCH');
    expect(k.run(lsof, ['lsof', '-p', '999'])).toMatchObject({
      status: 1,
      err: 'lsof: 999: No such process\n',
    });
    k.fail('lsof', 'ENOENT');
    expect(k.run(lsof, ['lsof', '/nope']).err).toBe('lsof: /nope: No such file or directory\n');
    k.fail('lsof', 'EIO');
    expect(k.run(lsof, ['lsof']).err).toBe('lsof: Input/output error\n');
    expect(k.run(lsof, ['lsof', '-p', 'x']).status).toBe(2);
    expect(k.run(lsof, ['lsof', 'a', 'b']).status).toBe(2);
  });
});

describe('shutdown and reboot', () => {
  function world(): FakeKernel {
    return kernel()
      .on('shutdown', (a) => ({ scheduledAt: NOW + (a.delayMs ?? 0) }))
      .on('reboot', (a) => ({ scheduledAt: NOW + (a.delayMs ?? 0) }));
  }

  it('BOOT-12 shutdown -r now restarts at once and -h halts', () => {
    const k = world();
    expect(k.run(shutdown, ['shutdown', '-r', 'now'])).toMatchObject({ status: 0, out: '' });
    expect(k.argsOf('reboot')).toEqual([{ delayMs: 0 }]);
    k.run(shutdown, ['shutdown', '-h']);
    expect(k.argsOf('shutdown')).toEqual([{ delayMs: 0 }]);
  });

  it('BOOT-12 shutdown +MIN and HH:MM schedule it and print the notice', () => {
    const k = world();
    expect(k.run(shutdown, ['shutdown', '-r', '+5', 'maintenance']).out).toBe(
      'Plotinium is going down for reboot in 5 minutes: maintenance\n',
    );
    expect(k.argsOf('reboot')).toEqual([{ delayMs: 300_000 }]);
    expect(k.run(shutdown, ['shutdown', '10:42']).out).toBe(
      'Plotinium is going down for halt in 30 minutes\n',
    );
    expect(delayMs({ kind: 'at', hh: 10, mm: 0 }, NOW, 300)).toBe(86_400_000 - 12 * 60_000 - 5_123);
    expect(parseWhen('25:00')).toBeNull();
    expect(k.run(shutdown, ['shutdown', '+90']).err).toBe(
      'shutdown: the delay may be at most 60 minutes\n',
    );
  });

  it('BOOT-12 shutdown -c cancels and errors are reported', () => {
    const k = world().on('shutdown.cancel', () => ({}));
    expect(k.run(shutdown, ['shutdown', '-c']).status).toBe(0);
    k.fail('shutdown', 'EPERM');
    expect(k.run(shutdown, ['shutdown', 'now'])).toMatchObject({
      status: 1,
      err: 'shutdown: Operation not permitted\n',
    });
    expect(k.run(shutdown, ['shutdown', '-h', '-r']).status).toBe(2);
  });

  it('BOOT-06 reboot --menu sets the boot menu for the next boot', () => {
    const k = world();
    expect(k.run(reboot, ['reboot', '--menu']).status).toBe(0);
    expect(k.argsOf('reboot')).toEqual([{ menu: true }]);
    k.run(reboot, ['reboot', '--safe']);
    expect(k.argsOf('reboot')).toEqual([{ safe: true }]);
    expect(k.run(reboot, ['reboot', '--verbose']).err).toBe(
      'reboot: --verbose is not available yet; restarting without the verbose log\n',
    );
    k.fail('reboot', 'EBUSY');
    expect(k.run(reboot, ['reboot']).err).toBe('reboot: Resource busy\n');
    expect(k.run(reboot, ['reboot', 'x']).status).toBe(2);
  });
});

describe('help and man', () => {
  it('SYS-02 help prints the banner first and the groups, with the AI row only when installed', () => {
    const k = kernel().on('uname', () => UNAME);
    const plain = k.run(help, ['help']).out.split('\n');
    expect(plain[0]).toBe("Plotinium 0.3.0 shell — type 'man <command>'");
    expect(plain.some((l) => l.startsWith('AI:'))).toBe(false);
    k.fs.addFile('/bin/semsearch.json', '{}');
    expect(k.run(help, ['help']).out).toContain('AI:         ai semsearch predict\n');
    k.fail('uname', 'EIO');
    expect(k.run(help, ['help']).out.split('\n')[0]).toBe("Plotinium shell — type 'man <command>'");
  });

  it('SHL-18 help omits the AI row in the AI-off build', () => {
    expect(
      kernel()
        .on('uname', () => UNAME)
        .run(help, ['help']).out,
    ).not.toContain('semsearch');
  });

  it('SYS-02 help NAME prints a builtin synopsis or points to man', () => {
    const k = kernel();
    k.fs.addFile('/bin/ls.json', '{}');
    expect(k.run(help, ['help', 'cd']).out).toBe(
      'cd: cd [DIR | -]\n    Change the working directory to DIR (default $HOME); - returns to $OLDPWD and prints it.\n',
    );
    expect(k.run(help, ['help', 'ls']).out).toBe("ls is a program; see 'man ls'.\n");
    expect(k.run(help, ['help', 'nope'])).toMatchObject({
      status: 1,
      err: "help: no help topics match 'nope'\n",
    });
    expect(k.run(help, ['help', 'a', 'b']).status).toBe(2);
  });

  const PAGE =
    '---json\n{"name":"ls"}\n---\n# NAME\n\nls — list directory contents\n\n# OPTIONS\n\n- `-a` — all\n\n    ls -la ~\n\n```\ncode here\n```\n';
  const INDEX = JSON.stringify([
    { name: 'ls', section: 1, summary: 'list directory contents' },
    { name: 'unlink', section: 2, summary: 'remove a name' },
  ]);

  function manWorld(): FakeKernel {
    const k = kernel().on('uname', () => UNAME);
    k.fs.addFile('/usr/share/man/1/ls.md', PAGE);
    k.fs.addFile('/usr/share/man/2/unlink.md', '# NAME\n\nunlink — remove a name\n');
    k.fs.addFile('/usr/share/man/index.json', INDEX);
    return k;
  }

  it('SYS-02 man renders a page without its front matter and ends with the version', () => {
    const out = manWorld().run(man, ['man', 'ls']).out.split('\n');
    expect(out.slice(0, 3)).toEqual(['NAME', '    ls — list directory contents', '']);
    expect(splitKeys('a\x1b[Bq\x1b')).toEqual(['a', '\x1b[B', 'q', '\x1b']);
    expect(out).toContain('    • -a — all');
    expect(out).toContain('        ls -la ~');
    expect(out).toContain('        code here');
    expect(out.at(-2)).toBe(`${' '.repeat(65)}Plotinium 0.3.0`);
  });

  it('SYS-02 man SECTION, -k and -f use the index', () => {
    const k = manWorld();
    expect(k.run(man, ['man', '2', 'unlink']).out).toContain('unlink — remove a name');
    expect(k.run(man, ['man', 'unlink']).out).toContain('unlink — remove a name');
    expect(k.run(man, ['man', '-k', 'REMOVE']).out).toBe('unlink (2) - remove a name\n');
    expect(k.run(man, ['man', '-f', 'ls']).out).toBe('ls (1) - list directory contents\n');
    expect(k.run(man, ['man', '-k', 'zzz'])).toMatchObject({
      status: 1,
      err: 'man: zzz: nothing appropriate\n',
    });
    expect(parseIndex('{}')).toEqual([]);
    expect(apropos(parseIndex(INDEX), 'LIST')).toEqual(['ls (1) - list directory contents']);
  });

  it('SYS-02 man reports a missing page with status 1', () => {
    const k = manWorld();
    expect(k.run(man, ['man', 'foo'])).toMatchObject({
      status: 1,
      err: 'man: no manual entry for foo\n',
    });
    expect(k.run(man, ['man', '../x']).status).toBe(1);
    expect(k.run(man, ['man', '-f', 'foo']).err).toBe('man: no manual entry for foo\n');
    expect(k.run(man, ['man']).status).toBe(2);
    expect(k.run(man, ['man', '-k']).status).toBe(2);
    expect(k.run(man, ['man', 'a', 'b']).status).toBe(2);
    const bare = kernel();
    expect(bare.run(man, ['man', '-k', 'x']).status).toBe(1);
    bare.fs.addFile('/usr/share/man/index.json', 'not json');
    expect(bare.run(man, ['man', '-f', 'x']).status).toBe(1);
  });

  it('SYS-02 man on a terminal pages a long page and quits with q', () => {
    const k = manWorld();
    k.fs.addFile(
      '/usr/share/man/1/long.md',
      Array.from({ length: 60 }, (_, i) => `# H${i}\n\ntext ${i}\n`).join('\n'),
    );
    k.on('tty.getattr', () => ({
      n: 1,
      canonical: true,
      echo: true,
      isig: true,
      altScreen: false,
      cols: 80,
      rows: 24,
      fgPgid: 1,
      sid: 1,
    }));
    k.on('tty.setattr', () => ({
      n: 1,
      canonical: true,
      echo: true,
      isig: true,
      altScreen: false,
      cols: 80,
      rows: 24,
      fgPgid: 1,
      sid: 1,
    }));
    const r = k.run(man, ['man', 'long'], { tty: true, stdin: ' bjkgG/text 5\rnq' });
    expect(r.status).toBe(0);
    expect(k.argsOf('tty.setattr')).toEqual([
      { fd: 0, canonical: false, echo: false, altScreen: true },
      { fd: 0, canonical: true, echo: true, altScreen: false },
    ]);
    expect(r.out).toContain('(END)');
    expect(r.out).toContain('/text 5');
  });

  it('SYS-02 the pager keys and search follow the spec', () => {
    expect(keyAction('\x1b[6~')).toEqual({ k: 'page', by: 1 });
    expect(keyAction('\x1b[A')).toEqual({ k: 'move', by: -1 });
    expect(keyAction('x')).toEqual({ k: 'none' });
    expect(findLine(['a', '\x1b[1mNeedle\x1b[0m'], 'needle', 0)).toBe(1);
    expect(findLine(['a'], '', 0)).toBe(-1);
  });
});

describe('svcctl', () => {
  const SVC = {
    services: [
      { name: 'kernel', state: 'running' as const, critical: true, restarts: 0 },
      { name: 'sync', state: 'degraded' as const, critical: false, pid: 12, restarts: 3 },
    ],
  };

  function world(): FakeKernel {
    const k = kernel().on('svc.status', () => SVC);
    k.fs.addFile(
      '/system/services/sync.json',
      JSON.stringify({ name: 'sync', requires: ['storage'] }),
    );
    k.on('writeFile', (a) => {
      const n = k.fs.node(k.fs.resolve(a.path, '/', true).ino);
      n.data = new Uint8Array(a.data);
      n.version += 1;
      return {
        ino: n.ino,
        version: n.version,
        bytes: a.data.byteLength,
        opId: n.ino,
        sync: 'applied',
      };
    });
    return k;
  }

  it('BOOT-07 svcctl status lists state, criticality, attempts and pid', () => {
    const lines = world().run(svcctl, ['svcctl', 'status']).out.split('\n');
    expect(lines[0]).toBe('SERVICE  LEVEL  CRIT  STATE     ATTEMPTS  NEXT RETRY  PID');
    expect(lines[2]).toBe('sync         -  no    degraded         3  -            12');
    expect(world().run(svcctl, ['svcctl', 'status', 'nope'])).toMatchObject({
      status: 1,
      err: "svcctl: unknown service 'nope'\n",
    });
    expect(
      statusLines(
        [{ name: 'x', state: 'failed', critical: false, restarts: 1, level: 5, nextRetryAt: 9000 }],
        5000,
      )[1],
    ).toContain('in 4 s');
  });

  it('BOOT-04 svcctl require edits the manifest, and with --force keeps a cycle with a warning', () => {
    const k = world().on('svc.verify', () => ({
      ok: false,
      count: 18,
      edges: 30,
      levels: [],
      errors: [],
      cycle: ['sync', 'lockd', 'auth'],
    }));
    const r = k.run(svcctl, ['svcctl', 'require', 'sync', 'lockd', '--force']);
    expect(r).toMatchObject({
      status: 0,
      err: 'svcctl: warning: this creates a dependency cycle (sync → lockd → auth → sync); the next boot will stop at a kernel panic\n',
    });
    expect(JSON.parse(k.fs.text('/system/services/sync.json'))).toMatchObject({
      requires: ['storage', 'lockd'],
    });
  });

  it('BOOT-04 svcctl require without --force restores the manifest and refuses a cycle', () => {
    const k = world().on('svc.verify', () => ({
      ok: false,
      count: 18,
      edges: 30,
      levels: [],
      errors: [],
      cycle: ['sync', 'lockd'],
    }));
    const r = k.run(svcctl, ['svcctl', 'require', 'sync', 'lockd']);
    expect(r.status).toBe(1);
    expect(JSON.parse(k.fs.text('/system/services/sync.json'))).toMatchObject({
      requires: ['storage'],
    });
    k.on('svc.verify', () => ({
      ok: true,
      count: 18,
      edges: 30,
      levels: [['kernel'], ['storage', 'sync']],
      errors: [],
    }));
    expect(k.run(svcctl, ['svcctl', 'require', 'sync', 'lockd']).status).toBe(0);
    expect(k.run(svcctl, ['svcctl', 'unrequire', 'sync', 'lockd']).status).toBe(0);
    expect(JSON.parse(k.fs.text('/system/services/sync.json'))).toMatchObject({
      requires: ['storage'],
    });
    expect(k.run(svcctl, ['svcctl', 'graph']).out).toBe('L0 kernel\nL1 storage sync\n');
    expect(editRequires('{"name":"x"}', ['a'], true)).toContain('"requires": [\n    "a"\n  ]');
  });

  it('BOOT-04 svcctl require without svc.verify keeps the edit and says why it was not checked', () => {
    const k = world();
    expect(k.run(svcctl, ['svcctl', 'require', 'sync', 'lockd']).err).toBe(
      'svcctl: cannot verify the service graph: Function not implemented\n',
    );
    expect(k.run(svcctl, ['svcctl', 'require', 'nope', 'x']).err).toBe(
      "svcctl: unknown service 'nope'\n",
    );
  });

  it('BOOT-07 svcctl retry, start, stop, restart and restore-defaults', () => {
    const k = world()
      .on('svc.control', () => ({}))
      .on('svc.restart', () => ({}))
      .on('svc.restoreDefaults', () => ({ written: 18 }));
    expect(k.run(svcctl, ['svcctl', 'retry', 'sync']).status).toBe(0);
    expect(k.argsOf('svc.control')).toEqual([{ name: 'sync', action: 'retry' }]);
    expect(k.run(svcctl, ['svcctl', 'restart', 'sync']).status).toBe(0);
    expect(k.run(svcctl, ['svcctl', 'start', 'sync']).status).toBe(0);
    expect(k.run(svcctl, ['svcctl', 'stop', 'kernel'])).toMatchObject({
      status: 1,
      err: 'svcctl: stopping a critical service is not allowed\n',
    });
    expect(k.run(svcctl, ['svcctl', 'stop', 'sync']).status).toBe(0);
    expect(k.run(svcctl, ['svcctl', 'defaults']).out).toBe(
      'svcctl: restored 18 default manifests (takes effect at the next boot)\n',
    );
    k.fail('svc.restart', 'EPERM');
    expect(k.run(svcctl, ['svcctl', 'restart', 'sync']).err).toBe(
      'svcctl: Operation not permitted\n',
    );
    k.fail('svc.control', 'ENOENT');
    expect(k.run(svcctl, ['svcctl', 'retry', 'x']).err).toBe("svcctl: unknown service 'x'\n");
    expect(() => parseSvcctl([])).toThrow();
    expect(() => parseSvcctl(['bogus'])).toThrow();
    expect(() => parseSvcctl(['retry'])).toThrow();
    expect(() => parseSvcctl(['require', 'a'])).toThrow();
  });
});

describe('swapctl and debug', () => {
  it('MEM-04 swapctl status prints the tiers, or the byte counts when swap.stat is missing', () => {
    const k = kernel().on('swap.stat', () => ({
      device: 'OPFS',
      fallback: 'IndexedDB plotinium-swap (unused)',
      policy: 'auto' as const,
      local: { bytes: 851_443_712, pages: 163 },
      remote: { bytes: 843_366_400, pages: 161 },
      queue: { pages: 2, bytes: 10_485_760 },
    }));
    expect(k.run(swapctl, ['swapctl']).out).toBe(
      'tier: auto   device: OPFS   fallback: IndexedDB plotinium-swap (unused)   uid: 1001\nlocal:  812.0M (163 pages)\nremote: 804.3M (161 pages acked, 2 pending)\n',
    );
    const bare = kernel().on('statfs', () => ({
      fsId: 'plotinium' as const,
      usageBytes: 0,
      quotaBytes: null,
      inodes: 0,
      persisted: true,
      swapBytes: { local: 1024, remote: 0 },
    }));
    expect(bare.run(swapctl, ['swapctl', 'status']).out).toBe(
      'local:  1.0K\nremote: 0B\ntier and device: unavailable (swap.stat not implemented)\n',
    );
  });

  it('MEM-05 swapctl bench reports p95 against the budget and passes or fails', () => {
    const k = kernel().on('swap.bench', (a: { tier: 'local' | 'remote' }) => ({
      p95Ms: a.tier === 'local' ? 41 : 2500,
      p50Ms: 20,
      tier: a.tier,
    }));
    expect(k.run(swapctl, ['swapctl', 'bench'])).toMatchObject({
      status: 0,
      out: 'MEM-05 local p95 41 ms (≤ 300 ms) PASS\n',
    });
    expect(
      k.run(swapctl, ['swapctl', 'bench', '--tier', 'remote', '--size', '5M', '-n', '3']),
    ).toMatchObject({ status: 1, out: 'MEM-05 remote p95 2500 ms (≤ 2 s) FAIL\n' });
    expect(k.argsOf('swap.bench')).toEqual([{ size: 5_242_880, tier: 'remote', n: 3 }]);
    expect(benchLine('remote', 2000).pass).toBe(true);
    expect(parseSize('512K')).toBe(524_288);
    expect(parseSize('x')).toBeNull();
  });

  it('MEM-05 swapctl tier, drop-local and checkpoint', () => {
    const k = kernel()
      .on('swap.ctl', () => ({ dropped: 4 }))
      .on('swap.checkpoint', () => ({ bytes: 1_048_576 }));
    expect(k.run(swapctl, ['swapctl', 'tier', 'remote']).out).toBe(
      'swapctl: tier policy is now remote\n',
    );
    expect(k.run(swapctl, ['swapctl', '--tier', 'auto']).out).toBe(
      'swapctl: tier policy is now auto\n',
    );
    expect(k.run(swapctl, ['swapctl', 'drop-local', '5']).out).toBe(
      'swapctl: dropped 4 local copies\n',
    );
    expect(k.argsOf('swap.ctl')).toEqual([{ dropLocal: true, pid: 5 }]);
    expect(k.run(swapctl, ['swapctl', 'checkpoint', '5']).out).toBe(
      'swapctl: checkpointed 5 (1.0M)\n',
    );
    k.fail('swap.ctl', 'EAGAIN');
    expect(k.run(swapctl, ['swapctl', 'tier', 'remote']).err).toBe(
      'swapctl: remote tier needs a connection\n',
    );
    k.fail('swap.ctl', 'EACCES');
    expect(k.run(swapctl, ['swapctl', 'drop-local']).err).toBe('swapctl: Permission denied\n');
    for (const bad of [
      ['tier', 'x'],
      ['checkpoint'],
      ['bogus'],
      ['bench', '--size', 'q'],
      ['bench', '-n', '0'],
      ['bench', '--tier', 'auto'],
      ['a', 'b', 'c'],
    ]) {
      expect(() => parseSwapctl(bad)).toThrow();
    }
  });

  it('DB-02 debug inject arms a one-shot fault with the target', () => {
    const k = kernel().on('debug.inject', () => ({
      armed: true as const,
      faultId: '0192f0c1-7c2e-7a51-9d6f-000000000001',
    }));
    expect(k.run(debug, ['debug', 'inject', 'rm', '500', '--target', 'both']).out).toBe(
      'debug: armed rm fault at node 500 (target both, one-shot)\n',
    );
    expect(k.argsOf('debug.inject')).toEqual([{ target: 'both', op: 'unlink', after: 500 }]);
    expect(k.run(debug, ['debug', 'inject', 'cp', '5']).out).toContain('(target both, one-shot)');
  });

  it('AGT-09 debug delay, status and clear', () => {
    const k = kernel()
      .on('debug.delay', () => ({ armed: true as const }))
      .on('debug.status', () => ({ armed: [{ op: 'unlink', after: 500, target: 'both' }] }))
      .on('debug.clear', () => ({ cleared: 1 }));
    expect(k.run(debug, ['debug', 'delay', '3000']).out).toBe(
      'debug: armed a 3000 ms delay for the next agent batch (one-shot)\n',
    );
    expect(k.run(debug, ['debug', 'status']).out).toBe('armed: unlink at node 500 (target both)\n');
    expect(k.run(debug, ['debug', 'clear']).out).toBe('debug: cleared 1\n');
    k.on('debug.status', () => ({ armed: [] }));
    expect(k.run(debug, ['debug', 'status']).out).toBe('debug: nothing armed\n');
  });

  it('DB-02 debug refuses non-root, a disabled server and unknown operations', () => {
    const k = kernel().fail('debug.inject', 'EPERM');
    expect(k.run(debug, ['debug', 'inject', 'rm', '5'])).toMatchObject({
      status: 1,
      err: 'debug: Operation not permitted\n',
    });
    k.fail('debug.inject', 'EPERM', { detail: { reason: 'disabled' } });
    expect(k.run(debug, ['debug', 'inject', 'rm', '5']).err).toBe(
      'debug: fault injection is disabled on this server\n',
    );
    expect(k.run(debug, ['debug', 'inject', 'dd', '5'])).toMatchObject({
      status: 2,
      err: "debug: unknown operation 'dd'\n",
    });
    for (const bad of [
      [],
      ['x'],
      ['inject'],
      ['inject', 'rm'],
      ['inject', 'rm', '5', '--target', 'moon'],
      ['delay', '0'],
      ['a', 'b', 'c', 'd'],
    ]) {
      expect(() => parseDebug(bad)).toThrow();
    }
  });
});
