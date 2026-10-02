import { describe, expect, it } from 'vitest';

import { echoText, interpretEscapes } from '../builtins/echo.ts';
import { banner, helpText } from '../builtins/help.ts';
import { BUILTIN_NAMES, isBuiltin, isConvenience } from '../builtins/names.ts';
import { runC, Session } from './session.ts';

describe('cd and pwd (§3.14.2, §3.14.3)', () => {
  it('SYS-02 cd with no operand goes home, cd - goes back and prints the directory', () => {
    const s = new Session({ setup: (k) => k.mkdir('/home/demo/notes') });
    expect(s.cmd('cd notes && pwd')).toBe('/home/demo/notes');
    expect(s.cmd('echo $PWD $OLDPWD')).toBe('/home/demo/notes /home/demo');
    expect(s.cmd('cd /tmp; cd -')).toBe('/home/demo/notes');
    expect(s.cmd('cd; pwd')).toBe('/home/demo');
    expect(s.current()).toBe('demo@plotinium:~$');
    s.cmd('cd /tmp');
    expect(s.current()).toBe('demo@plotinium:/tmp$');
  });

  it('SYS-02 cd reports errors with the spec texts and status 1', () => {
    const s = new Session({
      setup: (k) => {
        k.writeFile('/home/demo/file', '');
        k.mkdir('/home/demo/locked', 0o600);
      },
    });
    expect(s.cmd('cd nope')).toBe('cd: nope: No such file or directory');
    expect(s.st.status).toBe(1);
    expect(s.cmd('cd file')).toBe('cd: file: Not a directory');
    expect(s.cmd('cd locked')).toBe('cd: locked: Permission denied');
    expect(s.cmd('cd a b')).toBe('cd: too many arguments');
    expect(s.cmd('cd -')).toBe('cd: OLDPWD not set');
    s.cmd('unset HOME');
    expect(s.cmd('cd')).toBe('cd: HOME not set');
    expect(s.cmd("cd ''; echo $?")).toBe('0');
    expect(s.cmd('cd -- /tmp; pwd')).toBe('/tmp');
  });

  it('SYS-02 pwd prints the kernel’s directory; -L prints $PWD when it names the same one', () => {
    const s = new Session();
    expect(s.cmd('pwd -P')).toBe('/home/demo');
    s.cmd('PWD=/tmp');
    expect(s.cmd('pwd -L')).toBe('/home/demo');
    s.cmd('PWD=/home/demo/');
    expect(s.cmd('pwd -L')).toBe('/home/demo/');
    expect(s.cmd('pwd -x')).toBe(
      "pwd: invalid option -- 'x'\nUsage: pwd [-L | -P]\nTry 'man pwd'.",
    );
    expect(s.st.status).toBe(2);
  });

  it('SYS-02 pwd fails when the working directory was deleted, and cd ~ recovers', () => {
    const s = new Session({ setup: (k) => k.mkdir('/home/demo/gone') });
    s.cmd('cd gone');
    s.k.files.delete('/home/demo/gone');
    expect(s.cmd('pwd')).toBe('pwd: cannot determine current directory: No such file or directory');
    expect(s.cmd('cd ~; pwd')).toBe('/home/demo');
  });
});

describe('echo (§3.14.8)', () => {
  it('SYS-02 echo joins its arguments with spaces; -n drops the newline; -e interprets escapes', () => {
    expect(echoText(['a', 'b'])).toBe('a b\n');
    expect(echoText(['-n', 'a'])).toBe('a');
    expect(echoText(['-ne', 'a\\tb'])).toBe('a\tb');
    expect(echoText(['-e', '-n', 'x'])).toBe('x');
    expect(echoText(['-x', 'a'])).toBe('-x a\n');
    expect(echoText(['a\\n'])).toBe('a\\n\n');
    expect(interpretEscapes('\\n\\t\\\\\\a\\e\\0101\\0\\q')).toBe('\n\t\\\x07\x1bA\0\\q');
  });

  it('SYS-02 echo reports a write error on a closed descriptor', () => {
    const s = new Session();
    expect(s.cmd('echo x >&5')).toBe('sh: 5: Bad file descriptor');
    s.cmd('true');
    const r = runC('echo x 1>&0; echo $?');
    expect(r.code).toBe(0);
  });
});

