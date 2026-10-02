/**
 * The line discipline (shell-and-terminal.md §3.2 termios subset; SHL-02) and its confirmation
 * takeover (§3.11; SHL-14, AGT-03), as a pure unit with a recording sink.
 */
import { describe, expect, it } from 'vitest';

import type { ConfirmKey, JobSignal } from '../ldisc.ts';
import { INPUT_QUEUE_MAX, LINE_MAX, LineDiscipline } from '../ldisc.ts';

const dec = new TextDecoder();

function setup(): {
  ld: LineDiscipline;
  out: () => string;
  signals: JobSignal[];
  wakes: () => number;
  read: (max?: number) => string | null;
} {
  let text = '';
  let wakes = 0;
  const signals: JobSignal[] = [];
  const ld = new LineDiscipline({
    output: (b) => {
      text += dec.decode(b);
    },
    signal: (s) => signals.push(s),
    readable: () => {
      wakes += 1;
    },
  });
  return {
    ld,
    out: () => text,
    signals,
    wakes: () => wakes,
    read: (max = 4_096) => {
      const r = ld.read(max);
      return r === null ? null : dec.decode(r);
    },
  };
}

describe('canonical mode', () => {
  it('SHL-02 a line becomes readable at Enter (CR→LF) and is echoed with CR LF', () => {
    const t = setup();
    t.ld.input('ls -l');
    expect(t.read()).toBeNull();
    t.ld.input('\r');
    expect(t.read()).toBe('ls -l\n');
    expect(t.out()).toBe('ls -l\r\n');
    expect(t.wakes()).toBe(1);
  });

  it('SHL-02 a read returns at most one line', () => {
    const t = setup();
    t.ld.input('one\rtwo\r');
    expect(t.read()).toBe('one\n');
    expect(t.read()).toBe('two\n');
    expect(t.read()).toBeNull();
  });

  it('SHL-02 VERASE removes a whole UTF-8 character; VWERASE a word; VKILL the line', () => {
    const t = setup();
    t.ld.input('naïve\x7f\x7f\r');
    expect(t.read()).toBe('naï\n');
    t.ld.input('echo two words\x17\r');
    expect(t.read()).toBe('echo two \n');
    t.ld.input('gone\x15kept\r');
    expect(t.read()).toBe('kept\n');
  });

  it('SHL-02 VEOF on an empty line reads 0 bytes; after text it ends the read without LF', () => {
    const t = setup();
    t.ld.input('\x04');
    expect(t.read()).toBe('');
    t.ld.input('abc\x04');
    expect(t.read()).toBe('abc');
  });

  it(`SHL-02 lines stop at ${String(LINE_MAX)} bytes and ring the bell`, () => {
    const t = setup();
    t.ld.input('x'.repeat(LINE_MAX + 10));
    expect(t.out().endsWith('\x07')).toBe(true);
    t.ld.input('\r');
    expect(t.read(LINE_MAX * 2)).toHaveLength(LINE_MAX);
  });

  it('SHL-03 input that does not fit the 64 KiB queue is refused whole (again)', () => {
    const t = setup();
    t.ld.setModes({ canonical: false, echo: false });
    expect(t.ld.input(new Uint8Array(INPUT_QUEUE_MAX - 1))).toBe('ok');
    expect(t.ld.input('ab')).toBe('again');
    expect(t.ld.pending()).toBe(INPUT_QUEUE_MAX - 1);
  });
});

describe('ISIG', () => {
  it('SHL-02 Ctrl-C discards pending input, echoes ^C and raises SIGINT', () => {
    const t = setup();
    t.ld.input('half a line');
    t.ld.input('\x03');
    expect(t.signals).toEqual(['SIGINT']);
    expect(t.out().endsWith('^C\r\n')).toBe(true);
    expect(t.ld.pending()).toBe(0);
  });

  it('SHL-02 Ctrl-Z raises SIGTSTP and Ctrl-\\ SIGQUIT', () => {
    const t = setup();
    t.ld.input('\x1a\x1c');
    expect(t.signals).toEqual(['SIGTSTP', 'SIGQUIT']);
  });

  it('SHL-02 without isig the control bytes are data (raw mode)', () => {
    const t = setup();
    t.ld.setModes({ canonical: false, echo: false, isig: false });
    t.ld.input('\x03\x1a');
    expect(t.signals).toEqual([]);
    expect(t.read()).toBe('\x03\x1a');
  });
});

describe('raw mode and output processing', () => {
  it('SHL-02 raw mode makes bytes readable as they arrive', () => {
    const t = setup();
    t.ld.setModes({ canonical: false });
    t.ld.input('a');
    expect(t.read()).toBe('a');
  });

  it('SHL-02 leaving canonical mode makes the partial line readable', () => {
    const t = setup();
    t.ld.input('par');
    t.ld.setModes({ canonical: false });
    expect(t.read()).toBe('par');
  });

  it('SHL-02 onlcr turns LF into CR LF once, even across writes', () => {
    const t = setup();
    t.ld.write(new TextEncoder().encode('a\nb\r'));
    t.ld.write(new TextEncoder().encode('\nc\n'));
    expect(t.out()).toBe('a\r\nb\r\nc\r\n');
  });

  it('SHL-02 after a hang-up reads return end of file and input is dropped', () => {
    const t = setup();
    t.ld.hangup();
    expect(t.read()).toBe('');
    expect(t.ld.input('x')).toBe('ok');
    expect(t.ld.pending()).toBe(0);
  });
});

describe('confirmation takeover (§3.11)', () => {
  function takeover(): { t: ReturnType<typeof setup>; keys: ConfirmKey[] } {
    const t = setup();
    const keys: ConfirmKey[] = [];
    t.ld.beginTakeover((k) => keys.push(k));
    return { t, keys };
  }

  it('SHL-14 type-ahead is discarded and processes cannot read during the takeover', () => {
    const t = setup();
    t.ld.input('y\r');
    t.ld.beginTakeover(() => undefined);
    expect(t.ld.pending()).toBe(0);
    expect(t.read()).toBeNull();
  });

  it('SHL-14 one key answers: y yes, n / Enter / Ctrl-C no, e edit; others ring the bell', () => {
    for (const [key, want] of [
      ['y', 'yes'],
      ['Y', 'yes'],
      ['n', 'no'],
      ['\r', 'no'],
      ['\x03', 'no'],
      ['e', 'edit'],
    ] as const) {
      const { t, keys } = takeover();
      t.ld.input(`x${key}y`);
      expect(keys).toEqual([want]);
      expect(t.out()).toContain('\x07');
      expect(t.signals).toEqual([]);
    }
  });

  it('SHL-14 a bracketed paste is ignored, even one that contains y', () => {
    const { t, keys } = takeover();
    t.ld.input('\x1b[200~yyy\x1b[201~');
    expect(keys).toEqual([]);
    t.ld.input('n');
    expect(keys).toEqual(['no']);
  });

  it('AGT-03 the takeover ends with the saved modes and reads resume', () => {
    const { t } = takeover();
    expect(t.ld.modes.canonical).toBe(false);
    t.ld.endTakeover();
    expect(t.ld.modes).toMatchObject({ canonical: true, echo: true, isig: true });
    t.ld.input('ok\r');
    expect(t.read()).toBe('ok\n');
  });
});
