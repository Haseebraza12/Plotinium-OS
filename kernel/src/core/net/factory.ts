/**
 * The default sync and lock engines (offline-and-sync.md §3.2, §3.14; OFF-01, OFF-04, VFS-09;
 * UI-006): vfs's `Syncd` over the device store (`StoreSyncStorage`), the host's WebSocket, the
 * same-origin HTTPS routes and the protocol's frame schema, with `Lockd` on its control lane.
 *
 * kernel/src/core touches no platform global: the host passes the socket factory, `fetch`, the
 * Web Locks manager and the store getter (kernel/src/host/worker.ts binds them). The engines are
 * built per login session by `SyncIo` (core/io/sync.ts) through `EngineFactory`.
 */
import * as v from 'valibot';

import type { NetStatus, S2CFrame } from '@plotinium/protocol';
import { S2CFrame as S2CFrameSchema, uuidv7 } from '@plotinium/protocol';
import type { LockEvent, LockManagerLike } from '@plotinium/vfs/locks';
import { Lockd } from '@plotinium/vfs/locks';
import type {
  OpResultBody,
  SnapshotPage,
  SocketFactory,
  SyncEffect,
  SyncHttp,
  SyncNotice,
} from '@plotinium/vfs/sync';
import { decodeFrame, HttpUnavailable, StoreSyncStorage, Syncd } from '@plotinium/vfs/sync';
import type { BlobRec } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import type { FsStore } from '../fs/store.ts';
import type { BuildIdentity } from '../host.ts';
import type {
  EngineFactory,
  EngineSession,
  LockEngine,
  LockEngineGrant,
  SyncEngine,
  SyncEngineHost,
} from './engines.ts';

type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

export interface EngineFactoryDeps {
  /** The device store (`storage` opened it before `sync` starts). */
  readonly store: () => FsStore | null;
  readonly fetch: FetchLike;
  /** The host's WebSocket binding (vfs `browserSocket` in the worker). */
  readonly socket: SocketFactory;
  readonly identity: BuildIdentity;
  /** `navigator.locks` of the worker: local advisory locks while the server layer is down. */
  readonly locks?: LockManagerLike;
  /** `navigator.onLine` now. */
  readonly online: () => boolean;
  /** The OS time zone (conflicted-copy dates). */
  readonly timeZone?: string;
  /** Rows a sync transaction wrote (acks, conflicts, remote changes): apply them to the tree. */
  readonly applied: (effect: SyncEffect) => void;
  /** lockd's kernel events (`lock.granted`, `lock.queued`, `lock.lost`, `lock.released`). */
  readonly lockEvent: (ev: LockEvent) => void;
  /** A klog warning (protocol mismatches). */
  readonly warn?: (msg: string) => void;
}

/** Decode one server frame with the protocol schema (the TODO(protocol) of vfs `decodeFrame`). */
export function decodeS2C(raw: string): S2CFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = v.safeParse(S2CFrameSchema, json);
  return r.success ? (r.output as S2CFrame) : null;
}

/** Protocol mismatches reported to klog per engine (the rest are counted silently). */
export const DECODE_WARNINGS_MAX = 5;

/**
 * The frame decoder syncd uses: the protocol schema first; a frame that fails it but has the
 * frame envelope (`{v: 1, t, id, body}` with a known `t`) is still delivered (vfs `decodeFrame`)
 * and reported, so a server that is a little ahead of or behind this build degrades to a warning
 * instead of a stalled connection.
 */
export function frameDecoder(warn: (msg: string) => void): (raw: string) => S2CFrame | null {
  let warned = 0;
  return (raw) => {
    const strict = decodeS2C(raw);
    if (strict !== null) return strict;
    const loose = decodeFrame(raw);
    if (loose !== null && warned < DECODE_WARNINGS_MAX) {
      warned++;
      let where = '';
      try {
        const r = v.safeParse(S2CFrameSchema, JSON.parse(raw));
        const issue = r.success ? undefined : r.issues[0];
        const at = (issue?.path ?? []).map((p) => String(p.key)).join('.');
        where = `${at === '' ? '' : ` at ${at}`}: ${issue?.message ?? ''}`;
      } catch {
        // The envelope parsed a moment ago; nothing more to say.
      }
      warn(`sync: server frame ${loose.t} is off-schema${where.slice(0, 160)}`);
    }
    return loose;
  };
}

