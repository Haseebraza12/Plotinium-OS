import { describe, expect, it } from 'vitest';

import chmod, { changeLine, splitModeArg } from '../cmd/chmod.ts';
import chown, { parseOwner } from '../cmd/chown.ts';
import cp, { lastOf } from '../cmd/cp.ts';
import ln from '../cmd/ln.ts';
import mv from '../cmd/mv.ts';
import rm, { refusal } from '../cmd/rm.ts';
import { SysError } from '../lib/sys.ts';
import { kernel } from './harness.ts';

function tree() {
  const k = kernel();
  k.fs.addFile('/home/alice/t/a/b/x.txt', 'x');
  k.fs.addFile('/home/alice/t/f.txt', 'one\n');
  return k;
}

describe('cp', () => {
  it('SYS-02 cp -r copies a tree in one copy call and -v prints the pair', () => {
    const k = tree();
    const r = k.run(cp, ['cp', '-rv', 't', 't2']);
    expect(r).toMatchObject({ status: 0, out: "'t' -> 't2'\n" });
    expect(k.fs.text('t2/a/b/x.txt', k.cwd)).toBe('x');
    expect(k.countCalls('copy')).toBe(1);
  });

  it('SYS-02 cp into an existing directory keeps the name; several sources need a directory', () => {
    const k = tree();
    k.fs.addDir('/home/alice/dest');
    expect(k.run(cp, ['cp', 't/f.txt', 'dest']).status).toBe(0);
    expect(k.fs.text('dest/f.txt', k.cwd)).toBe('one\n');
    expect(k.run(cp, ['cp', 't/f.txt', 't/a', 'nodir'])).toMatchObject({
      status: 1,
      err: "cp: target 'nodir': No such file or directory\n",
    });
  });

  it('SYS-02 cp without -r omits a directory and reports a missing source', () => {
    const r = tree().run(cp, ['cp', 't', 'nope', 'x']);
    expect(r.status).toBe(1);
    expect(r.err).toBe("cp: target 'x': No such file or directory\n");
    const one = tree().run(cp, ['cp', 't', 'y']);
    expect(one.err).toBe("cp: -r not specified; omitting directory 't'\n");
    expect(tree().run(cp, ['cp', 'nope', 'y']).err).toBe(
      "cp: cannot stat 'nope': No such file or directory\n",
    );
  });

  it('SYS-02 cp refuses to copy a directory into itself', () => {
    expect(tree().run(cp, ['cp', '-r', 't', 't/a/inside']).err).toBe(
      "cp: cannot copy a directory, 't', into itself, 't/a/inside'\n",
    );
  });

  it('VFS-06 cp over quota copies nothing and says so', () => {
    const k = tree().fail('copy', 'EDQUOT');
    expect(k.run(cp, ['cp', 't/f.txt', 'g']).err).toBe(
      "cp: cannot copy 't/f.txt': Disk quota exceeded — nothing was copied\n",
    );
  });

  it('DB-02 cp with an injected fault prints EIO with rolled back', () => {
    const k = tree().fail('copy', 'EIO', { msg: 'injected fault at node 500' });
    expect(k.run(cp, ['cp', '-r', 't', 'u']).err).toBe(
      "cp: cannot copy 't': Input/output error (injected fault at node 500) — rolled back\n",
    );
  });

  it('SYS-02 cp -n never overwrites and -f replaces an unwritable destination', () => {
    const k = tree();
    k.fs.addFile('/home/alice/dst', 'old', { mode: 0o444 });
    expect(k.run(cp, ['cp', '-n', 't/f.txt', 'dst']).status).toBe(0);
    expect(k.fs.text('dst', k.cwd)).toBe('old');
    expect(k.run(cp, ['cp', 't/f.txt', 'dst']).status).toBe(1);
    expect(k.run(cp, ['cp', '-f', 't/f.txt', 'dst']).status).toBe(0);
    expect(k.fs.text('dst', k.cwd)).toBe('one\n');
    expect(lastOf(['-nf'], 'n', 'f')).toBe('f');
    expect(kernel().run(cp, ['cp', 'only']).status).toBe(2);
  });
});

