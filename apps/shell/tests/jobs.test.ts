import { describe, expect, it } from 'vitest';

import type { ProgramContext } from '../../src/_sys.ts';
import {
  addJob,
  applyWait,
  jobLine,
  newJob,
  newJobTable,
  resolveJobSpec,
  stateText,
} from '../jobs.ts';
import { KILL_LIST, parseSignal } from '../builtins/kill.ts';
import { runC, Session } from './session.ts';

const CTRL_C = '\x03';
const CTRL_Z = '\x1a';

function bgPid(out: string): number {
  return Number(/\[\d+\] (\d+)/.exec(out)?.[1]);
}

describe('job control (§3.8, PROC-08)', () => {
  it('SHL-08 cmd & prints the job and pid, and jobs lists it as Running (scripted-session step 14)', () => {
    const s = new Session();
    const out = s.cmd('sleep 30 &');
    expect(out).toMatch(/^\[1\] \d+$/);
    expect(s.st.lastBg).toBe(bgPid(out));
    expect(s.cmd('jobs')).toBe('[1]+  Running                 sleep 30 &');
    expect(s.cmd('jobs -l')).toBe(
      `[1]+ ${String(bgPid(out)).padStart(5)} Running                 sleep 30 &`,
    );
    expect(s.cmd('jobs -p')).toBe(String(bgPid(out)));
    expect(s.k.tty.fgPgid).toBe(s.pid);
  });

  it('SHL-08 Ctrl-Z stops top, jobs lists it as Stopped, bg resumes it, fg brings it back (scripted-session step 15)', () => {
    const s = new Session();
    s.cmd('sleep 30 &');
    const row = s.k.screen.cursor().row;
    s.keys('top\r');
    expect(s.k.tty.canonical).toBe(true);
    expect(s.k.tty.isig).toBe(true);
    expect(s.k.tty.fgPgid).not.toBe(s.pid);
    s.keys(CTRL_Z);
    expect(s.since(row)).toBe('^Z\n[2]+  Stopped                 top');
    expect(s.st.status).toBe(148);
    expect(s.k.tty.fgPgid).toBe(s.pid);
    expect(s.cmd('jobs')).toBe(
      '[1]-  Running                 sleep 30 &\n[2]+  Stopped                 top',
    );
    expect(s.cmd('bg')).toBe('[2]+ top &');
    expect(s.cmd('jobs %2')).toBe('[2]+  Running                 top &');
    expect(s.cmd('kill %2')).toBe('[2]+  Terminated              top');
    expect(s.cmd('kill %1')).toBe('[1]+  Terminated              sleep 30');
    expect(s.cmd('jobs')).toBe('');
  });

  it('SHL-08 fg prints the job text, gives it the terminal, and Ctrl-C ends it with 130 (scripted-session step 16)', () => {
    const s = new Session();
    s.cmd('sleep 5 &');
    const row = s.k.screen.cursor().row;
    s.keys('fg\r');
    expect(s.k.tty.fgPgid).not.toBe(s.pid);
    s.keys(CTRL_C);
    expect(s.since(row)).toBe('sleep 5\n^C');
    expect(s.cmd('echo $?')).toBe('130');
  });

  it('SHL-08 a stopped job keeps its terminal mode and gets it back on fg', () => {
    const raw = {
      init: () => ({ phase: 0 }),
      *run(ctx: ProgramContext) {
        yield* ctx.sys.call('tty.setattr', { fd: 0, canonical: false, echo: false });
        for (;;) yield* ctx.sys.call('sleep', { ms: 1000 });
      },
    };
    const s = new Session({ programs: { rawapp: raw } });
    s.keys('rawapp\r');
    expect(s.k.tty.canonical).toBe(false);
    s.k.signalGroup(s.k.tty.fgPgid, 'SIGTSTP');
    s.k.run();
    expect(s.st.jobs.list[0]?.mode).toEqual({ canonical: false, echo: false, isig: true });
    s.cmd('fg');
    expect(s.k.tty.canonical).toBe(false);
    expect(s.k.tty.echo).toBe(false);
  });

  it('SHL-08 Done notices appear before the next prompt and exit with stopped jobs warns once', () => {
    const s = new Session();
    s.cmd('sleep 1 &');
    s.cmd('status 3 1 &');
    s.k.advance(1000);
    expect(s.cmd('')).toBe(
      '[1]-  Done                    sleep 1\n[2]+  Exit 3                  status 3 1',
    );
    s.keys('top\r');
    s.keys(CTRL_Z);
    expect(s.cmd('exit')).toBe('There are stopped jobs.');
    expect(s.exited()).toBe(false);
    s.cmd('exit');
    expect(s.exited()).toBe(true);
  });

  it('SHL-08 the stopped-jobs warning is forgotten after another command', () => {
    const s = new Session();
    s.keys('top\r');
    s.keys(CTRL_Z);
    expect(s.cmd('exit')).toBe('There are stopped jobs.');
    s.cmd('true');
    expect(s.cmd('exit')).toBe('There are stopped jobs.');
    s.keys('\x04');
    expect(s.exited()).toBe(true);
  });

  it('SHL-02 a background job that reads the terminal is stopped with SIGTTIN', () => {
    const s = new Session();
    expect(s.cmd('readtty &')).toMatch(/^\[1\] \d+\n\[1\]\+ {2}Stopped \(tty input\) {5}readtty$/);
    const row = s.k.screen.cursor().row;
    s.keys('fg\r');
    s.keys('hello\r');
    expect(s.since(row)).toBe('readtty\nhello\ngot:hello');
  });

  it('SHL-08 wait collects background jobs and Ctrl-C interrupts it with 130', () => {
    const s = new Session();
    s.cmd('sleep 2 &');
    s.keys('wait\r');
    expect(s.st.exec).not.toBeNull();
    s.k.advance(2000);
    expect(s.cmd('echo $?')).toBe('0');
    s.cmd('sleep 100 &');
    s.keys('wait %1\r');
    s.keys(CTRL_C);
    expect(s.cmd('echo $?')).toBe('130');
    expect(s.cmd('wait %9')).toBe('wait: %9: no such job');
  });

  it('SHL-08 Ctrl-C of a foreground job abandons the rest of the line', () => {
    const s = new Session();
    const row = s.k.screen.cursor().row;
    s.keys('sleep 10; echo after\r');
    s.keys(CTRL_C);
    expect(s.since(row)).toBe('^C');
    expect(s.st.status).toBe(130);
  });

  it('SHL-07 a foreground job killed by a signal other than SIGINT prints the reason and sets 128+n', () => {
    const s = new Session();
    const row = s.k.screen.cursor().row;
    s.keys('top\r');
    s.k.signalGroup(s.k.tty.fgPgid, 'SIGTERM');
    s.k.run();
    expect(s.since(row)).toBe('Terminated');
    expect(s.st.status).toBe(143);
    s.keys('top\r');
    s.k.signalGroup(s.k.tty.fgPgid, 'SIGKILL');
    s.k.run();
    expect(s.st.status).toBe(137);
    expect(s.k.screen.text()).toContain('Killed');
  });

  it('SHL-02 Ctrl-C at the prompt discards the line, prints ^C and sets 130', () => {
    const s = new Session();
    const row = s.k.screen.cursor().row;
    s.keys('echo never');
    s.keys(CTRL_C);
    expect(s.since(row)).toBe('');
    expect(s.k.screen.lines()[row]).toBe('demo@plotinium:~$ echo never^C');
    expect(s.st.status).toBe(130);
    expect(s.exited()).toBe(false);
  });

  it('SHL-08 job builtins report missing and already-running jobs', () => {
    const s = new Session();
    expect(s.cmd('fg')).toBe('fg: no current job');
    expect(s.cmd('bg')).toBe('bg: no current job');
    expect(s.cmd('jobs %5')).toBe('jobs: %5: no such job');
    expect(s.st.status).toBe(1);
    expect(s.cmd('jobs -x')).toBe(
      "jobs: invalid option -- 'x'\nUsage: jobs [-l] [-p] [%JOB...]\nTry 'man jobs'.",
    );
    s.cmd('sleep 9 &');
    expect(s.cmd('bg %1')).toBe('bg: job 1 already in background');
    expect(s.cmd('fg %sl')).toBe('sleep 9');
  });

  it('SHL-08 job builtins in a child shell see no jobs (jobs | cat prints nothing)', () => {
    const s = new Session();
    s.cmd('sleep 9 &');
    expect(s.cmd('jobs | cat')).toBe('');
    expect(s.cmd('fg | cat')).toBe('fg: no job control');
  });
});