/** The wire identity `hello` carries (protocol `BuildIdentity`: hex build, ISO date). */
export function wireIdentity(id: BuildIdentity): {
  readonly name: 'Plotinium';
  readonly version: string;
  readonly build: string;
  readonly date: string;
} {
  const build = /^[0-9a-f]{7,12}$/.test(id.build) ? id.build : '0000000';
  const date = /^\d{4}-\d{2}-\d{2}/.test(id.buildDate) ? id.buildDate.slice(0, 10) : '1970-01-01';
  return { name: 'Plotinium', version: id.version, build, date };
}

async function transport<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new HttpUnavailable(e instanceof Error ? e.message : 'network unavailable');
  }
}

/** The bytes of blob `sha` from the local chunks (the upload body of `PUT /api/blobs`). */
export async function blobBytes(store: FsStore, sha: string): Promise<Uint8Array<ArrayBuffer>> {
  const rec = await store.get<BlobRec>('blobs', sha);
  if (rec === undefined || rec.chunks === null)
    throw new Error(`blob ${sha.slice(0, 12)} is not stored on this device`);
  const parts: Uint8Array[] = [];
  for (const c of rec.chunks) {
    const chunk = await store.get<{ bytes: ArrayBuffer }>('blob_chunks', c);
    if (chunk === undefined) throw new Error(`chunk ${c.slice(0, 12)} is missing`);
    parts.push(new Uint8Array(chunk.bytes));
  }
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.byteLength, 0)));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** `SyncHttp` over same-origin fetch (backend-api.md §3.6, offline-and-sync.md §4.10). */
export function syncHttp(fetchFn: FetchLike, store: () => FsStore | null): SyncHttp {
  const json = async <T>(r: Response, what: string): Promise<T> => {
    if (!r.ok) throw new Error(`${what}: HTTP ${String(r.status)}`);
    return (await r.json()) as T;
  };
  return {
    authMe: async () => (await transport(fetchFn('/api/auth/me', { cache: 'no-store' }))).status,
    healthz: async () => {
      try {
        const r = await fetchFn('/api/healthz', { cache: 'no-store' });
        return r.status > 0;
      } catch {
        return false;
      }
    },
    postOp: async (opId, body) => {
      const r = await transport(
        fetchFn(`/api/ops/${encodeURIComponent(opId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      return json<OpResultBody>(r, 'POST /api/ops');
    },
    putBlob: async (sha) => {
      const s = store();
      if (s === null) throw new Error('the device store is not open');
      const bytes = await blobBytes(s, sha);
      const r = await transport(
        fetchFn(`/api/blobs/${sha}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        }),
      );
      if (!r.ok) throw new Error(`PUT /api/blobs: HTTP ${String(r.status)}`);
    },
    snapshot: async (url, after) => {
      const u = after === undefined ? url : `${url}&after=${encodeURIComponent(after)}`;
      return json<SnapshotPage>(await transport(fetchFn(u, { cache: 'no-store' })), 'snapshot');
    },
  };
}

/** How a sync notice reads in a desktop notification (title from `kind`, see SyncIo). */
export function noticeText(n: SyncNotice): { kind: string; text: string } | null {
  switch (n.type) {
    case 'rejected':
      return {
        kind: 'rejected',
        text: `${n.errno}${n.reason === undefined ? '' : ` (${n.reason})`}${n.parked ? ': the change was kept in ~/lost+found' : ''}`,
      };
    case 'conflict':
      return {
        kind: 'conflict',
        text: `Changed elsewhere; your version was kept as ${n.keptAs.name}`,
      };
    case 'superseded':
      return { kind: 'superseded', text: 'Plotinium was opened in another window of this device.' };
    case 'su-ended':
      return { kind: 'su-ended', text: `Your su session for uid ${String(n.uid)} ended.` };
    case 'refetch':
    case 'server-build':
    case 'protocol-error':
    case 'snapshot-reset':
      return null;
  }
}

/** `SyncEngine` over `Syncd`, built at `start()` (it needs the store's device id first). */
class SyncdEngine implements SyncEngine {
  private readonly deps: EngineFactoryDeps;
  private readonly session: EngineSession;
  private readonly host: SyncEngineHost;
  private syncd: Syncd | null = null;
  private wantConnect = false;
  private readonly settled = new Set<() => void>();

  constructor(deps: EngineFactoryDeps, session: EngineSession, host: SyncEngineHost) {
    this.deps = deps;
    this.session = session;
    this.host = host;
  }

  get daemon(): Syncd | null {
    return this.syncd;
  }