describe('export, unset and variables (§3.4)', () => {
  it('SYS-02 export lists exported variables and rejects bad names', () => {
    const s = new Session();
    s.cmd('export Q=\'a "b" $c\'');
    expect(s.cmd('export | grep Q=')).toBe('export Q="a \\"b\\" \\$c"');
    expect(s.cmd('export 1x')).toBe("export: '1x': not a valid identifier");
    expect(s.st.status).toBe(1);
    expect(s.cmd('export UID=0')).toBe('export: UID: readonly variable');
    expect(s.cmd('export -p | grep -c HOME=')).toBe('1');
  });

  it('SYS-02 unset removes variables but not read-only ones', () => {
    const s = new Session();
    s.cmd('X=1; unset X');
    expect(s.cmd('echo "[$X]"')).toBe('[]');
    expect(s.cmd('unset UID')).toBe('unset: UID: cannot unset: readonly variable');
    expect(s.cmd('unset -v a-b')).toBe("unset: 'a-b': not a valid identifier");
    expect(s.cmd('UID=5')).toBe('sh: UID: readonly variable');
    expect(s.cmd('echo $UID')).toBe('1000');
  });

  it('SYS-02 the start-up environment has HOME, USER, PATH, PWD and friends (scripted-session step 2)', () => {
    const s = new Session();
    expect(s.cmd('echo "$USER $HOME $PATH"')).toBe('demo /home/demo /bin');
    expect(s.cmd('echo $LOGNAME $SHELL $TERM $HOSTNAME $LANG $TZ')).toBe(
      'demo /bin/sh xterm-256color plotinium C.UTF-8 Asia/Karachi',
    );
    expect(s.cmd('echo $HISTFILE $HISTSIZE $COLUMNS $LINES')).toBe(
      '/home/demo/.sh_history 1000 160 24',
    );
    expect(s.cmd('printenv PS1; echo $?')).toBe('1');
    expect(s.cmd('printenv HOME')).toBe('/home/demo');
  });

  it('SYS-02 a non-login shell keeps inherited values, a login shell resets HOME and USER', () => {
    const inherited = runC('echo $HOME $USER $PATH', {
      env: { HOME: '/x', USER: 'u', PATH: '/p' },
    });
    expect(inherited.out).toBe('/x u /p');
    const login = new Session({ env: { HOME: '/x', USER: 'u' } });
    expect(login.cmd('echo $HOME $USER')).toBe('/home/demo demo');
  });
});

describe('type, help, exit, true and false', () => {
  it('SYS-02 type says whether a name is a builtin or a program', () => {
    const s = new Session();
    expect(s.cmd('type cd ls cat')).toBe(
      'cd is a shell builtin\nsh: type: ls: not found\ncat is /bin/cat',
    );
    expect(s.st.status).toBe(1);
  });

  it('SYS-02 help prints the exact banner line first (scripted-session step 26)', () => {
    const s = new Session();
    expect(s.cmd('help | head -n 1')).toBe("Plotinium 0.3.0 shell — type 'man <command>'");
    expect(banner('1.2.3')).toBe("Plotinium 1.2.3 shell — type 'man <command>'");
    expect(s.cmd('help cd')).toBe(
      'cd [DIR | -]\n    Change the working directory to DIR (default $HOME); `cd -` goes to $OLDPWD.',
    );
    expect(s.cmd('help cat')).toBe("cat: not a builtin; see 'man cat'");
    expect(s.cmd('help zork')).toBe("help: no help topics match 'zork'");
    expect(s.st.status).toBe(1);
  });

  it('SHL-18 help omits the AI row when ai is not installed and shows it when it is', () => {
    const off = new Session();
    expect(off.cmd('help')).not.toContain('AI:');
    const on = new Session({
      programs: {
        ai: {
          init: () => ({}),
          *run() {
            yield Symbol('t');
            return 0;
          },
        },
      },
    });
    expect(on.cmd('help')).toContain('AI:         ai semsearch predict');
    expect(helpText('0.3.0', true).split('\n')).toHaveLength(12);
    expect(helpText('0.3.0', false).split('\n')).toHaveLength(11);
  });

  it('SHL-18 in the AI-off build ai exits 127', () => {
    const s = new Session();
    expect(s.cmd('ai "make a folder"; echo $?')).toBe('sh: ai: command not found\n127');
  });

  it('SYS-02 exit leaves with $? or N, and a bad N is reported and exits with 2', () => {
    expect(runC('status 4; exit').code).toBe(4);
    expect(runC('exit 256').code).toBe(0);
    expect(runC('exit -1').code).toBe(255);
    const bad = runC('exit x');
    expect(bad.out).toBe('exit: x: numeric argument required');
    expect(bad.code).toBe(2);
    const many = runC('exit 1 2; echo still');
    expect(many.out).toBe('exit: too many arguments\nstill');
  });

  it('SYS-02 Ctrl-D on an empty line exits an interactive shell', () => {
    const s = new Session();
    s.cmd('status 3');
    s.keys('\x04');
    expect(s.exited()).toBe(true);
    expect(s.k.exitStatus(s.pid)).toEqual({ kind: 'exited', code: 3 });
  });

  it('SYS-02 the builtin sets of §3.7.1', () => {
    expect(BUILTIN_NAMES).toEqual([
      'bg',
      'cd',
      'echo',
      'exit',
      'export',
      'false',
      'fg',
      'help',
      'history',
      'jobs',
      'kill',
      'pwd',
      'true',
      'type',
      'unset',
      'wait',
    ]);
    expect(isBuiltin('ls')).toBe(false);
    expect(isConvenience('echo')).toBe(true);
    expect(isConvenience('cd')).toBe(false);
  });
});
