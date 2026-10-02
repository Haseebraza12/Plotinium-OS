import { describe, expect, it } from 'vitest';

import echo, { interpretEscapes, parseEcho } from '../cmd/echo.ts';
import id from '../cmd/id.ts';
import pwd from '../cmd/pwd.ts';
import uname from '../cmd/uname.ts';
import uptime from '../cmd/uptime.ts';
import whoami from '../cmd/whoami.ts';
import { SysError } from '../lib/sys.ts';
import { kernel } from './harness.ts';

const INFO = {
  sysname: 'Plotinium' as const,
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-11-02',
  codename: 'Orthorhombic',
  browser: { brand: 'Chrome' as const, major: 154 },
  cores: 8,
  uid: 1001,
  user: 'alice',
};

const CRED = {
  uid: 1001,
  gid: 1001,
  groups: [1001, 100, 1002],
  user: 'alice',
  groupNames: ['alice', 'users', 'team'],
  home: '/home/alice',
  ruid: 1001,
};

describe('echo', () => {
  it('SYS-02 echo joins its arguments with single spaces and ends with a newline', () => {
    const r = kernel().run(echo, ['echo', 'home', 'is', '/home/alice']);
    expect(r).toMatchObject({ status: 0, out: 'home is /home/alice\n', err: '' });
  });

  it('SYS-02 echo -n omits the newline and -e interprets escapes', () => {
    expect(kernel().run(echo, ['echo', '-n', 'x']).out).toBe('x');
    expect(kernel().run(echo, ['echo', '-ne', 'a\\tb\\n']).out).toBe('a\tb\n');
    expect(interpretEscapes('\\0101\\e\\a\\\\\\q')).toBe('A\x1b\x07\\\\q');
  });

  it('SYS-02 echo treats unknown dashes and --help as words', () => {
    expect(parseEcho(['-x', 'y']).words).toEqual(['-x', 'y']);
    expect(kernel().run(echo, ['echo', '--help']).out).toBe('--help\n');
  });

  it('SYS-02 echo reports a write error with the errno text and exits 1', () => {
    const k = kernel();
    k.on('write', (a) => {
      if (a.fd === 1) throw new SysError('EBADF');
      k.err += new TextDecoder().decode(a.data);
      return { bytes: a.data.byteLength };
    });
    const r = k.run(echo, ['echo', 'x']);
    expect(r).toMatchObject({ status: 1, err: 'echo: write error: Bad file descriptor\n' });
    expect(kernel().fail('write', 'EBADF').run(echo, ['echo', 'x']).status).toBe(1);
  });

  it('SHL-07 echo into a closed pipe ends quietly with 141', () => {
    const r = kernel().fail('write', 'EPIPE').run(echo, ['echo', 'x']);
    expect(r).toMatchObject({ status: 141, err: '' });
  });
});

describe('pwd', () => {
  it('SYS-02 pwd prints the kernel working directory', () => {
    expect(kernel().run(pwd, ['pwd'])).toMatchObject({ status: 0, out: '/home/alice\n' });
  });

  it('SYS-02 pwd -L prints $PWD when it names the same directory', () => {
    const k = kernel();
    k.fs.addLink('/home/alice/here', '/home/alice');
    const r = k.run(pwd, ['pwd', '-L'], { env: { PWD: '/home/alice/here' } });
    expect(r.out).toBe('/home/alice/here\n');
    expect(k.run(pwd, ['pwd', '-L', '-P'], { env: { PWD: '/home/alice/here' } }).out).toBe(
      '/home/alice\n',
    );
    expect(k.run(pwd, ['pwd', '-L'], { env: { PWD: '/nowhere' } }).out).toBe('/home/alice\n');
  });

  it('SYS-02 pwd reports a deleted working directory', () => {
    const r = kernel().fail('getcwd', 'ENOENT').run(pwd, ['pwd']);
    expect(r).toMatchObject({
      status: 1,
      err: 'pwd: cannot determine current directory: No such file or directory\n',
    });
  });
});

