import { describe, expect, it } from 'vitest';

import type { CompleteItem } from '../../src/_sys.ts';
import { SysError } from '../../src/_sys.ts';
import {
  completionContext,
  DEGRADED_NOTICE,
  escapeWord,
  formatListing,
  outcome,
} from '../complete.ts';
import { Session } from './session.ts';

const TAB = '\t';

describe('what gets completed (§3.10)', () => {
  it.each([
    ['', { ns: 'cmd' }, ''],
    ['ca', { ns: 'cmd' }, 'ca'],
    ['ls | gr', { ns: 'cmd' }, 'gr'],
    ['a && b; A=1 ec', { ns: 'cmd' }, 'ec'],
    ['ls ', { ns: 'path' }, ''],
    ['ls no', { ns: 'path' }, 'no'],
    ['cat f > ou', { ns: 'path' }, 'ou'],
    ['./scr', { ns: 'path' }, './scr'],
    ['ls -l', { ns: 'flag', cmd: 'ls' }, '-l'],
    ['A=1 ls --co', { ns: 'flag', cmd: 'ls' }, '--co'],
    ['echo $HO', { ns: 'var' }, '$HO'],
    ['cat "my fi', { ns: 'path' }, 'my fi'],
    ['cat my\\ fi', { ns: 'path' }, 'my fi'],
    ["echo '$HO", { ns: 'path' }, '$HO'],
  ])('SYS-03 %j completes in %j', (line, where, value) => {
    const ctx = completionContext(line, line.length);
    expect(ctx.where).toEqual(where);
    expect(ctx.value).toBe(value);
  });

  it('SYS-03 the word starts where the typed word starts and open quotes are tracked', () => {
    expect(completionContext('cat "my fi', 10)).toMatchObject({ start: 4, quote: '"' });
    expect(completionContext('ls abc', 4)).toMatchObject({ value: 'a', start: 3 });
  });
});

describe('applying candidates (§3.10)', () => {
  const items = (...texts: string[]): CompleteItem[] => texts.map((text) => ({ text, kind: 'f' }));
  const ctx = completionContext('cat no', 6);

  it('SYS-03 one candidate is completed with a space, a directory with a slash', () => {
    expect(
      outcome({ prefix: 'no', items: items('notes.md'), truncated: false }, ctx, false),
    ).toEqual({
      k: 'insert',
      text: 'tes.md ',
    });
    expect(
      outcome(
        { prefix: 'no', items: [{ text: 'notes', kind: 'd' }], truncated: false },
        ctx,
        false,
      ),
    ).toEqual({
      k: 'insert',
      text: 'tes/',
    });
  });

  it('SYS-03 several candidates insert their common prefix, then a second Tab lists them', () => {
    const c = { prefix: 'no', items: items('notes.md', 'notebook'), truncated: false };
    expect(outcome(c, ctx, false)).toEqual({ k: 'insert', text: 'te' });
    const d = { prefix: 'note', items: items('notes.md', 'notebook'), truncated: false };
    expect(outcome(d, ctx, false)).toEqual({ k: 'bell' });
    expect(outcome(d, ctx, true)).toEqual({ k: 'list', items: d.items });
    expect(outcome({ prefix: 'x', items: [], truncated: false }, ctx, true)).toEqual({ k: 'bell' });
  });

  it('SYS-03 inserted text escapes spaces and shell-special characters', () => {
    expect(escapeWord('my file (1).txt', null)).toBe('my\\ file\\ \\(1\\).txt');
    expect(escapeWord('a"b$c', '"')).toBe('a\\"b\\$c');
    expect(escapeWord("it's", "'")).toBe("it's");
  });

  it('SYS-03 listings are in code-point order in columns; flags one per line with descriptions', () => {
    const list = formatListing(
      [
        { text: 'beta', kind: 'f' },
        { text: 'Alpha', kind: 'd' },
        { text: 'gamma', kind: 'f' },
      ],
      20,
    );
    expect(list).toBe('Alpha/  gamma\r\nbeta\r\n');
    expect(
      formatListing(
        [
          { text: '-l', kind: 'flag', desc: 'long listing' },
          { text: '-a', kind: 'flag' },
        ],
        80,
      ),
    ).toBe('-a\r\n-l  long listing\r\n');
  });
});

