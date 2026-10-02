/**
 * A TTY of the terminal's process host (shell-and-terminal.md §3.2): the line discipline plus the
 * session, the foreground process group, the window size and the output queue.
 *
 * Output flow control (SHL-03): process output and echo are queued; the host hands the terminal at
 * most one batch per turn, at most 64 KiB, with at most 2 batches unacknowledged. The terminal
 * acknowledges a batch once xterm has parsed it. While more than 256 KiB wait, writers block.
 */
import type { JobSignal, LdiscSink, Modes } from '../ldisc.ts';
import { LineDiscipline } from '../ldisc.ts';

/** One batch handed to the terminal (§3.2 output path step 3). */
export const OUTPUT_BATCH_MAX = 65_536;
/** Unacknowledged batches at most. */
export const OUTPUT_INFLIGHT_MAX = 2;
/** Queued plus unacknowledged output at which writers block. */
export const OUTPUT_QUEUE_MAX = 262_144;

export type OutputListener = (data: Uint8Array, ack: () => void) => void;

export interface TtyEvents {
  /** Raise a job-control signal for the foreground group of this TTY. */
  signal(tty: Tty, sig: JobSignal): void;
  /** Readable input or an end of file: wake blocked readers. */
  readable(tty: Tty): void;
  /** Output space was freed: wake blocked writers. */
  space(tty: Tty): void;
  /** Output is queued and a batch could be delivered. */
  pending(tty: Tty): void;
}

export class Tty {
  readonly n: number;
  readonly ldisc: LineDiscipline;
  sid = 0;
  fgPgid = 0;
  cols: number;
  rows: number;
  /** Descriptors open on this TTY. */
  refs = 0;
  closed = false;
  private out: Uint8Array[] = [];
  private queued = 0;
  private inflight = 0;
  private unacked = 0;
  private listener: OutputListener | null = null;
  private readonly events: TtyEvents;

  constructor(n: number, size: { cols: number; rows: number }, events: TtyEvents) {
    this.n = n;
    this.cols = size.cols;
    this.rows = size.rows;
    this.events = events;
    const sink: LdiscSink = {
      output: (bytes) => this.enqueue(bytes),
      signal: (sig) => this.events.signal(this, sig),
      readable: () => this.events.readable(this),
    };
    this.ldisc = new LineDiscipline(sink);
  }

  get name(): string {
    return `tty${String(this.n)}`;
  }

  get modes(): Readonly<Modes> {
    return this.ldisc.modes;
  }

  /** Bytes queued or not yet acknowledged. */
  backlog(): number {
    return this.queued + this.unacked;
  }

  /** Whether a writer must block now. */
  full(): boolean {
    return this.backlog() >= OUTPUT_QUEUE_MAX;
  }

  /** The terminal side: receives output batches. Queued output is delivered at once. */
  attach(listener: OutputListener | null): void {
    this.listener = listener;
    if (listener !== null && this.queued > 0) this.events.pending(this);
  }

  /** Delivers at most one batch; true when one was delivered. */
  deliver(): boolean {
    const listener = this.listener;
    if (listener === null || this.queued === 0 || this.inflight >= OUTPUT_INFLIGHT_MAX) {
      return false;
    }
    const size = Math.min(this.queued, OUTPUT_BATCH_MAX);
    const batch = new Uint8Array(size);
    let off = 0;
    while (off < size) {
      const head = this.out[0];
      if (head === undefined) break;
      const take = Math.min(size - off, head.length);
      batch.set(head.subarray(0, take), off);
      off += take;
      if (take === head.length) this.out.shift();
      else this.out[0] = head.subarray(take);
    }
    this.queued -= size;
    this.inflight += 1;
    this.unacked += size;
    let acked = false;
    listener(batch, () => {
      if (acked) return;
      acked = true;
      this.inflight -= 1;
      this.unacked -= size;
      this.events.space(this);
      if (this.queued > 0) this.events.pending(this);
    });
    return true;
  }

  /** Whether a batch is waiting and could be delivered now. */
  canDeliver(): boolean {
    return this.listener !== null && this.queued > 0 && this.inflight < OUTPUT_INFLIGHT_MAX;
  }

  resize(cols: number, rows: number): boolean {
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    return true;
  }

  private enqueue(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.out.push(bytes);
    this.queued += bytes.length;
    this.events.pending(this);
  }
}
