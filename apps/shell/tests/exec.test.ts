import { describe, expect, it } from 'vitest';

import type { Program } from '../../src/_sys.ts';
import { shellQuote } from '../exec.ts';
import { runC, Session } from './session.ts';

interface SpawnArgs {
  path: string;
  argv: string[];
  env: Record<string, string>;
  fds: Record<number, number>;
  pgid?: number;
}

describe('pipelines and redirection (§3.7.3, §3.7.4)', () => {
  it('SYS-02 a pipeline connects stdout to stdin and its status is the last command’s', () => {
    const s = new Session({ setup: (k) => k.writeFile('/home/demo/f.txt', 'one\ntwo\nthree\n') });
    expect(s.cmd('cat f.txt | grep -c o')).toBe('2');
    expect(s.cmd('cat f.txt | grep t | grep h')).toBe('three');
    s.cmd('cat f.txt | grep zzz');
    expect(s.st.status).toBe(1);
    s.cmd('grep zzz f.txt | cat');
    expect(s.st.status).toBe(0);
  });

  it('SYS-02 every process of a pipeline is in the first process’s group and the shell closes its pipe ends', () => {
    const s = new Session();
    s.cmd('cat /dev/none | grep x | cat');
    const spawns = s.k.callsOf('spawn') as SpawnArgs[];
    expect(spawns).toHaveLength(3);
    expect(spawns[0]?.pgid).toBe(0);
    const first = s.k.procs.get(Math.min(...[...s.k.procs.keys()].filter((p) => p !== s.pid)));
    expect(spawns[1]?.pgid).toBe(first?.pid);
    expect(spawns[2]?.pgid).toBe(first?.pid);
    const shellFds = [...(s.k.proc(s.pid)?.fds.keys() ?? [])];
    expect(shellFds.sort()).toEqual([0, 1, 2]);
  });

  it('SYS-02 > truncates, >> appends and < reads (the scripted-session step 4)', () => {
    const s = new Session();
    expect(s.cmd("echo 'one $HOME' > t.txt; echo two >> t.txt; cat < t.txt")).toBe(
      'one $HOME\ntwo',
    );
    s.cmd('echo new > t.txt');
    expect(s.k.readFile('/home/demo/t.txt')).toBe('new\n');
    s.cmd('> empty.txt');
    expect(s.k.readFile('/home/demo/empty.txt')).toBe('');
  });

  it('SYS-02 2>&1 sends errors down the pipe and n>&m applies left to right', () => {
    const s = new Session();
    expect(s.cmd('cat missing 2>&1 | grep -c missing')).toBe('1');
    s.cmd('cat missing > out.txt 2>&1');
    expect(s.k.readFile('/home/demo/out.txt')).toBe('missing: ENOENT\n');
    s.cmd('cat missing 2>&1 > out2.txt');
    expect(s.k.readFile('/home/demo/out2.txt')).toBe('');
    expect(s.cmd('echo err 1>&2')).toBe('err');
  });

  it('SYS-02 redirections on a builtin are undone afterwards', () => {
    const s = new Session();
    s.cmd('echo hidden > b.txt');
    expect(s.cmd('echo visible')).toBe('visible');
    expect(s.k.readFile('/home/demo/b.txt')).toBe('hidden\n');
    s.cmd('pwd >> b.txt');
    expect(s.k.readFile('/home/demo/b.txt')).toBe('hidden\n/home/demo\n');
    expect([...(s.k.proc(s.pid)?.fds.keys() ?? [])].sort()).toEqual([0, 1, 2]);
  });

  it('SYS-02 a failed redirection prints the errno text, sets 1 and does not run the command', () => {
    const s = new Session({
      setup: (k) => {
        k.writeFile('/home/demo/ro.txt', 'x', 0o444);
        k.mkdir('/home/demo/t');
      },
    });
    expect(s.cmd('echo x > ro.txt')).toBe('sh: ro.txt: Permission denied');
    expect(s.st.status).toBe(1);
    expect(s.cmd('cat < nope.txt')).toBe('sh: nope.txt: No such file or directory');
    expect(s.cmd('args x > t')).toBe('sh: t: Is a directory');
    expect(s.k.callsOf('spawn')).toHaveLength(0);
    // Inside the shell any descriptor can be redirected; spawn maps only 0–2.
    expect(s.cmd('echo x 3> f')).toBe('x');
    expect(s.cmd('args x 3> f')).toBe('sh: 3: Bad file descriptor');
  });

  it('SYS-02 a redirection target that expands to several fields is an ambiguous redirect', () => {
    const s = new Session({
      setup: (k) => {
        k.writeFile('/home/demo/a.txt', '');
        k.writeFile('/home/demo/b.txt', '');
      },
    });
    expect(s.cmd('echo x > *.txt')).toBe('sh: *.txt: ambiguous redirect');
    expect(s.st.status).toBe(1);
    s.cmd('F="two words"');
    expect(s.cmd('args > $F')).toBe('sh: $F: ambiguous redirect');
  });

  it('SYS-02 a writer whose reader exited ends quietly with 141', () => {
    const s = new Session();
    expect(s.cmd('yes | head -n 3')).toBe('y\ny\ny');
    expect(s.st.status).toBe(0);
    s.cmd('yes | status 0');
    expect(s.st.status).toBe(0);
  });
});

