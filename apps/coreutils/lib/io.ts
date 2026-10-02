/**
 * Standard streams for a command (shell-and-terminal.md §3.13): buffered stdout, unbuffered
 * stderr, TTY detection through `isatty`, and the per-process facts most commands need (terminal
 * width, time-zone offset, environment).
 */
import type { ProgramContext, Sys, SysGen } from './sys.ts';
import { encodeText, errnoOf } from './sys.ts';

/**
 * Thrown when stdout or stderr is a pipe whose reader has gone (EPIPE). It is not an errno, so
 * per-operand error handling (`describe`) lets it through and the command ends with 141.
 */
export class PipeClosed extends Error {
  constructor() {
    super('pipe closed');
    this.name = 'PipeClosed';
  }
}

/** Stdout is flushed at this many UTF-16 units, so a long listing costs few `write` calls. */
const FLUSH_AT = 32_768;
/** Buffered output yields to the scheduler this often even when nothing is flushed. */
const TICK_EVERY = 128;

export class Io {
  readonly cmd: string;
  readonly ctx: ProgramContext;
  readonly sys: Sys;
  private buffer: string[] = [];
  private buffered = 0;
  private sinceTick = 0;
  private readonly ttyCache = new Map<number, boolean>();
  private tz: number | undefined;
  private cols: number | undefined;

  constructor(cmd: string, ctx: ProgramContext) {
    this.cmd = cmd;
    this.ctx = ctx;
    this.sys = ctx.sys;
  }

  env(name: string): string | undefined {
    return this.ctx.env.get(name);
  }

  /** Appends to stdout; the text is written at FLUSH_AT or by `flush`. */
  *out(text: string): SysGen<void> {
    this.buffer.push(text);
    this.buffered += text.length;
    if (this.buffered >= FLUSH_AT) {
      yield* this.flush();
      return;
    }
    this.sinceTick += 1;
    if (this.sinceTick >= TICK_EVERY) {
      this.sinceTick = 0;
      yield this.ctx.tick;
    }
  }

  /** One line on stdout. */
  *line(text = ''): SysGen<void> {
    yield* this.out(`${text}\n`);
  }

  /** Every line followed by a newline. */
  *lines(lines: readonly string[]): SysGen<void> {
    for (const text of lines) yield* this.out(`${text}\n`);
  }

  *flush(): SysGen<void> {
    if (this.buffered === 0) return;
    const text = this.buffer.join('');
    this.buffer = [];
    this.buffered = 0;
    this.sinceTick = 0;
    yield* this.write(1, text);
  }

  /** A diagnostic on stderr, `<cmd>: <message>`; stdout is flushed first to keep the order. */
  *error(message: string): SysGen<void> {
    yield* this.flush();
    yield* this.write(2, `${this.cmd}: ${message}\n`);
  }

  /** Raw text on stderr (usage blocks, notices without the command prefix). */
  *errRaw(text: string): SysGen<void> {
    yield* this.flush();
    yield* this.write(2, text);
  }

  /** Writes all of `text` to `fd`, continuing after short writes. */
  *write(fd: number, text: string): SysGen<void> {
    if (text.length === 0) return;
    yield* this.writeBytes(fd, encodeText(text));
  }

  /** Raw bytes on stdout, after any buffered text (`cat` passes content through unchanged). */
  *outBytes(bytes: Uint8Array): SysGen<void> {
    yield* this.flush();
    const copy = bytes.slice();
    yield* this.writeBytes(1, copy.buffer);
  }

  *writeBytes(fd: number, buffer: ArrayBuffer): SysGen<void> {
    let data = buffer;
    while (data.byteLength > 0) {
      let res: { bytes: number };
      try {
        res = yield* this.sys.call('write', { fd, data });
      } catch (e) {
        if (errnoOf(e) === 'EPIPE') throw new PipeClosed();
        throw e;
      }
      if (res.bytes >= data.byteLength || res.bytes === 0) return;
      data = data.slice(res.bytes);
    }
  }

  /** True when `fd` is a terminal (`isatty`); cached for the life of the process. */
  *isTty(fd: number): SysGen<boolean> {
    const known = this.ttyCache.get(fd);
    if (known !== undefined) return known;
    let tty: boolean;
    try {
      tty = (yield* this.sys.call('isatty', { fd })).tty;
    } catch {
      tty = false;
    }
    this.ttyCache.set(fd, tty);
    return tty;
  }

  /** Terminal width: `$COLUMNS`, else the TTY's size, else 80. */
  *columns(): SysGen<number> {
    if (this.cols !== undefined) return this.cols;
    const fromEnv = Number(this.env('COLUMNS'));
    let cols = Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 0;
    if (cols === 0 && (yield* this.isTty(1))) {
      try {
        cols = (yield* this.sys.call('tty.getattr', { fd: 1 })).cols;
      } catch {
        cols = 0;
      }
    }
    this.cols = cols > 0 ? cols : 80;
    return this.cols;
  }

  /** Terminal height: `$LINES`, else the TTY's size, else 24. */
  *rows(): SysGen<number> {
    const fromEnv = Number(this.env('LINES'));
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
    try {
      return (yield* this.sys.call('tty.getattr', { fd: 1 })).rows;
    } catch {
      return 24;
    }
  }

  /** The local UTC offset in minutes from `time.now` (the kernel knows `$TZ`). */
  *tzOffset(): SysGen<number> {
    if (this.tz !== undefined) return this.tz;
    try {
      this.tz = (yield* this.sys.call('time.now', {})).tzOffsetMin;
    } catch {
      this.tz = 0;
    }
    return this.tz;
  }

  /**
   * The wall clock in epoch milliseconds, from `time.now`. `ctx.now()` is the executor's
   * monotonic clock, fine for intervals but not a time of day or an age (UI-119).
   */
  *wallClock(): SysGen<number> {
    try {
      const now = yield* this.sys.call('time.now', {});
      this.tz ??= now.tzOffsetMin;
      return now.epochMs;
    } catch {
      return Date.now();
    }
  }
}
