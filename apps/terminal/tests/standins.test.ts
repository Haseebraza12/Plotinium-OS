/**
 * What the Terminal's process host answers itself while the kernel cannot (polish wave, BUGS.md):
 * the manual pages under /usr/share/man (UI-053), `lsof` for its own processes (UI-125), a shell
 * started in a chosen folder (UI-129), and the backoff of the `term` relay loop (UI-121).
 */
import { describe, expect, it } from 'vitest';

import { PROGRAMS } from '../../coreutils/index.ts';
import { bundledManPages, frontMatter, manIndexText, manLibrary } from '../host/manpages.ts';
import {
  nextRelaySleep,
  RELAY_BUSY_SLEEP_MS,
  RELAY_QUIET_SLEEP_MS,
  startDirectoryOf,
} from '../proc.ts';
import { localBackend } from '../session.ts';
import { startSession } from './harness.ts';

describe('UI-053 man pages from the Terminal', () => {
  it('UI-053 the bundled library has a page with front matter for every coreutils program', async () => {
    const lib = bundledManPages();
    for (const name of Object.keys(PROGRAMS)) expect(lib.names()).toContain(name);
    const ls = await lib.page('ls');
    expect(frontMatter(ls ?? '')?.summary).toBe('list directory contents');
    expect(await lib.page('no-such-page')).toBeNull();
    const index: unknown = JSON.parse(await manIndexText(lib));
    expect(index).toContainEqual({ name: 'ls', section: 1, summary: 'list directory contents' });
  });

  it('UI-053 man ls renders the page when the volume has none, and man -k searches the index', async () => {
    const h = await startSession({ rows: 400, host: { manPages: bundledManPages() } });
    const page = await h.cmd('man ls');
    expect(page).toMatch(/list directory contents/);
    expect(page).not.toMatch(/no manual entry/);
    expect(await h.cmd('man -k "directory contents"')).toBe('ls (1) - list directory contents');
    expect(await h.cmd('man nosuch')).toBe('man: no manual entry for nosuch');
  });

  it('UI-053 /usr/share/man lists as a read-only directory', async () => {
    const lib = manLibrary({
      cat: () =>
        Promise.resolve(
          '---json\n{"name":"cat","summary":"concatenate files","flags":[]}\n---\n# cat\n',
        ),
    });
    const h = await startSession({ host: { manPages: lib } });
    expect(await h.cmd('ls /usr/share/man')).toMatch(/^1\/\s+index\.json$/m);
    expect(await h.cmd('ls /usr/share/man/1')).toBe('cat.md');
    expect(await h.cmd('cat /usr/share/man/1/cat.md')).toContain('# cat');
    expect(await h.cmd('echo x > /usr/share/man/1/cat.md')).toMatch(/Permission denied/);
    expect(await h.cmd('cd /usr/share/man/1 && pwd')).toBe('/usr/share/man/1');
  });
});

describe('UI-125 lsof in the Terminal', () => {
  it('UI-125 lsof lists this terminal’s processes and their TTY, pipes and files instead of "not available"', async () => {
    const h = await startSession({ cols: 160 });
    const out = await h.cmd('lsof');
    expect(out).not.toMatch(/not available/i);
    expect(out.split('\n')[0]).toMatch(/^COMMAND +PID +USER +FD +TYPE +MODE +NAME +LEASE$/);
    expect(out).toMatch(/^-sh +\d+ +demo +0 +TTY +rw +tty1 /m);
    // A pipe and the process on its read end.
    const piped = await h.cmd('lsof | cat');
    expect(piped).toMatch(/PIPE +w +pipe:\d+/);
    expect(await h.cmd('lsof -p 1')).toBe('COMMAND  PID  USER  FD  TYPE  MODE  NAME  LEASE');
  });
});

describe('UI-129 a Terminal opened on a folder', () => {
  it('UI-129 the shell starts in the folder; a file, a missing path or a closed folder fall back to home', async () => {
    const h = await startSession();
    expect(await h.host.enterableDirectory('/tmp')).toBe('/tmp');
    expect(await h.host.enterableDirectory('/tmp/../home/demo/')).toBe('/home/demo');
    expect(await h.host.enterableDirectory('/home/demo/notes.md')).toBeNull();
    expect(await h.host.enterableDirectory('/nope')).toBeNull();
    expect(await h.host.enterableDirectory('/root')).toBeNull();
    expect(await h.host.enterableDirectory('relative')).toBeNull();
  });

  it('UI-129 localBackend opens the first session in the given directory', async () => {
    const { FakeSys } = await import('./fake-sys.ts');
    const fs = new FakeSys();
    const backend = localBackend({ sys: fs });
    const port = await backend.open({ cols: 80, rows: 24 }, { cwd: '/tmp' });
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      port.onCwd((cwd) => {
        seen.push(cwd);
        if (cwd === '/tmp') resolve();
      });
    });
    expect(seen.at(-1)).toBe('/tmp');
    port.close();
    backend.dispose();
  });

  it('UI-129 term takes the folder from argv[1] on the kernel TTY path', () => {
    expect(startDirectoryOf(['terminal', '/home/demo/Projects'])).toBe('/home/demo/Projects');
    expect(startDirectoryOf(['terminal'])).toBeNull();
    expect(startDirectoryOf(['terminal', 'relative'])).toBeNull();
  });
});

