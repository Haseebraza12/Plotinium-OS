/**
 * Tab completion through the Terminal (shell-and-terminal.md §3.10; SYS-03, SHL-10, SHL-17): the
 * Tab key is a byte for the TTY like any other, the shell's line editor asks the `complete`
 * service with `complete.query` (the process host passes it to the kernel unchanged), and without
 * the service it falls back to a directory scan and says so once.
 */
import { describe, expect, it } from 'vitest';

import { manLibrary } from '../host/manpages.ts';
import { startSession } from './harness.ts';

interface Query {
  ns: string;
  prefix: string;
  dir?: string;
}

function asQuery(a: Record<string, unknown>): Query {
  return {
    ns: String(a['ns']),
    prefix: String(a['prefix']),
    ...(typeof a['dir'] === 'string' ? { dir: a['dir'] } : {}),
  };
}

describe('Tab completion in the Terminal', () => {
  it('SYS-03 Tab completes a command name from complete.query (the trie service)', async () => {
    const queries: Query[] = [];
    const h = await startSession({
      setup: (fs) =>
        fs.handlers.set('complete.query', (a) => {
          const q = asQuery(a);
          queries.push(q);
          const names = q.ns === 'cmd' ? ['whoami'] : [];
          return {
            items: names
              .filter((n) => n.startsWith(q.prefix))
              .map((text) => ({ text, kind: 'program' })),
            truncated: false,
            indexed: true,
          };
        }),
    });
    await h.keys('who\t');
    expect(queries).toContainEqual({ ns: 'cmd', prefix: 'who' });
    expect(h.screen.lines()[h.screen.cursorRow]).toBe('demo@plotinium:~$ whoami');
    expect(await h.cmd('')).toBe('demo');
  });

  it('SYS-03 Tab completes a path relative to the shell’s directory', async () => {
    const h = await startSession({
      setup: (fs) =>
        fs.handlers.set('complete.query', (a) => {
          const q = asQuery(a);
          const names = q.ns === 'path' ? ['notes.md'] : [];
          return {
            items: names.filter((n) => n.startsWith(q.prefix)).map((text) => ({ text, kind: 'f' })),
            truncated: false,
            indexed: true,
          };
        }),
    });
    await h.keys('cat no\t');
    expect(h.screen.lines()[h.screen.cursorRow]).toBe('demo@plotinium:~$ cat notes.md');
    expect(await h.cmd('')).toBe('# notes');
  });

  it('UI-123 while the kernel does not route complete.query, the Terminal completes paths itself without a "service unavailable" notice', async () => {
    // The fake kernel answers ENOSYS for complete.* (not registered), like the kernel today.
    const h = await startSession();
    await h.keys('cat to\t');
    expect(h.screen.text()).not.toContain('service unavailable');
    expect(h.screen.lines()[h.screen.cursorRow]).toBe('demo@plotinium:~$ cat todo.txt');
    expect(await h.cmd('')).toBe('one\ntwo');
  });

  it('UI-123 command names come from the builtins and /bin', async () => {
    const h = await startSession();
    await h.keys('whoa\t');
    expect(h.screen.lines()[h.screen.cursorRow]).toBe('demo@plotinium:~$ whoami');
    await h.keys('\x15hist\t');
    expect(h.screen.lines()[h.screen.cursorRow]).toBe('demo@plotinium:~$ history');
  });

  it('UI-123 flags complete from the man page, and a second Tab lists them with their text', async () => {
    const page = [
      '---json',
      JSON.stringify({
        name: 'ls',
        section: 1,
        summary: 'list directory contents',
        flags: [
          { short: '-a', long: '--all', arg: null, desc: 'include names that begin with .' },
          { short: '-h', long: '--human-readable', arg: null, desc: 'sizes like 1.5K' },
        ],
      }),
      '---',
      '# ls',
    ].join('\n');
    const h = await startSession({
      host: { manPages: manLibrary({ ls: () => Promise.resolve(`${page}\n`) }) },
    });
    await h.keys('ls --h\t');
    expect(h.screen.lines()[h.screen.cursorRow]).toBe('demo@plotinium:~$ ls --human-readable');
    await h.keys('\x15ls -\t\t');
    const text = h.screen.text();
    expect(text).toContain('--all  include names that begin with .');
    expect(text).toContain('-h  sizes like 1.5K');
    expect(text).not.toContain('service unavailable');
  });
});
