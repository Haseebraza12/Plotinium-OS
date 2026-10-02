/**
 * The Terminal view's end of the TTY device (shell-and-terminal.md §3.2, SHL-01, SHL-03).
 *
 * xterm.js is the device only: it renders and turns keys into strings. The line discipline is the
 * kernel's and the line editor is the shell's. This module sits between xterm and the view port:
 * - input: `onData` strings become `tty.input` calls of at most TTY_INPUT_MAX_BYTES, never split
 *   inside a character or an escape sequence; EAGAIN (the kernel queue is full) is retried on
 *   the next animation frame, in order;
 * - output: `tty.out` batches are written to xterm one at a time, each acknowledged after xterm
 *   has parsed it, so terminal work on the main thread stays bounded per frame.
 *
 * Pure TypeScript over small interfaces, so it is testable without a DOM or xterm.
 * TODO(R1): acknowledge with `tty.ack({seq})` once the protocol has it (§4.1 requests it); until
 * then `onParsed` only reports the local sequence number.
 */
import { TTY_INPUT_MAX_BYTES } from '@plotinium/protocol';

const encoder = new TextEncoder();
// eslint-disable-next-line no-control-regex -- matching ESC is the point
const CSI_SEQ = /^\x1b\[[0-9;?]*[\x40-\x7e]/;

function utf8Length(ch: string): number {
  return encoder.encode(ch).length;
}

/** Index of an escape sequence that `text` ends inside of, or -1. */
function openEscape(text: string): number {
  const esc = text.lastIndexOf('\x1b');
  if (esc < 0 || text.length - esc > 32) return -1;
  const tail = text.slice(esc);
  if (tail.length === 1) return esc;
  if (tail[1] === '[') return CSI_SEQ.test(tail) ? -1 : esc;
  if (tail[1] === 'O') return tail.length >= 3 ? -1 : esc;
  return -1;
}

/**
 * Splits keyboard or paste text into chunks of at most `maxBytes` UTF-8 bytes. Characters and
 * escape sequences are never cut in half, so the shell's key decoder always sees them whole.
 */
export function splitInput(data: string, maxBytes = TTY_INPUT_MAX_BYTES): string[] {
  const chunks: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of data) {
    const n = utf8Length(ch);
    if (bytes + n > maxBytes && cur.length > 0) {
      const esc = openEscape(cur);
      const cut = esc > 0 ? esc : cur.length;
      chunks.push(cur.slice(0, cut));
      cur = cur.slice(cut);
      bytes = encoder.encode(cur).length;
    }
    cur += ch;
    bytes += n;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export type SendResult = 'ok' | 'again';

/** The view port's `tty.input` call: 'again' when the kernel answered EAGAIN. */
export interface InputPort {
  send(chunk: string): Promise<SendResult>;
}

/** `requestAnimationFrame` in the view; a manual clock in tests. */
export interface FrameClock {
  next(callback: () => void): void;
}

/** Sends terminal input in order, backing off one frame whenever the kernel's queue is full. */
export class InputPump {
  private readonly queue: string[] = [];
  private busy = false;
  private readonly port: InputPort;
  private readonly clock: FrameClock;
  private readonly maxBytes: number;

  constructor(port: InputPort, clock: FrameClock, maxBytes = TTY_INPUT_MAX_BYTES) {
    this.port = port;
    this.clock = clock;
    this.maxBytes = maxBytes;
  }

  push(data: string): void {
    this.queue.push(...splitInput(data, this.maxBytes));
    void this.pump();
  }

  /** Chunks not yet accepted by the kernel. */
  pending(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let chunk = this.queue[0]; chunk !== undefined; chunk = this.queue[0]) {
        if ((await this.port.send(chunk)) === 'again') {
          this.clock.next(() => void this.pump());
          return;
        }
        this.queue.shift();
      }
    } finally {
      this.busy = false;
    }
  }
}

/** xterm's `write(data, callback)`: the callback runs once xterm has parsed the data. */
export interface TermSink {
  write(data: Uint8Array, parsed: () => void): void;
}

/** Writes output batches to the terminal one at a time and reports each once it is parsed. */
export class OutputPump {
  private readonly queue: Uint8Array[] = [];
  private writing = false;
  private seq = 0;
  private readonly sink: TermSink;
  private readonly onParsed: (seq: number) => void;

  constructor(sink: TermSink, onParsed: (seq: number) => void = () => undefined) {
    this.sink = sink;
    this.onParsed = onParsed;
  }

  /** A `tty.out` batch from the view port (or from the Terminal's process host). */
  receive(data: ArrayBuffer | Uint8Array): void {
    this.queue.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    this.drain();
  }

  /** Batches received but not yet parsed (at most one is inside xterm at a time). */
  backlog(): number {
    return this.queue.length + (this.writing ? 1 : 0);
  }

  private drain(): void {
    if (this.writing) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.writing = true;
    const seq = ++this.seq;
    this.sink.write(next, () => {
      this.writing = false;
      this.onParsed(seq);
      this.drain();
    });
  }
}