describe('sequencing and statuses (§3.7.5, §3.7.6)', () => {
  it('SYS-02 ; runs both, && runs on success, || on failure (scripted-session step 6)', () => {
    const s = new Session();
    expect(s.cmd('false || echo fallback; true && echo ok')).toBe('fallback\nok');
    expect(s.cmd('false && echo no; echo $?')).toBe('1');
    expect(s.cmd('true || echo no || echo no2; echo $?')).toBe('0');
    expect(s.cmd('false && echo a || echo b && echo c')).toBe('b\nc');
  });

  it('SHL-07 command not found is 127, not executable is 126, and ! inverts the status', () => {
    const s = new Session({
      setup: (k) => {
        k.install(
          'locked',
          {
            init: () => ({}),
            *run() {
              yield Symbol('x');
              return 0;
            },
          },
          0o644,
        );
        k.writeFile('/home/demo/data.txt', 'x', 0o644);
      },
    });
    expect(s.cmd('nope; echo $?')).toBe('sh: nope: command not found\n127');
    expect(s.cmd('locked; echo $?')).toBe('sh: locked: Permission denied\n126');
    expect(s.cmd('./data.txt; echo $?')).toBe('sh: ./data.txt: cannot execute\n126');
    expect(s.cmd('./gone; echo $?')).toBe('sh: ./gone: No such file or directory\n127');
    expect(s.cmd('! false; echo $?')).toBe('0');
    expect(s.cmd('! status 4; echo $?')).toBe('0');
    expect(s.cmd('! true; echo $?')).toBe('1');
  });

  it('SHL-07 a syntax error runs nothing on the line and sets 2', () => {
    const s = new Session();
    expect(s.cmd('echo a; echo $(date)')).toBe('sh: command substitution is not supported');
    expect(s.st.status).toBe(2);
    expect(s.cmd('echo a ;; echo b')).toBe("sh: syntax error near unexpected token ';' (column 9)");
  });

  it('SHL-07 exit statuses of programs are reported through $?', () => {
    const s = new Session();
    expect(s.cmd('status 7; echo $?')).toBe('7');
    expect(s.cmd('status 300; echo $?')).toBe('300');
  });

  it('SYS-02 a /-path runs its manifest, or a #!/bin/sh script through sh', () => {
    const s = new Session({
      setup: (k) => {
        k.writeFile('/home/demo/hello.sh', '#!/bin/sh\necho "hi $1"\n', 0o755);
        k.writeFile('/home/demo/tool.json', '{}', 0o755);
        k.programs.set(
          '/home/demo/tool.json',
          k.programs.get('/bin/args.json') as Program<unknown>,
        );
      },
    });
    expect(s.cmd('./hello.sh there')).toBe('hi there');
    expect(s.cmd('./tool a b')).toBe('[a][b]');
  });
});

