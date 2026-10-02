import { describe, expect, it } from 'vitest';

import type { EditorState } from '../editor.ts';
import { continueLine, draw, feed, LINE_MAX_BYTES, newEditor, startHistory } from '../editor.ts';
import type { Key } from '../keys.ts';
import { nextKey } from '../keys.ts';
import { defaultPs1, expandPrompt, tildePath } from '../prompt.ts';
import { newState } from '../state.ts';
import { setVar } from '../vars.ts';
import { charWidth, stringWidth, visibleText } from '../wcwidth.ts';
import { Screen } from './screen.ts';
import { Session } from './session.ts';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';

/** An editor wired to a screen, fed like the shell feeds it. */
function rig(cols = 40, history: string[] = []) {
  const ed = newEditor('$ ', cols);
  const screen = new Screen(cols);
  screen.write(draw(ed));
  const actions: string[] = [];
  const type = (input: string): void => {
    let rest = input;
    while (rest.length > 0) {
      const step = feed(ed, rest, history);
      screen.write(step.out);
      rest = rest.slice(step.used);
      if (step.action.k === 'hist') {
        startHistory(
          ed,
          [...history]
            .reverse()
            .filter((h) => h.startsWith(step.action.k === 'hist' ? step.action.prefix : '')),
        );
        continue;
      }
      if (step.action.k !== 'none')
        actions.push(step.action.k === 'submit' ? `submit:${step.action.text}` : step.action.k);
      if (step.action.k === 'more' || step.used === 0) break;
    }
  };
  return { ed, screen, type, actions };
}

describe('key decoding (§3.9)', () => {
  function keys(s: string, paste = false): Key[] {
    const out: Key[] = [];
    let i = 0;
    for (;;) {
      const d = nextKey(s, i, paste);
      if (d === null) break;
      out.push(d.key);
      i += d.len;
    }
    return out;
  }

  it('SHL-09 printable runs, control keys and CSI/SS3 sequences decode to keys', () => {
    expect(keys('ab\x01\x7f\t\r\n')).toEqual([
      { k: 'text', s: 'ab' },
      { k: 'ctrl', c: 'a' },
      { k: 'backspace' },
      { k: 'tab' },
      { k: 'enter' },
    ]);
    expect(keys('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F\x1bOH\x1bOF\x1b[3~\x1b[1~\x1b[4~')).toEqual(
      ['up', 'down', 'right', 'left', 'home', 'end', 'home', 'end', 'delete', 'home', 'end'].map(
        (k) => ({ k }),
      ),
    );
    expect(keys('\x1b[1;5C\x1b[1;5D\x1b[5~\x1bx\x1b[Z')).toEqual([
      { k: 'wordRight' },
      { k: 'wordLeft' },
      { k: 'ignore' },
      { k: 'ignore' },
      { k: 'ignore' },
    ]);
    expect(keys('\x1b')).toEqual([{ k: 'esc' }]);
  });

  it('SHL-09 an escape sequence split across reads waits for the rest', () => {
    expect(nextKey('\x1b[1;', 0, false)).toBeNull();
    expect(nextKey('\x1bO', 0, false)).toBeNull();
  });

  it('SHL-09 bracketed paste is literal text, with CR turned into newlines, up to the end marker', () => {
    expect(keys('\x1b[200~')).toEqual([{ k: 'pasteStart' }]);
    expect(keys('a\r\nb\rc\x1b[201~', true)).toEqual([
      { k: 'text', s: 'a\nb\nc' },
      { k: 'pasteEnd' },
    ]);
    expect(nextKey('\x1b[20', 0, true)).toBeNull();
    expect(keys('\x1bq', true)[0]).toEqual({ k: 'text', s: '\x1b' });
  });
});

