/**
 * TEST-ONLY harness: a real kernel (`createKernel`: dispatcher, process table, event bus, audit)
 * with the kernel file system mounted on the memory store adapter and every fs call registered.
 * Calls travel as `{id, call, args}` frames on an executor port through ALL dispatcher stages, so
 * the tests exercise identity, schema, capabilities, stage-5 permission checks and the handlers.
 *
 * Users (standalone mount, provisioned locally): alice 1000 and bob 1001 in `users` (100); carol
 * 1002 in her own group 300. Homes are 0700 except carol's (0755).
 */
import type { NaryTree } from '@plotinium/dsa/tree';
import { IMPLEMENTED as TREE_IMPLEMENTED, createTree } from '@plotinium/dsa/tree';
import type { ArgsIn, Cap, CallName, ProcClass, SysRes } from '@plotinium/protocol';
import type { InodeRec } from '@plotinium/vfs';

import type { BuildIdentity, KernelClock, PlatformInfo } from '../../host.ts';
import { DEV_IDENTITY } from '../../host.ts';
import type { ExecPortRec } from '../../ipc/ports.ts';
import { execPort } from '../../ipc/ports.ts';
import type { Kernel } from '../../kernel.ts';
import { createKernel } from '../../kernel.ts';
import type { PCB } from '../../proc/pcb.ts';
import type { TreeFactory } from '../kfs.ts';
import { KernelFs } from '../kfs.ts';
import { MemStore } from '../mem-store.ts';
import { registerFsSyscalls } from '../syscalls.ts';
import type { FsSyscallOptions } from '../syscalls.ts';
import { provisionLocalUser } from '../users.ts';
import { createTreeDouble } from './tree-double.ts';

/** Whether the real `dsa/tree` is used (false: the test double, until R2 flips the flag). */
export const USING_DSA_TREE = TREE_IMPLEMENTED;

/** The tree the tests mount: the team's `dsa/tree` once implemented, the double until then. */
export const testTreeFactory: TreeFactory = (id, rec): NaryTree<InodeRec> =>
  TREE_IMPLEMENTED ? createTree(id, rec) : createTreeDouble(id, rec);

export class TestClock implements KernelClock {
  t = 0;
  readonly epoch0 = Date.UTC(2026, 8, 25, 9, 0, 0);

  now(): number {
    return this.t;
  }

  epochMs(): number {
    return this.epoch0 + this.t;
  }

