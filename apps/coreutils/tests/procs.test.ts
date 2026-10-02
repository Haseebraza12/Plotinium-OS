import { describe, expect, it } from 'vitest';

import free from '../cmd/free.ts';
import kill, { parseKill } from '../cmd/kill.ts';
import nice, { clampNice } from '../cmd/nice.ts';
import pmap, { pageFlags } from '../cmd/pmap.ts';
import ps, { parsePs, select } from '../cmd/ps.ts';
import renice, { parseRenice } from '../cmd/renice.ts';
import top, { withIntervalCpu } from '../cmd/top.ts';
import vmstat, { parseVmstat } from '../cmd/vmstat.ts';
import type { ProcRow } from '../lib/procs.ts';
import { cls, FIELDS, fieldName, renderTable, statCode } from '../lib/procs.ts';
import { SysError } from '../lib/sys.ts';
import type { FakeKernel } from './harness.ts';
import { kernel } from './harness.ts';

const NOW = Date.UTC(2026, 10, 14, 5, 12, 5, 123);

function proc(over: Partial<ProcRow>): ProcRow {
  return {
    pid: 203,
    ppid: 1,
    pgid: 203,
    uid: 1001,
    user: 'alice',
    state: 'BLOCKED',
    class: 'user',
    waitingOn: 'tty:input',
    priority: 20,
    nice: 0,
    effPrio: 20,
    cpuPct: 0.5,
    cpuTimeMs: 140,
    residentBytes: 84_172,
    swappedBytes: 0,
    faults: 0,
    hitRatio: 1,
    speculative: false,
    argv: ['sh'],
    executor: 1,
    windows: [],
    startedAt: NOW - 60_000,
    ...over,
  };
}

const ROWS: ProcRow[] = [
  proc({
    pid: 1,
    ppid: 0,
    pgid: 1,
    uid: 0,
    user: 'root',
    class: 'system',
    executor: null,
    argv: ['init'],
    kind: 'kthread',
    sid: 1,
    tty: null,
    leader: true,
  }),
  proc({ pid: 203, sid: 200, tty: 1, leader: true }),
  proc({
    pid: 415,
    ppid: 203,
    pgid: 415,
    state: 'RUNNING',
    waitingOn: null,
    argv: ['ps', '-e'],
    cpuTimeMs: 10,
    sid: 200,
    tty: 1,
    fg: true,
  }),
  proc({
    pid: 322,
    uid: 1001,
    state: 'READY',
    priority: 22,
    nice: 10,
    effPrio: 31,
    cpuPct: 1.8,
    argv: ['ai.indexer'],
    sid: 322,
    tty: null,
    residentBytes: 2_202_009,
  }),
  proc({
    pid: 501,
    uid: 1002,
    user: 'bob',
    state: 'SUSPENDED',
    argv: ['burn', '--ms', '120000'],
    cpuPct: 33.1,
    cpuTimeMs: 39_720,
    sid: 500,
    tty: 2,
  }),
];

const MEM = {
  budget: 256 * 1_048_576,
  accounted: 196_502_323,
  reservedWaiting: 14_575_206,
  resident: 150_000_000,
  swappedLocal: 432_013_312,
  swappedRemote: 408_944_640,
  speculative: 9_542_041,
  embed: { bytes: 0, state: 'absent' as const },
  kernel: 9_437_184,
  faults: 1204,
  faultsPerSec: 4,
  hitRatio: 0.974,
  bytesIn: 40_000_000,
  bytesOut: 432_000_000,
  procs: [
    {
      pid: 203,
      accounted: 84_172,
      resident: 84_172,
      swapped: 0,
      faults: 12,
      hitRatio: 0.974,
      softLimit: 67_108_864,
    },
  ],
};

const UP = {
  bootAt: NOW - 871_000,
  uptimeMs: 871_000,
  users: 2,
  load: [2.31, 1.87, 1.02] as [number, number, number],
};

function world(): FakeKernel {
  return kernel()
    .on('proc.list', () => ({ procs: ROWS }))
    .on('mem.stat', () => MEM)
    .on('uptime', () => UP)
    .on('sleep', (a) => ({ sleptMs: a.ms }));
}