describe('line editor (§3.9)', () => {
  it('SHL-09 typing, moving and deleting edit the line in place', () => {
    const r = rig();
    r.type('hello world');
    r.type(`${LEFT}${LEFT}${LEFT}\x7f`);
    expect(r.ed.buf).toBe('hello wrld');
    r.type('\x01X\x05Y');
    expect(r.ed.buf).toBe('Xhello wrldY');
    r.type('\x02\x02\x1b[3~');
    expect(r.ed.buf).toBe('Xhello wrlY');
    r.type('\x17');
    expect(r.ed.buf).toBe('Xhello Y');
    r.type('\x01\x06\x0b');
    expect(r.ed.buf).toBe('X');
    r.type('abc def\x1b[1;5D');
    expect(r.ed.cur).toBe(5);
    r.type('\x15');
    expect(r.ed.buf).toBe('def');
    r.type('\x1b[1;5C\x04');
    expect(r.ed.buf).toBe('def');
    r.type('\x1b[H\x04');
    expect(r.ed.buf).toBe('ef');
    expect(r.screen.text()).toBe('$ ef');
  });

  it('SHL-09 Enter submits, Ctrl-C cancels, Ctrl-D on an empty line is end of input', () => {
    const r = rig();
    r.type('ls\r');
    const c = rig();
    c.type('x\x03');
    const e = rig();
    e.type('\x04');
    expect(r.actions).toEqual(['submit:ls']);
    expect(c.actions).toEqual(['cancel']);
    expect(e.actions).toEqual(['eof']);
    expect(c.screen.text()).toBe('$ x^C');
  });

  it('SHL-09 ↑ and ↓ walk history; with text typed only entries starting with it', () => {
    const history = ['ls a', 'cat x', 'ls b'];
    const r = rig(40, history);
    r.type(UP);
    expect(r.ed.buf).toBe('ls b');
    r.type(UP);
    expect(r.ed.buf).toBe('cat x');
    r.type(DOWN);
    r.type(DOWN);
    expect(r.ed.buf).toBe('');
    r.type(DOWN);
    const p = rig(40, history);
    p.type(`ls${UP}${UP}`);
    expect(p.ed.buf).toBe('ls a');
    p.type(UP);
    expect(p.ed.buf).toBe('ls a');
    p.type('\x10');
    p.type('\x0e');
    expect(p.ed.buf).toBe('ls b');
  });

  it('SHL-09 Ctrl-R searches history backwards for a substring', () => {
    const history = ['echo alpha', 'ls -la', 'echo beta'];
    const r = rig(60, history);
    r.type('\x12ech');
    expect(r.screen.text()).toBe("(reverse-i-search)'ech': echo beta");
    r.type('\x12');
    expect(r.screen.text()).toBe("(reverse-i-search)'ech': echo alpha");
    r.type('zz');
    expect(r.screen.text()).toBe("(failed reverse-i-search)'echzz': echo alpha");
    r.type('\x7f\x7f\r');
    expect(r.actions).toEqual(['submit:echo beta']);
    const c = rig(60, history);
    c.type('keep\x12ls\x07');
    expect(c.ed.buf).toBe('keep');
    c.type('\x12ls\x1b');
    expect(c.ed.buf).toBe('ls -la');
    c.type('\x12alp\x05!');
    expect(c.ed.buf).toBe('echo alpha!');
  });

  it('SHL-09 long lines wrap and the cursor is placed correctly across rows', () => {
    const r = rig(10);
    r.type('abcdefghijklmnop');
    expect(r.screen.lines()).toEqual(['$ abcdefgh', 'ijklmnop']);
    expect(r.screen.cursor()).toEqual({ row: 1, col: 8 });
    r.type('\x01');
    expect(r.screen.cursor()).toEqual({ row: 0, col: 2 });
    r.type('\x05');
    r.type('qr\x7f\x7f');
    expect(r.screen.lines()).toEqual(['$ abcdefgh', 'ijklmnop']);
    const exact = rig(10);
    exact.type('abcdefgh');
    expect(exact.screen.cursor()).toEqual({ row: 1, col: 0 });
  });

  it('SHL-09 pasted text is inserted literally, newlines included, and nothing runs until Enter', () => {
    const r = rig(40);
    r.type('\x1b[200~echo a\r\necho b\x1b[201~');
    expect(r.actions).toEqual([]);
    expect(r.ed.buf).toBe('echo a\necho b');
    expect(r.screen.lines()).toEqual(['$ echo a', 'echo b']);
    r.type('\r');
    expect(r.actions).toEqual(['submit:echo a\necho b']);
  });

  it('SHL-09 control characters are shown as ^X and input past the line limit rings the bell', () => {
    const r = rig(40);
    r.type('\x1b[200~a\tb\x1b[201~');
    expect(r.screen.text()).toBe('$ a^Ib');
    const big = rig(40);
    big.type('x'.repeat(LINE_MAX_BYTES + 1));
    expect(big.ed.buf).toBe('');
  });

  it('SHL-09 Ctrl-L clears the screen and redraws the line', () => {
    const r = rig();
    r.screen.write('old output\r\n');
    r.type('abc\x0c');
    expect(r.screen.text()).toBe('$ abc');
  });

  it('SHL-09 a continuation line shows PS2 and keeps the earlier text', () => {
    const r = rig();
    r.type("echo 'a\r");
    const ed: EditorState = r.ed;
    r.screen.write(continueLine(ed, "echo 'a", '> '));
    r.type("b'\r");
    expect(r.actions).toEqual(["submit:echo 'a", "submit:echo 'a\nb'"]);
  });

  it('SHL-09 Tab asks the driver to complete, a second Tab says so', () => {
    const r = rig();
    r.type('ca\t\t');
    expect(r.actions).toEqual(['complete', 'complete']);
    expect(r.ed.tabs).toBe(2);
  });
});