describe('command lookup (§3.7.2)', () => {
  it('SYS-02 PATH is searched in order, cached, and the cache is cleared when PATH changes', () => {
    const s = new Session({
      setup: (k) => {
        k.mkdir('/opt');
        k.install('tool', k.programs.get('/bin/args.json') as Program<unknown>);
      },
    });
    s.cmd('tool 1');
    s.cmd('tool 2');
    const stats = () =>
      (s.k.callsOf('stat') as { path: string }[]).filter((a) => a.path.endsWith('tool.json'))
        .length;
    expect(stats()).toBe(1);
    s.cmd('PATH=/opt:/bin');
    s.cmd('tool 3');
    expect(stats()).toBe(3);
    expect((s.k.callsOf('stat') as { path: string }[]).map((a) => a.path)).toContain(
      '/opt/tool.json',
    );
    s.cmd('PATH=/opt');
    expect(s.cmd('tool 4')).toBe('sh: tool: command not found');
  });

  it('SYS-02 a stale cache entry is looked up again once', () => {
    const s = new Session({ setup: (k) => k.mkdir('/usr') });
    s.cmd('PATH=/usr:/bin');
    s.k.install('late', s.k.programs.get('/bin/args.json') as Program<unknown>);
    s.k.files.set('/usr/late.json', { type: 'f', data: '{}', mode: 0o755, ino: 'x' });
    s.k.programs.set('/usr/late.json', s.k.programs.get('/bin/args.json') as Program<unknown>);
    s.cmd('late 1');
    s.k.files.delete('/usr/late.json');
    s.k.programs.delete('/usr/late.json');
    expect(s.cmd('late 2')).toBe('[2]');
  });

  it('SYS-02 argument lists over the ABI limit are refused before spawn', () => {
    const s = new Session({ env: { L: 'x'.repeat(62_000) } });
    expect(s.cmd('args $L')).toBe('sh: args: Argument list too long');
    expect(s.st.status).toBe(126);
  });
});