describe('ps', () => {
  it('PROC-08 ps lists the caller processes on the caller terminal with PID TTY STAT TIME COMMAND', () => {
    const r = world().run(ps, ['ps'], { tty: true });
    expect(r.out).toBe(
      '  PID TTY   STAT    TIME COMMAND\n  203 tty1  BLKs 0:00.14 sh\n  415 tty1  RUN+ 0:00.01 ps\n',
    );
  });

  it('PROC-08 ps -e -o pid,stat,cmd lists every process with the chosen fields', () => {
    const lines = world().run(ps, ['ps', '-e', '-o', 'pid,stat,cmd']).out.trimEnd().split('\n');
    expect(lines[0]).toBe('  PID STAT COMMAND');
    expect(lines[1]).toBe('    1 BLKs [init]');
    expect(lines.at(-1)).toBe('  501 SUS  burn --ms 120000');
    expect(lines).toHaveLength(6);
  });

  it('PROC-08 ps -ef --sort=-pcpu shows the full format sorted by CPU', () => {
    const lines = world().run(ps, ['ps', '-ef', '--sort=-pcpu']).out.split('\n');
    expect(lines[0]).toBe(
      '  UID   PID  PPID  PGID   SID PRI  NI CLS STAT  %CPU    RSS   SWAP TTY      TIME COMMAND',
    );
    expect(lines[1]).toMatch(/^ 1002 +501 .* nor SUS +33\.1 .*burn --ms 120000$/);
    expect(lines[2]).toContain(' 32  10 bkg RDYN   1.8   2.1M     0B ?     0:00.14 ai.indexer');
  });

  it('PROC-08 ps -l adds the effective priority and what a process waits on', () => {
    const lines = world().run(ps, ['ps', '-l', '-p', '203']).out.split('\n');
    expect(lines[0]).toBe(
      'STAT   UID   PID  PPID CLS PRI  NI  EP    RSS   SWAP WCHAN     TTY      TIME COMMAND',
    );
    expect(lines[1]).toContain('tty:input');
  });

  it('PROC-08 ps selects by user, pid and terminal, and can drop the header or print JSON', () => {
    const k = world();
    expect(k.run(ps, ['ps', '-u', 'bob', '--no-headers', '-o', 'pid']).out).toBe('  501\n');
    expect(k.run(ps, ['ps', '-p', '1,322', '-o', 'pid', '--no-headers']).out).toBe(
      '    1\n  322\n',
    );
    expect(k.run(ps, ['ps', '-t', 'tty2', '-o', 'comm', '--no-headers']).out).toBe('burn\n');
    const json = JSON.parse(k.run(ps, ['ps', '-p', '203', '--json']).out) as { pid: number }[];
    expect(json.map((p) => p.pid)).toEqual([203]);
  });

  it('PROC-08 ps without a terminal field falls back to the caller uid and session', () => {
    const rows = [proc({ pid: 7 }), proc({ pid: 8, uid: 1002 }), proc({ pid: 9, sid: 999 })];
    const opts = parsePs([]);
    expect(select(rows, opts, [], { uid: 1001, sid: 999, tty: null }).map((r) => r.pid)).toEqual([
      7, 9,
    ]);
  });

  it('PROC-08 ps reports an unknown field with 2 and an unknown user with 1', () => {
    const k = world();
    expect(k.run(ps, ['ps', '-o', 'pid,foo'])).toMatchObject({
      status: 2,
      err: "ps: unknown field 'foo'\n",
    });
    expect(k.run(ps, ['ps', '--sort', 'bar']).err).toBe("ps: unknown field 'bar'\n");
    expect(k.run(ps, ['ps', '-u', 'x'])).toMatchObject({
      status: 1,
      err: "ps: no such user 'x'\n",
    });
    expect(k.run(ps, ['ps', '-p', 'abc']).status).toBe(2);
    expect(k.run(ps, ['ps', '-t', 'ttyX']).status).toBe(2);
    expect(k.run(ps, ['ps', 'aux']).status).toBe(2);
    k.fail('proc.list', 'EIO');
    expect(k.run(ps, ['ps', '-e']).status).toBe(1);
  });

  it('PROC-08 the process fields follow the kernel definitions', () => {
    expect(
      statCode(
        proc({
          state: 'BLOCKED',
          stopped: true,
          boosted: true,
          exclusive: true,
          overSoftLimit: true,
          pinned: true,
        }),
      ),
    ).toBe('STP<X!P');
    expect(statCode(proc({ state: 'TERMINATED' }))).toBe('ZMB');
    expect(cls(proc({ priority: 3 }))).toBe('int');
    expect(cls(proc({ kind: 'special' }))).toBe('spc');
    expect(fieldName('CMD')).toBe('args');
    expect(fieldName('nope')).toBeUndefined();
    const env = { now: NOW, tz: 300 };
    const row = proc({ exit: '137 killed', overruns: 2 });
    expect(FIELDS.etime?.text(row, env)).toBe('0:01:00');
    expect(FIELDS.stime?.text(row, env)).toBe('10:11');
    expect(FIELDS.hit?.text(row, env)).toBe('100.0');
    expect(FIELDS.ovr?.text(row, env)).toBe('2');
    expect(FIELDS.sid?.text(proc({}), env)).toBe('-');
    expect(FIELDS.exe?.text(proc({ state: 'SUSPENDED' }), env)).toBe('-');
    expect(renderTable([row], ['exit', 'state'], env, { headers: false })).toEqual([
      '137 killed BLOCKED',
    ]);
  });
});

