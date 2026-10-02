/**
 * TEST-ONLY: a whole boot on the Node loopback host with the REAL system services of `installIo`
 * (storage on the memory store, vfs, mm, login, session, auth, sync, lockd, ai.*, complete, update)
 * plus test stand-ins for the four kernel-host services (`kernel`, `sched`, `wm`, `desktop`),
 * driven by the service manager on a manual kernel timer heap. The compositor is a real
 * MessageChannel; the router is `io.router` plus the captured `IoToRouter` messages.
 */
import type {
  BootProfile,
  KernelTimers,
  ManifestFile,
  ServiceImpl,
  ServiceName,
  SvcEvent,
  SvcPanic,
} from '@plotinium/services';
import { BUILTIN_MANIFEST_FILES, ServiceManager } from '@plotinium/services';
import type { AppManifestInput, Cap, SysRes } from '@plotinium/protocol';

import type { SliceReport } from '../../../runtime/executor.ts';
import { ExecutorRuntime } from '../../../runtime/executor.ts';
import type { Program } from '../../../runtime/sys.ts';
import { MemStore } from '../../fs/mem-store.ts';
import type { KernelClock, PlatformInfo } from '../../host.ts';
import { DEV_IDENTITY } from '../../host.ts';
import { execPort } from '../../ipc/ports.ts';
import type { Kernel } from '../../kernel.ts';
import { createKernel } from '../../kernel.ts';
import type { ProgramCatalog } from '../../programs/catalog.ts';
import { StaticProgramCatalog } from '../../programs/catalog.ts';
import type { PCB } from '../../proc/pcb.ts';
import type { Io, IoDeps, IoToRouter, LoginReply } from '../index.ts';
import { installIo } from '../index.ts';

/** A manual kernel clock (the loopback host's clock is host code; core tests keep their own). */
export class TestClock implements KernelClock {
  private t = 0;
  private readonly epoch0 = Date.UTC(2026, 8, 26, 9, 0, 0);

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
    this.t += Math.max(0, ms);
  }
}

const PLATFORM: PlatformInfo = {
  browser: { brand: 'Chrome', major: 154 },
  cores: 8,
  crossOriginIsolated: false,
};

export interface SpawnOptions {
  readonly name: string;
  readonly argv?: readonly string[];
  readonly uid?: number;
  readonly gid?: number;
  readonly caps?: readonly Cap[];
}

/**
 * The part of the loopback host these tests need: a real kernel plus one in-process executor
 * and a deterministic slice loop (spawn, run to exit), all on the manual clock.
 */
export interface TestLoopback {
  readonly kernel: Kernel;
  readonly clock: TestClock;
  spawn<St>(program: Program<St>, opts: SpawnOptions): PCB;
  run(pid: number): Promise<{ code: number | null; reason: string | null; reports: SliceReport[] }>;
}