describe('builtins versus programs (§3.7.1)', () => {
  it('SHL-06 cd in a pipeline does not change the shell’s directory', () => {
    const s = new Session();
    s.cmd('cd /tmp | cat');
    expect(s.cmd('pwd')).toBe('/home/demo');
    const spawns = s.k.callsOf('spawn') as SpawnArgs[];
    expect(spawns[0]?.argv).toEqual(['sh', '-c', 'cd /tmp']);
  });

  it('SHL-06 a convenience builtin in a pipeline runs its /bin program when installed', () => {
    const s = new Session({ echoProgram: true });
    expect(s.cmd('echo piped | cat')).toBe('piped');
    expect((s.k.callsOf('spawn') as SpawnArgs[])[0]?.path).toBe('/bin/echo.json');
    const t = new Session();
    expect(t.cmd("echo 'it''s' | cat")).toBe('its');
    expect((t.k.callsOf('spawn') as SpawnArgs[])[0]?.argv).toEqual(['sh', '-c', 'echo its']);
  });

  it('SHL-06 words for a child sh -c are quoted so they survive re-parsing', () => {
    expect(shellQuote('plain-word_1.txt')).toBe('plain-word_1.txt');
    expect(shellQuote('two words')).toBe("'two words'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });

  it('SHL-06 a backgrounded and-or list runs in a child sh and $! is its pid', () => {
    const s = new Session();
    const out = s.cmd('true && sleep 1 &');
    const spawn = (s.k.callsOf('spawn') as SpawnArgs[])[0];
    expect(spawn?.argv).toEqual(['sh', '-c', 'true && sleep 1']);
    expect(spawn?.pgid).toBe(0);
    expect(out).toBe(`[1] ${s.st.lastBg ?? ''}`);
    s.k.advance(1000);
    expect(s.cmd('')).toBe('[1]+  Done                    true && sleep 1');
  });

  it('SYS-02 variables: assignment alone is not exported, export and prefix assignment are', () => {
    const s = new Session();
    s.cmd('A=1');
    expect(s.cmd('printenv A; echo $?')).toBe('1');
    s.cmd('export A');
    expect(s.cmd('printenv A')).toBe('1');
    expect(s.cmd('B=2 printenv B')).toBe('2');
    expect(s.cmd('echo "[$B]"')).toBe('[]');
    s.cmd('export C=3');
    expect(s.cmd('printenv C')).toBe('3');
    s.cmd('unset C');
    expect(s.cmd('printenv C; echo $?')).toBe('1');
  });

  it('SYS-02 assignments on one line are made left to right', () => {
    const s = new Session();
    expect(s.cmd('A=1 B=$A; echo $B')).toBe('1');
    expect(s.cmd('C=x > made.txt; echo $C')).toBe('x');
    expect(s.k.readFile('/home/demo/made.txt')).toBe('');
    expect(s.cmd('D=1 > *.none > two')).toBe('');
    expect(s.cmd('PATH=/nowhere type sh; type sh')).toBe('sh: type: sh: not found\nsh is /bin/sh');
  });

  it('SYS-02 a prefix assignment on a builtin lasts for that builtin only', () => {
    const s = new Session();
    s.cmd('HOME=/tmp cd');
    expect(s.cmd('pwd')).toBe('/tmp');
    expect(s.cmd('echo $HOME')).toBe('/home/demo');
  });
});

describe('non-interactive shells (§3.4)', () => {
  it('SYS-02 sh -c runs the text and exits with the status of the last command', () => {
    expect(runC('echo a; status 5').code).toBe(5);
    expect(runC('exit 3; echo no').code).toBe(3);
    const r = runC("echo 'unclosed");
    expect(r.out).toBe("sh: syntax error: unexpected end of input (unclosed ')");
    expect(r.code).toBe(2);
  });

  it('SYS-02 sh FILE runs a script with positional parameters, and a missing file is 127', () => {
    const { k } = runC('true', {
      setup: (kk) => kk.writeFile('/home/demo/s.sh', 'echo "$0 $1 $#"\nstatus 4\n'),
    });
    const sh = k.programs.get('/bin/sh.json') as Program<unknown>;
    const pid = k.start(sh, ['sh', 's.sh', 'arg']);
    k.run();
    expect(k.screen.text()).toBe('s.sh arg 1');
    expect(k.exitStatus(pid)).toEqual({ kind: 'exited', code: 4 });
    const missing = k.start(sh, ['sh', 'nope.sh']);
    k.run();
    expect(k.exitStatus(missing)).toEqual({ kind: 'exited', code: 127 });
  });

  it('SYS-02 a shell whose stdin is not a terminal reads its commands from stdin', () => {
    const { k } = runC('true');
    const sh = k.programs.get('/bin/sh.json') as Program<unknown>;
    const pid = k.start(sh, ['sh'], { stdin: 'echo from stdin\nstatus 6\n' });
    k.run();
    expect(k.screen.text()).toBe('from stdin');
    expect(k.exitStatus(pid)).toEqual({ kind: 'exited', code: 6 });
  });

  it('SYS-02 a non-interactive shell keeps its children in its own group', () => {
    const r = runC('sleep 1; true');
    expect(r.k.live()).toHaveLength(2);
    r.k.advance(1000);
    const spawns = r.k.callsOf('spawn') as SpawnArgs[];
    expect(spawns[0]?.pgid).toBeUndefined();
    expect(r.k.live()).toHaveLength(0);
  });
});