describe('top', () => {
  it('PROC-08 top -b -n 1 prints the summary lines and the process table', () => {
    const lines = world().run(top, ['top', '-b', '-n', '1']).out.split('\n');
    expect(lines[0]).toBe('top - 10:12:05 up 0:14:31,  2 users,  load average: 2.31, 1.87, 1.02');
    expect(lines[1]).toBe(
      'Tasks:   5 total,   1 running,   1 ready,   2 blocked,   1 suspended,   0 zombie',
    );
    expect(lines[2]).toBe('Memory: see free; faults 4/s, hit 97.4%');
    expect(lines[3]).toBe(
      'Mem:  256.0M total, 187.4M used, 13.9M rsv, 54.7M free   Swap: L 412.0M  R 390.0M',
    );
    expect(lines[5]).toMatch(
      /^ +PID USER +PRI +NI +EP CLS STAT +%CPU +RES +SWAP +FLT EXE +TIME\+ COMMAND$/,
    );
    expect(lines[6]).toContain('burn --ms 120000');
  });

  it('PROC-05 top computes %CPU over the last interval from the second frame on', () => {
    const k = world();
    let calls = 0;
    k.on('proc.list', () => {
      calls += 1;
      const extra = calls > 1 ? 500 : 0;
      return {
        procs: ROWS.map((r) => (r.pid === 501 ? { ...r, cpuTimeMs: r.cpuTimeMs + extra } : r)),
      };
    });
    k.on('sleep', (a) => {
      k.fs.clock += a.ms;
      return { sleptMs: a.ms };
    });
    const r = k.run(top, ['top', '-b', '-n', '2', '-d', '1', '-p', '501']);
    const frames = r.out.split('\n\n');
    expect(frames).toHaveLength(4);
    expect(r.out).toMatch(/ 50\.0 /);
    expect(withIntervalCpu([proc({ cpuTimeMs: 100 })], new Map([[203, 50]]), 0)[0]?.cpuPct).toBe(
      0.5,
    );
  });

  it('PROC-08 top -u filters by user, -o sorts, --json prints one line per frame', () => {
    const k = world();
    const out = k.run(top, ['top', '-b', '-n', '1', '-u', 'bob']).out;
    expect(out).toContain('burn');
    expect(out).not.toContain('ai.indexer');
    const json = k.run(top, ['top', '--json', '-n', '1', '-o', 'rss']).out.trim().split('\n');
    expect(json).toHaveLength(1);
    expect(k.run(top, ['top', '-b', '-u', 'nobody']).status).toBe(1);
  });

  it('PROC-08 top on a terminal uses the alternate screen and restores it on SIGINT', () => {
    const k = world();
    const r = k.run(top, ['top'], { tty: true, signals: ['SIGINT'] });
    expect(r.status).toBe(0);
    expect(r.out.startsWith('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J')).toBe(true);
    expect(r.out.endsWith('\x1b[?25h\x1b[?1049l')).toBe(true);
    // SIGINT, SIGTERM, SIGHUP, SIGWINCH and SIGCHLD (the frame timer, UI-120).
    expect(k.argsOf('sig.action')).toHaveLength(5);
  });

  it('UI-119 the header shows the wall-clock time of day, not the executor’s monotonic clock', () => {
    const k = world();
    // The monotonic clock is small (seconds since the executor started); time.now is the epoch.
    k.on('time.now', () => ({
      epochMs: Date.UTC(2026, 8, 27, 4, 55, 4),
      monotonicMs: 1000,
      tz: 'Asia/Karachi',
      tzOffsetMin: 300,
    }));
    const lines = k.run(top, ['top', '-b', '-n', '1']).out.split('\n');
    expect(lines[0]).toMatch(/^top - 09:55:04 up /);
  });

  it('PROC-08 top stops on SIGTERM delivered during the sleep and rejects bad options', () => {
    const k = world();
    k.on('sleep', () => {
      throw new SysError('ECANCELED');
    });
    expect(k.run(top, ['top', '-b'], { signals: ['SIGTERM'] }).status).toBe(0);
    expect(k.run(top, ['top', '-d', '0.1']).status).toBe(2);
    expect(k.run(top, ['top', '-n', '0']).status).toBe(2);
    expect(k.run(top, ['top', '-o', 'nope']).status).toBe(2);
    expect(k.run(top, ['top', '-p', 'x']).status).toBe(2);
    expect(k.run(top, ['top', 'extra']).status).toBe(2);
    k.fail('mem.stat', 'ENOSYS');
    expect(k.run(top, ['top', '-b', '-n', '1']).out).toContain('Mem:  unavailable');
    k.fail('uptime', 'EIO');
    expect(k.run(top, ['top', '-b', '-n', '1']).status).toBe(1);
  });
});