export function createTestLoopback(clock: TestClock, programs?: ProgramCatalog): TestLoopback {
  const kernel = createKernel({
    host: { clock, identity: DEV_IDENTITY, platform: PLATFORM },
    ai: true,
    ...(programs === undefined ? {} : { programs }),
  });
  const executor = new ExecutorRuntime({ now: () => clock.now(), ctl: null });
  const inbox = new Map<number, SysRes[]>();
  const waiters = new Map<number, () => void>();
  const port = execPort(0, (pid, res) => {
    const q = inbox.get(pid) ?? [];
    q.push(res);
    inbox.set(pid, q);
    waiters.get(pid)?.();
  });
  let sliceSeq = 0;
  const nextReply = (pid: number): Promise<SysRes> => {
    const take = (): SysRes | undefined => inbox.get(pid)?.shift();
    const ready = take();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise<SysRes>((resolve) => {
      waiters.set(pid, () => {
        const res = take();
        if (res === undefined) return;
        waiters.delete(pid);
        resolve(res);
      });
    });
  };
  return {
    kernel,
    clock,
    spawn: (program, s) => {
      const uid = s.uid ?? 1001;
      const pcb = kernel.procs.create({
        ppid: 1,
        kind: 'user',
        cls: 'user',
        name: s.name,
        argv: s.argv ?? [s.name],
        cred: { uid, gid: s.gid ?? uid, groups: [], ruid: uid },
        caps: s.caps ?? ['fs.read', 'fs.write', 'proc', 'window', 'tty', 'lock', 'mem'],
      });
      pcb.worker = port.index;
      const loaded = executor.load(
        {
          pid: pcb.pid,
          ppid: pcb.ppid,
          pgid: pcb.pgid,
          sid: pcb.sid,
          uid,
          gid: pcb.cred.gid,
          argv: pcb.argv,
          env: [...pcb.env],
          cwd: pcb.cwdPath,
          tty: pcb.tty,
        },
        program,
      );
      if (!loaded.ok)
        kernel.procs.terminate(pcb, 'spawn-failed', { code: 126, reason: 'spawn-failed' });
      else kernel.lifecycle.transition(pcb, 'READY', 'admit');
      return pcb;
    },
    run: async (pid) => {
      const pcb = kernel.procs.get(pid);
      if (pcb === undefined) throw new Error(`no pid ${String(pid)}`);
      const reports: SliceReport[] = [];
      let res: SysRes | undefined;
      let resume = false;
      for (let i = 0; i < 1_000 && pcb.state !== 'TERMINATED'; i++) {
        if (!resume) {
          sliceSeq++;
          kernel.lifecycle.transition(pcb, 'RUNNING', 'dispatch');
        }
        port.slice = { pid, sliceSeq };
        const report = executor.runSlice({
          t: resume ? 'resume' : 'dispatch',
          pid,
          sliceSeq,
          quantumMs: 10,
          pendingSigs: 0,
          ...(res === undefined ? {} : { res }),
        });
        reports.push(report);
        clock.advance(1);
        res = undefined;
        resume = false;
        switch (report.t) {
          case 'syscall': {
            kernel.execFrame(port, report);
            const sync = inbox.get(pid)?.shift();
            if (sync !== undefined) {
              res = sync;
              resume = true;
            } else {
              kernel.lifecycle.transition(pcb, 'BLOCKED', 'block', {
                waitingOn: `io:${report.req.call}`,
              });
              res = await nextReply(pid);
              kernel.lifecycle.transition(pcb, 'READY', 'wake');
            }
            break;
          }
          case 'yield':
            kernel.lifecycle.transition(pcb, 'READY', 'quantum');
            break;
          case 'exit':
            kernel.procs.terminate(pcb, 'exit', { code: report.code, reason: 'normal' });
            break;
          case 'killed':
            kernel.procs.terminate(pcb, 'signal:9', { code: 137, reason: 'signal', by: 0 });
            break;
          case 'error':
          case 'fault':
            kernel.procs.terminate(pcb, 'crash', { code: 1, reason: 'crash' });
            break;
        }
        port.slice = null;
      }
      return { code: pcb.exitCode, reason: pcb.exitReason, reports };
    },
  };
}

/** The kernel timer heap of a test: fires on the loopback's manual clock. */
export class ClockTimers implements KernelTimers {
  private nextId = 1;
  private entries: { id: number; at: number; prio: number; fire: () => void }[] = [];
  private readonly clock: TestClock;

  constructor(clock: TestClock) {
    this.clock = clock;
  }

  at(deadlineMs: number, fire: () => void, priority = 0): number {
    const id = this.nextId++;
    this.entries.push({ id, at: deadlineMs, prio: priority, fire });
    return id;
  }

  cancel(handle: number): boolean {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== handle);
    return this.entries.length !== n;
  }

  now(): number {
    return this.clock.now();
  }

  get armed(): number {
    return this.entries.length;
  }

  /** Move time forward, firing due timers in (deadline, priority, arm order) order. */
  advance(ms: number): void {
    const end = this.clock.now() + ms;
    for (;;) {
      const due = this.entries
        .filter((e) => e.at <= end)
        .sort((a, b) => a.at - b.at || a.prio - b.prio || a.id - b.id)[0];
      if (due === undefined) break;
      this.entries = this.entries.filter((e) => e !== due);
      if (due.at > this.clock.now()) this.clock.advance(due.at - this.clock.now());
      due.fire();
    }
    if (end > this.clock.now()) this.clock.advance(end - this.clock.now());
  }
}

/** Let promise callbacks and macrotasks (WebCrypto, MessagePorts) run. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** A tiny fake of the server's auth routes (backend-api.md §3.6). */
export interface FakeServer {
  readonly fetch: NonNullable<NonNullable<IoDeps['platform']>['fetch']>;
  readonly calls: string[];
  down: boolean;
  /** Current session cookie's user, if any. */
  session: string | null;
  readonly users: Map<string, { uid: number; password: string; kind: 'user' | 'demo' }>;
}

