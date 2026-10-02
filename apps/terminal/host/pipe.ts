/**
 * A pipe of the terminal's process host (syscall-abi.md §4.4.3 `pipe`; shell-and-terminal.md
 * §3.7.3): a bounded byte queue with reader and writer counts.
 *
 * - `read` returns what is queued (up to `len`), 0 bytes once every writer has closed, or null
 *   when the caller must block;
 * - `write` takes what fits and returns how many bytes it took (the host blocks the writer for the
 *   rest), or 'epipe' when no reader is left (the writer then gets SIGPIPE and EPIPE).
 */
import { PIPE_CAPACITY_DEFAULT } from '@plotinium/protocol';

export class Pipe {
  readonly id: number;
  readonly capacity: number;
  readers = 0;
  writers = 0;
  private chunks: Uint8Array[] = [];
  private queued = 0;

  constructor(id: number, capacity = PIPE_CAPACITY_DEFAULT) {
    this.id = id;
    this.capacity = capacity;
  }

  get size(): number {
    return this.queued;
  }

  space(): number {
    return this.capacity - this.queued;
  }

  read(len: number): Uint8Array | null {
    if (this.queued === 0) return this.writers === 0 ? new Uint8Array(0) : null;
    const n = Math.min(len, this.queued);
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      if (head === undefined) break;
      const take = Math.min(n - off, head.length);
      out.set(head.subarray(0, take), off);
      off += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.queued -= n;
    return out;
  }

  write(data: Uint8Array): number | 'epipe' {
    if (this.readers === 0) return 'epipe';
    const n = Math.min(data.length, this.space());
    if (n > 0) {
      this.chunks.push(data.slice(0, n));
      this.queued += n;
    }
    return n;
  }
}