describe('names on the terminal (§3.13)', () => {
  it('SHL-13 jobs shows control characters in command lines as ? on a terminal and raw into a file', () => {
    const s = new Session();
    s.keys("\x1b[200~sleep 9 '\x07\u202e' &\x1b[201~\r");
    expect(s.cmd('jobs')).toBe("[1]+  Running                 sleep 9 '??' &");
    s.cmd('jobs > j.txt');
    expect(s.k.readFile('/home/demo/j.txt')).toBe(
      "[1]+  Running                 sleep 9 '\x07\u202e' &\n",
    );
  });
});

describe('kill builtin (§3.14.24)', () => {
  it('PROC-08 kill -l lists the twelve signals exactly and names a status or number', () => {
    const s = new Session();
    expect(s.cmd('kill -l')).toBe(
      '1) SIGHUP 2) SIGINT 9) SIGKILL 13) SIGPIPE 15) SIGTERM 17) SIGCHLD 18) SIGCONT 19) SIGSTOP 20) SIGTSTP 21) SIGTTIN 22) SIGTTOU 28) SIGWINCH',
    );
    expect(KILL_LIST.split(') ').length).toBe(13);
    expect(s.cmd('kill -l 9 137 TERM')).toBe('KILL\nKILL\n15');
    expect(s.cmd('kill -l 99')).toBe("kill: invalid signal '99'");
  });

  it('PROC-08 kill sends SIGTERM by default and accepts -SIG, -NUM, -s and -n', () => {
    const s = new Session();
    const pids = [1, 2, 3, 4].map(() => bgPid(s.cmd('sleep 100 &')));
    s.cmd(`kill ${pids[0]}`);
    s.cmd(`kill -9 ${pids[1]}`);
    s.cmd(`kill -s int ${pids[2]}`);
    s.cmd(`kill -n 15 -- -${pids[3]}`);
    const sigs = (s.k.callsOf('kill') as { pid: number; sig: string }[]).map(
      (k) => `${k.pid}:${k.sig}`,
    );
    expect(sigs).toEqual([
      `${pids[0]}:SIGTERM`,
      `${pids[1]}:SIGKILL`,
      `${pids[2]}:SIGINT`,
      `-${pids[3]}:SIGTERM`,
    ]);
  });

  it('PROC-08 kill reports errors with the spec texts and statuses', () => {
    const s = new Session();
    expect(s.cmd('kill 999')).toBe('kill: (999) - No such process');
    expect(s.st.status).toBe(1);
    expect(s.cmd('kill 1')).toBe('kill: (1) - Operation not permitted');
    expect(s.cmd('kill -FOO 1')).toBe("kill: invalid signal 'FOO'");
    expect(s.st.status).toBe(2);
    expect(s.cmd('kill')).toBe(
      'kill: usage: kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID | %JOB...',
    );
    expect(s.cmd('kill -s')).toBe(
      'kill: usage: kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID | %JOB...',
    );
    expect(s.cmd('kill abc')).toBe('kill: abc: arguments must be process or job IDs');
    expect(s.cmd('kill %3')).toBe('kill: %3: no such job');
  });

  it('PROC-08 SIGTERM to a stopped job is followed by SIGCONT so it takes effect', () => {
    const s = new Session();
    s.keys('top\r');
    s.keys(CTRL_Z);
    s.cmd('kill %1');
    const sigs = (s.k.callsOf('kill') as { sig: string }[]).map((k) => k.sig);
    expect(sigs).toEqual(['SIGTERM', 'SIGCONT']);
    expect(s.k.screen.text().split('\n').at(-2)).toBe('[1]+  Terminated              top');
  });

  it('PROC-08 without job control kill %n signals the job’s processes, not the shell’s group', () => {
    const r = runC('sleep 50 & kill %1; wait; echo $?');
    const kills = r.k.callsOf('kill') as { pid: number }[];
    expect(kills.every((k) => k.pid > 0)).toBe(true);
    expect(r.k.live()).toHaveLength(0);
  });

  it('PROC-08 signal names parse with or without SIG and in any case', () => {
    expect(parseSignal('term')).toBe('SIGTERM');
    expect(parseSignal('SIGKILL')).toBe('SIGKILL');
    expect(parseSignal('0')).toBe(0);
    expect(parseSignal('20')).toBe('SIGTSTP');
    expect(parseSignal('nope')).toBeNull();
    expect(parseSignal('77')).toBeNull();
  });
});

