/**
 * The `term` process (../proc.ts; shell-and-terminal.md §3.3): with a kernel TTY it opens the TTY
 * and spawns the login shell on it; without one it owns the window until SIGTERM, and the view's
 * process host runs the shell.
 */
import type { ProgramContext, Sys } from '@plotinium/kernel/sys';
import { createSys, SysError, TICK } from '@plotinium/kernel/sys';
import { describe, expect, it } from 'vitest';

import type { TermState } from '../proc.ts';
import { SHELL_MANIFEST, term } from '../proc.ts';

type Reply = (args: Record<string, unknown>) => unknown;

/** Runs `term` against scripted kernel replies until it blocks on `stopAt` or exits. */
function drive(
  replies: Readonly<Record<string, Reply>>,
  opts: { env?: Record<string, string>; stopAt?: string } = {},
): {
  st: TermState;
  calls: string[];
  exit: number | null;
  /** Ends the blocked call with ECANCELED (a caught signal). */
  resume: () => number | null;
  /** Ends the blocked call with a value (a sleep that ran out). */
  wake: (value?: unknown) => number | null;
  ctx: ProgramContext;
} {
  const sys: Sys = createSys();
  const ctx: ProgramContext = {
    pid: 40,
    ppid: 1,
    pgid: 40,
    sid: 40,
    uid: 1000,
    gid: 1000,
    argv: ['terminal'],
    env: new Map(Object.entries(opts.env ?? {})),
    cwd: '/home/demo',
    tty: null,
    restored: 'no',
    sys,
    tick: TICK,
    now: () => 0,
    *sleep() {
      // not used by term
    },
    *sleepUntil() {
      // not used by term
    },
  };
  const st = term.init(['terminal']);
  const gen = term.run(ctx, st);
  const calls: string[] = [];
  let input: { ok: true; v: unknown } | { ok: false; e: unknown } | null = null;
  const step = (): number | null => {
    for (let i = 0; i < 100; i++) {
      const r = input === null ? gen.next() : input.ok ? gen.next(input.v) : gen.throw(input.e);
      input = null;
      if (r.done === true) return r.value ?? 0;
      const req = r.value as { call: string; args: Record<string, unknown> };
      calls.push(req.call);
      if (req.call === opts.stopAt) return null;
      const reply = replies[req.call];
      try {
        input = { ok: true, v: reply === undefined ? {} : reply(req.args) };
      } catch (e) {
        input = { ok: false, e };
      }
    }
    throw new Error('term did not block');
  };
  const exit = step();
  return {
    st,
    calls,
    exit,
    ctx,
    resume: () => {
      input = { ok: false, e: new SysError('ECANCELED') };
      return step();
    },
    wake: (value: unknown = {}) => {
      input = { ok: true, v: value };
      return step();
    },
  };
}

/** The process's end of a display channel, recording what it posts. */
class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  /** The view posts one relayed call. */
  input(id: number, call: string, args: unknown): void {
    this.onmessage?.({
      data: { t: 'input', seq: id, ev: { kind: 'sys', id, call, args } },
    } as MessageEvent);
  }
}

const cred: Reply = () => ({
  uid: 1000,
  gid: 1000,
  user: 'demo',
  home: '/home/demo',
  ruid: 1000,
  groups: [],
  groupNames: [],
});

