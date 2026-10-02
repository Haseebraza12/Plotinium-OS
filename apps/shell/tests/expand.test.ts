import { describe, expect, it } from 'vitest';

import { compareCodePoints, escapeGlob, hasGlobMeta, matchGlob, unescapeGlob } from '../glob.ts';
import { runC, Session } from './session.ts';

describe('expansion (§3.6)', () => {
  it('SHL-05 single quotes keep $HOME literal, double quotes expand it, and unquoted expansions split into fields', () => {
    const s = new Session();
    expect(s.cmd("args '$HOME'")).toBe('[$HOME]');
    expect(s.cmd('args "$HOME"')).toBe('[/home/demo]');
    s.cmd('X="a  b   c"');
    expect(s.cmd('args $X')).toBe('[a][b][c]');
    expect(s.cmd('args "$X"')).toBe('[a  b   c]');
    expect(s.cmd('args x${X}y')).toBe('[xa][b][cy]');
  });

  it('SHL-05 unset names expand to nothing and an empty quoted word stays one field', () => {
    const s = new Session();
    expect(s.cmd('args a $NOPE b')).toBe('[a][b]');
    expect(s.cmd('args "$NOPE" ""')).toBe('[][]');
    expect(s.cmd("args ''x")).toBe('[x]');
    s.cmd('E=');
    expect(s.cmd('args $E""')).toBe('[]');
  });

  it('SHL-05 special parameters $? $$ $! $# and $0', () => {
    const s = new Session();
    s.cmd('status 3');
    expect(s.cmd('echo $?')).toBe('3');
    expect(s.cmd('echo $$')).toBe(String(s.pid));
    expect(s.cmd('echo "[$!]"')).toBe('[]');
    const bg = s.cmd('sleep 5 &');
    const pid = /\[1\] (\d+)/.exec(bg)?.[1];
    expect(s.cmd('echo $!')).toBe(pid);
    expect(s.cmd('echo $# $0')).toBe('0 sh');
  });

  it('SHL-05 "$@" yields one field per positional parameter in sh -c mode', () => {
    const script = 'args "$@"; args $@; args "x$@y"; echo $# $1 ${2} $0';
    const r = runC(script, {}, ['name', 'a b', 'c']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('[a b][c]\n[a][b][c]\n[xa b][cy]\n2 a b c name');
    expect(runC('args "$@" end').out).toBe('[end]');
  });

  it('SHL-05 tilde expands at the start of a word, after = in an assignment, and for known users', () => {
    const s = new Session();
    expect(s.cmd('args ~ ~/x ~bob ~nobody/x a~ "~"')).toBe(
      '[/home/demo][/home/demo/x][/home/bob][~nobody/x][a~][~]',
    );
    s.cmd('P=~/bin');
    expect(s.cmd('echo $P')).toBe('/home/demo/bin');
  });

  it('SHL-05 a glob with no match is passed literally and dotfiles match only a leading dot', () => {
    const s = new Session({
      setup: (k) => {
        k.writeFile('/home/demo/b.txt', '');
        k.writeFile('/home/demo/a.txt', '');
        k.writeFile('/home/demo/.hidden.txt', '');
        k.writeFile('/home/demo/c.md', '');
      },
    });
    expect(s.cmd('args *.txt')).toBe('[a.txt][b.txt]');
    expect(s.cmd('args .*.txt')).toBe('[.hidden.txt]');
    expect(s.cmd('args *.none')).toBe('[*.none]');
    expect(s.cmd('args "*.txt" \\*.txt')).toBe('[*.txt][*.txt]');
    expect(s.cmd('args [ab].txt ?.md [!a].txt')).toBe('[a.txt][b.txt][c.md][b.txt]');
  });

  it('SHL-05 globs match per path component, sorted in code-point order, across directory pages', () => {
    const s = new Session({
      pageSize: 2,
      setup: (k) => {
        for (const d of ['t', 't/b', 't/a', 't/c']) k.mkdir(`/home/demo/${d}`);
        for (const f of ['t/b/x.txt', 't/a/x.txt', 't/a/y.txt', 't/c/z.md', 't/B.txt'])
          k.writeFile(`/home/demo/${f}`, '');
      },
    });
    expect(s.cmd('args t/*/x.txt')).toBe('[t/a/x.txt][t/b/x.txt]');
    expect(s.cmd('args t/*')).toBe('[t/B.txt][t/a][t/b][t/c]');
    expect(s.cmd('args t/*/')).toBe('[t/a/][t/b/][t/c/]');
    expect(s.cmd('args /home/demo/t/?/*.md')).toBe('[/home/demo/t/c/z.md]');
    expect(s.cmd('args t/nope/*')).toBe('[t/nope/*]');
  });

  it('SHL-05 unquoted expansion results are globbed, quoted ones are not', () => {
    const s = new Session({ setup: (k) => k.writeFile('/home/demo/f1', '') });
    s.cmd("P='f*'");
    expect(s.cmd('args $P "$P"')).toBe('[f1][f*]');
  });
});

describe('glob matching (§3.6 step 4)', () => {
  it.each([
    ['*', 'abc', true],
    ['a*c', 'abbbc', true],
    ['a*c', 'abcd', false],
    ['?b', 'ab', true],
    ['[a-c]x', 'bx', true],
    ['[!a-c]x', 'bx', false],
    ['[^a-c]x', 'dx', true],
    ['[]]', ']', true],
    ['*', '.hidden', false],
    ['.*', '.hidden', true],
    ['\\*', '*', true],
    ['\\*', 'a', false],
    ['a[b', 'a[b', true],
    ['**', 'x', true],
    ['*a*a*a*a*b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false],
  ])('SHL-05 %j matches %j: %s', (pattern, name, want) => {
    expect(matchGlob(pattern, name)).toBe(want);
  });

  it('SHL-05 escaping round-trips and only unescaped metacharacters count', () => {
    expect(unescapeGlob(escapeGlob('a*b?[c]\\'))).toBe('a*b?[c]\\');
    expect(hasGlobMeta(escapeGlob('*?['))).toBe(false);
    expect(hasGlobMeta('a\\*b*')).toBe(true);
  });

  it('SHL-05 names sort in code-point order, not UTF-16 order', () => {
    const names = ['b', '\u{1F600}', 'B', 'Ａ', 'a'];
    expect([...names].sort(compareCodePoints)).toEqual(['B', 'a', 'b', 'Ａ', '\u{1F600}']);
  });
});