describe('job table (§4.4)', () => {
  function table() {
    const t = newJobTable();
    const a = addJob(t, newJob(10, [10], 'sleep 100'));
    const b = addJob(t, newJob(20, [20, 21], 'grep x | wc'));
    const c = addJob(t, newJob(30, [30], 'top'));
    return { t, a, b, c };
  }

  it('SHL-08 ids are the smallest free positive integers', () => {
    const { t, b } = table();
    t.list = t.list.filter((j) => j !== b);
    t.order = t.order.filter((id) => id !== b.id);
    expect(addJob(t, newJob(40, [40], 'x')).id).toBe(2);
  });

  it('SHL-08 %+, %%, %-, %n, %prefix and %?substring resolve jobs', () => {
    const { t, a, b, c } = table();
    const id = (spec: string | undefined): number | string => {
      const r = resolveJobSpec(t, spec, 'fg');
      return r.ok ? r.job.id : r.message;
    };
    expect(id(undefined)).toBe(c.id);
    expect(id('%%')).toBe(c.id);
    expect(id('%+')).toBe(c.id);
    expect(id('%-')).toBe(b.id);
    expect(id('%1')).toBe(a.id);
    expect(id('2')).toBe(b.id);
    expect(id('%sl')).toBe(a.id);
    expect(id('%?x |')).toBe(b.id);
    expect(id('%zz')).toBe('fg: %zz: no such job');
    expect(id('zz')).toBe('fg: zz: no such job');
    expect(resolveJobSpec(newJobTable(), '%-', 'fg')).toEqual({
      ok: false,
      message: 'fg: %-: no such job',
    });
  });

  it('SHL-08 states and the fixed 24-column layout of the job lines', () => {
    const { t, b, c } = table();
    applyWait(b, 20, { kind: 'exited', code: 0 });
    expect(b.state).toBe('running');
    applyWait(b, 21, { kind: 'exited', code: 1 });
    expect(stateText(b)).toBe('Exit 1');
    applyWait(c, 30, { kind: 'stopped', signal: 'SIGTTOU' });
    expect(jobLine(t, c)).toBe('[3]+  Stopped (tty output)    top');
    applyWait(c, 30, { kind: 'continued' });
    expect(jobLine(t, c)).toBe('[3]+  Running                 top &');
    applyWait(c, 30, { kind: 'signaled', signal: 'SIGHUP', code: 129 });
    expect(stateText(c)).toBe('Hangup');
    c.fixed = 127;
    expect(stateText(c)).toBe('Exit 127');
  });
});
