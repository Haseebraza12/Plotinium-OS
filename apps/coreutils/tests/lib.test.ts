/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

import { AI_PROGRAMS, ARGSPEC, PROGRAMS } from '../index.ts';
import { parseArgs, UsageError } from '../lib/argspec.ts';
import type { CommandSpec } from '../lib/argspec.ts';
import { helpText, synopsisForms, usageText } from '../lib/command.ts';
import {
  bulkSuffix,
  describe as describeError,
  errnoText,
  mustErrno,
  reasonOf,
} from '../lib/errors.ts';
import {
  binSize,
  byCodePoint,
  clockMs,
  cpuTime,
  escapeName,
  hms,
  humanSize,
  mib,
  offsetString,
  padLeft,
  padRight,
  pct,
  permString,
  plural,
  prettyUp,
  thousands,
  upString,
} from '../lib/format.ts';
import { inline, renderMarkdown, stripFrontMatter, wrap } from '../lib/markdown.ts';
import { applyMode, parseMode, toModeChange } from '../lib/mode.ts';
import { basename, dirname, expandHome, isWithin, join, resolve } from '../lib/path.ts';
import { parseSignal, translateSignal } from '../lib/signals.ts';
import { SysError } from '../lib/sys.ts';
import { findGid, findUid, groupName, userName } from '../lib/users.ts';
import { uuidv7 } from '../lib/uuid.ts';
import { kernel } from './harness.ts';

const PAGES = import.meta.glob<string>('../man/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Front {
  name: string;
  section: number;
  summary: string;
  synopsis: string;
  owner: string;
  requirements: string[];
  flags: { short: string | null; long: string | null; arg: string | null; desc: string }[];
  seeAlso: string[];
}

function front(text: string): Front {
  const m = /^---json\n([\s\S]*?)\n---\n/.exec(text);
  if (m === null) throw new Error('no front matter');
  return JSON.parse(m[1] ?? '') as Front;
}

const SPEC: CommandSpec = {
  synopsis: 'x [-a] [-l] [-n N] [--color[=WHEN]] [--sort FIELD]',
  summary: 'test',
  flags: [
    { short: '-a', long: '--all', arg: null, optionalArg: false },
    { short: '-l', long: null, arg: null, optionalArg: false },
    { short: '-n', long: null, arg: 'N', optionalArg: false },
    { short: null, long: '--color', arg: 'WHEN', optionalArg: true },
    { short: null, long: '--sort', arg: 'FIELD', optionalArg: false },
    { short: null, long: '--sorted', arg: null, optionalArg: false },
  ],
};