describe('kill', () => {
  it('PROC-07 kill sends SIGTERM by default and signal names, numbers and groups', () => {
    const k = kernel().on('kill', () => ({ delivered: 1 }));
    expect(k.run(kill, ['kill', '312']).status).toBe(0);
    k.run(kill, ['kill', '-9', '312']);
    k.run(kill, ['kill', '-TERM', '-312']);
    k.run(kill, ['kill', '-s', 'hup', '5']);
    k.run(kill, ['kill', '-n', '19', '5']);
    k.run(kill, ['kill', '--', '-312']);
    expect(k.argsOf('kill')).toEqual([{ pid: -312, sig: 'SIGTERM' }]);
    expect(parseKill(['-9', '312'])).toEqual({ mode: 'send', sig: 'SIGKILL', targets: ['312'] });
    expect(parseKill(['-TERM', '-312'])).toEqual({
      mode: 'send',
      sig: 'SIGTERM',
      targets: ['-312'],
    });
    expect(parseKill(['-s', 'hup', '5'])).toEqual({ mode: 'send', sig: 'SIGHUP', targets: ['5'] });
    expect(parseKill(['-n', '19', '5'])).toEqual({ mode: 'send', sig: 'SIGSTOP', targets: ['5'] });
    expect(parseKill(['-0', '5'])).toEqual({ mode: 'send', sig: 0, targets: ['5'] });
  });

  it('PROC-08 kill -l lists the signals and translates numbers and exit statuses', () => {
    const k = kernel();
    expect(k.run(kill, ['kill', '-l']).out).toBe(
      '1) SIGHUP  2) SIGINT  3) SIGQUIT  9) SIGKILL  13) SIGPIPE  15) SIGTERM  17) SIGCHLD  18) SIGCONT  19) SIGSTOP  20) SIGTSTP  21) SIGTTIN  22) SIGTTOU  28) SIGWINCH\n',
    );
    expect(k.run(kill, ['kill', '-l', '137']).out).toBe('KILL\n');
    expect(k.run(kill, ['kill', '-l', 'TERM']).out).toBe('15\n');
    expect(k.run(kill, ['kill', '-l', '99']).status).toBe(2);
  });

  it('PROC-07 kill reports ESRCH and EPERM per target, invalid signals with 2 and jobs as unknown', () => {
    const k = kernel().on('kill', (a) => {
      if (a.pid === 999) throw new SysError('ESRCH');
      if (a.pid === 1) throw new SysError('EPERM');
      return { delivered: 1 };
    });
    const r = k.run(kill, ['kill', '999', '1', '5', '%1', 'x']);
    expect(r.status).toBe(1);
    expect(r.err).toBe(
      "kill: (999) - No such process\nkill: (1) - Operation not permitted\nkill: %1: no such job\nkill: failed to parse argument: 'x'\n",
    );
    expect(k.run(kill, ['kill', '-FOO', '1'])).toMatchObject({
      status: 2,
      err: "kill: invalid signal 'FOO'\n",
    });
    expect(k.run(kill, ['kill', '-s', 'BAR', '1']).status).toBe(2);
    expect(k.run(kill, ['kill']).status).toBe(2);
    expect(k.run(kill, ['kill', '-s']).status).toBe(2);
  });
});