describe('whoami and id', () => {
  it('SYS-02 whoami prints the effective user name', () => {
    const k = kernel().on('proc.cred', () => CRED);
    expect(k.run(whoami, ['whoami']).out).toBe('alice\n');
  });

  it('SYS-02 whoami prints root inside su', () => {
    const k = kernel().on('proc.cred', () => ({
      ...CRED,
      uid: 0,
      user: 'root',
      gid: 0,
      groups: [0],
    }));
    expect(k.run(whoami, ['whoami']).out).toBe('root\n');
  });

  it('SYS-02 whoami rejects an operand with a usage error', () => {
    const r = kernel().run(whoami, ['whoami', 'x']);
    expect(r.status).toBe(2);
    expect(r.err).toBe("whoami: extra operand 'x'\nUsage: whoami\nTry 'man whoami'.\n");
  });

  it('SYS-02 id prints uid, gid and groups with names', () => {
    const k = kernel().on('proc.cred', () => CRED);
    expect(k.run(id, ['id']).out).toBe(
      'uid=1001(alice) gid=1001(alice) groups=1001(alice),100(users),1002(team)\n',
    );
  });

  it('SYS-02 id -Gn, -u and -gn print only the selected ids', () => {
    const k = kernel().on('proc.cred', () => CRED);
    expect(k.run(id, ['id', '-Gn']).out).toBe('alice users team\n');
    expect(k.run(id, ['id', '-u']).out).toBe('1001\n');
    expect(k.run(id, ['id', '-gn']).out).toBe('alice\n');
    expect(k.run(id, ['id', '-un', 'bob']).out).toBe('bob\n');
  });

  it('SYS-02 id reports an unknown user and rejects conflicting options', () => {
    const k = kernel();
    expect(k.run(id, ['id', 'bob2'])).toMatchObject({
      status: 1,
      err: "id: 'bob2': no such user\n",
    });
    expect(k.run(id, ['id', '-u', '-g']).status).toBe(2);
    expect(k.run(id, ['id', '-n']).status).toBe(2);
  });
});

describe('uname', () => {
  it('PLT-ID-07 uname -a prints the identity line exactly', () => {
    const k = kernel().on('uname', () => INFO);
    expect(k.run(uname, ['uname', '-a']).out).toBe(
      'Plotinium 0.3.0 (kernel 0.3.0-a1f93c2, built 2026-11-02) · Chrome 154 · 8 cores · uid=1001(alice)\n',
    );
  });

  it('PLT-ID-07 uname prints each field and combined options in the order s r v m', () => {
    const k = kernel().on('uname', () => INFO);
    expect(k.run(uname, ['uname']).out).toBe('Plotinium\n');
    expect(k.run(uname, ['uname', '-r']).out).toBe('0.3.0-a1f93c2\n');
    expect(k.run(uname, ['uname', '-v']).out).toBe('built 2026-11-02\n');
    expect(k.run(uname, ['uname', '-m']).out).toBe('Chrome 154 · 8 cores\n');
    expect(k.run(uname, ['uname', '-rs']).out).toBe('Plotinium 0.3.0-a1f93c2\n');
  });

  it('PLT-ID-07 uname prints Unknown browser and 1 core', () => {
    const k = kernel().on('uname', () => ({
      ...INFO,
      browser: { brand: 'Unknown browser' as const, major: null },
      cores: 1,
    }));
    expect(k.run(uname, ['uname', '-m']).out).toBe('Unknown browser · 1 core\n');
  });

  it('PLT-ID-07 uname with an unknown option exits 2 without a syscall', () => {
    const k = kernel();
    const r = k.run(uname, ['uname', '-x']);
    expect(r.status).toBe(2);
    expect(r.err.split('\n')[0]).toBe("uname: invalid option -- 'x'");
    expect(r.calls.map((c) => c.call)).toEqual(['write']);
  });
});

describe('uptime', () => {
  const UP = {
    bootAt: Date.UTC(2026, 10, 14, 5, 0, 3),
    uptimeMs: 12 * 60_000,
    users: 1,
    load: [0.42, 0.3, 0.12] as [number, number, number],
  };

  it('SYS-02 uptime prints the time, the uptime, the users and the load averages', () => {
    const k = kernel().on('uptime', () => UP);
    expect(k.run(uptime, ['uptime']).out).toBe(
      ' 10:12:05 up 12 min,  1 user,  load average: 0.42, 0.30, 0.12\n',
    );
  });

  it('SYS-02 uptime -p and -s print the pretty uptime and the boot time', () => {
    const k = kernel().on('uptime', () => UP);
    expect(k.run(uptime, ['uptime', '-p']).out).toBe('up 12 minutes\n');
    expect(k.run(uptime, ['uptime', '-s']).out).toBe('2026-11-14 10:00:03\n');
  });

  it('SYS-02 uptime reports a failed call', () => {
    const k = kernel().on('uptime', () => {
      throw new SysError('ENOSYS');
    });
    expect(k.run(uptime, ['uptime'])).toMatchObject({
      status: 1,
      err: 'uptime: Function not implemented\n',
    });
  });
});