describe('man pages and flags (SHL-12)', () => {
  const names = Object.keys(PAGES)
    .map((p) => p.replace(/^.*\/(.*)\.md$/, '$1'))
    .sort();

  it('SHL-12 every program has a man page and every man page has a program', () => {
    expect(names).toEqual(Object.keys(PROGRAMS).sort());
    expect(AI_PROGRAMS).toEqual(['ai', 'semsearch', 'predict']);
  });

  it("SHL-12 each command's option parser accepts exactly the flags in its man front matter", () => {
    for (const [path, text] of Object.entries(PAGES)) {
      const fm = front(text);
      expect(path).toContain(`/${fm.name}.md`);
      const gen = ARGSPEC[fm.name as keyof typeof ARGSPEC];
      expect(gen.synopsis).toBe(fm.synopsis);
      expect(gen.summary).toBe(fm.summary);
      expect(gen.flags.map((f) => [f.short, f.long, f.arg, f.desc])).toEqual(
        fm.flags.map((f) => [f.short, f.long, f.arg, f.desc]),
      );
    }
  });

  it('SHL-12 every front-matter flag appears in OPTIONS and every page has the required sections', () => {
    for (const text of Object.values(PAGES)) {
      const fm = front(text);
      expect(fm.section).toBe(1);
      expect(['R1', 'R2', 'R3', 'R4', 'R5']).toContain(fm.owner);
      const body = text.slice(text.indexOf('\n---\n') + 5);
      const sections = [...body.matchAll(/^# (.+)$/gm)].map((m) => m[1]);
      expect(sections).toEqual([
        'NAME',
        'SYNOPSIS',
        'DESCRIPTION',
        'OPTIONS',
        'EXIT STATUS',
        'ERRORS',
        'EXAMPLES',
        'SEE ALSO',
      ]);
      const options = body.slice(body.indexOf('# OPTIONS'), body.indexOf('# EXIT STATUS'));
      for (const f of fm.flags) {
        expect(options).toContain(f.short ?? f.long ?? '');
        expect(f.desc.length).toBeLessThanOrEqual(80);
        if (f.short !== null) expect(f.short).toMatch(/^-[A-Za-z0-9]$/);
        if (f.long !== null) expect(f.long).toMatch(/^--[a-z][a-z0-9-]*$/);
      }
      expect(body).toContain(`${fm.name} — ${fm.summary}`);
    }
  });

  it('SHL-12 the ai page lists the agent flags', () => {
    const page = Object.entries(PAGES).find(([path]) => path.endsWith('/ai.md'))?.[1] ?? '';
    expect(page).toContain('--dry-run');
  });
});

describe('option parsing (SHL-15)', () => {
  it('SHL-15 short options cluster, -- ends options, and options after operands are accepted', () => {
    const p = parseArgs('x', SPEC, ['-al', 'file', '-n5', '--', '-a']);
    expect(p.has('a') && p.has('l')).toBe(true);
    expect(p.value('n')).toBe('5');
    expect(p.operands).toEqual(['file', '-a']);
    expect(parseArgs('x', SPEC, ['-n', '7']).value('n')).toBe('7');
    expect(parseArgs('x', SPEC, ['-', 'a']).operands).toEqual(['-', 'a']);
  });

  it('SHL-15 long options take =value or the next argument, unique prefixes and optional arguments', () => {
    expect(parseArgs('x', SPEC, ['--sort=pid']).value('sort')).toBe('pid');
    expect(parseArgs('x', SPEC, ['--sort', 'pid']).value('sort')).toBe('pid');
    expect(parseArgs('x', SPEC, ['--al']).has('a')).toBe(true);
    expect(parseArgs('x', SPEC, ['--color']).value('color')).toBe('');
    expect(parseArgs('x', SPEC, ['--color=never']).value('color')).toBe('never');
    expect(parseArgs('x', SPEC, ['-n', '1', '-n', '2']).values('n')).toEqual(['1', '2']);
    expect(parseArgs('x', SPEC, ['a', '-l'], { stopAtFirstOperand: true }).operands).toEqual([
      'a',
      '-l',
    ]);
  });

  it('SHL-15 unknown, ambiguous and incomplete options are usage errors', () => {
    expect(() => parseArgs('x', SPEC, ['-z'])).toThrow("x: invalid option -- 'z'");
    expect(() => parseArgs('x', SPEC, ['--zzz'])).toThrow("x: unrecognized option '--zzz'");
    expect(() => parseArgs('x', SPEC, ['--so'])).toThrow("x: option '--so' is ambiguous");
    expect(() => parseArgs('x', SPEC, ['--all=1'])).toThrow(
      "x: option '--all' doesn't allow an argument",
    );
    expect(() => parseArgs('x', SPEC, ['--sort'])).toThrow(
      "x: option '--sort' requires an argument",
    );
    expect(() => parseArgs('x', SPEC, ['-n'])).toThrow("x: option requires an argument -- 'n'");
    expect(new UsageError('m').name).toBe('UsageError');
  });

  it('SHL-15 --help prints the synopsis and the flags from the man page', () => {
    const text = helpText('kill');
    expect(text.split('\n').slice(0, 2)).toEqual([
      'Usage: kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID...',
      '       kill -l [NUM | SIGNAL]',
    ]);
    expect(text).toContain('  -s SIGNAL  signal name, with or without SIG');
    expect(helpText('whoami')).not.toContain('Options:');
    expect(synopsisForms('svcctl', 'svcctl status | svcctl start|stop NAME')).toEqual([
      'svcctl status',
      'svcctl start|stop NAME',
    ]);
    expect(usageText('ls', 'boom').split('\n')[0]).toBe('ls: boom');
    const r = kernel().run(PROGRAMS.du, ['du', '--help']);
    expect(r.out).toContain('  -d, --max-depth N');
    expect(r.out).toContain("See 'man du' for details.");
    expect(kernel().run(PROGRAMS.ls, ['ls', '--', '--help']).err).toBe(
      "ls: cannot access '--help': No such file or directory\n",
    );
  });
});

describe('errors (SHL-07)', () => {
  it('SHL-07 errno texts match the shell table for every errno a command can print', () => {
    expect(errnoText('EBUSY')).toBe('Resource busy');
    expect(errnoText('ETIMEDOUT')).toBe('Timed out');
    expect(errnoText('ENOENT')).toBe('No such file or directory');
    expect(errnoText('EAIUNAVAIL')).toBe('AI service unavailable');
    expect(
      describeError(Object.assign(new SysError('EIO'), { msg: 'injected fault at node 500' })),
    ).toBe('Input/output error (injected fault at node 500)');
    expect(describeError(new SysError('EIO', 'Input/output error'))).toBe('Input/output error');
    expect(describeError({ errno: 'EBUSY', detail: { holder: 'bob' } })).toBe(
      'Resource busy (locked by bob)',
    );
    expect(() => describeError(new Error('bug'))).toThrow('bug');
    expect(() => mustErrno('x')).toThrow();
    expect(reasonOf({ errno: 'EPERM', detail: { reason: 'guest' } })).toBe('guest');
    expect(reasonOf({ detail: 5 })).toBeUndefined();
    expect(bulkSuffix({ errno: 'EPERM', detail: { reason: 'server' } })).toBe(' — restored');
    expect(bulkSuffix(new SysError('EPERM'))).toBe('');
  });
});

describe('formatting', () => {
  it('SYS-02 sizes, times and modes use the shell conventions', () => {
    expect(humanSize(512)).toBe('512');
    expect(humanSize(4096)).toBe('4.0K');
    expect(humanSize(18 * 1_048_576)).toBe('18M');
    expect(humanSize(2_040_000_000)).toBe('1.9G');
    expect(binSize(0)).toBe('0B');
    expect(binSize(84_172)).toBe('82.2K');
    expect(binSize(5 * 1024 ** 5)).toBe('5120.0T');
    expect(mib(268_435_456)).toBe('256.0M');
    expect(thousands(1_204)).toBe('1,204');
    expect(pct(0.974)).toBe('97.4%');
    expect(permString(0o1777)).toBe('rwxrwxrwt');
    expect(permString(0o1770)).toBe('rwxrwx--T');
    expect(offsetString(-330)).toBe('-0530');
    expect(clockMs(0, 0)).toBe('00:00:00.000');
    expect(cpuTime(3_723_000)).toBe('01:02:03');
    expect(hms(3_723_000)).toBe('1:02:03');
    expect(upString(3 * 86_400_000 + 125 * 60_000)).toBe('3 days, 2:05');
    expect(upString(86_400_000)).toBe('1 day, 0 min');
    expect(prettyUp(90_061_000)).toBe('up 1 day, 1 hour, 1 minute');
    expect(prettyUp(0)).toBe('up 0 minutes');
    expect(padLeft(5, 3) + padRight('a', 2)).toBe('  5a ');
    expect(plural(1, 'file', 'files')).toBe('1 file');
    expect(escapeName('a⁦b', true)).toBe('a?b');
  });

  it('SYS-02 names sort in code-point order', () => {
    expect(['b', 'B', 'a', '\u{1F600}', 'Ａ'].sort(byCodePoint)).toEqual([
      'B',
      'a',
      'b',
      'Ａ',
      '\u{1F600}',
    ]);
    expect(byCodePoint('ab', 'a')).toBe(1);
    expect(byCodePoint('a', 'a')).toBe(0);
  });

  it('SYS-02 paths are built and normalised lexically', () => {
    expect(basename('/a/b/')).toBe('b');
    expect(basename('/')).toBe('/');
    expect(dirname('a')).toBe('.');
    expect(dirname('/a')).toBe('/');
    expect(join('/', 'x')).toBe('/x');
    expect(resolve('/a/b', '../c/./d')).toBe('/a/c/d');
    expect(expandHome('~/x', '/home/a')).toBe('/home/a/x');
    expect(expandHome('~', '/home/a')).toBe('/home/a');
    expect(expandHome('~x', undefined)).toBe('~x');
    expect(isWithin('/a', '/a/b')).toBe(true);
    expect(isWithin('/', '/z')).toBe(true);
    expect(isWithin('/a', '/ab')).toBe(false);
  });
});

describe('chmod modes (VFS-04)', () => {
  const cases: [string, number, boolean, number][] = [
    ['644', 0o777, false, 0o644],
    ['1777', 0o755, true, 0o1777],
    ['777', 0o1777, true, 0o777],
    ['o-w', 0o666, false, 0o664],
    ['a+X', 0o644, true, 0o755],
    ['a+X', 0o644, false, 0o644],
    ['u=rw,go=r', 0o777, false, 0o644],
    ['+t', 0o777, true, 0o1777],
    ['+w', 0o444, false, 0o644],
    ['o+t', 0o755, true, 0o1755],
    ['u-t', 0o1777, true, 0o1777],
    ['a-t', 0o1777, true, 0o777],
    ['g=', 0o777, false, 0o707],
  ];

  it('VFS-04 chmod modes evaluate as in the VFS table', () => {
    for (const [text, old, isDir, expected] of cases) {
      const spec = parseMode(text);
      expect(spec).not.toBeNull();
      if (spec !== null)
        expect(applyMode(spec, old, isDir, 0o022).toString(8)).toBe(expected.toString(8));
    }
  });

  it('VFS-04 invalid modes are rejected and deltas are disjoint', () => {
    for (const bad of ['u+s', '4755', 'g=u', 'u+x,', 'u', '', '+z', '17777'])
      expect(parseMode(bad)).toBeNull();
    const spec = parseMode('u=rw,go=r');
    expect(spec === null ? null : toModeChange(spec, 0o022)).toEqual({
      op: 'delta',
      add: 0o644,
      clear: 0o133,
    });
    const x = parseMode('a+X');
    expect(x === null ? 'bad' : toModeChange(x, 0)).toBeNull();
    const octal = parseMode('600');
    expect(octal === null ? null : toModeChange(octal, 0)).toEqual({ op: 'set', bits: 0o600 });
  });
});

describe('misc helpers', () => {
  it('SYS-02 UUIDv7 transaction ids carry the time, version and variant', () => {
    const id = uuidv7(0x0192f0c17c2e, new Uint8Array(10).fill(0xff));
    expect(id).toBe('0192f0c1-7c2e-7fff-bfff-ffffffffffff');
    expect(uuidv7(Date.now())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('PROC-07 signal names and numbers are parsed like the shell builtin', () => {
    expect(parseSignal('term')).toBe('SIGTERM');
    expect(parseSignal('SIGUSR1')).toBe('SIGUSR1');
    expect(parseSignal('99')).toBeUndefined();
    expect(translateSignal('9')).toBe('KILL');
    expect(translateSignal('NOPE')).toBeUndefined();
    expect(translateSignal('0')).toBeUndefined();
  });

  it('SYS-02 user and group lookups accept names and numbers', () => {
    const db = {
      users: [{ uid: 5, name: 'eve', gid: 7, home: '/home/eve', groups: [7] }],
      groups: [{ gid: 7, name: 'lab' }],
    };
    expect(userName(db, 5)).toBe('eve');
    expect(userName(db, 6)).toBe('6');
    expect(groupName(db, 8)).toBe('8');
    expect(findUid(db, '5')).toBe(5);
    expect(findUid(db, '42')).toBe(42);
    expect(findUid(db, 'nobody')).toBeUndefined();
    expect(findGid(db, 'lab')).toBe(7);
    expect(findGid(db, '9')).toBe(9);
    expect(findGid(db, 'x')).toBeUndefined();
    const k = kernel().fail('users.list', 'EIO');
    expect(k.run(PROGRAMS.id, ['id', 'eve']).err).toBe("id: 'eve': no such user\n");
  });

  it('SYS-02 man pages render with wrapping, bullets, bold on a terminal and plain text in a pipe', () => {
    expect(stripFrontMatter('no front matter')).toBe('no front matter');
    expect(inline('`a` **b** [c](d)', false)).toBe('a b c');
    expect(inline('`a`', true)).toBe('\x1b[1ma\x1b[0m');
    expect(wrap('aaa bbb ccc', 8, '> ', '  ')).toEqual(['> aaa', '  bbb', '  ccc']);
    expect(wrap('', 8, '> ', '  ')).toEqual(['> ']);
    const lines = renderMarkdown('# T\n\nline one  \nline two\n\n* item\n', 80, true);
    expect(lines).toEqual(['\x1b[1mT\x1b[0m', '    line one', '    line two', '', '    • item']);
  });
});