export function fakeServer(opts: { build?: string; version?: string } = {}): FakeServer {
  const users = new Map<string, { uid: number; password: string; kind: 'user' | 'demo' }>([
    ['demo', { uid: 1000, password: 'demo-pass-1234567890', kind: 'demo' }],
    ['alice', { uid: 1100, password: 'alice-pass', kind: 'user' }],
  ]);
  const me = (name: string): unknown => {
    const u = users.get(name);
    const guest = name.startsWith('guest-');
    return {
      uid: u?.uid ?? 60_001,
      username: name,
      kind: guest ? 'guest' : (u?.kind ?? 'user'),
      gid: 100,
      groups: [{ gid: 100, name: 'users' }],
      home: `/home/${name}`,
      quota: { quotaBytes: 1_048_576, quotaInodes: 1_000, usedBytes: 0, usedInodes: 1 },
      suGrants: [],
      session: { expiresAt: '2026-10-01T00:00:00Z', absoluteExpiresAt: '2026-10-08T00:00:00Z' },
      passwordVersion: 1,
      offlineVerifier: { allowed: !guest },
      telemetryOptIn: false,
      server: {
        name: 'Plotinium',
        version: opts.version ?? '0.1.0-dev.0',
        build: opts.build ?? '0000000',
      },
    };
  };
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const server: FakeServer = {
    calls: [],
    down: false,
    session: null,
    users,
    fetch: (path, init) => {
      server.calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (server.down) return Promise.reject(new TypeError('Failed to fetch'));
      if (path === '/version.json')
        return Promise.resolve(
          json(200, {
            name: 'Plotinium',
            version: opts.version ?? '0.1.0-dev.0',
            build: opts.build ?? '0000000',
          }),
        );
      if (path === '/api/auth/me')
        return Promise.resolve(
          server.session === null ? json(401, { errno: 'EACCES' }) : json(200, me(server.session)),
        );
      if (path === '/api/auth/login') {
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        const body = JSON.parse(raw) as { username?: string; password?: string };
        const u = users.get(body.username ?? '');
        if (u === undefined || u.password !== body.password)
          return Promise.resolve(
            json(401, { errno: 'EACCES', msg: 'invalid username or password' }),
          );
        server.session = body.username ?? null;
        return Promise.resolve(json(200, me(body.username ?? '')));
      }
      if (path === '/api/auth/guest') {
        server.session = 'guest-ab12';
        return Promise.resolve(json(200, me('guest-ab12')));
      }
      if (path === '/api/auth/logout') {
        server.session = null;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(json(404, { errno: 'ENOENT' }));
    },
  };
  return server;
}

export interface WorldOptions {
  readonly profile?: BootProfile;
  readonly store?: MemStore;
  readonly server?: FakeServer;
  readonly online?: boolean;
  readonly files?: readonly ManifestFile[];
  /** The program catalog (`/bin/<name>.json`). */
  readonly programs?: readonly AppManifestInput[];
  readonly io?: Partial<IoDeps>;
}

export interface World {
  readonly lb: TestLoopback;
  readonly clock: TestClock;
  readonly timers: ClockTimers;
  readonly store: MemStore;
  readonly io: Io;
  readonly mgr: ServiceManager;
  readonly posted: IoToRouter[];
  /** Messages the compositor (the shell's end of the port) received. */
  readonly compositor: unknown[];
  readonly shellPort: MessagePort;
  readonly events: SvcEvent[];
  readonly panics: SvcPanic[];
  /** Run the clock in small steps until `pred` holds (or fail after `maxMs` of kernel time). */
  until(pred: () => boolean, maxMs?: number): Promise<void>;
  stateOf(name: ServiceName): string | undefined;
  /** The router's `desktop.interactive`. */
  interactive(): void;
  /** `login.guest` / `login.submit` through the router; resolves with the reply. */
  login(user: 'guest' | { user: string; secret: string }): Promise<LoginReply>;
  close(): void;
}

let rid = 0;

export function bootWorld(o: WorldOptions = {}): Promise<World> {
  const clock = new TestClock();
  const timers = new ClockTimers(clock);
  const store = o.store ?? new MemStore();
  const lb = createTestLoopback(
    clock,
    o.programs === undefined ? undefined : new StaticProgramCatalog(o.programs),
  );
  const posted: IoToRouter[] = [];
  const compositor: unknown[] = [];
  const channels: MessagePort[] = [];
  const events: SvcEvent[] = [];
  const panics: SvcPanic[] = [];
  let mgr: ServiceManager | null = null;
  let openInteractive: () => void = () => undefined;
  const interactive = new Promise<void>((resolve) => {
    openInteractive = resolve;
  });

  const io = installIo(lb.kernel, {
    timers,
    store,
    frame: (cb) => {
      queueMicrotask(cb);
    },
    platform: {
      channel: () => {
        const ch = new MessageChannel();
        channels.push(ch.port1, ch.port2);
        return ch;
      },
      subtle: crypto.subtle,
      ...(o.server === undefined
        ? {}
        : { fetch: o.server.fetch, origin: 'https://plotinium.test' }),
      online: o.online ?? true,
    },
    post: (m) => {
      posted.push(m);
    },
    services: () => mgr,
    t0: () => lb.kernel.epochAtZero,
    verifierIterations: 1_000,
    ...o.io,
  });

  const RUNNING = { status: 'running' } as const;
  const stop = (): Promise<void> => Promise.resolve();
  const host: [ServiceName, ServiceImpl][] = [
    ['kernel', { start: () => Promise.resolve(RUNNING), stop }],
    ['sched', { start: () => Promise.resolve(RUNNING), stop }],
    ['wm', { start: () => Promise.resolve(RUNNING), stop }],
    [
      'desktop',
      {
        start: async () => {
          await interactive;
          return RUNNING;
        },
        stop,
      },
    ],
  ];
  const registry = new Map<ServiceName, ServiceImpl>([...host, ...io.services]);

  const ch = new MessageChannel();
  channels.push(ch.port1, ch.port2);
  ch.port2.onmessage = (ev: MessageEvent) => {
    compositor.push(ev.data);
  };
  io.attachCompositor(ch.port1);

  const k = lb.kernel;
  mgr = new ServiceManager({
    profile: o.profile ?? 'normal',
    files: o.files ?? BUILTIN_MANIFEST_FILES,
    source: 'builtin',
    registry,
    timers,
    seed: 7,
    pidFor: (m) =>
      m.name === 'kernel'
        ? k.init.pid
        : k.procs.createKernelProcess(m.name, 'service', m.priority).pid,
    onEvent: (ev) => {
      events.push(ev);
      const payload = {
        name: ev.name,
        critical: ev.critical,
        ...(ev.reason === undefined ? {} : { error: ev.reason.slice(0, 256) }),
      };
      if (ev.state === 'running') k.bus.publish('svc.started', payload);
      else if (ev.state === 'degraded' || ev.state === 'blocked')
        k.bus.publish('svc.degraded', payload);
      else if (ev.state === 'failed') k.bus.publish('svc.failed', payload);
      else if (ev.state === 'stopped') k.bus.publish('svc.stopped', payload);
    },
    onLog: (line) => {
      k.log(line.sub, line.level, line.msg);
    },
    onPanic: (p) => {
      panics.push(p);
    },
  });
  const m = mgr;
  const built = m.build();
  if (built.ok) m.start();

  const until = async (pred: () => boolean, maxMs = 30_000): Promise<void> => {
    const end = clock.now() + maxMs;
    for (;;) {
      await settle();
      if (pred()) return;
      if (clock.now() >= end)
        throw new Error(`condition not met within ${String(maxMs)} ms of kernel time`);
      timers.advance(5);
    }
  };

  const world: World = {
    lb,
    clock,
    timers,
    store,
    io,
    mgr: m,
    posted,
    compositor,
    shellPort: ch.port2,
    events,
    panics,
    until,
    stateOf: (name) => m.stateOf(name),
    interactive: () => {
      io.router({ t: 'desktop.interactive' });
      openInteractive();
    },
    login: async (who) => {
      const id = ++rid;
      if (who === 'guest') io.router({ t: 'login.guest', rid: id });
      else io.router({ t: 'login.submit', rid: id, user: who.user, secret: who.secret });
      let reply: LoginReply | undefined;
      await until(() => {
        const r = posted.find(
          (p): p is Extract<IoToRouter, { t: 'login.result' }> =>
            p.t === 'login.result' && p.rid === id,
        );
        if (r !== undefined) reply = r;
        return r !== undefined;
      }, 10_000);
      if (reply === undefined) throw new Error('no login reply');
      return reply;
    },
    close: () => {
      io.dispose();
      for (const p of channels) p.close();
    },
  };
  return Promise.resolve(world);
}

/** Boot through login (guest unless `who` is given) to desktop-interactive. */
export async function bootToDesktop(
  o: WorldOptions & { who?: { user: string; secret: string } } = {},
): Promise<World> {
  const w = await bootWorld(o);
  await w.until(
    () => w.stateOf('login') === 'starting' && w.io.ports.login !== undefined && loginWaiting(w),
  );
  const r = await w.login(o.who ?? 'guest');
  if (!r.ok) throw new Error(`login failed: ${r.error}`);
  await w.until(() => w.stateOf('desktop') === 'starting');
  w.interactive();
  await w.until(() => w.stateOf('desktop') === 'running');
  return w;
}

export function loginWaiting(w: World): boolean {
  return w.posted.some((p) => p.t === 'login.state' && p.state.waiting);
}
