/**
 * The byte stream between xterm and the TTY (shell-and-terminal.md §3.2; SHL-01, SHL-03):
 * the view-side pumps of ../tty.ts and the TTY's output flow control in the process host.
 */
import { TTY_INPUT_MAX_BYTES } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import type { HostProgram } from '../host/programs.ts';
import { OUTPUT_BATCH_MAX, OUTPUT_INFLIGHT_MAX, OUTPUT_QUEUE_MAX } from '../host/tty.ts';
import type { FrameClock, SendResult } from '../tty.ts';
import { InputPump, OutputPump, splitInput } from '../tty.ts';
import { startSession } from './harness.ts';

const enc = new TextEncoder();

class Frames implements FrameClock {
  private queue: (() => void)[] = [];
  next(callback: () => void): void {
    this.queue.push(callback);
  }
  tick(): void {
    const q = this.queue;
    this.queue = [];
    for (const fn of q) fn();
  }
  get waiting(): number {
    return this.queue.length;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('view-side input (tty.input)', () => {
  it('SHL-01 splitInput keeps chunks within the byte limit and never splits a character', () => {
    const text = 'é'.repeat(3_000); // 2 bytes each
    const chunks = splitInput(text);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) expect(enc.encode(c).length).toBeLessThanOrEqual(TTY_INPUT_MAX_BYTES);
  });

  it('SHL-01 splitInput never cuts an escape sequence in half', () => {
    const chunks = splitInput(`${'a'.repeat(6)}\x1b[1;5A`, 8);
    expect(chunks).toEqual(['aaaaaa', '\x1b[1;5A']);
  });

  it('SHL-03 EAGAIN is retried on the next frame, in order', async () => {
    const sent: string[] = [];
    let full = true;
    const frames = new Frames();
    const pump = new InputPump(
      {
        send: (chunk): Promise<SendResult> => {
          if (full) return Promise.resolve('again');
          sent.push(chunk);
          return Promise.resolve('ok');
        },
      },
      frames,
      4,
    );
    pump.push('abcdefgh');
    await flush();
    expect(sent).toEqual([]);
    expect(pump.pending()).toBe(2);
    expect(frames.waiting).toBe(1);
    full = false;
    frames.tick();
    await flush();
    expect(sent).toEqual(['abcd', 'efgh']);
    expect(pump.pending()).toBe(0);
  });
});

describe('view-side output (tty.output)', () => {
  it('SHL-03 batches are written one at a time and acknowledged after xterm parsed them', () => {
    const parsedCallbacks: (() => void)[] = [];
    const written: string[] = [];
    const acked: number[] = [];
    const pump = new OutputPump(
      {
        write: (data, parsed) => {
          written.push(new TextDecoder().decode(data));
          parsedCallbacks.push(parsed);
        },
      },
      (seq) => acked.push(seq),
    );
    pump.receive(enc.encode('one'));
    pump.receive(enc.encode('two'));
    expect(written).toEqual(['one']);
    expect(pump.backlog()).toBe(2);
    parsedCallbacks.shift()?.();
    expect(written).toEqual(['one', 'two']);
    expect(acked).toEqual([1]);
    parsedCallbacks.shift()?.();
    expect(acked).toEqual([1, 2]);
    expect(pump.backlog()).toBe(0);
  });
});

/** Writes `total` bytes of 'x' to stdout in 16 KiB writes, then exits. */
const flood: HostProgram = {
  init: (argv) => ({ total: Number(argv[1] ?? '0'), done: 0 }),
  *run(ctx: never, st: never): Generator<unknown, number | undefined, unknown> {
    const c = ctx as {
      sys: { call(name: string, args: unknown): Generator<unknown, unknown, unknown> };
    };
    const s = st as { total: number; done: number };
    while (s.done < s.total) {
      const n = Math.min(16_384, s.total - s.done);
      yield* c.sys.call('write', { fd: 1, data: new Uint8Array(n).fill(0x78).buffer });
      s.done += n;
    }
    return 0;
  },
};

describe('TTY output flow control in the process host', () => {
  it(`SHL-03 batches are at most ${String(OUTPUT_BATCH_MAX)} bytes, ${String(OUTPUT_INFLIGHT_MAX)} unacknowledged, and writers block at ${String(OUTPUT_QUEUE_MAX)}`, async () => {
    const h = await startSession({ registry: { extra: { flood } }, noAck: true });
    const batches: { size: number; ack: () => void }[] = [];
    let received = 0;
    h.link.attach((data, ack) => {
      received += data.length;
      batches.push({ size: data.length, ack });
    });
    await h.clock.settle();
    for (const b of batches.splice(0)) b.ack();
    await h.clock.settle();
    received = 0;
    const total = 1_000_000;
    h.link.input(`flood ${String(total)}\r`);
    await h.clock.settle();
    // Nothing is acknowledged: two batches in flight, the writer blocked on a full queue.
    expect(batches.length).toBe(OUTPUT_INFLIGHT_MAX);
    expect(batches.every((b) => b.size <= OUTPUT_BATCH_MAX)).toBe(true);
    const state = h.host.processes().find((p) => p.argv[0] === 'flood')?.state;
    expect(state).toBe('blocked:tty:output');
    let largest = 0;
    for (let round = 0; round < 1_000 && batches.length > 0; round++) {
      const b = batches.shift();
      largest = Math.max(largest, b?.size ?? 0);
      b?.ack();
      await h.clock.settle();
      expect(batches.length).toBeLessThanOrEqual(OUTPUT_INFLIGHT_MAX);
    }
    expect(largest).toBe(OUTPUT_BATCH_MAX);
    expect(h.host.processes().map((p) => p.argv[0])).toEqual(['-sh']);
    expect(received).toBeGreaterThan(total);
  });
});
