/**
 * The TTY line discipline (shell-and-terminal.md §3.2, SHL-02; §3.11, SHL-14, AGT-03).
 *
 * Pure TypeScript, no timers and no DOM: it turns the keyboard bytes of the terminal (the master
 * side) into what processes read from the TTY (the slave side), and turns what processes write into
 * the bytes the terminal renders. It implements the termios subset of §3.2:
 *
 * - `isig`: VINTR (Ctrl-C) discards pending input, echoes `^C` and raises SIGINT for the foreground
 *   process group; VSUSP (Ctrl-Z) echoes `^Z` and raises SIGTSTP; VQUIT (Ctrl-\) raises SIGQUIT;
 * - `icrnl`: CR becomes LF on input;
 * - canonical mode: the line is edited in place (VERASE, VWERASE, VKILL) and becomes readable on
 *   LF; VEOF on an empty line makes the next read return 0 bytes; lines are limited to 4,096 bytes
 *   (further bytes ring the bell);
 * - raw mode: bytes are readable as they arrive (VMIN 1);
 * - `echo` and `onlcr` (LF becomes CR LF on output);
 * - a 64 KiB input queue: input that does not fit is refused whole ('again', the view retries on
 *   its next animation frame).
 *
 * The confirmation takeover (§3.11) is also here: while it is active every keyboard byte goes to
 * the takeover and nowhere else, pending type-ahead is discarded when it starts, bytes inside a
 * bracketed paste are ignored, and processes cannot read. Only the owner of the discipline (the
 * kernel, or the terminal's process host acting as the kernel) can start one; a process's stdin is
 * never consulted, so `yes | ai …` cannot answer the prompt (AGT-03).
 */

export const VINTR = 0x03;
export const VEOF = 0x04;
export const VKILL = 0x15;
export const VWERASE = 0x17;
export const VSUSP = 0x1a;
export const VQUIT = 0x1c;
export const VERASE = 0x7f;
const BS = 0x08;
const LF = 0x0a;
const CR = 0x0d;
const ESC = 0x1b;
const BEL = 0x07;
const TAB = 0x09;

/** Canonical line length limit, including the LF (§3.2 input path step 4). */
export const LINE_MAX = 4_096;
/** Input queue size (§3.2 input path step 6). */
export const INPUT_QUEUE_MAX = 65_536;

export interface Modes {
  canonical: boolean;
  echo: boolean;
  isig: boolean;
  icrnl: boolean;
  onlcr: boolean;
  /** The alternate screen is in use (full-screen programs); informational for the view. */
  altScreen: boolean;
}

/** §3.2 defaults: canonical, echo, isig, icrnl and onlcr on. */
export const DEFAULT_MODES: Readonly<Modes> = Object.freeze({
  canonical: true,
  echo: true,
  isig: true,
  icrnl: true,
  onlcr: true,
  altScreen: false,
});

export type JobSignal = 'SIGINT' | 'SIGTSTP' | 'SIGQUIT';
export type ConfirmKey = 'yes' | 'no' | 'edit';

/** Where the discipline sends its effects. */
export interface LdiscSink {
  /** Bytes for the terminal (echo and process output, after output processing). */
  output(bytes: Uint8Array): void;
  /** Raise a job-control signal for the foreground process group. */
  signal(sig: JobSignal): void;
  /** New readable data (or an end of file) for blocked readers. */
  readable(): void;
}

interface Segment {
  bytes: number[];
  /** A VEOF on an empty line: the read that reaches it returns 0 bytes. */
  eof: boolean;
  /** Canonical data ends at this segment's end: a read never crosses it. */
  line: boolean;
}

