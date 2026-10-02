/**
 * The storage and vfs services on the loopback host with the in-memory store, and the file system
 * reached ONLY through the fs system calls (SYS-01; virtual-file-system.md §3.3.6, §3.5, §3.13.3).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppManifestInput, RetOf } from '@plotinium/protocol';
import { INO } from '@plotinium/protocol';
import type { MetaRec } from '@plotinium/vfs';

import type { Program } from '../../../runtime/sys.ts';
import { errnoOf } from '../../../runtime/sys.ts';
import { MemStore } from '../../fs/mem-store.ts';
import type { World } from './world.ts';
import { bootToDesktop, bootWorld } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

interface FsOut {
  steps: string[];
  entries?: string[];
  stat?: RetOf<'stat'>;
  text?: string;
  services?: RetOf<'stat'>;
  release?: string;
  errors: Record<string, string>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function fsProgram(out: FsOut, home: string): Program<FsOut> {
  return {
    init: () => out,
    *run(ctx, st) {
      yield* ctx.sys.mkdir({ path: `${home}/docs` });
      st.steps.push('mkdir');
      yield* ctx.sys.writeFile({
        path: `${home}/docs/a.txt`,
        data: enc.encode('hello plotinium').buffer,
      });
      st.steps.push('writeFile');
      st.entries = (yield* ctx.sys.readdir({ path: `${home}/docs` })).entries.map((e) => e.name);
      st.stat = yield* ctx.sys.stat({ path: `${home}/docs/a.txt` });
      const fd = (yield* ctx.sys.open({ path: `${home}/docs/a.txt`, flags: 'r' })).fd;
      const r = yield* ctx.sys.read({ fd, len: 64 });
      st.text = dec.decode(r);
      yield* ctx.sys.close({ fd });
      yield* ctx.sys.rename({ from: `${home}/docs/a.txt`, to: `${home}/docs/b.txt` });
      st.steps.push('rename');
      st.services = yield* ctx.sys.stat({ path: '/system/services/storage.json' });
      const rel = yield* ctx.sys.open({ path: '/system/release', flags: 'r' });
      st.release = dec.decode(yield* ctx.sys.read({ fd: rel.fd, len: 4_096 }));
      yield* ctx.sys.close({ fd: rel.fd });
      for (const [name, path] of [
        ['root-home', '/root/secret'],
        ['bin-write', '/bin/evil.json'],
      ] as const) {
        try {
          yield* ctx.sys.writeFile({ path, data: enc.encode('x').buffer });
        } catch (e) {
          st.errors[name] = errnoOf(e) ?? 'unknown';
        }
      }
      return 0;
    },
  };
}

describe('storage and vfs services, fs syscalls on the loopback host', () => {
  it('VFS-02 first boot runs mkfs with the well-known ids and seeds /system/services; programs reach files only through syscalls', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const fs = w.io.fs();
    expect(fs?.mounted).toBe(true);
    await fs?.loader.ensureLoaded(INO.SYSTEM);
    for (const ino of [INO.ROOT, INO.BIN, INO.HOME, INO.TMP, INO.SYSTEM, INO.SYSTEM_SERVICES])
      expect(fs?.tree.inode(ino)?.type).toBe('d');
    const out: FsOut = { steps: [], errors: {} };
    const guest = w.posted.findLast((p) => p.t === 'login.session');
    expect(guest).toBeDefined();
    const uid = guest?.t === 'login.session' ? (guest.session?.uid ?? -1) : -1;
    const pcb = w.lb.spawn(fsProgram(out, '/home/guest'), { name: 'fsprobe', uid, gid: 100 });
    const r = await w.lb.run(pcb.pid);
    expect(r.code).toBe(0);
    expect(out.steps).toEqual(['mkdir', 'writeFile', 'rename']);
    expect(out.entries).toEqual(['a.txt']);
    expect(out.stat).toMatchObject({ type: 'f', size: 15, uid });
    expect(out.text).toBe('hello plotinium');
    expect(out.services).toMatchObject({ type: 'f', uid: 0 });
    expect(out.release).toContain('Plotinium');
    expect(out.errors).toEqual({ 'root-home': 'EACCES', 'bin-write': 'EACCES' });
  });

  it('VFS-02 a second boot on the same store does not run mkfs again, keeps files and bumps the fencing epoch', async () => {
    const store = new MemStore();
    const a = await bootToDesktop({ store });
    worlds.push(a);
    const out: FsOut = { steps: [], errors: {} };
    const pa = a.lb.spawn(fsProgram(out, '/home/guest'), {
      name: 'fsprobe',
      uid: 65_534,
      gid: 100,
    });
    expect((await a.lb.run(pa.pid)).code).toBe(0);
    expect(out.steps).toContain('rename');
    a.close();
    worlds.pop();
    const b = await bootToDesktop({ store });
    worlds.push(b);
    const mkfsLines = b.lb.kernel.klog
      .read()
      .filter((rec) => rec.kind === 'line' && rec.msg.startsWith('mkfs:'));
    expect(mkfsLines).toHaveLength(0);
    const epoch = await store.get<MetaRec>('meta', 'fencingEpoch');
    expect(epoch?.v).toBe(2);
    const docs = b.io.fs()?.tree;
    expect(docs).toBeDefined();
    const again: FsOut = { steps: [], errors: {} };
    const probe: Program<FsOut> = {
      init: () => again,
      *run(ctx, st) {
        st.entries = (yield* ctx.sys.readdir({ path: '/home/guest/docs' })).entries.map(
          (e) => e.name,
        );
        return 0;
      },
    };
    const pb = b.lb.spawn(probe, { name: 'ls', uid: 65_534, gid: 100 });
    await b.lb.run(pb.pid);
    expect(again.entries).toEqual(['b.txt']);
  });

  it('PVFS-10 /tmp is cleared at boot', async () => {
    const store = new MemStore();
    const a = await bootToDesktop({ store });
    worlds.push(a);
    const tmp: Program<null> = {
      init: () => null,
      *run(ctx) {
        yield* ctx.sys.writeFile({ path: '/tmp/scratch', data: enc.encode('bye').buffer });
        return 0;
      },
    };
    const p = a.lb.spawn(tmp, { name: 'tmp', uid: 65_534, gid: 100 });
    expect((await a.lb.run(p.pid)).code).toBe(0);
    a.close();
    worlds.pop();
    const b = await bootWorld({ store });
    worlds.push(b);
    await b.until(() => b.io.fs() !== null);
    const lines = b.lb.kernel.klog
      .read()
      .filter((rec) => rec.kind === 'line' && rec.msg.startsWith('/tmp cleared'));
    expect(lines).toHaveLength(1);
    await b.io.fs()?.loader.ensureLoaded(INO.TMP);
    expect(b.io.fs()?.tree.child(INO.TMP, 'scratch')).toBeNull();
  });

  it('SVC-06 recovery mode mounts read-only: every mutation is EPERM', async () => {
    const w = await bootWorld({ profile: 'recovery' });
    worlds.push(w);
    await w.until(() => w.io.fs() !== null);
    expect(w.io.fs()?.readOnly).toBe(true);
    const out: { err?: string } = {};
    const ro: Program<{ err?: string }> = {
      init: () => out,
      *run(ctx, st) {
        try {
          yield* ctx.sys.mkdir({ path: '/tmp/x' });
        } catch (e) {
          st.err = errnoOf(e) ?? 'unknown';
        }
        return 0;
      },
    };
    const p = w.lb.spawn(ro, { name: 'ro', uid: 0, gid: 0, caps: ['fs.read', 'fs.write'] });
    await w.lb.run(p.pid);
    expect(out.err).toBe('EPERM');
  });

  it('VFS-02 a later boot adds the /bin manifests of new programs without touching the existing ones', async () => {
    const store = new MemStore();
    const ls: AppManifestInput = {
      name: 'ls',
      kind: 'command',
      entry: 'coreutils/ls',
      requires: [],
    };
    const a = await bootToDesktop({ store, programs: [ls] });
    worlds.push(a);
    const stat = (w: World, path: string): Promise<{ out: FsOut; code: number | null }> => {
      const out: FsOut = { steps: [], errors: {} };
      const prog: Program<FsOut> = {
        init: () => out,
        *run(ctx, st) {
          try {
            st.stat = yield* ctx.sys.stat({ path });
          } catch (e) {
            st.errors['stat'] = errnoOf(e) ?? 'unknown';
          }
          return 0;
        },
      };
      const p = w.lb.spawn(prog, { name: 'stat', uid: 65_534, gid: 100 });
      return w.lb.run(p.pid).then((r) => ({ out, code: r.code }));
    };
    expect((await stat(a, '/bin/ls.json')).out.stat).toMatchObject({
      type: 'f',
      mode: 0o755,
      uid: 0,
    });
    expect((await stat(a, '/bin/cat.json')).out.errors).toEqual({ stat: 'ENOENT' });
    a.close();
    worlds.pop();

    const cat: AppManifestInput = {
      name: 'cat',
      kind: 'command',
      entry: 'coreutils/cat',
      requires: [],
    };
    const b = await bootToDesktop({ store, programs: [ls, cat] });
    worlds.push(b);
    expect((await stat(b, '/bin/cat.json')).out.stat).toMatchObject({
      type: 'f',
      mode: 0o755,
      uid: 0,
    });
    expect((await stat(b, '/bin/ls.json')).out.stat).toMatchObject({ type: 'f' });
    const lines = b.lb.kernel.klog
      .read()
      .filter((r) => r.kind === 'line' && r.msg.startsWith('seed upgrade'));
    expect(lines.map((r) => (r.kind === 'line' ? r.msg : ''))).toEqual([
      'seed upgrade: 1 paths added',
    ]);
  });
});