describe('completion in the shell', () => {
  function withService(entries: Record<string, CompleteItem[]>) {
    const s = new Session();
    s.k.handlers.set('complete.query', (args) => {
      const q = args as { ns: string; prefix: string };
      const items = (entries[q.ns] ?? []).filter((i) => i.text.startsWith(q.prefix));
      return { items, truncated: false, indexed: true };
    });
    return s;
  }

  it('SYS-03 Tab completes commands, paths and flags from the service', () => {
    const s = withService({
      cmd: [
        { text: 'grep', kind: 'program' },
        { text: 'groups', kind: 'program' },
      ],
      path: [{ text: 'notes', kind: 'd' }],
      flag: [{ text: '--color', kind: 'flag', desc: 'colour output' }],
    });
    s.keys(`gre${TAB}`);
    expect(s.st.ed?.buf).toBe('grep ');
    s.keys(`\x15ls no${TAB}`);
    expect(s.st.ed?.buf).toBe('ls notes/');
    s.keys(`\x15ls --c${TAB}`);
    expect(s.st.ed?.buf).toBe('ls --color ');
    const queries = s.k.callsOf('complete.query');
    expect(queries).toEqual([
      { ns: 'cmd', prefix: 'gre', limit: 100 },
      { ns: 'path', prefix: 'no', dir: '/home/demo', limit: 100 },
      { ns: 'flag', prefix: '--c', cmd: 'ls', limit: 100 },
    ]);
  });

  it('SYS-03 a second Tab lists the candidates under the line and redraws it', () => {
    const s = withService({
      cmd: [
        { text: 'grep', kind: 'program' },
        { text: 'groups', kind: 'program' },
      ],
    });
    const row = s.k.screen.cursor().row;
    s.keys(`gr${TAB}${TAB}`);
    expect(s.k.screen.lines().slice(row)).toEqual([
      'demo@plotinium:~$ gr',
      'grep    groups',
      'demo@plotinium:~$ gr',
    ]);
  });

  it('SHL-10 a directory the caller cannot list completes nothing and does not fall back', () => {
    const s = new Session();
    s.k.handlers.set('complete.query', () => {
      throw new SysError('EACCES');
    });
    s.keys(`cat /root/${TAB}`);
    expect(s.current()).toBe('demo@plotinium:~$ cat /root/');
    expect(s.k.screen.text()).not.toContain('service unavailable');
    expect(s.k.callsOf('readdir')).toEqual([]);
  });

  it('SHL-17 with the complete service stopped Tab still completes paths by directory scan and prints the notice once', () => {
    const s = new Session({
      setup: (k) => {
        k.mkdir('/home/demo/projects');
        k.writeFile('/home/demo/prose.txt', '');
        k.writeFile('/home/demo/.profile', '');
      },
    });
    s.keys(`cat pro${TAB}`);
    expect(s.st.ed?.buf).toBe('cat pro');
    s.keys(`j${TAB}`);
    expect(s.st.ed?.buf).toBe('cat projects/');
    s.keys(`\x15ca${TAB}`);
    expect(s.st.ed?.buf).toBe('cat ');
    s.keys(`\x15cat .pr${TAB}`);
    expect(s.st.ed?.buf).toBe('cat .profile ');
    s.keys(`\x15his${TAB}`);
    expect(s.st.ed?.buf).toBe('history ');
    const notices = s.k.screen
      .text()
      .split('\n')
      .filter((l) => l === DEGRADED_NOTICE.trim());
    expect(notices).toHaveLength(1);
  });

  it('SYS-03 $ completes shell variable names', () => {
    const s = new Session();
    s.keys(`echo $HIST${TAB}`);
    expect(s.current()).toBe('demo@plotinium:~$ echo $HIST');
    s.keys(`F${TAB}`);
    expect(s.st.ed?.buf).toBe('echo $HISTFILE ');
  });

  it('SYS-03 more than 100 candidates asks before listing them', () => {
    const s = new Session({
      setup: (k) => {
        for (let i = 0; i < 120; i++) k.writeFile(`/home/demo/f${String(i).padStart(3, '0')}`, '');
      },
    });
    s.keys(`cat f${TAB}`);
    s.keys(TAB);
    expect(s.current()).toBe('Display all 120 possibilities? (y or n)');
    s.keys('n');
    expect(s.current()).toBe('demo@plotinium:~$ cat f');
    s.keys(`${TAB}${TAB}y`);
    expect(s.k.screen.text()).toContain('f119');
  });
});
