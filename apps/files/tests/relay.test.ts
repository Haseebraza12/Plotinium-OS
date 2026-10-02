/**
 * The display-channel relay of Files and Editor (lib/relay.ts): the view's client sends view calls
 * to its view port and executor-only calls to the app's process, which makes them as itself.
 * Real MessageChannels, the real process program (proc.ts) on a tiny test executor, and the
 * in-memory kernel double of fake-sys.ts behind both.
 */
import type { ArgsIn, CallName, RetOf } from '@plotinium/protocol';
import { lookupCall } from '@plotinium/protocol';
import type { Program, ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { createSys, errnoOf, SysError, TICK } from '@plotinium/kernel/sys';
import { afterEach, describe, expect, it } from 'vitest';

import { descriptor as editorDescriptor } from '../../editor/manifest.ts';
import editorProgram from '../../editor/proc.ts';
import { EditorController } from '../../editor/lib/controller.ts';
import { descriptor as filesDescriptor } from '../manifest.ts';
import filesProgram from '../proc.ts';
import { FilesController } from '../lib/controller.ts';
import type { AppProcessState, PortLike } from '../lib/relay.ts';
import {
  createRelaySys,
  FILE_RELAY_CALLS,
  parseRelayInput,
  parseRelayReply,
  serveRelay,
  transferables,
} from '../lib/relay.ts';
import type { PromiseSys } from '../lib/sys.ts';
import { drive, STUBS } from '../lib/sys.ts';
import { demoWorld, type FakeSys } from './fake-sys.ts';

/** The view port as the kernel's view table answers it: executor-only calls are ENOSYS. */
function viewPortOf(sys: PromiseSys, log: string[] = []): PromiseSys {
  return {
    call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> {
      log.push(name);
      if (lookupCall(name)?.origin === 'E') {
        return Promise.reject(new SysError('ENOSYS', `${name}: not available here`));
      }
      return sys.call(name, args);
    },
  };
}

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const ch of channels.splice(0)) {
    ch.port1.close();
    ch.port2.close();
  }
});