  async start(): Promise<void> {
    const store = this.deps.store();
    if (store === null) throw new KernelError('EIO', { reason: 'storage' }, 'store not open');
    const device = await store.get<{ v?: unknown }>('meta', 'deviceId');
    const deviceId = typeof device?.v === 'string' ? device.v : uuidv7();
    const session = this.session;
    const d = new Syncd({
      session: {
        // Live: the OS session id is final only after the `session` service restored it.
        get osSessionId(): string {
          return session.osSessionId;
        },
        deviceId,
        kernelEpoch: this.session.kernelEpoch,
        loginUid: this.session.loginUid,
        build: wireIdentity(this.deps.identity),
        url: this.session.url,
      },
      storage: new StoreSyncStorage(store),
      socket: this.deps.socket,
      http: syncHttp(this.deps.fetch, this.deps.store),
      decode: frameDecoder((m) => {
        this.deps.warn?.(m);
      }),
      online: this.deps.online(),
      ...(this.deps.timeZone === undefined ? {} : { timeZone: this.deps.timeZone }),
      host: {
        applied: (effect) => {
          this.deps.applied(effect);
        },
        status: (status: NetStatus) => {
          this.host.status(status, '');
          for (const fn of [...this.settled]) fn();
        },
        notice: (n) => {
          const t = noticeText(n);
          if (t !== null) this.host.notice(t.kind, t.text);
        },
      },
    });
    await d.start();
    this.syncd = d;
    if (this.wantConnect) d.connect();
  }

  connect(): void {
    this.wantConnect = true;
    this.syncd?.connect();
  }

  kick(): void {
    this.syncd?.kick();
  }

  setOnline(online: boolean): void {
    this.syncd?.setOnline(online);
  }

  onVisible(): void {
    this.syncd?.onVisible();
  }

  status(): { status: NetStatus | null; label: string } {
    return this.syncd?.status() ?? { status: null, label: '' };
  }

  /** Resolves once nothing waits in the outbox (held ops, another principal's, do not count). */
  async idle(): Promise<void> {
    for (;;) {
      const d = this.syncd;
      if (d === null) return;
      await d.idle();
      const o = d.outbox();
      if (o.pending + o.inflight === 0) return;
      await new Promise<void>((resolve) => {
        const fn = (): void => {
          this.settled.delete(fn);
          resolve();
        };
        this.settled.add(fn);
      });
    }
  }

  async shutdown(
    reason: 'shutdown' | 'reboot' | 'logout' | 'takeover' | 'update' = 'shutdown',
  ): Promise<void> {
    const d = this.syncd;
    if (d === null) return;
    await d.shutdown(reason);
  }
}

/** `LockEngine` over `Lockd` (fed by syncd's control lane). */
class LockdEngine implements LockEngine {
  readonly lockd: Lockd;

  constructor(lockd: Lockd) {
    this.lockd = lockd;
  }

  get serverEngaged(): boolean {
    return this.lockd.serverLayer;
  }

  async acquire(req: {
    readonly pid: number;
    readonly ino: string;
    readonly path: string;
    readonly mode: 'S' | 'X';
    readonly wait: boolean;
    readonly timeoutMs?: number;
    readonly principal?: number;
  }): Promise<LockEngineGrant> {
    const r = await this.lockd.acquire({
      pid: req.pid,
      ino: req.ino,
      mode: req.mode,
      wait: req.wait,
      principal: req.principal ?? 0,
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    });
    if (!r.ok)
      throw new KernelError(
        r.errno,
        {
          ...(r.reason === undefined ? {} : { reason: r.reason }),
          ...(r.holder === undefined ? {} : { holder: r.holder }),
        },
        r.holder === undefined ? 'the file is locked' : `locked by ${r.holder}`,
      );
    return r.value;
  }

  release(leaseId: string, pid: number): Promise<void> {
    const r = this.lockd.release(pid, leaseId);
    if (!r.ok) return Promise.reject(new KernelError(r.errno, undefined, 'no such lease'));
    return Promise.resolve();
  }

  releaseAll(pid: number): void {
    this.lockd.releaseAll(pid);
  }

  onVisible(): void {
    this.lockd.onVisible();
  }
}

/** The product's `EngineFactory` (installIo builds it when the host binds a socket). */
export function createEngineFactory(deps: EngineFactoryDeps): EngineFactory {
  return {
    sync: (session, host) => new SyncdEngine(deps, session, host),
    locks: (sync) => {
      const d = sync instanceof SyncdEngine ? sync.daemon : null;
      if (d === null) throw new KernelError('EAGAIN', undefined, 'sync is not started');
      const lockd = new Lockd({
        channel: d,
        newId: uuidv7,
        ...(deps.locks === undefined ? {} : { locks: deps.locks }),
        emit: (ev) => {
          deps.lockEvent(ev);
        },
      });
      d.attachLocks(lockd);
      return new LockdEngine(lockd);
    },
  };
}