describe('mv', () => {
  it('SYS-02 mv renames and moves into a directory', () => {
    const k = tree();
    k.fs.addDir('/home/alice/reports');
    expect(k.run(mv, ['mv', '-v', 't/f.txt', 'reports']).out).toBe(
      "renamed 't/f.txt' -> 'reports/f.txt'\n",
    );
    expect(k.run(mv, ['mv', 't', 't3']).status).toBe(0);
    expect(k.fs.exists('t3/a/b/x.txt', k.cwd)).toBe(true);
  });

  it('SYS-02 mv reports a move into its own subdirectory and overwriting a directory', () => {
    const k = tree();
    k.fs.addDir('/home/alice/d');
    k.fs.addFile('/home/alice/file', '');
    expect(k.run(mv, ['mv', 't', 't/a/in']).err).toBe(
      "mv: cannot move 't' to a subdirectory of itself, 't/a/in'\n",
    );
    k.fail('rename', 'EISDIR');
    expect(k.run(mv, ['mv', 'file', 'x']).err).toBe(
      "mv: cannot overwrite directory 'x' with non-directory\n",
    );
  });

  it('SYS-02 mv -n skips an existing destination and reports a missing source', () => {
    const k = tree();
    k.fs.addFile('/home/alice/g', 'g');
    expect(k.run(mv, ['mv', '-n', 't/f.txt', 'g']).status).toBe(0);
    expect(k.fs.text('g', k.cwd)).toBe('g');
    expect(k.run(mv, ['mv', 'nope', 'z']).err).toBe(
      "mv: cannot stat 'nope': No such file or directory\n",
    );
    expect(k.run(mv, ['mv', 'g', 'h', 'nodir']).status).toBe(1);
    k.fail('rename', 'EBUSY', { detail: { holder: 'bob@lab-pc-3' } });
    expect(k.run(mv, ['mv', 'g', 'h']).err).toBe(
      "mv: cannot move 'g' to 'h': Resource busy (locked by bob@lab-pc-3)\n",
    );
  });
});

describe('rm', () => {
  it('SYS-02 rm removes a file and refuses a directory without -r', () => {
    const k = tree();
    expect(k.run(rm, ['rm', 't/f.txt']).status).toBe(0);
    expect(k.run(rm, ['rm', 't'])).toMatchObject({
      status: 1,
      err: "rm: cannot remove 't': Is a directory\n",
    });
  });

  it('SYS-02 rm -r removes a tree in one unlink call and -v counts the entries', () => {
    const k = tree();
    const r = k.run(rm, ['rm', '-rv', 't']);
    expect(r.out).toBe("removed 't' (5 entries)\n");
    expect(k.argsOf('unlink')).toEqual([{ path: 't', recursive: true }]);
    expect(k.fs.exists('t', k.cwd)).toBe(false);
  });

  it('SYS-02 rm -d removes an empty directory and -f ignores missing operands', () => {
    const k = kernel();
    k.fs.addDir('/home/alice/empty');
    expect(k.run(rm, ['rm', '-dv', 'empty']).out).toBe("removed directory 'empty'\n");
    expect(k.run(rm, ['rm', '-f', 'ghost'])).toMatchObject({ status: 0, err: '' });
    expect(k.run(rm, ['rm', 'ghost']).err).toBe(
      "rm: cannot remove 'ghost': No such file or directory\n",
    );
    expect(k.run(rm, ['rm']).status).toBe(2);
    expect(k.run(rm, ['rm', '-f']).status).toBe(0);
  });

  it('SYS-02 rm refuses / and . and ..', () => {
    expect(refusal('/', true)).toBe("it is dangerous to operate recursively on '/'");
    expect(refusal('a/..', false)).toBe(
      "refusing to remove '.' or '..' directory: skipping 'a/..'",
    );
    expect(refusal('a', true)).toBeNull();
    expect(kernel().run(rm, ['rm', '-rf', '/']).err).toBe(
      "rm: it is dangerous to operate recursively on '/'\n",
    );
  });

  it('DB-02 rm -r with an injected fault is rolled back; a server rejection is restored', () => {
    const k = tree().fail('unlink', 'EIO', { msg: 'injected fault at node 500' });
    expect(k.run(rm, ['rm', '-r', 't']).err).toBe(
      "rm: cannot remove 't': Input/output error (injected fault at node 500) — rolled back\n",
    );
    k.fail('unlink', 'EACCES', { msg: 'server' });
    expect(k.run(rm, ['rm', '-r', 't']).err).toBe(
      "rm: cannot remove 't': Permission denied (server) — restored\n",
    );
  });

  it('SYS-02 rm -r online without server confirmation succeeds with a notice', () => {
    const k = tree();
    k.on('unlink', () => ({
      removed: 5,
      bytes: 5,
      opId: '0192f0c1-7c2e-7a51-9d6f-000000000001',
      sync: 'pending',
    }));
    k.on('net.status', () => ({
      state: 'online',
      queuedOps: 1,
      lastAckAt: null,
      degraded: [],
      leaseTtlMs: 15_000,
      serverBuild: null,
    }));
    expect(k.run(rm, ['rm', '-r', 't'])).toMatchObject({
      status: 0,
      err: "rm: 't' removed locally; server confirmation pending\n",
    });
    k.on('net.status', () => ({
      state: 'offline',
      queuedOps: 1,
      lastAckAt: null,
      degraded: [],
      leaseTtlMs: 15_000,
      serverBuild: null,
    }));
    expect(k.run(rm, ['rm', '-r', 't']).err).toBe('');
  });
});

