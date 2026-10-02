/**
 * SYS-02: the scripted terminal session of shell-and-terminal.md §3.15, driven through the
 * Terminal's pseudo-terminal: keystrokes go into the line discipline, the real shell (apps/shell)
 * and coreutils run as processes of the Terminal's process host, and the screen is read back from
 * the output batches. The kernel side (files, identity) is the in-memory fake of ./fake-sys.ts.
 * The browser run of the same script is tests/e2e/sys-02-session.spec.ts.
 */
import { describe, expect, it } from 'vitest';

import { startSession } from './harness.ts';

describe('SYS-02 scripted terminal session (§3.15)', () => {
  it('SYS-02 the login shell prints a prompt with user, host and ~', async () => {
    const h = await startSession();
    expect(h.screen.lines()[h.screen.cursorRow]).toBe('demo@plotinium:~$');
    expect(h.host.processes().map((p) => p.argv[0])).toEqual(['-sh']);
  });

  it('SYS-02 step 1: cd ~; pwd prints the home directory', async () => {
    const h = await startSession();
    expect(await h.cmd('cd /tmp')).toBe('');
    expect(await h.cmd('pwd')).toBe('/tmp');
    expect(await h.cmd('cd ~; pwd')).toBe('/home/demo');
  });

  it('SYS-02 ls lists the working directory', async () => {
    const h = await startSession();
    expect(await h.cmd('ls')).toBe('notes.md  todo.txt');
  });

  it('SYS-02 step 2: environment variables in double quotes', async () => {
    const h = await startSession();
    expect(await h.cmd('echo "$USER $HOME $PATH"')).toBe('demo /home/demo /bin');
  });

  it('SYS-02 echo hi | cat: a pipeline between two processes', async () => {
    const h = await startSession();
    expect(await h.cmd('echo hi | cat')).toBe('hi');
    // Both ends were reaped: only the shell is left.
    expect(h.host.processes()).toHaveLength(1);
  });

  it('SYS-02 step 3: mkdir -p, touch, && and ls', async () => {
    const h = await startSession();
    expect(await h.cmd('mkdir -p t/a/b && touch t/a/b/x.txt && ls t/a/b')).toBe('x.txt');
    expect(h.fs.text('/home/demo/t/a/b/x.txt')).toBe('');
  });

  it('SYS-02 step 4: single quotes, >, >> and <', async () => {
    const h = await startSession();
    await h.cmd('mkdir t');
    const out = await h.cmd("echo 'one $HOME' > t/f.txt; echo two >> t/f.txt; cat < t/f.txt");
    expect(out).toBe('one $HOME\ntwo');
    expect(h.fs.text('/home/demo/t/f.txt')).toBe('one $HOME\ntwo\n');
  });

  it('SYS-02 step 5: cat t/f.txt | grep -c o', async () => {
    const h = await startSession({
      setup: (fs) => fs.addFile('/home/demo/f.txt', 'one\ntwo\nthree\n'),
    });
    expect(await h.cmd('cat f.txt | grep -c o')).toBe('2');
  });

  it('SYS-02 step 6: || and &&', async () => {
    const h = await startSession();
    expect(await h.cmd('false || echo fallback; true && echo ok')).toBe('fallback\nok');
  });

  it('SYS-02 step 7: an unknown command is 127', async () => {
    const h = await startSession();
    expect(await h.cmd('nope')).toBe('sh: nope: command not found');
    expect(await h.cmd('echo $?')).toBe('127');
  });

  it('SYS-02 step 14: a background job with & and jobs', async () => {
    const h = await startSession();
    expect(await h.cmd('sleep 30 &')).toMatch(/^\[1\] \d+$/);
    expect(await h.cmd('jobs')).toMatch(/^\[1\]\+\s+Running\s+sleep 30 &$/);
    await h.clock.advance(31_000);
    expect(await h.cmd('')).toMatch(/^\[1\]\+\s+Done\s+sleep 30$/);
    expect(await h.cmd('jobs')).toBe('');
  });

  it('SYS-02 step 16: sleep 5 & then fg then Ctrl-C gives 130', async () => {
    const h = await startSession();
    await h.cmd('sleep 5 &');
    await h.keys('fg\r');
    expect(h.screen.lines()[h.screen.cursorRow - 1]).toBe('sleep 5');
    await h.keys('\x03');
    expect(await h.cmd('echo $?')).toBe('130');
    expect(await h.cmd('jobs')).toBe('');
  });

  it('SYS-02 step 17: ps shows the session on its TTY, the leader and the foreground job', async () => {
    const h = await startSession();
    await h.cmd('sleep 9 &');
    const rows = (await h.cmd('ps -o pid,stat,tty,comm')).split('\n');
    expect(rows[0]).toMatch(/^\s*PID STAT TTY\s+COMMAND$/);
    // The login shell leads the session (s); ps runs in the foreground group (+); the
    // background sleep is neither.
    expect(rows.slice(1).map((r) => r.trim().split(/\s+/).slice(1))).toEqual([
      ['BLKs', 'tty1', '-sh'],
      ['BLK', 'tty1', 'sleep'],
      ['RUN+', 'tty1', 'ps'],
    ]);
  });

  it('SYS-02 step 21: uname -a and whoami', async () => {
    const h = await startSession();
    expect(await h.cmd('uname -a')).toMatch(/^Plotinium \d+\.\d+\.\d+ \(kernel/);
    expect(await h.cmd('whoami')).toBe('demo');
  });

  it('SYS-02 step 27: history numbers the lines typed', async () => {
    const h = await startSession();
    await h.cmd('echo a');
    await h.cmd('echo b');
    await h.cmd('pwd');
    // The shell adds a line to the history once it has run (apps/shell/history.ts).
    expect(await h.cmd('history 3')).toBe('    1  echo a\n    2  echo b\n    3  pwd');
    expect(await h.cmd('history -c; history')).toBe('');
  });

  it('SYS-02 exit ends the session with its status', async () => {
    const h = await startSession();
    await h.cmd('exit 3');
    expect(h.exits).toEqual([{ kind: 'exited', code: 3 }]);
    expect(h.host.processes()).toEqual([]);
  });
});