describe('UI-121 the term relay loop backs off', () => {
  it('UI-121 busy after a call, then doubling to the quiet interval (6 wake-ups, not about 500)', () => {
    const waits: number[] = [];
    let wait = nextRelaySleep(RELAY_QUIET_SLEEP_MS, true);
    waits.push(wait);
    while (wait < RELAY_QUIET_SLEEP_MS) {
      wait = nextRelaySleep(wait, false);
      waits.push(wait);
    }
    expect(waits).toEqual([RELAY_BUSY_SLEEP_MS, 8, 16, 32, 64, RELAY_QUIET_SLEEP_MS]);
    expect(nextRelaySleep(RELAY_QUIET_SLEEP_MS, false)).toBe(RELAY_QUIET_SLEEP_MS);
    expect(nextRelaySleep(64, true)).toBe(RELAY_BUSY_SLEEP_MS);
  });
});

const UPTIME = { uptimeMs: 60_000, users: 1, load: [0.1, 0.2, 0.3], bootAt: 0 };

describe('UI-120 interactive top in the Terminal', () => {
  it('UI-120 q quits top at once, and nothing typed during top reaches the shell', async () => {
    const h = await startSession({
      rows: 40,
      setup: (fs) => fs.handlers.set('uptime', () => UPTIME),
    });
    await h.keys('top\r');
    const frames = (): number => h.screen.raw.split('\x1b[H\x1b[2J').length - 1;
    expect(frames()).toBe(1);
    // The next frame comes when the one-second `sleep` child ends.
    await h.clock.advance(1_000);
    expect(frames()).toBe(2);
    await h.keys('xq');
    expect(
      h.screen.raw.endsWith('demo@plotinium:~$ ') || h.screen.text().endsWith('demo@plotinium:~$'),
    ).toBe(true);
    // The line is empty: neither `x` nor `q` was left for the shell.
    expect(await h.cmd('echo after')).toBe('after');
    expect(h.screen.text()).not.toMatch(/command not found/);
    // No frame timer is left behind.
    expect(h.host.processes().map((p) => p.argv[0])).toEqual(['-sh']);
  });

  it('UI-120 Ctrl-C still ends top and restores the terminal', async () => {
    const h = await startSession({
      rows: 40,
      setup: (fs) => fs.handlers.set('uptime', () => UPTIME),
    });
    await h.keys('top -d 5\r');
    await h.keys('\x03');
    expect(h.screen.raw).toContain('\x1b[?1049l');
    expect(await h.cmd('echo ok')).toBe('ok');
    expect(h.link.modes().canonical).toBe(false);
    expect(h.host.processes().map((p) => p.argv[0])).toEqual(['-sh']);
  });
});

describe('UI-123 the complete command', () => {
  it('UI-123 complete --line prints what Tab would offer; --stats and --bench say the service is not reachable', async () => {
    const page =
      '---json\n{"name":"ls","summary":"list","flags":[{"short":"-a","long":"--all","desc":"all names"}]}\n---\n';
    const h = await startSession({
      host: { manPages: manLibrary({ ls: () => Promise.resolve(page) }) },
    });
    expect(await h.cmd("complete --line 'whoa'")).toBe('whoami');
    expect(await h.cmd("complete --line 'ls --a'")).toBe('--all  all names');
    expect(await h.cmd("complete --line 'cat t'")).toBe('todo.txt');
    const stats = await h.cmd('complete --stats; echo status=$?');
    expect(stats).toMatch(
      /complete: --stats: the completion service is not reachable from this terminal yet/,
    );
    expect(stats).toMatch(/status=1$/);
    expect(await h.cmd('complete --nope; echo status=$?')).toMatch(/status=2$/);
    expect(await h.cmd('type complete')).toBe('complete is /bin/complete');
  });
});

describe('UI-159 the kill builtin', () => {
  it('UI-159 kill of a pid beyond PID_MAX says "No such process"', async () => {
    const h = await startSession();
    expect(await h.cmd('kill -9 99999; echo status=$?')).toBe(
      'kill: (99999) - No such process\nstatus=1',
    );
  });
});