describe('nice and renice', () => {
  function niceWorld(): FakeKernel {
    const k = kernel();
    k.fs.addFile('/bin/sleep.json', '{}');
    return k
      .on('getpriority', () => ({ priority: 20, nice: 0, effPrio: 20, band: 'normal' as const }))
      .on('spawn', () => ({ pid: 777 }))
      .on('wait', () => ({ pid: 777, status: { kind: 'exited' as const, code: 0 } }));
  }

  it('PROC-08 nice prints the current niceness and runs a command with nice + N', () => {
    const k = niceWorld();
    expect(k.run(nice, ['nice']).out).toBe('0\n');
    expect(k.run(nice, ['nice', '-n', '5', 'sleep', '20']).status).toBe(0);
    expect(k.argsOf('spawn')[0]).toMatchObject({
      path: '/bin/sleep.json',
      argv: ['sleep', '20'],
      nice: 5,
      cwd: '/home/alice',
    });
    k.run(nice, ['nice', 'sleep', '1']);
    expect(k.argsOf('spawn')[0]).toMatchObject({ nice: 10 });
    expect(clampNice(40)).toBe(19);
  });

  it('PROC-08 nice with a negative N without root warns and runs unchanged', () => {
    const k = niceWorld();
    let first = true;
    k.on('spawn', () => {
      if (first) {
        first = false;
        throw new SysError('EPERM');
      }
      return { pid: 778 };
    });
    k.on('wait', () => ({
      pid: 778,
      status: { kind: 'signaled' as const, signal: 'SIGKILL' as const, code: 137 },
    }));
    const r = k.run(nice, ['nice', '-n', '-5', 'sleep', '1']);
    expect(r).toMatchObject({ status: 137, err: 'nice: cannot set niceness: Permission denied\n' });
    expect(k.argsOf('spawn')[1]).not.toHaveProperty('nice');
  });

  it('PROC-08 nice reports a missing command with 127 and a bad adjustment', () => {
    const k = niceWorld();
    expect(k.run(nice, ['nice', 'nosuch'])).toMatchObject({
      status: 127,
      err: "nice: 'nosuch': No such file or directory\n",
    });
    expect(k.run(nice, ['nice', '-n', 'x', 'sleep']).status).toBe(2);
    k.fail('spawn', 'EAGAIN');
    expect(k.run(nice, ['nice', 'sleep']).status).toBe(126);
  });

  it('PROC-02 renice sets the absolute nice value and prints old and new', () => {
    const k = kernel()
      .on('getpriority', () => ({ priority: 20, nice: 5, effPrio: 25, band: 'normal' as const }))
      .on('setpriority', (a) => ({ priority: 20, nice: a.nice ?? 0, effPrio: 30 }))
      .on('proc.list', (a) => ({
        procs: ROWS.filter(
          (r) =>
            (a.pgid === undefined || r.pgid === a.pgid) && (a.uid === undefined || r.uid === a.uid),
        ),
      }));
    expect(k.run(renice, ['renice', '10', '-p', '301']).out).toBe(
      '301 (process ID) old priority 5, new priority 10\n',
    );
    expect(k.run(renice, ['renice', '-n', '19', '-g', '203']).out).toBe(
      '203 (process group ID) old priority 0, new priority 19\n',
    );
    expect(k.run(renice, ['renice', '+3', '-u', 'bob']).out).toBe(
      '1002 (user ID) old priority 0, new priority 3\n',
    );
    expect(k.argsOf('setpriority')).toEqual([{ pid: 501, nice: 3 }]);
    expect(parseRenice(['-5', '1', '-g', '2', '-p', '3']).targets).toEqual([
      { which: 'pid', id: '1' },
      { which: 'pgid', id: '2' },
      { which: 'pid', id: '3' },
    ]);
  });

  it('PROC-02 renice reports permission and missing targets', () => {
    const k = kernel()
      .on('getpriority', () => ({ priority: 20, nice: 0, effPrio: 20, band: 'normal' as const }))
      .on('setpriority', () => {
        throw new SysError('EACCES');
      })
      .on('proc.list', () => ({ procs: [] }));
    expect(k.run(renice, ['renice', '-5', '-p', '312'])).toMatchObject({
      status: 1,
      err: 'renice: failed to set priority for 312 (process ID): Permission denied\n',
    });
    expect(k.run(renice, ['renice', '1', '-g', '9']).err).toBe(
      'renice: failed to set priority for 9 (process group ID): No such process\n',
    );
    expect(k.run(renice, ['renice', '1', '-u', 'bob2']).err).toBe('renice: unknown user bob2\n');
    expect(k.run(renice, ['renice', '1', 'x']).err).toBe('renice: bad value x\n');
    expect(k.run(renice, ['renice']).status).toBe(2);
    expect(k.run(renice, ['renice', 'x', '1']).status).toBe(2);
    expect(k.run(renice, ['renice', '1']).status).toBe(2);
  });
});

