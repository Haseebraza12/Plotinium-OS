import { describe, expect, it } from 'vitest';

import {
  addLine,
  escapeHistLine,
  formatHistory,
  newHistory,
  prefixMatches,
  shouldAdd,
  unescapeHistLine,
} from '../history.ts';
import shell from '../proc.ts';
import type { ShellState } from '../state.ts';
import { Session } from './session.ts';

const HISTFILE = '/home/demo/.sh_history';

describe('history (§3.9, SHL-09)', () => {
  it('SHL-09 ~/.sh_history is created with mode 0600 and gets one line per command', () => {
    const s = new Session();
    s.cmd('echo one');
    s.cmd('echo two');
    expect(s.k.files.get(HISTFILE)?.mode).toBe(0o600);
    expect(s.k.readFile(HISTFILE)).toBe('echo one\necho two\n');
    const writes = (s.k.callsOf('open') as { path: string; flags: string }[]).filter(
      (o) => o.path === HISTFILE && o.flags !== 'r',
    );
    expect(writes.map((o) => o.flags)).toEqual(['a', 'a']);
  });

  it('SHL-09 history persists across a Terminal restart and history -c empties the file and the hist namespace', () => {
    const s = new Session();
    s.cmd('echo one');
    s.cmd('ls -la ~');
    s.cmd('echo three');
    const pid = s.k.start(shell, ['-sh']);
    s.k.run();
    const st = s.k.proc(pid)?.st as ShellState;
    expect(st.hist.lines).toEqual(['echo one', 'ls -la ~', 'echo three']);
    expect(s.k.callsOf('complete.hist.load')).toContainEqual({
      lines: ['echo one', 'ls -la ~', 'echo three'],
    });
    expect(s.cmd('history 2')).toBe('    2  ls -la ~\n    3  echo three');
    expect(s.cmd('history -c; history')).toBe('');
    expect(s.k.callsOf('complete.hist.clear')).toEqual([{}]);
    expect(s.k.readFile(HISTFILE)).toBe('history -c; history\n');
  });

  it('SHL-09 lines starting with a space, blank lines and repeats of the previous entry are not added', () => {
    const s = new Session();
    s.cmd('echo a');
    s.cmd('echo a');
    s.cmd(' echo secret');
    s.cmd('   ');
    s.cmd('echo b');
    expect(s.st.hist.lines).toEqual(['echo a', 'echo b']);
    expect((s.k.callsOf('complete.hist.add') as { line: string }[]).map((a) => a.line)).toEqual([
      'echo a',
      'echo b',
    ]);
  });

  it('SHL-09 the file is rewritten to the last 1,000 lines once it passes 1,200 (I-SH5)', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `cmd ${i}`);
    const s = new Session({
      setup: (k) => k.writeFile(HISTFILE, lines.map((l) => `${l}\n`).join(''), 0o600),
    });
    expect(s.st.hist.lines).toHaveLength(1000);
    expect(s.st.hist.lines[0]).toBe('cmd 200');
    s.cmd('echo last');
    const file =
      s.k
        .readFile(HISTFILE)
        ?.split('\n')
        .filter((l) => l !== '') ?? [];
    expect(file).toHaveLength(1000);
    expect(file.at(-1)).toBe('echo last');
    expect(file[0]).toBe('cmd 201');
    expect(s.cmd('history 1')).toBe(' 1001  echo last');
  });

  it('SHL-09 history N needs a number, and a line with a syntax error is still recorded', () => {
    const s = new Session();
    expect(s.cmd('history x')).toBe('history: x: numeric argument required');
    expect(s.st.status).toBe(2);
    expect(s.cmd('history 1 2')).toBe('history: too many arguments');
    s.cmd('echo (');
    expect(s.st.hist.lines.at(-1)).toBe('echo (');
  });

  it('SHL-09 history | grep reads $HISTFILE in the child shell', () => {
    const s = new Session();
    s.cmd('ls one');
    s.cmd('echo two');
    expect(s.cmd('history | grep ls')).toBe('    1  ls one');
  });

  it('SHL-09 HISTSIZE caps the list and numbering continues', () => {
    const h = newHistory();
    for (const l of ['a', 'b', 'c', 'd']) addLine(h, l, 2);
    expect(h.lines).toEqual(['c', 'd']);
    expect(formatHistory(h)).toBe('    3  c\n    4  d\n');
    expect(formatHistory(h, 1)).toBe('    4  d\n');
    expect(shouldAdd(h, 'd')).toBe(false);
    expect(shouldAdd(h, ' x')).toBe(false);
    expect(shouldAdd(h, 'x')).toBe(true);
  });

  it('SHL-09 multi-line entries are stored with \\n escapes and read back exactly', () => {
    for (const line of ['a\nb', 'back\\slash', 'both\\n\nx', '']) {
      expect(unescapeHistLine(escapeHistLine(line))).toBe(line);
      expect(escapeHistLine(line)).not.toContain('\n');
    }
  });

  it('SHL-09 ↑ without the service walks the shell’s own list by prefix, most recent first', () => {
    const h = newHistory();
    for (const l of ['ls a', 'cat x', 'ls b', 'ls a']) addLine(h, l, 100);
    expect(prefixMatches(h, 'ls')).toEqual(['ls a', 'ls b']);
    expect(prefixMatches(h, 'ls a')).toEqual([]);
  });

  it('SHL-09 a history file that cannot be written does not break the shell', () => {
    const s = new Session({ setup: (k) => k.writeFile(HISTFILE, '', 0o400) });
    expect(s.cmd('echo ok')).toBe('ok');
    expect(s.st.hist.lines).toEqual(['echo ok']);
    s.cmd('HISTFILE=');
    expect(s.cmd('history -c')).toBe('');
    expect(s.st.status).toBe(0);
  });
});