describe('the term process', () => {
  it('SYS-02 with a kernel TTY: window, tty.open, then the login shell on the TTY', () => {
    let spawned: Record<string, unknown> = {};
    const r = drive(
      {
        'proc.cred': cred,
        'window.create': () => ({ wid: 7, rect: { x: 0, y: 0, w: 1, h: 1 } }),
        'tty.open': () => ({ fd: 3, n: 2 }),
        spawn: (a) => {
          spawned = a;
          return { pid: 41 };
        },
      },
      { stopAt: 'wait' },
    );
    expect(r.calls).toEqual([
      'sig.action',
      'sig.action',
      'proc.cred',
      'window.create',
      'tty.open',
      'spawn',
      'wait',
    ]);
    expect(spawned).toMatchObject({
      path: SHELL_MANIFEST,
      argv: ['-sh'],
      fds: { 0: 3, 1: 3, 2: 3 },
      pgid: 0,
      cwd: '/home/demo',
    });
    expect(r.st).toMatchObject({
      phase: 'running',
      wid: 7,
      tty: 2,
      shPid: 41,
      title: 'demo@plotinium: ~',
    });
  });

  it('SYS-02 without a kernel TTY it owns the host’s window until SIGTERM', () => {
    const r = drive(
      {
        'proc.cred': cred,
        'tty.open': () => {
          throw new SysError('ENOSYS');
        },
      },
      { env: { PLT_WINDOW: '9' }, stopAt: 'sleep' },
    );
    expect(r.calls).not.toContain('window.create');
    expect(r.st).toMatchObject({ phase: 'owner', wid: 9, hostWindow: true, ttyError: 'ENOSYS' });
    term.signal?.(r.ctx, r.st, 'SIGTERM');
    expect(r.resume()).toBe(0);
    // The host created the window, so the host closes it.
    expect(r.calls.at(-1)).toBe('sleep');
  });

  it('SYS-01 without a kernel TTY it makes the view’s executor calls as itself, in order', () => {
    const port = new FakePort();
    const made: { call: string; args: Record<string, unknown> }[] = [];
    const record =
      (call: string, value: unknown): Reply =>
      (args) => {
        made.push({ call, args });
        return value;
      };
    const r = drive(
      {
        'proc.cred': cred,
        'window.create': () => ({ wid: 7, rect: { x: 0, y: 0, w: 1, h: 1 }, display: port }),
        'tty.open': () => {
          throw new SysError('ENOSYS');
        },
        mkdir: record('mkdir', { ino: 'i-1' }),
        unlink: () => {
          throw new SysError('ENOENT', 'no such file');
        },
      },
      { stopAt: 'sleep' },
    );
    expect(r.st).toMatchObject({ phase: 'owner', wid: 7, hostWindow: false, ttyError: 'ENOSYS' });
    expect(port.onmessage).not.toBeNull();
    port.input(1, 'mkdir', { path: '/home/demo/t', mode: 0o755 });
    port.input(2, 'unlink', { path: '/home/demo/nope' });
    // `exit`, `spawn` and `su` would act on term itself: refused before any system call.
    port.input(3, 'exit', { code: 0 });
    port.input(4, 'su', { user: 'root' });
    expect(r.wake()).toBeNull();
    expect(made).toEqual([{ call: 'mkdir', args: { path: '/home/demo/t', mode: 0o755 } }]);
    expect(port.posted).toEqual([
      { t: 'reply', id: 1, ok: true, value: { ino: 'i-1' } },
      { t: 'reply', id: 2, ok: false, errno: 'ENOENT', message: 'no such file' },
      {
        t: 'reply',
        id: 3,
        ok: false,
        errno: 'EPERM',
        message: 'exit is not relayed for this window',
      },
      {
        t: 'reply',
        id: 4,
        ok: false,
        errno: 'EPERM',
        message: 'su is not relayed for this window',
      },
    ]);
    expect(r.st.served).toBe(4);
    expect(r.calls.filter((c) => c === 'exit' || c === 'su')).toEqual([]);
    // SIGTERM (the window's close button): the channel is released and term closes its window.
    term.signal?.(r.ctx, r.st, 'SIGTERM');
    expect(r.resume()).toBe(0);
    expect(port.onmessage).toBeNull();
    expect(r.calls.at(-1)).toBe('window.close');
  });

  it('SYS-01 the relay allow-list holds only executor calls and never one that acts on term', async () => {
    const { lookupCall } = await import('@plotinium/protocol');
    const { TERMINAL_RELAY_CALLS, descriptor } = await import('../manifest.ts');
    expect(descriptor.relay).toBe(TERMINAL_RELAY_CALLS);
    for (const call of TERMINAL_RELAY_CALLS) expect(lookupCall(call)?.origin).toBe('E');
    for (const call of [
      'exit',
      'spawn',
      'wait',
      'chdir',
      'tty.open',
      'window.create',
      'su',
      'sleep',
    ]) {
      expect(TERMINAL_RELAY_CALLS as readonly string[]).not.toContain(call);
    }
  });
});
