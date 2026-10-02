import { describe, expect, it } from 'vitest';

import shell, { initShell } from '../proc.ts';
import type { ShellState } from '../state.ts';
import { runC, Session } from './session.ts';

const CTRL_C = '\x03';
const CTRL_Z = '\x1a';

describe('scripted terminal session (§3.15)', () => {
  it('SYS-02 scripted terminal session covers the required commands, pipes, redirection, sequencing, background jobs, variables and history', () => {
    const s = new Session({ setup: (k) => k.mkdir('/home/demo/t') });
    const transcript: string[] = [];
    const step = (line: string, want: RegExp): void => {
      const out = s.cmd(line);
      transcript.push(`$ ${line}`, out);
      expect(out, line).toMatch(want);
    };
    step('cd ~; pwd', /^\/home\/demo$/);
    step('echo "$USER $HOME $PATH"', /^demo \/home\/demo \/bin$/);
    step("echo 'one $HOME' > t/f.txt; echo two >> t/f.txt; cat < t/f.txt", /^one \$HOME\ntwo$/);
    step('cat t/f.txt | grep -c o', /^2$/);
    step('false || echo fallback; true && echo ok', /fallback\nok/);
    step('nope', /nope: command not found/);
    step('echo $?', /^127$/);
    step('cat t/missing 2>&1 | cat', /t\/missing: ENOENT/);
    step('sleep 30 &', /^\[1\] \d+$/);
    step('jobs', /Running\s+sleep 30 &/);
    s.keys('top\r');
    s.keys(CTRL_Z);
    expect(s.k.screen.text()).toMatch(/Stopped\s+top/);
    step('jobs', /\[2\]\+\s+Stopped\s+top/);
    step('bg', /^\[2\]\+ top &$/);
    step('kill %2', /Terminated\s+top/);
    step('kill %1', /Terminated\s+sleep 30/);
    step('sleep 5 &', /^\[1\] \d+$/);
    const row = s.k.screen.cursor().row;
    s.keys('fg\r');
    s.keys(CTRL_C);
    expect(s.since(row)).toBe('sleep 5\n^C');
    step('echo $?', /^130$/);
    step('help | head -n 1', /^Plotinium 0\.3\.0 shell — type 'man <command>'$/);
    step('history 3', /^\s+\d+ {2}fg\n\s+\d+ {2}echo \$\?\n\s+\d+ {2}help \| head -n 1$/);
    step('history -c; history', /^$/);
    expect(s.k.crashes).toEqual([]);
    expect(s.k.live().map((p) => p.pid)).toEqual([s.pid]);
    expect(transcript.length).toBeGreaterThan(30);
  });
});

describe('the shell as a serialisable program (processes-and-scheduling.md §3.5)', () => {
  it('SYS-02 init is pure and parses login, -c, -i and script arguments', () => {
    expect(initShell(['-sh'])).toMatchObject({ login: true, name: 'sh', mode: 'stdin' });
    expect(initShell(['sh', '-c', 'echo hi', 'nm', 'a'])).toMatchObject({
      mode: 'command',
      command: 'echo hi',
      name: 'nm',
      positional: ['a'],
    });
    expect(initShell(['sh', '-i', '-l'])).toMatchObject({ forceInteractive: true, login: true });
    expect(initShell(['sh', '--', 'x.sh', '1'])).toMatchObject({
      mode: 'script',
      scriptPath: 'x.sh',
      positional: ['1'],
    });
    expect(initShell(['sh', '-c'])).toMatchObject({ mode: 'command', command: '' });
    expect(shell.checkpointable).toBe(true);
  });

  it('SYS-02 the shell state is plain data that survives a structured clone and JSON', () => {
    const s = new Session();
    s.cmd('X=1; export Y=2');
    s.cmd('sleep 30 &');
    s.keys('echo half');
    const st = s.st;
    expect(structuredClone(st)).toEqual(st);
    expect(JSON.parse(JSON.stringify(st))).toEqual(st);
  });

  it('SYS-02 a page-out at the prompt keeps the half-typed line, variables, history and jobs', () => {
    const s = new Session();
    s.cmd('X=kept');
    s.cmd('sleep 30 &');
    s.keys('echo hel');
    s.k.checkpointRestore(s.pid);
    s.k.run();
    s.keys('lo $X\r');
    expect(s.k.screen.text().split('\n').at(-2)).toBe('hello kept');
    expect(s.cmd('jobs')).toBe('[1]+  Running                 sleep 30 &');
    expect(s.st.hist.lines).toContain('X=kept');
    expect(s.k.crashes).toEqual([]);
  });

  it('SYS-02 a page-out while waiting for a foreground job resumes the wait and the rest of the line', () => {
    const s = new Session();
    const row = s.k.screen.cursor().row;
    s.keys('sleep 5; echo after; status 4\r');
    expect(s.st.exec?.waiting).toBe(true);
    s.k.checkpointRestore(s.pid);
    s.k.run();
    s.k.advance(5000);
    expect(s.since(row)).toBe('after');
    expect(s.st.status).toBe(4);
    expect((s.k.callsOf('spawn') as { argv: string[] }[]).map((a) => a.argv[0])).toEqual([
      'sleep',
      'status',
    ]);
    expect(s.st.hist.lines.at(-1)).toBe('sleep 5; echo after; status 4');
  });

  it('SYS-02 a non-interactive shell resumes its script after a page-out', () => {
    const r = runC('sleep 2; echo done; exit 9');
    const pid = [...r.k.procs.values()].find((p) => p.argv[0] === 'sh')?.pid ?? 0;
    r.k.checkpointRestore(pid);
    r.k.advance(2000);
    expect(r.k.screen.text()).toBe('done');
    expect(r.k.exitStatus(pid)).toEqual({ kind: 'exited', code: 9 });
  });

  it('SYS-02 an exited shell returns its status again when re-entered', () => {
    const r = runC('exit 5');
    const proc = [...r.k.procs.values()][0];
    const st = proc?.st as ShellState;
    expect(st.exitCode).toBe(5);
    const gen = shell.run(proc?.ctx ?? ({} as never), st);
    expect(gen.next()).toEqual({ done: true, value: 5 });
  });
});