describe('free, vmstat and pmap', () => {
  it('MEM-07 free prints the budget line, the swap tiers and the kernel line', () => {
    const lines = world().run(free, ['free']).out.split('\n');
    expect(lines[0]).toBe(
      '             total       used       free   reserved     pinned   specul.      avail',
    );
    expect(lines[1]).toBe(
      'Mem:        256.0M     187.4M      54.7M      13.9M          -      9.1M          -',
    );
    expect(lines[2]).toBe('Swap-L:          -     412.0M          -   device -');
    expect(lines[3]).toBe('Swap-R:          -     390.0M          -   write-behind');
    expect(lines[4]).toBe('Kernel:          -       9.0M          -   not charged');
  });

  it('MEM-01 free -m, -b and the kernel extension fields', () => {
    const k = world().on('mem.stat', () => ({
      ...MEM,
      pinned: 44_040_192,
      avail: 100_000_000,
      localCap: 2_147_483_648,
      device: 'opfs' as const,
      uploadPending: 3,
      uploadFailed: 0,
    }));
    const m = k.run(free, ['free', '-m']).out.split('\n');
    expect(m[1]).toBe(
      'Mem:           256        187         55         14         42         9         95',
    );
    expect(m[2]).toBe('Swap-L:       2048        412       1636   device opfs');
    expect(m[3]).toBe(
      'Swap-R:          -        390          -   write-behind: 3 pending, 0 failed',
    );
    expect(k.run(free, ['free', '-b']).out).toContain('268435456');
    expect(k.run(free, ['free', '-k']).out).toContain('262144');
    expect(k.run(free, ['free', '-g']).out).toContain('Swap-L:          2');
  });

  it('MEM-07 free -s repeats and -c limits, --json prints the record', () => {
    const k = world();
    const r = k.run(free, ['free', '-s', '1', '-c', '2']);
    expect(r.out.split('Mem:')).toHaveLength(3);
    expect(k.countCalls('sleep')).toBe(1);
    expect(JSON.parse(k.run(free, ['free', '--json']).out)).toMatchObject({ budget: MEM.budget });
    expect(k.run(free, ['free', '-m', '-b']).status).toBe(2);
    expect(k.run(free, ['free', '-s', '0']).status).toBe(2);
    expect(k.run(free, ['free', '-c', 'x']).status).toBe(2);
    expect(k.run(free, ['free', 'x']).status).toBe(2);
    k.fail('mem.stat', 'EIO');
    expect(k.run(free, ['free']).status).toBe(1);
  });

  it('MEM-07 vmstat prints the header and a line averaged since boot', () => {
    const lines = world().run(vmstat, ['vmstat']).out.split('\n');
    expect(lines[0]).toBe(
      'procs ------memory (MiB)------- ---------paging--------- -----swap (KiB/s)----- ---cpu---',
    );
    expect(lines[1]).toBe(
      ' r  b  s   used  free  rsv  pin   flt  hit%    pi    po      si      so      ro  us ke id',
    );
    expect(lines[2]).toBe(
      ' 2  2  1  187.4  54.7 13.9    -     1  97.4     -     -      45     484       -   -  -  -',
    );
  });

  it('MEM-07 vmstat DELAY COUNT prints interval lines and -w widens them', () => {
    const k = world();
    let faults = 1204;
    k.on('mem.stat', () => {
      faults += 10;
      return { ...MEM, faults };
    });
    k.on('sleep', (a) => {
      k.fs.clock += a.ms;
      return { sleptMs: a.ms };
    });
    const lines = k.run(vmstat, ['vmstat', '1', '2']).out.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(/^ 2 {2}2 {2}1 .* 10 +97\.4 /);
    expect(k.run(vmstat, ['vmstat', '-w']).out.split('\n')[1]?.startsWith('   r')).toBe(true);
  });

  it('MEM-07 vmstat -p shows faults, hit ratio and bytes paged per process', () => {
    const k = world().on('mem.stat', () => ({
      ...MEM,
      procs: [{ ...MEM.procs[0], swapLocal: 1_572_864, bytesIn: 1_572_864, lastPageInMs: 43 }],
    }));
    const lines = k.run(vmstat, ['vmstat', '-p']).out.split('\n');
    expect(lines[0]).toMatch(
      /^ +PID USER +RES +SWAP-L +SWAP-R +WS +FLT +HIT% +IN +OUT +LAST-IN COMMAND$/,
    );
    expect(lines[1]).toMatch(/^ +203 alice +82\.2K +1\.5M +- +- +12 +97\.4 +1\.5M +- +43 ms sh$/);
    expect(k.run(vmstat, ['vmstat', '-p', '999']).out.split('\n')).toHaveLength(2);
    expect(JSON.parse(k.run(vmstat, ['vmstat', '--json']).out)).toMatchObject({ faults: 1204 });
  });

  it('MEM-07 vmstat rejects bad arguments', () => {
    expect(() => parseVmstat(['1', '2', '3'])).toThrow();
    expect(() => parseVmstat(['-x'])).toThrow();
    expect(() => parseVmstat(['--x'])).toThrow();
    expect(() => parseVmstat(['abc'])).toThrow();
    expect(() => parseVmstat(['0'])).toThrow();
    expect(() => parseVmstat(['1', '1.5'])).toThrow();
    expect(parseVmstat(['2', '-p', '412'])).toMatchObject({
      delayMs: 2000,
      count: null,
      perProcess: true,
      pids: [412],
    });
    const k = world();
    k.fail('uptime', 'EIO');
    expect(k.run(vmstat, ['vmstat']).status).toBe(1);
  });

  const DETAIL = {
    ...proc({ pid: 412, state: 'READY', argv: ['editor', '~/notes/os.md'] }),
    hitRatio: 0.974,
    faults: 12,
    pages: [
      {
        pageId: 0,
        loc: 'RESIDENT' as const,
        dirty: false,
        size: 18_637,
        lastAccess: NOW - 300,
        pinned: false,
        speculative: false,
      },
      {
        pageId: 1,
        loc: 'RESIDENT' as const,
        dirty: true,
        size: 1_258_291,
        lastAccess: NOW - 2_100,
        pinned: true,
        speculative: false,
      },
      {
        pageId: 2,
        loc: 'LOCAL_SWAP' as const,
        dirty: false,
        size: 262_144,
        lastAccess: NOW - 41_000,
        pinned: false,
        speculative: true,
      },
      {
        pageId: 3,
        loc: 'REMOTE_SWAP' as const,
        dirty: false,
        size: 262_144,
        lastAccess: NOW - 41_000,
        pinned: false,
        speculative: false,
      },
    ],
  };

  it('MEM-07 pmap prints the header, one row per page and the totals', () => {
    const k = world()
      .on('proc.info', () => DETAIL)
      .on('mem.stat', () => ({ ...MEM, procs: [{ ...MEM.procs[0], pid: 412 }] }));
    const lines = k.run(pmap, ['pmap', '412']).out.split('\n');
    expect(lines[0]).toBe(
      '412:   editor ~/notes/os.md   (alice, READY, exec e1, soft limit 64.0M)',
    );
    expect(lines[1]).toMatch(/^PAGE +KIND +LABEL +SIZE +LOCATION +COPIES +FLAGS +AGE +SHA256$/);
    expect(lines[2]).toMatch(/^ +0 +- +- +18\.2K +RESIDENT +- +- +0\.3s +-$/);
    expect(lines[3]).toContain('DP');
    expect(lines[6]).toBe(
      'total 4 pages 1.7M | resident 1.2M, local copies 256.0K, remote copies 256.0K | faults 12, hit 97.4%',
    );
  });

  it('MEM-07 pmap -x adds the extended columns and --json prints the record', () => {
    const k = world().on('proc.info', () => ({
      ...DETAIL,
      pages: [
        {
          ...DETAIL.pages[0],
          sha256: 'a'.repeat(64),
          gen: 3,
          pinReasons: ['P1'],
          swapKey: 'k',
          kind: 'state',
          label: 'process state',
          copies: 'L S',
          io: true,
        },
      ],
    }));
    const lines = k.run(pmap, ['pmap', '-x', '412']).out.split('\n');
    expect(lines[1]).toContain('GEN');
    expect(lines[2]).toContain('a'.repeat(64));
    expect(lines[2]).toContain('P1');
    expect(JSON.parse(k.run(pmap, ['pmap', '--json', '412']).out)).toMatchObject({ pid: 412 });
    expect(
      pageFlags({
        pageId: 9,
        loc: 'RESIDENT',
        dirty: false,
        size: 1,
        lastAccess: NOW,
        pinned: false,
        speculative: false,
        io: true,
      }),
    ).toBe('W');
  });

  it('MEM-07 pmap reports a missing process and another user process', () => {
    const k = world().fail('proc.info', 'ESRCH');
    expect(k.run(pmap, ['pmap', '999'])).toMatchObject({
      status: 1,
      err: 'pmap: 999: No such process\n',
    });
    k.fail('proc.info', 'EACCES');
    expect(k.run(pmap, ['pmap', '23']).err).toBe('pmap: 23: Permission denied\n');
    expect(k.run(pmap, ['pmap']).status).toBe(2);
    expect(k.run(pmap, ['pmap', '1', '2']).status).toBe(2);
    expect(k.run(pmap, ['pmap', 'x']).status).toBe(2);
    k.on('proc.info', () => DETAIL).fail('mem.stat', 'EIO');
    expect(k.run(pmap, ['pmap', '412']).out.split('\n')[0]).toBe(
      '412:   editor ~/notes/os.md   (alice, READY, exec e1)',
    );
  });
});