describe('widths and prompts', () => {
  it('SHL-09 wide characters take two columns and combining marks none', () => {
    expect(charWidth(0x4e2d)).toBe(2);
    expect(charWidth(0x1f600)).toBe(2);
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(0x41)).toBe(1);
    expect(stringWidth('a中é')).toBe(4);
    expect(visibleText('\x1b[1;32mhi\x1b[0m')).toBe('hi');
  });

  it('SYS-02 the default prompt is user@host:cwd$ with ~ for home, # and red for root', () => {
    const st = newState(['sh']);
    for (const [k, v] of [
      ['USER', 'alice'],
      ['HOME', '/home/alice'],
      ['PWD', '/home/alice/notes'],
    ])
      setVar(st.vars, k ?? '', v ?? '');
    st.uid = 1000;
    expect(visibleText(expandPrompt(defaultPs1(1000), st))).toBe('alice@plotinium:~/notes$ ');
    expect(expandPrompt(defaultPs1(1000), st)).toContain('\x1b[1;32m');
    st.uid = 0;
    expect(expandPrompt(defaultPs1(0), st)).toContain('\x1b[1;31m');
    expect(visibleText(expandPrompt('\\W \\$ \\\\ \\x', st))).toBe('notes # \\ \\x');
    expect(tildePath('/home/alicex', '/home/alice')).toBe('/home/alicex');
    expect(tildePath('/', '/')).toBe('/');
  });
});

describe('the editor inside the shell', () => {
  it('SYS-02 the terminal is raw while a line is edited and cooked while it runs', () => {
    const s = new Session();
    expect(s.k.tty.canonical).toBe(false);
    expect(s.k.tty.isig).toBe(false);
    s.keys('top\r');
    expect(s.k.tty.canonical).toBe(true);
    expect(s.k.tty.isig).toBe(true);
    s.keys('\x1a');
    expect(s.k.tty.canonical).toBe(false);
  });

  it('SHL-09 ↑ uses the shell’s history when the completion service is not running', () => {
    const s = new Session();
    s.cmd('echo first');
    s.cmd('ls x');
    s.cmd('echo second');
    s.keys(`ec${UP}`);
    expect(s.current()).toBe('demo@plotinium:~$ echo second');
    s.keys(UP);
    expect(s.current()).toBe('demo@plotinium:~$ echo first');
    s.keys(`${DOWN}${DOWN}`);
    expect(s.current()).toBe('demo@plotinium:~$ ec');
    s.keys(`\x15${UP}${UP}`);
    expect(s.current()).toBe('demo@plotinium:~$ ls x');
  });

  it('SHL-09 ↑ with a prefix asks the hist namespace when the service answers', () => {
    const s = new Session();
    s.k.handlers.set('complete.query', () => ({
      items: [
        { text: 'git status', kind: 'hist', seq: 1 },
        { text: 'git push', kind: 'hist', seq: 7 },
      ],
      truncated: false,
      indexed: true,
    }));
    s.keys(`git${UP}`);
    expect(s.current()).toBe('demo@plotinium:~$ git push');
    expect(s.k.callsOf('complete.query')).toEqual([{ ns: 'hist', prefix: 'git', limit: 100 }]);
  });

  it('SYS-02 an unclosed quote continues on a PS2 line and runs when complete', () => {
    const s = new Session();
    const row = s.k.screen.cursor().row;
    s.keys("echo 'a\r");
    expect(s.current()).toBe('>');
    s.keys("b'\r");
    expect(s.since(row)).toBe("> b'\na\nb");
  });

  it('SHL-02 a resize updates COLUMNS and LINES through SIGWINCH', () => {
    const s = new Session();
    s.k.tty.cols = 100;
    s.k.tty.rows = 30;
    s.k.signal(s.pid, 'SIGWINCH');
    s.k.run();
    expect(s.cmd('echo $COLUMNS $LINES')).toBe('100 30');
    expect(s.st.ed?.cols).toBe(100);
  });

  it('SYS-02 multi-byte UTF-8 split across reads is decoded whole', () => {
    const s = new Session();
    s.k.tty.input = '';
    s.keys('echo ');
    s.keys('中文\r');
    expect(s.k.screen.text().split('\n').at(-2)).toBe('中文');
  });

  it('SHL-02 end of input on the terminal (hang-up) exits the shell', () => {
    const s = new Session();
    s.k.handlers.set('read', () => new ArrayBuffer(0));
    s.k.run();
    expect(s.exited()).toBe(true);
  });
});