const PASTE_START = [ESC, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // ESC [ 2 0 0 ~
const PASTE_END = [ESC, 0x5b, 0x32, 0x30, 0x31, 0x7e]; // ESC [ 2 0 1 ~

interface Takeover {
  onKey(key: ConfirmKey): void;
  /** Bytes of a possible bracketed-paste marker seen so far. */
  pending: number[];
  inPaste: boolean;
  answered: boolean;
}

const encoder = new TextEncoder();

function isContinuation(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

function isSpace(b: number): boolean {
  return b === 0x20 || b === TAB;
}

/** Visible cells an echoed byte sequence took (control characters echo as `^X`). */
function echoWidth(char: readonly number[]): number {
  const first = char[0] ?? 0;
  if (first < 0x20 && first !== TAB) return 2;
  return 1;
}

export class LineDiscipline {
  private modesNow: Modes = { ...DEFAULT_MODES };
  private line: number[] = [];
  private ready: Segment[] = [];
  private readyBytes = 0;
  private lastOut = -1;
  private takeover: Takeover | null = null;
  private saved: Modes | null = null;
  private hung = false;
  private readonly sink: LdiscSink;

  constructor(sink: LdiscSink, modes: Partial<Modes> = {}) {
    this.sink = sink;
    this.modesNow = { ...DEFAULT_MODES, ...modes };
  }

  get modes(): Readonly<Modes> {
    return this.modesNow;
  }

  get hungUp(): boolean {
    return this.hung;
  }

  /** A confirmation takeover is in progress: processes cannot read. */
  get takingOver(): boolean {
    return this.takeover !== null;
  }

  /** Bytes queued for readers plus the line being edited. */
  pending(): number {
    return this.readyBytes + this.line.length;
  }

  /** Changes modes (`tty.setattr`). Leaving canonical mode makes the partial line readable. */
  setModes(change: Partial<Modes>): Readonly<Modes> {
    const wasCanonical = this.modesNow.canonical;
    this.modesNow = { ...this.modesNow, ...change };
    if (wasCanonical && !this.modesNow.canonical && this.line.length > 0) {
      this.pushReady(this.line, false, false);
      this.line = [];
      this.sink.readable();
    }
    return this.modesNow;
  }

  /**
   * Keyboard input from the terminal (`tty.input`). Returns 'again' when the input queue cannot
   * take all of it; nothing is consumed then.
   */
  input(data: string | Uint8Array): 'ok' | 'again' {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (this.hung) return 'ok';
    if (this.takeover !== null) {
      for (const b of bytes) this.takeoverByte(b);
      return 'ok';
    }
    if (this.pending() + bytes.length > INPUT_QUEUE_MAX) return 'again';
    const echo: number[] = [];
    let wake = false;
    for (let i = 0; i < bytes.length; i++) {
      let b = bytes[i] ?? 0;
      // A takeover can start from inside a signal handler (never here), so it is re-checked.
      if (this.takeover !== null) {
        this.takeoverByte(b);
        continue;
      }
      if (this.modesNow.isig && (b === VINTR || b === VSUSP || b === VQUIT)) {
        if (b !== VSUSP) this.discardInput();
        if (this.modesNow.echo) {
          const caret = b === VINTR ? 'C' : b === VSUSP ? 'Z' : '\\';
          echo.push(0x5e, caret.charCodeAt(0), LF);
        }
        this.flushEcho(echo);
        this.sink.signal(b === VINTR ? 'SIGINT' : b === VSUSP ? 'SIGTSTP' : 'SIGQUIT');
        continue;
      }
      if (this.modesNow.icrnl && b === CR) b = LF;
      if (!this.modesNow.canonical) {
        this.pushReady([b], false, false);
        if (this.modesNow.echo) this.echoByte(b, echo);
        wake = true;
        continue;
      }
      wake = this.canonicalByte(b, echo) || wake;
    }
    this.flushEcho(echo);
    if (wake) this.sink.readable();
    return 'ok';
  }

  /**
   * What a reader gets now: up to `max` bytes, an empty array at end of file, or null when the
   * read must block. A canonical read returns at most one line.
   */
  read(max: number): Uint8Array | null {
    if (this.takeover !== null) return null;
    const seg = this.ready[0];
    if (seg === undefined) return this.hung ? new Uint8Array(0) : null;
    if (seg.eof) {
      this.ready.shift();
      return new Uint8Array(0);
    }
    const out: number[] = [];
    while (out.length < max) {
      const s = this.ready[0];
      if (s === undefined || s.eof) break;
      const take = Math.min(max - out.length, s.bytes.length);
      out.push(...s.bytes.splice(0, take));
      this.readyBytes -= take;
      if (s.bytes.length === 0) {
        this.ready.shift();
        if (s.line) break;
      } else break;
    }
    return Uint8Array.from(out);
  }

  /** Process output (`write` on a TTY descriptor), with output processing applied. */
  write(data: Uint8Array): void {
    if (data.length === 0) return;
    if (!this.modesNow.onlcr) {
      this.lastOut = data[data.length - 1] ?? -1;
      this.sink.output(data);
      return;
    }
    let extra = 0;
    let prev = this.lastOut;
    for (const b of data) {
      if (b === LF && prev !== CR) extra++;
      prev = b;
    }
    if (extra === 0) {
      this.lastOut = prev;
      this.sink.output(data);
      return;
    }
    const out = new Uint8Array(data.length + extra);
    let j = 0;
    prev = this.lastOut;
    for (const b of data) {
      if (b === LF && prev !== CR) out[j++] = CR;
      out[j++] = b;
      prev = b;
    }
    this.lastOut = prev;
    this.sink.output(out);
  }

  /** Discards the line being edited and everything not yet read. */
  discardInput(): void {
    this.line = [];
    this.ready = [];
    this.readyBytes = 0;
  }

  /**
   * Starts a confirmation takeover (§3.11 step 3): pending input is discarded, the modes are saved
   * and switched to raw without echo, and the next accepted key is reported once to `onKey`.
   */
  beginTakeover(onKey: (key: ConfirmKey) => void): void {
    if (this.takeover !== null) throw new Error('a confirmation is already in progress');
    this.discardInput();
    this.saved = { ...this.modesNow };
    this.modesNow = { ...this.modesNow, canonical: false, echo: false, isig: false };
    this.takeover = { onKey, pending: [], inPaste: false, answered: false };
  }

  /** Ends the takeover (§3.11 step 8): the saved modes return and reads resume. */
  endTakeover(): void {
    if (this.takeover === null) return;
    this.takeover = null;
    if (this.saved !== null) this.modesNow = this.saved;
    this.saved = null;
    this.sink.readable();
  }

  /** Hang-up: later reads return 0 bytes and input is dropped. */
  hangup(): void {
    this.hung = true;
    this.takeover = null;
    this.sink.readable();
  }

  // -------------------------------------------------------------------------------------------

  private pushReady(bytes: number[], eof: boolean, line: boolean): void {
    const last = this.ready.at(-1);
    if (!eof && !line && last !== undefined && !last.eof && !last.line) {
      last.bytes.push(...bytes);
    } else {
      this.ready.push({ bytes: [...bytes], eof, line });
    }
    this.readyBytes += bytes.length;
  }

  private flushEcho(echo: number[]): void {
    if (echo.length === 0) return;
    this.write(Uint8Array.from(echo));
    echo.length = 0;
  }

  private echoByte(b: number, echo: number[]): void {
    if (b === LF || b === TAB || b >= 0x20) echo.push(b);
    else echo.push(0x5e, b + 0x40);
  }

  /** Removes the last character of the line; returns its bytes (empty when the line is empty). */
  private popChar(): number[] {
    const char: number[] = [];
    while (this.line.length > 0) {
      const b = this.line.pop() ?? 0;
      char.unshift(b);
      if (!isContinuation(b)) break;
    }
    return char;
  }

  private rubout(char: readonly number[], echo: number[]): void {
    if (!this.modesNow.echo || char.length === 0) return;
    for (let i = 0; i < echoWidth(char); i++) echo.push(BS, 0x20, BS);
  }

  /** One byte in canonical mode; true when a line (or EOF) became readable. */
  private canonicalByte(b: number, echo: number[]): boolean {
    if (b === VERASE || b === BS) {
      this.rubout(this.popChar(), echo);
      return false;
    }
    if (b === VKILL) {
      while (this.line.length > 0) this.rubout(this.popChar(), echo);
      return false;
    }
    if (b === VWERASE) {
      while (this.line.length > 0 && isSpace(this.line.at(-1) ?? 0)) {
        this.rubout(this.popChar(), echo);
      }
      while (this.line.length > 0 && !isSpace(this.line.at(-1) ?? 0)) {
        this.rubout(this.popChar(), echo);
      }
      return false;
    }
    if (b === VEOF) {
      if (this.line.length === 0) this.pushReady([], true, false);
      else this.pushReady(this.line, false, true);
      this.line = [];
      return true;
    }
    if (b === LF) {
      this.line.push(LF);
      this.pushReady(this.line, false, true);
      this.line = [];
      if (this.modesNow.echo) echo.push(LF);
      return true;
    }
    if (this.line.length >= LINE_MAX - 1) {
      echo.push(BEL);
      return false;
    }
    this.line.push(b);
    if (this.modesNow.echo) this.echoByte(b, echo);
    return false;
  }

  private takeoverByte(b: number): void {
    const t = this.takeover;
    if (t === null || t.answered) return;
    // Bracketed paste markers: everything between them is ignored (§3.11 step 5).
    if (t.pending.length > 0 || b === ESC) {
      t.pending.push(b);
      const marker = t.inPaste ? PASTE_END : PASTE_START;
      const other = t.inPaste ? PASTE_START : PASTE_END;
      const matches = (m: readonly number[]): boolean => t.pending.every((x, i) => m[i] === x);
      if (matches(marker)) {
        if (t.pending.length === marker.length) {
          t.inPaste = !t.inPaste;
          t.pending = [];
        }
        return;
      }
      if (matches(other) && t.pending.length < other.length) return;
      // Not a paste marker: a lone ESC or another escape sequence is an unrecognised key.
      t.pending = [];
      if (!t.inPaste) this.bell();
      return;
    }
    if (t.inPaste) return;
    let key: ConfirmKey | null = null;
    if (b === 0x79 || b === 0x59)
      key = 'yes'; // y Y
    else if (b === 0x6e || b === 0x4e || b === CR || b === LF || b === VINTR) key = 'no';
    else if (b === 0x65 || b === 0x45) key = 'edit'; // e E
    if (key === null) {
      this.bell();
      return;
    }
    t.answered = true;
    t.onKey(key);
  }

  private bell(): void {
    this.sink.output(Uint8Array.of(BEL));
  }
}