  timeZone(): { tz: string; offsetMin: number } {
    return { tz: 'Asia/Karachi', offsetMin: 300 };
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

const PLATFORM: PlatformInfo = {
  browser: { brand: 'Chrome', major: 154 },
  cores: 8,
  crossOriginIsolated: false,
};

export const USER_CAPS: readonly Cap[] = [
  'fs.read',
  'fs.write',
  'proc',
  'window',
  'tty',
  'lock',
  'mem',
];
export const ROOT_CAPS: readonly Cap[] = [...USER_CAPS, 'kill.other', 'sys.admin'];

export const UID = { root: 0, alice: 1000, bob: 1001, carol: 1002 } as const;

export interface SpawnOpts {
  readonly gid?: number;
  readonly groups?: readonly number[];
  readonly caps?: readonly Cap[];
  readonly cls?: ProcClass;
  readonly fsScope?: readonly string[];
  readonly cwdPath?: string;
  readonly umask?: number;
}

export interface Proc {
  readonly pcb: PCB;
  call(name: CallName, args: unknown): Promise<SysRes>;
  /** The value of a call that must succeed (throws with the errno otherwise). */
  ok<T = unknown>(name: CallName, args: unknown): Promise<T>;
  /** The errno of a call ('ok' when it succeeded). */
  errno(name: CallName, args: unknown): Promise<string>;
}

export interface World {
  readonly kernel: Kernel;
  readonly fs: KernelFs;
  readonly store: MemStore;
  readonly clock: TestClock;
  readonly port: ExecPortRec;
  readonly logs: string[];
  spawn(uid: number, opts?: SpawnOpts): Proc;
  readonly root: Proc;
  readonly alice: Proc;
  readonly bob: Proc;
  readonly carol: Proc;
}

export interface BootOpts {
  readonly store?: MemStore;
  readonly quotaBytes?: number;
  readonly quotaInodes?: number;
  readonly users?: boolean;
  readonly syscalls?: FsSyscallOptions;
  readonly identity?: BuildIdentity;
  readonly treeFactory?: TreeFactory;
}

export async function boot(opts: BootOpts = {}): Promise<World> {
  const clock = new TestClock();
  const identity = opts.identity ?? DEV_IDENTITY;
  const kernel = createKernel({
    host: { clock, identity, platform: PLATFORM },
    users: { nameOf: (uid) => (uid === 0 ? 'root' : `u${String(uid)}`) },
  });
  const store = opts.store ?? new MemStore();
  const logs: string[] = [];
  const fs = new KernelFs({
    store,
    bus: kernel.bus,
    clock,
    procs: kernel.procs,
    identity,
    osSessionId: () => kernel.osSessionId,
    treeFactory: opts.treeFactory ?? testTreeFactory,
    log: (level, msg) => logs.push(`${level}: ${msg}`),
  });
  await fs.mount({ standalone: true });
  registerFsSyscalls(kernel.handlers, fs, opts.syscalls);
  if (opts.users !== false) {
    const q = {
      ...(opts.quotaBytes === undefined ? {} : { quotaBytes: opts.quotaBytes }),
      ...(opts.quotaInodes === undefined ? {} : { quotaInodes: opts.quotaInodes }),
    };
    if (fs.tree.user(UID.alice) === undefined) {
      await provisionLocalUser(fs, { uid: UID.alice, username: 'alice', ...q });
      await provisionLocalUser(fs, { uid: UID.bob, username: 'bob', ...q });
      await provisionLocalUser(fs, {
        uid: UID.carol,
        username: 'carol',
        gid: 300,
        homeMode: 0o755,
        ...q,
      });
    }
  }

  let reqId = 0;
  let sliceSeq = 0;
  const pending = new Map<number, (res: SysRes) => void>();
  const port = execPort(0, (_pid, res) => {
    const done = pending.get(res.id);
    pending.delete(res.id);
    done?.(res);
  });

  const spawn = (uid: number, s: SpawnOpts = {}): Proc => {
    const gid = s.gid ?? (uid === 0 ? 0 : uid === UID.carol ? 300 : 100);
    const pcb = kernel.procs.create({
      ppid: 1,
      kind: 'user',
      cls: s.cls ?? 'user',
      name: 'test',
      cred: { uid, gid, groups: [...(s.groups ?? [gid])], ruid: uid },
      caps: s.caps ?? (uid === 0 ? ROOT_CAPS : USER_CAPS),
      ...(s.cwdPath === undefined ? {} : { cwdPath: s.cwdPath }),
    });
    pcb.worker = port.index;
    if (s.fsScope !== undefined) pcb.fsScope = [...s.fsScope];
    if (s.umask !== undefined) pcb.umask = s.umask;
    const call = (name: CallName, args: unknown): Promise<SysRes> => {
      const id = ++reqId;
      return new Promise<SysRes>((resolve) => {
        pending.set(id, resolve);
        sliceSeq++;
        port.slice = { pid: pcb.pid, sliceSeq };
        kernel.execFrame(port, { pid: pcb.pid, sliceSeq, req: { id, call: name, args } });
      });
    };
    return {
      pcb,
      call,
      ok: async <T>(name: CallName, args: unknown): Promise<T> => {
        const res = await call(name, args);
        if (!res.ok) {
          throw new Error(
            `${name} failed with ${res.errno}${res.detail ? ` ${JSON.stringify(res.detail)}` : ''}`,
          );
        }
        return res.value as T;
      },
      errno: async (name, args) => {
        const res = await call(name, args);
        return res.ok ? 'ok' : res.errno;
      },
    };
  };

  return {
    kernel,
    fs,
    store,
    clock,
    port,
    logs,
    spawn,
    root: spawn(UID.root),
    alice: spawn(UID.alice),
    bob: spawn(UID.bob),
    carol: spawn(UID.carol),
  };
}

/** Typed argument helper: `args('open', {...})` checks the shape at compile time. */
export function args<C extends CallName>(_name: C, a: ArgsIn<C>): ArgsIn<C> {
  return a;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytes(text: string): ArrayBuffer {
  const b = encoder.encode(text);
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

export function text(buf: ArrayBuffer): string {
  return decoder.decode(new Uint8Array(buf));
}

/** A snapshot of the persistent rows, to assert that a refused call changed nothing. */
export function snapshot(store: MemStore): string {
  return JSON.stringify({
    inodes: store.dump('inodes'),
    dentries: store.dump('dentries'),
    users: store.dump('users'),
    outbox: store.dump('outbox').length,
    undo: store.dump('undo').length,
  });
}