describe('ln', () => {
  it('VFS-05 ln -s makes a symlink that may dangle and -v prints it', () => {
    const k = tree();
    expect(k.run(ln, ['ln', '-sv', 't/f.txt', 'link']).out).toBe("'link' -> 't/f.txt'\n");
    expect(k.fs.node(k.fs.resolve('link', k.cwd, false).ino).target).toBe('t/f.txt');
    expect(k.run(ln, ['ln', '-s', 'missing', 'dangling']).status).toBe(0);
  });

  it('SYS-02 ln -s into a directory, with one operand, and -f replacing in one batch', () => {
    const k = tree();
    expect(k.run(ln, ['ln', '-s', '/etc/x', 't']).status).toBe(0);
    expect(k.fs.exists('t/x', k.cwd)).toBe(true);
    expect(k.run(ln, ['ln', '-s', '/opt/tool']).status).toBe(0);
    expect(k.fs.exists('tool', k.cwd)).toBe(true);
    k.on('batch', (a) => ({
      txnId: a.txnId,
      applied: a.ops.length,
      inodes: 1,
      bytes: 0,
      undoId: a.txnId,
      opId: a.txnId,
      sync: 'applied',
    }));
    expect(k.run(ln, ['ln', '-sf', 'new', 'tool']).status).toBe(0);
    const batch = k.argsOf('batch')[0] as { ops: unknown[]; txnId: string };
    expect(batch.ops).toEqual([
      { op: 'unlink', path: 'tool' },
      { op: 'symlink', target: 'new', path: 'tool' },
    ]);
    expect(batch.txnId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('SYS-02 ln without -s reports that hard links are not supported', () => {
    const r = tree().run(ln, ['ln', 't/f.txt', 'hard']);
    expect(r).toMatchObject({ status: 1, err: 'ln: hard links are not supported; use ln -s\n' });
  });

  it('SYS-02 ln reports an existing link name', () => {
    const k = tree();
    k.fs.addFile('/home/alice/taken', '');
    expect(k.run(ln, ['ln', '-s', 'x', 'taken']).err).toBe(
      "ln: failed to create symbolic link 'taken': File exists\n",
    );
    expect(k.run(ln, ['ln', '-s', 'a', 'b', 'taken']).status).toBe(1);
    expect(k.run(ln, ['ln']).status).toBe(2);
  });
});

describe('chmod', () => {
  it('SYS-02 chmod 600 sets the mode exactly', () => {
    const k = tree();
    expect(k.run(chmod, ['chmod', '600', 't/f.txt']).status).toBe(0);
    expect(k.fs.node(k.fs.resolve('t/f.txt', k.cwd, false).ino).mode).toBe(0o600);
    expect(k.argsOf('chmod')).toEqual([
      { path: 't/f.txt', mode: { op: 'set', bits: 0o600 }, recursive: false },
    ]);
  });

  it('VFS-04 chmod -R o-w is one recursive delta and -c reports only changes', () => {
    const k = tree();
    k.fs.walk(k.fs.node(k.fs.resolve('t', k.cwd, false).ino), (n) => {
      n.mode = n.type === 'd' ? 0o777 : 0o666;
    });
    const r = k.run(chmod, ['chmod', '-Rc', 'o-w', 't']);
    expect(r.status).toBe(0);
    expect(r.out.split('\n')[0]).toBe(
      "mode of 't' changed from 0777 (rwxrwxrwx) to 0775 (rwxrwxr-x)",
    );
    expect(k.argsOf('chmod')).toEqual([
      { path: 't', mode: { op: 'delta', add: 0, clear: 0o002 }, recursive: true },
    ]);
  });

  it('VFS-04 chmod -R a+X becomes one batch of exact modes', () => {
    const k = tree();
    k.on('batch', (a) => ({
      txnId: a.txnId,
      applied: a.ops.length,
      inodes: a.ops.length,
      bytes: 0,
      undoId: a.txnId,
      opId: a.txnId,
      sync: 'applied',
    }));
    k.fs.walk(k.fs.node(k.fs.resolve('t', k.cwd, false).ino), (n) => {
      n.mode = n.type === 'd' ? 0o744 : 0o644;
    });
    expect(k.run(chmod, ['chmod', '-R', 'a+X', 't']).status).toBe(0);
    const ops = (k.argsOf('batch')[0] as { ops: { path: string; mode: { bits: number } }[] }).ops;
    expect(ops.map((o) => [o.path, o.mode.bits])).toEqual([
      ['t', 0o755],
      ['t/a', 0o755],
      ['t/a/b', 0o755],
      ['t/a/b/x.txt', 0o644],
      ['t/f.txt', 0o644],
    ]);
  });

  it('SYS-02 chmod -w takes a dash mode and umask applies without a who', () => {
    const k = tree();
    expect(splitModeArg(['-w', 'f'])).toEqual({ args: ['f'], mode: '-w' });
    expect(splitModeArg(['-R', 'u+x', 'f'])).toEqual({ args: ['-R', 'u+x', 'f'], mode: null });
    expect(k.run(chmod, ['chmod', '-v', '-w', 't/f.txt']).out).toBe(
      "mode of 't/f.txt' changed from 0644 (rw-r--r--) to 0444 (r--r--r--)\n",
    );
    expect(k.run(chmod, ['chmod', '-v', '+w', 't/f.txt']).out).toBe(
      "mode of 't/f.txt' changed from 0444 (r--r--r--) to 0644 (rw-r--r--)\n",
    );
    expect(changeLine({ path: 'x', from: 0o644, to: 0o644 }, true)).toBe(
      "mode of 'x' retained as 0644 (rw-r--r--)",
    );
    expect(changeLine({ path: 'x', from: 0o644, to: 0o644 }, false)).toBeNull();
  });

  it('SYS-02 chmod reports an invalid mode, a missing file and a refusal', () => {
    const k = tree();
    expect(k.run(chmod, ['chmod', 'u+z', 't'])).toMatchObject({
      status: 1,
      err: "chmod: invalid mode: 'u+z'\n",
    });
    expect(k.run(chmod, ['chmod', '644', 'nope']).err).toBe(
      "chmod: cannot access 'nope': No such file or directory\n",
    );
    k.fs.addFile('/home/alice/bobs', '', { uid: 1002 });
    expect(k.run(chmod, ['chmod', '600', 'bobs']).err).toBe(
      "chmod: changing permissions of 'bobs': Operation not permitted\n",
    );
    expect(k.run(chmod, ['chmod', '644']).status).toBe(2);
  });
});

describe('chown', () => {
  it('SYS-02 chown by a non-root user fails with Operation not permitted', () => {
    const r = tree().run(chown, ['chown', 'bob', 't/f.txt']);
    expect(r).toMatchObject({
      status: 1,
      err: "chown: changing ownership of 't/f.txt': Operation not permitted\n",
    });
  });

  it('SYS-02 chown as root changes owner and group and -v reports it', () => {
    const k = tree();
    k.fs.cred = { uid: 0, gid: 0 };
    const r = k.run(chown, ['chown', '-Rv', 'bob:team', 't']);
    expect(r.out).toBe("changed ownership of 't' from alice:alice to bob:team\n");
    expect(k.argsOf('chown')).toEqual([{ path: 't', uid: 1002, gid: 1002, recursive: true }]);
    expect(k.run(chown, ['chown', '-v', 'bob:team', 't']).out).toBe(
      "ownership of 't' retained as bob:team\n",
    );
    k.run(chown, ['chown', 'alice:', 't']);
    expect(k.argsOf('chown')).toEqual([{ path: 't', uid: 1001, gid: 1001, recursive: false }]);
    k.run(chown, ['chown', ':users', 't']);
    expect(k.argsOf('chown')).toEqual([{ path: 't', gid: 100, recursive: false }]);
  });

  it('SYS-02 chown reports an invalid user or group', () => {
    const k = tree();
    expect(k.run(chown, ['chown', 'bob2', 't'])).toMatchObject({
      status: 1,
      err: "chown: invalid user: 'bob2'\n",
    });
    expect(k.run(chown, ['chown', 'bob:nogroup', 't']).err).toBe(
      "chown: invalid group: 'bob:nogroup'\n",
    );
    expect(k.run(chown, ['chown', 'bob', 'nope']).err).toBe(
      "chown: cannot access 'nope': No such file or directory\n",
    );
    expect(parseOwner('1005:7')).toEqual({ owner: '1005', group: '7', loginGroup: false });
    expect(k.run(chown, ['chown', 'bob']).status).toBe(2);
  });

  it('VFS-06 chown -R over the new owner quota changes nothing', () => {
    const k = tree();
    k.fs.cred = { uid: 0, gid: 0 };
    k.on('chown', () => {
      throw new SysError('EDQUOT');
    });
    expect(k.run(chown, ['chown', '-R', 'bob', 't']).err).toBe(
      "chown: changing ownership of 't': Disk quota exceeded\n",
    );
  });
});
