/**
 * Test-only harness: a fake kernel with the test-double programs installed and an interactive
 * shell on its TTY, driven by keystrokes like the SYS-02 scripted session.
 */
import type { Program } from '../../src/_sys.ts';
import shell from '../proc.ts';
import type { ShellState } from '../state.ts';
import type { KernelOptions } from './fake-kernel.ts';
import { FakeKernel } from './fake-kernel.ts';
import * as progs from './programs.ts';

export const PROMPT = 'demo@plotinium:~$ ';

export interface SessionOptions extends KernelOptions {
  argv?: string[];
  env?: Record<string, string>;
  /** Extra programs to install, by name. */
  programs?: Record<string, Program<unknown>>;
  /** Install `/bin/echo.json` (the program version of the builtin). */
  echoProgram?: boolean;
  setup?: (k: FakeKernel) => void;
}

export function newKernel(opts: SessionOptions = {}): FakeKernel {
  const k = new FakeKernel({ cols: 160, ...opts });
  const table: Record<string, Program<unknown>> = {
    sh: shell,
    cat: progs.cat,
    grep: progs.grep,
    args: progs.args,
    printenv: progs.printenv,
    sleep: progs.sleep,
    top: progs.top,
    yes: progs.yes,
    head: progs.head,
    status: progs.status,
    readtty: progs.readtty,
    ...(opts.echoProgram === true ? { echo: progs.echoProgram } : {}),
    ...opts.programs,
  };
  for (const [name, p] of Object.entries(table)) k.install(name, p);
  opts.setup?.(k);
  return k;
}

export class Session {
  readonly k: FakeKernel;
  readonly pid: number;

  constructor(opts: SessionOptions = {}) {
    this.k = newKernel(opts);
    this.pid = this.k.start(shell, opts.argv ?? ['-sh'], { env: opts.env ?? {} });
    this.k.run();
  }

  get st(): ShellState {
    return this.k.proc(this.pid)?.st as ShellState;
  }

  /** Types a line (Enter included) and returns what appeared between it and the next prompt. */
  cmd(line: string): string {
    const row = this.k.screen.cursor().row;
    this.k.send(`${line}\r`);
    return this.since(row);
  }

  /** Screen lines after `row` up to (not including) the cursor's line. */
  since(row: number): string {
    const lines = this.k.screen.lines();
    return lines.slice(row + 1, this.k.screen.cursor().row).join('\n');
  }

  /** The line the cursor is on (the prompt and what is typed). */
  current(): string {
    return this.k.screen.lines()[this.k.screen.cursor().row] ?? '';
  }

  keys(data: string): void {
    this.k.send(data);
  }

  exited(): boolean {
    return this.k.proc(this.pid)?.state !== 'run';
  }
}

/** Runs `sh -c TEXT` (non-interactive) and returns the screen text and exit status. */
export function runC(
  text: string,
  opts: SessionOptions = {},
  extra: string[] = [],
): { out: string; code: number | null; k: FakeKernel } {
  const k = newKernel(opts);
  const pid = k.start(shell, ['sh', '-c', text, ...extra], { env: opts.env ?? {} });
  k.run();
  const status = k.exitStatus(pid);
  return { out: k.screen.text(), code: status?.kind === 'exited' ? status.code : null, k };
}
