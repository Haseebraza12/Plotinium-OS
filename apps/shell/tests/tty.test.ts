import { describe, expect, it } from 'vitest';

import type { SendResult } from '../../terminal/tty.ts';
import { InputPump, OutputPump, splitInput } from '../../terminal/tty.ts';

const enc = new TextEncoder();

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('terminal input chunking (§3.2 input path)', () => {
  it('SHL-03 pastes are split into chunks of at most the input limit, never inside a character', () => {
    const text = `${'a'.repeat(5)}中文${'b'.repeat(3)}`;
    const chunks = splitInput(text, 8);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) expect(enc.encode(c).length).toBeLessThanOrEqual(8);
    expect(chunks).toEqual(['aaaaa中', '文bbb']);
    expect(splitInput('😀😀', 4)).toEqual(['😀', '😀']);
  });

  it('SHL-03 an escape sequence is never split between two chunks', () => {
    expect(splitInput('abcd\x1b[A', 6)).toEqual(['abcd', '\x1b[A']);
    expect(splitInput('abcde\x1bOH', 7)).toEqual(['abcde', '\x1bOH']);
    expect(splitInput('ab\x1b[Axyz', 6)).toEqual(['ab\x1b[Ax', 'yz']);
    expect(splitInput('', 4)).toEqual([]);
  });

  it('SHL-03 input is sent in order and EAGAIN is retried on the next animation frame', async () => {
    const sent: string[] = [];
    const answers: SendResult[] = ['ok', 'again', 'ok', 'ok'];
    const frames: (() => void)[] = [];
    const pump = new InputPump(
      {
        send: (chunk) => {
          sent.push(chunk);
          return Promise.resolve(answers.shift() ?? 'ok');
        },
      },
      { next: (cb) => frames.push(cb) },
      4,
    );
    pump.push('abcdefgh');
    pump.push('ij');
    await settle();
    expect(sent).toEqual(['abcd', 'efgh']);
    expect(pump.pending()).toBe(2);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await settle();
    expect(sent).toEqual(['abcd', 'efgh', 'efgh', 'ij']);
    expect(pump.pending()).toBe(0);
  });
});

describe('terminal output batches (§3.2 output path)', () => {
  it('SHL-03 at most one tty.output batch is inside xterm at a time and each is acknowledged after parsing', () => {
    const written: string[] = [];
    const callbacks: (() => void)[] = [];
    const acked: number[] = [];
    const pump = new OutputPump(
      {
        write: (data, parsed) => {
          written.push(new TextDecoder().decode(data));
          callbacks.push(parsed);
        },
      },
      (seq) => acked.push(seq),
    );
    for (const s of ['one', 'two', 'three']) pump.receive(enc.encode(s).buffer);
    expect(written).toEqual(['one']);
    expect(pump.backlog()).toBe(3);
    callbacks.shift()?.();
    expect(written).toEqual(['one', 'two']);
    callbacks.shift()?.();
    callbacks.shift()?.();
    expect(written).toEqual(['one', 'two', 'three']);
    expect(acked).toEqual([1, 2, 3]);
    expect(pump.backlog()).toBe(0);
    const quiet = new OutputPump({ write: (_d, parsed) => parsed() });
    quiet.receive(new ArrayBuffer(1));
    expect(quiet.backlog()).toBe(0);
  });
});
