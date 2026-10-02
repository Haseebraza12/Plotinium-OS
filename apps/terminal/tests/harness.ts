/**
 * Test-only harness for the Terminal: a manual clock for the process host, a small terminal
 * emulator (text, CR, LF, BS, cursor moves, erase; SGR ignored) and a session driver that types
 * keystrokes and reads the screen, like the SYS-02 scripted session (shell-and-terminal.md §3.15).
 */
import type { WaitStatus } from '@plotinium/protocol';

import type { HostClock, HostOptions, TerminalLink } from '../host/host.ts';
import { ProcessHost } from '../host/host.ts';
import type { RegistryOptions } from '../host/programs.ts';
import { bundledPrograms } from '../host/programs.ts';
import { FakeSys } from './fake-sys.ts';

export class ManualClock implements HostClock {
  t = 0;
  private tasks: (() => void)[] = [];
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  now(): number {
    return this.t;
  }

  setTimer(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, seq: this.seq++, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }

  defer(fn: () => void): void {
    this.tasks.push(fn);
  }

  /** Runs deferred tasks and settles promises until nothing is left to do. */
  async settle(): Promise<void> {
    for (let round = 0; round < 10_000; round++) {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const task = this.tasks.shift();
      if (task === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.tasks.length === 0) return;
        continue;
      }
      task();
    }
    throw new Error('the host did not settle');
  }

  /** Moves time forward, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await this.settle();
      const due = this.timers
        .filter((x) => x.at <= end)
        .sort((x, y) => x.at - y.at || x.seq - y.seq)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
    await this.settle();
  }
}

export class Screen {
  private rows: string[][] = [[]];
  private row = 0;
  private col = 0;
  private wrap = false;
  readonly cols: number;
  raw = '';

  constructor(cols: number) {
    this.cols = cols;
  }

  private line(r: number): string[] {
    while (this.rows.length <= r) this.rows.push([]);
    return this.rows[r] ?? [];
  }

  private put(ch: string): void {
    if (this.wrap) {
      this.row++;
      this.col = 0;
      this.wrap = false;
    }
    const l = this.line(this.row);
    while (l.length < this.col) l.push(' ');
    l[this.col] = ch;
    if (this.col === this.cols - 1) this.wrap = true;
    else this.col++;
  }

  private csi(params: string, final: string): void {
    const nums = params
      .replace(/^\?/, '')
      .split(';')
      .map((x) => (x === '' ? NaN : Number(x)));
    const first = nums[0] ?? NaN;
    const n = Number.isNaN(first) ? 1 : first;
    this.wrap = false;
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - n);
        break;
      case 'B':
        this.row += n;
        break;
      case 'C':
        this.col = Math.min(this.cols - 1, this.col + n);
        break;
      case 'D':
        this.col = Math.max(0, this.col - n);
        break;
      case 'G':
        this.col = Math.min(this.cols - 1, n - 1);
        break;
      case 'H':
        this.row = Number.isNaN(first) ? 0 : first - 1;
        this.col = Number.isNaN(nums[1] ?? NaN) ? 0 : (nums[1] ?? 1) - 1;
        break;
      case 'J':
        if (params === '2' || params === '3') this.rows = [[]];
        else {
          const l = this.line(this.row);
          l.length = Math.min(l.length, this.col);
          this.rows.length = Math.min(this.rows.length, this.row + 1);
        }
        break;
      case 'K': {
        const l = this.line(this.row);
        l.length = Math.min(l.length, this.col);
        break;
      }
      default:
        break;
    }
  }

  write(text: string): void {
    this.raw += text;
    let i = 0;
    while (i < text.length) {
      const c = text[i] ?? '';
      if (c === '\x1b') {
        // eslint-disable-next-line no-control-regex -- parsing escape sequences
        const m = /^\x1b\[([0-9;?]*)([\x40-\x7e])/.exec(text.slice(i));
        if (m !== null) {
          this.csi(m[1] ?? '', m[2] ?? '');
          i += m[0].length;
        } else i += 2;
        continue;
      }
      if (c === '\r') {
        this.col = 0;
        this.wrap = false;
      } else if (c === '\n') {
        this.row++;
        this.wrap = false;
      } else if (c === '\b') {
        this.col = Math.max(0, this.col - 1);
        this.wrap = false;
      } else if (c !== '\x07') this.put(c);
      i++;
    }
  }

  lines(): string[] {
    return this.rows.map((r) => r.join('').trimEnd());
  }

  text(): string {
    const lines = this.lines();
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }

  get cursorRow(): number {
    return this.row;
  }
}

export interface Harness {
  readonly fs: FakeSys;
  readonly clock: ManualClock;
  readonly host: ProcessHost;
  readonly link: TerminalLink;
  readonly screen: Screen;
  readonly exits: WaitStatus[];
  /** Types keys (no Enter) and lets the host settle. */
  keys(data: string): Promise<void>;
  /** Types a command line with Enter; returns the lines printed before the next prompt. */
  cmd(line: string): Promise<string>;
}

export interface HarnessOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly registry?: RegistryOptions;
  readonly host?: Partial<HostOptions>;
  readonly setup?: (fs: FakeSys) => void;
  /** Do not acknowledge output batches (flow-control tests). */
  readonly noAck?: boolean;
}

export async function startSession(opts: HarnessOptions = {}): Promise<Harness> {
  const fs = new FakeSys();
  opts.setup?.(fs);
  const clock = new ManualClock();
  const cols = opts.cols ?? 100;
  const host = new ProcessHost({
    programs: bundledPrograms(opts.registry),
    delegate: fs.call,
    clock,
    ...opts.host,
  });
  const link = await host.openTerminal({ cols, rows: opts.rows ?? 30 });
  const screen = new Screen(cols);
  const decoder = new TextDecoder();
  const exits: WaitStatus[] = [];
  link.onExit((s) => exits.push(s));
  if (opts.noAck !== true) {
    link.attach((data, ack) => {
      screen.write(decoder.decode(data, { stream: true }));
      ack();
    });
  }
  await clock.settle();
  const keys = async (data: string): Promise<void> => {
    let tries = 0;
    while (link.input(data) === 'again') {
      await clock.settle();
      if (++tries > 100) throw new Error('input queue stayed full');
    }
    await clock.settle();
  };
  const cmd = async (line: string): Promise<string> => {
    const row = screen.cursorRow;
    await keys(`${line}\r`);
    return screen
      .lines()
      .slice(row + 1, screen.cursorRow)
      .join('\n');
  };
  return { fs, clock, host, link, screen, exits, keys, cmd };
}