function channel(): MessageChannel {
  const ch = new MessageChannel();
  channels.push(ch);
  return ch;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

interface Running {
  readonly st: AppProcessState;
  readonly calls: string[];
  stop(): Promise<void>;
}

/**
 * Runs an app process the way an executor does: every yielded request is answered by the kernel
 * double (a failure is thrown into the generator), `sleep` lets the event loop run, and
 * `window.create` returns a window whose display channel end is `display`.
 */
function runProcess(
  program: Program<AppProcessState>,
  sys: FakeSys,
  display: MessagePort | undefined,
  env: ReadonlyMap<string, string> = new Map(),
): Running {
  const stubs = createSys();
  const ctx: ProgramContext = {
    pid: 42,
    ppid: 1,
    pgid: 42,
    sid: 42,
    uid: sys.user.uid,
    gid: sys.user.gid,
    argv: [],
    env,
    cwd: sys.user.home,
    tty: null,
    restored: 'no',
    sys: stubs,
    tick: TICK,
    now: () => Date.now(),
    *sleep(ms: number): SysGen<void> {
      yield* stubs.sleep({ ms });
    },
    *sleepUntil(t: number): SysGen<void> {
      yield* stubs.sleep({ ms: Math.max(0, t - Date.now()) });
    },
  };
  const st = program.init([]);
  const gen = program.run(ctx, st);
  const calls: string[] = [];
  let stopped = false;
  const done = (async () => {
    let next = gen.next();
    while (!stopped && next.done !== true) {
      const req = next.value;
      if (typeof req === 'symbol') {
        next = gen.next();
        continue;
      }
      calls.push(req.call);
      if (req.call === 'sleep') {
        await tick();
        next = gen.next({ sleptMs: 1 });
      } else if (req.call === 'window.create') {
        next =
          display === undefined
            ? gen.throw(new SysError('ENOSYS', 'window.create'))
            : gen.next({ wid: 7, rect: { x: 0, y: 0, w: 960, h: 600 }, display });
      } else {
        try {
          const value: unknown = await sys.call(req.call as CallName, req.args as never);
          next = gen.next(value);
        } catch (e) {
          next = gen.throw(e);
        }
      }
    }
  })();
  return {
    st,
    calls,
    stop: async () => {
      stopped = true;
      await done;
    },
  };
}

describe('Files and Editor relay (VFS-07)', () => {
  it('VFS-07 relays executor-only calls to the process and sends view calls to the view port', async () => {
    const { world, alice } = demoWorld();
    const ch = channel();
    const log: string[] = [];
    const proc = runProcess(filesProgram, alice, ch.port1);
    const sys = createRelaySys(viewPortOf(alice, log), ch.port2);

    const st = await sys.call('stat', { path: '/home/alice' });
    expect(st.type).toBe('d');
    await sys.call('mkdir', { path: '/home/alice/Plans', mode: 0o777 });
    expect(world.names('/home/alice')).toContain('Plans');
    // mkdir never touched the view port; stat did.
    expect(log).toEqual(['stat']);
    // The process made the call as alice, after creating its window.
    expect(proc.calls).toEqual(expect.arrayContaining(['window.create', 'mkdir']));
    expect(proc.st.wid).toBe(7);
    expect(proc.st.served).toBe(1);

    // A refusal keeps its errno across the channel.
    await expect(sys.call('mkdir', { path: '/home/bob/x', mode: 0o777 })).rejects.toMatchObject({
      errno: 'EACCES',
    });
    // An executor call outside the allow-list is not relayed: the view port refuses it.
    await expect(sys.call('kill', { pid: 1, sig: 'SIGTERM' })).rejects.toMatchObject({
      errno: 'ENOSYS',
    });
    sys.dispose();
    await proc.stop();
  });

  it('VFS-07 Files creates, renames, copies, trashes and chmods through its process', async () => {
    const { world, alice } = demoWorld();
    const ch = channel();
    const proc = runProcess(filesProgram, alice, ch.port1);
    const sys = createRelaySys(viewPortOf(alice), ch.port2);
    const launched: string[] = [];
    const files = new FilesController({
      sys,
      now: () => world.now,
      launch: (app) => launched.push(app),
      aiAvailable: false,
    });
    await files.start();
    expect(files.state.path).toBe('/home/alice');

    expect(await files.newFolder('Plans')).toBe('/home/alice/Plans');
    const plans = files.state.rows.find((r) => r.name === 'Plans');
    expect(plans).toBeDefined();
    if (plans === undefined) return;
    expect(await files.rename(plans, 'Plans 2026')).toBe(true);
    const report = files.state.rows.find((r) => r.name === 'Documents');
    expect(report).toBeDefined();
    if (report === undefined) return;
    files.copy([report]);
    await files.paste();
    expect(world.names('/home/alice')).toContain('Documents copy');
    const copy = files.state.rows.find((r) => r.name === 'Documents copy');
    if (copy === undefined) throw new Error('no copy');
    await files.chmod([copy], 0o700);
    await files.trash([copy]);
    // The item, and its Put Back record (UI-107) in the hidden .trashinfo folder.
    expect(world.names('/home/alice/.Trash')).toEqual(['.trashinfo', 'Documents copy']);
    expect(world.text('/home/alice/.Trash/.trashinfo/Documents copy.trashinfo')).toContain(
      'Path=/home/alice/Documents copy',
    );
    expect(files.state.toast?.tone).toBe('success');
    // Every change went through the process (it served each executor call).
    const mutating = ['mkdir', 'rename', 'copy', 'chmod'];
    for (const call of mutating) expect(proc.calls).toContain(call);
    expect(proc.st.served).toBeGreaterThanOrEqual(mutating.length);
    sys.dispose();
    await proc.stop();
  });

  it('VFS-10 the Editor saves through its process with expectedVersion; a stale save is a conflicted copy', async () => {
    const { world, alice, bob } = demoWorld();
    const ch = channel();
    const proc = runProcess(editorProgram, alice, ch.port1);
    const sys = createRelaySys(viewPortOf(alice), ch.port2);
    const ed = new EditorController({ sys, now: () => world.now });
    await ed.start([
      { path: '~/notes/week6-standup.md', line: 3 },
      { path: '/home/shared/plan.md' },
    ]);
    const notes = ed.state.docs.find((d) => d.name === 'week6-standup.md');
    expect(notes).toMatchObject({ loading: false, line: 3, version: 1 });
    expect(notes?.text).toContain('LRU pager');

    const plan = ed.doc();
    if (plan === undefined) throw new Error('no plan');
    await bob.call('writeFile', {
      path: '/home/shared/plan.md',
      data: new TextEncoder().encode('# Plan\n\n- bob\n').buffer,
      expectedVersion: 1,
    });
    ed.edit(plan.id, '# Plan\n\n- alice\n');
    await ed.save(plan.id);
    const copyName = 'plan (conflict from alice, 2026-09-26).md';
    expect(ed.doc(plan.id)?.conflict).toEqual({
      kind: 'conflict',
      copyName,
      copyPath: `/home/shared/${copyName}`,
    });
    expect(world.text(`/home/shared/${copyName}`)).toBe('# Plan\n\n- alice\n');
    expect(world.text('/home/shared/plan.md')).toBe('# Plan\n\n- bob\n');
    const save = world.calls.find((c) => c.user === 'alice' && c.call === 'writeFile');
    expect(save?.args).toMatchObject({ expectedVersion: 1 });
    expect(proc.calls).toEqual(
      expect.arrayContaining(['open', 'read', 'close', 'writeFile', 'lock.acquire']),
    );
    sys.dispose();
    await proc.stop();
  });

  it('VFS-07 without a display channel the process still owns its window and executor calls fail with ENOSYS', async () => {
    const { alice } = demoWorld();
    const proc = runProcess(filesProgram, alice, undefined, new Map([['PLT_WINDOW', '12']]));
    await tick();
    expect(proc.st.wid).toBe(12);
    expect(proc.calls).not.toContain('window.create');
    const files = new FilesController({
      sys: viewPortOf(alice),
      now: () => 0,
      launch: () => undefined,
      aiAvailable: false,
    });
    await files.start();
    expect(files.state.rows.map((r) => r.name)).toContain('Documents');
    expect(await files.newFolder('Nope')).toBeUndefined();
    expect(files.state.toast).toMatchObject({ tone: 'error', errno: 'ENOSYS' });
    await proc.stop();
  });

  it('VFS-07 the process refuses calls outside its allow-list and keeps errnos', async () => {
    const { alice } = demoWorld();
    const denied = await drive(
      serveRelay(STUBS, { kind: 'sys', id: 1, call: 'spawn', args: {} }, FILE_RELAY_CALLS),
      alice,
    );
    expect(denied).toMatchObject({ t: 'reply', id: 1, ok: false, errno: 'EPERM' });
    const missing = await drive(
      serveRelay(
        STUBS,
        { kind: 'sys', id: 2, call: 'unlink', args: { path: '/home/alice/none' } },
        FILE_RELAY_CALLS,
      ),
      alice,
    );
    expect(missing).toMatchObject({ ok: false, errno: 'ENOENT' });
    const made = await drive(
      serveRelay(
        STUBS,
        { kind: 'sys', id: 3, call: 'mkdir', args: { path: '/home/alice/New', mode: 0o777 } },
        FILE_RELAY_CALLS,
      ),
      alice,
    );
    expect(made).toMatchObject({ ok: true, id: 3 });
  });

  it('VFS-07 relayed calls time out with ETIMEDOUT and end with ESRCH when the channel closes', async () => {
    const posted: unknown[] = [];
    const display: PortLike = {
      onmessage: null,
      postMessage: (msg) => {
        posted.push(msg);
      },
    };
    const timers: (() => void)[] = [];
    const sys = createRelaySys(viewPortOf(demoWorld().alice), display, {
      setTimer: (fn) => {
        timers.push(fn);
        return () => undefined;
      },
    });
    const first = sys.call('mkdir', { path: '/home/alice/a', mode: 0o777 });
    expect(parseRelayInput(posted[0])).toMatchObject({ kind: 'sys', id: 1, call: 'mkdir' });
    timers[0]?.();
    await expect(first).rejects.toMatchObject({ errno: 'ETIMEDOUT' });
    const second = sys.call('rename', { from: '/a', to: '/b' });
    sys.dispose('window closed');
    await expect(second).rejects.toMatchObject({ errno: 'ESRCH' });
    expect(errnoOf(await second.catch((e: unknown) => e))).toBe('ESRCH');
  });

  it('VFS-07 relay messages are checked before use', () => {
    expect(parseRelayInput(null)).toBeUndefined();
    expect(parseRelayInput({ t: 'input', seq: 1, ev: { kind: 'ui-state' } })).toBeUndefined();
    expect(
      parseRelayInput({ t: 'input', seq: 1, ev: { kind: 'sys', id: 1.5, call: 'open' } }),
    ).toBeUndefined();
    expect(
      parseRelayInput({ t: 'input', seq: 1, ev: { kind: 'sys', id: 1, call: '' } }),
    ).toBeUndefined();
    expect(
      parseRelayInput({
        t: 'input',
        seq: 1,
        ev: { kind: 'sys', id: 4, call: 'open', args: { path: '/' } },
      }),
    ).toEqual({
      kind: 'sys',
      id: 4,
      call: 'open',
      args: { path: '/' },
    });
    expect(parseRelayReply({ t: 'snapshot' })).toBeUndefined();
    expect(parseRelayReply({ t: 'reply', id: 2, ok: false })).toEqual({
      t: 'reply',
      id: 2,
      ok: false,
      errno: 'EIO',
      message: '',
    });
    const big = new ArrayBuffer(70_000);
    expect(transferables(big)).toEqual([big]);
    expect(transferables({ data: big, path: '/x' })).toEqual([big]);
    expect(transferables({ data: new ArrayBuffer(10) })).toEqual([]);
  });
});

describe('Files and Editor descriptors', () => {
  it('SYS-01 describe their windows, menus and processes for the desktop', async () => {
    expect(filesDescriptor).toMatchObject({
      id: 'files',
      title: 'Files',
      icon: 'files',
      manifest: { name: 'files', kind: 'app', entry: 'apps/files/proc', view: 'apps/files/view' },
    });
    expect(filesDescriptor.window.chrome).toBe('unified');
    expect(editorDescriptor).toMatchObject({
      id: 'editor',
      title: 'Editor',
      icon: 'editor',
      manifest: {
        name: 'editor',
        kind: 'app',
        entry: 'apps/editor/proc',
        view: 'apps/editor/view',
      },
    });
    for (const d of [filesDescriptor, editorDescriptor]) {
      expect(d.manifest.caps).toEqual(['window', 'fs.read', 'fs.write', 'lock']);
      expect(d.manifest.requires).toContain('svc:vfs');
      const program = await d.program?.();
      expect(typeof program?.init).toBe('function');
      expect(typeof program?.run).toBe('function');
      expect(program?.checkpointable).toBe(true);
      const ids = (d.menus ?? []).flatMap((m) =>
        m.items.flatMap((i) => ('id' in i && i.id !== undefined ? [i.id] : [])),
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
