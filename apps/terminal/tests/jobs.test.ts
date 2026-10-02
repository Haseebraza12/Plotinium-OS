/**
 * Job control through the Terminal's TTY (shell-and-terminal.md §3.2, §3.8; SHL-02, SHL-08,
 * PROC-08): the keyboard's Ctrl-C and Ctrl-Z become SIGINT and SIGTSTP for the foreground process
 * group only, background readers get SIGTTIN, a resize is SIGWINCH, and a hang-up is SIGHUP.
 */
import { describe, expect, it } from 'vitest';

import { startSession } from './harness.ts';

describe('job control through the TTY', () => {
  it('SHL-02 Ctrl-C interrupts the foreground job, not the shell (status 130)', async () => {
    const h = await startSession();
    await h.keys('sleep 30\r');
    expect(h.host.processes().map((p) => p.argv[0])).toEqual(['-sh', 'sleep']);
    await h.keys('\x03');
    expect(h.screen.lines()).toContain('^C');
    expect(h.host.processes().map((p) => p.argv[0])).toEqual(['-sh']);
    expect(await h.cmd('echo $?')).toBe('130');
  });

  it('SHL-02 Ctrl-C at the prompt discards the line and keeps the shell', async () => {
    const h = await startSession();
    await h.keys('echo never');
    await h.keys('\x03');
    expect(await h.cmd('echo after')).toBe('after');
    expect(h.screen.text()).not.toMatch(/^never$/m);
    expect(h.exits).toEqual([]);
  });

  it('SHL-08 Ctrl-Z stops the job; jobs, bg and kill %1 manage it', async () => {
    const h = await startSession();
    await h.keys('sleep 30\r');
    await h.keys('\x1a');
    const lines = h.screen.lines();
    expect(lines).toContain('^Z');
    expect(lines.some((l) => /^\[1\]\+\s+Stopped\s+sleep 30$/.test(l))).toBe(true);
    expect(await h.cmd('jobs')).toMatch(/^\[1\]\+\s+Stopped\s+sleep 30$/);
    expect(await h.cmd('bg')).toBe('[1]+ sleep 30 &');
    expect(await h.cmd('jobs')).toMatch(/^\[1\]\+\s+Running\s+sleep 30 &$/);
    expect(await h.cmd('kill %1')).toMatch(/^\[1\]\+\s+Terminated\s+sleep 30/);
    expect(await h.cmd('jobs')).toBe('');
  });

  it('SHL-02 a background reader is stopped with SIGTTIN', async () => {
    const h = await startSession();
    const out = await h.cmd('cat &');
    expect(out).toMatch(/^\[1\] \d+\n\[1\]\+\s+Stopped \(tty input\)\s+cat$/);
  });

  it('SHL-02 canonical mode: a foreground cat reads lines and ends at Ctrl-D', async () => {
    const h = await startSession();
    await h.keys('cat\r');
    await h.keys('helo\x7flo\r');
    const at = h.screen.cursorRow;
    expect(h.screen.lines().slice(at - 2, at)).toEqual(['hello', 'hello']);
    await h.keys('\x04');
    expect(h.host.processes().map((p) => p.argv[0])).toEqual(['-sh']);
    expect(await h.cmd('echo $?')).toBe('0');
  });

  it('SHL-02 a resize sets the winsize and SIGWINCH updates COLUMNS and LINES', async () => {
    const h = await startSession({ cols: 100, rows: 30 });
    expect(await h.cmd('echo $COLUMNS $LINES')).toBe('100 30');
    h.link.resize(120, 40);
    await h.clock.settle();
    expect(await h.cmd('echo $COLUMNS $LINES')).toBe('120 40');
  });

  it('SHL-02 a hang-up sends SIGHUP to the session and ends it', async () => {
    const h = await startSession();
    await h.cmd('sleep 100 &');
    expect(h.host.processes()).toHaveLength(2);
    h.link.hangup(1_000);
    await h.clock.advance(1_000);
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]?.kind).toBe('signaled');
    expect(h.host.processes()).toEqual([]);
  });
});
