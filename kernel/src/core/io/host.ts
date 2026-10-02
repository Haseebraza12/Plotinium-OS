/**
 * Requests of the desktop host (web/src/desktop/host.ts) that only the kernel can answer, carried
 * on the router port (`host.request` → `host.reply`, kernel/src/host/router-protocol.ts). The host
 * is the main-thread shell's composer: it has no process and no system-call client, so each
 * request acts for the CONSOLE user (the one at the desktop) with that user's credentials.
 *
 * - `mem.budget` (UI-047): the Control Centre's memory budget slider sets `mm.budget` exactly as
 *   Settings does (`sysctl.set`, a session key), refused for a guest session;
 * - `outbox` (UI-026): the operations waiting in the durable outbox, for the connectivity
 *   popover; the kernel also pushes the list whenever the queued count changes;
 * - `search` (UI-045): file and folder names under the user's home that match the query, walked
 *   breadth-first with the user's own permissions (bounded), so Search finds files even with an
 *   empty semantic index.
 */
import type { OutboxRec, UndoRec } from '@plotinium/vfs';
import { R, X, may } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import type { FsActor, KernelFs } from '../fs/kfs.ts';
import type { FsStore } from '../fs/store.ts';
import type { Kernel } from '../kernel.ts';
import type { ConsoleSession } from './login.ts';

const MIB = 1_048_576;

/** The Control Centre slider's range and step (MB). */
export const BUDGET_MIN_MB = 128;
export const BUDGET_MAX_MB = 1_024;

/** One operation waiting in the outbox (the shell's `QueuedOp` without its display strings). */
export interface HostQueuedOp {
  readonly id: string;
  /** `write`, `mkdir`, `mv`, `rm`, `cp`, `chmod`, … (the op's plan label). */
  readonly verb: string;
  readonly path: string;
  /** Destination of a move or copy. */
  readonly target?: string;
  /** Epoch ms when the op was committed locally. */
  readonly at: number;
  /** `parked`: the server refused it; it waits for the user (§3.12.4). */
  readonly state: 'queued' | 'parked';
}

/** One matching file or folder. */
export interface HostSearchHit {
  readonly path: string;
  readonly name: string;
  readonly type: 'f' | 'd' | 'l';
  readonly size: number;
  readonly mtime: number;
  /** The owner's name when it is not the console user. */
  readonly owner?: string;
}

export type HostRequest =
  | { readonly op: 'mem.budget'; readonly mb: number }
  | { readonly op: 'outbox' }
  | { readonly op: 'search'; readonly q: string; readonly limit?: number };

export type HostReplyValue =
  | { readonly op: 'mem.budget'; readonly budgetMb: number }
  | { readonly op: 'outbox'; readonly ops: readonly HostQueuedOp[] }
  | {
      readonly op: 'search';
      readonly hits: readonly HostSearchHit[];
      /** The walk stopped at its bounds before the whole home was seen. */
      readonly partial: boolean;
    };

export interface HostRequestsDeps {
  readonly kernel: Kernel;
  readonly console: () => ConsoleSession | null;
  readonly fs: () => KernelFs | null;
  readonly store: () => FsStore | null;
}

/** Search bounds: at most this many directories and entries are looked at per query. */
export const SEARCH_MAX_DIRS = 400;
export const SEARCH_MAX_ENTRIES = 20_000;
export const SEARCH_DEFAULT_LIMIT = 20;
/** Most outbox rows listed (the popover shows a count for the rest). */
export const OUTBOX_LIST_MAX = 200;

/**
 * `verb path [target]` from a plan label (kernel/src/core/fs/handlers.ts: `write /home/a/f.txt`,
 * `mv /a /b`, `cp -r /a /b`, `rm -r /a`, `batch of 3`). Paths may contain spaces; a two-path label
 * splits at its last ` /`.
 */
export function opOfLabel(
  label: string,
  call: string,
): { verb: string; path: string; target?: string } {
  const text = label.trim();
  const m = /^(\S+)((?:\s+-\S+)*)\s+(.*)$/.exec(text);
  const verbRaw = m?.[1];
  const rest = m?.[3];
  if (verbRaw === undefined || rest === undefined || !rest.startsWith('/'))
    return { verb: text === '' ? call : text, path: '' };
  const verb = verbRaw === 'rmdir' ? 'rm' : verbRaw;
  if (verbRaw === 'mv' || verbRaw === 'cp' || verbRaw === 'ln') {
    const i = rest.lastIndexOf(' /');
    if (i > 0) return { verb, path: rest.slice(0, i), target: rest.slice(i + 1) };
  }
  return { verb, path: rest };
}

function score(name: string, terms: readonly string[]): number {
  const n = name.toLowerCase();
  const q = terms.join(' ');
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

export class HostRequests {
  private readonly deps: HostRequestsDeps;

  constructor(deps: HostRequestsDeps) {
    this.deps = deps;
  }

  private session(): ConsoleSession {
    const s = this.deps.console();
    if (s === null) throw new KernelError('EACCES', undefined, 'nobody is signed in');
    return s;
  }

  async handle(req: HostRequest): Promise<HostReplyValue> {
    switch (req.op) {
      case 'mem.budget':
        return { op: 'mem.budget', budgetMb: this.memBudget(req.mb) };
      case 'outbox':
        return { op: 'outbox', ops: await this.outbox() };
      case 'search':
        return { op: 'search', ...(await this.search(req.q, req.limit)) };
    }
  }

  /** UI-047: `mm.budget` for the console user; the new budget (MB) as the kernel applied it. */
  memBudget(mb: number): number {
    const s = this.session();
    if (s.kind === 'guest')
      throw new KernelError(
        'EPERM',
        undefined,
        'the memory budget is managed by the administrator',
      );
    if (!Number.isInteger(mb) || mb < BUDGET_MIN_MB || mb > BUDGET_MAX_MB)
      throw new KernelError(
        'EINVAL',
        undefined,
        `choose between ${String(BUDGET_MIN_MB)} MB and ${String(BUDGET_MAX_MB)} MB`,
      );
    const r = this.deps.kernel.sysctl.set('mm.budget', mb * MIB);
    return typeof r.value === 'number' ? Math.round(r.value / MIB) : mb;
  }

  /** UI-026: the records `sync` counts as queued (pending or parked), oldest first. */
  async outbox(): Promise<HostQueuedOp[]> {
    const store = this.deps.store();
    if (store === null) return [];
    const recs: OutboxRec[] = [];
    await store.scan<OutboxRec>('outbox', null, (r) => {
      if (r.state === 'pending' || r.state === 'parked') recs.push(r);
    });
    recs.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const out: HostQueuedOp[] = [];
    for (const r of recs.slice(0, OUTBOX_LIST_MAX)) {
      const undo = await store.get<UndoRec>('undo', r.opId).catch(() => undefined);
      const what = opOfLabel(undo?.summary ?? r.call, r.call);
      out.push({
        id: r.opId,
        ...what,
        at: r.createdAt,
        state: r.state === 'parked' ? 'parked' : 'queued',
      });
    }
    return out;
  }

  /** UI-045: names under the console user's home matching every term of `q` (case-insensitive). */
  async search(
    q: string,
    limit: number = SEARCH_DEFAULT_LIMIT,
  ): Promise<{ hits: HostSearchHit[]; partial: boolean }> {
    const s = this.session();
    const fs = this.deps.fs();
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t !== '');
    if (fs === null || terms.length === 0) return { hits: [], partial: false };
    const actor: FsActor = {
      pid: 0,
      cred: {
        uid: s.uid,
        gid: s.gid,
        groups: s.groups.includes(s.gid) ? [...s.groups] : [s.gid, ...s.groups],
      },
      cls: 'user',
      cwdIno: '',
      cwdPath: s.home,
      umask: 0o022,
    };
    let root;
    try {
      root = await fs.resolvePath(actor, s.home, { follow: true });
    } catch {
      return { hits: [], partial: false };
    }
    if (root.node === null || root.node.type !== 'd') return { hits: [], partial: false };
    const tree = fs.tree;
    const found: (HostSearchHit & { rank: number })[] = [];
    const queue: { ino: string; path: string }[] = [{ ino: root.node.ino, path: s.home }];
    let dirs = 0;
    let seen = 0;
    let partial = false;
    while (queue.length > 0) {
      if (dirs >= SEARCH_MAX_DIRS || seen >= SEARCH_MAX_ENTRIES) {
        partial = true;
        break;
      }
      const dir = queue.shift();
      if (dir === undefined) break;
      const node = tree.inode(dir.ino);
      if (node === undefined || !may(actor.cred, node, R | X)) continue;
      dirs++;
      try {
        await fs.loader.ensureLoaded(dir.ino);
      } catch {
        continue;
      }
      const entries = tree.entries(dir.ino);
      if (typeof entries === 'string') continue;
      for (const e of entries) {
        seen++;
        const child = tree.inode(e.ino);
        if (child === undefined) continue;
        const path = dir.path === '/' ? `/${e.name}` : `${dir.path}/${e.name}`;
        const lower = e.name.toLowerCase();
        if (terms.every((t) => lower.includes(t))) {
          const owner = child.uid === s.uid ? undefined : fs.userName(child.uid);
          found.push({
            path,
            name: e.name,
            type: child.type,
            size: child.size,
            mtime: child.mtime,
            rank: score(e.name, terms),
            ...(owner === undefined ? {} : { owner }),
          });
        }
        if (child.type === 'd') queue.push({ ino: e.ino, path });
      }
    }
    found.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime || (a.path < b.path ? -1 : 1));
    const hits = found.slice(0, Math.max(1, Math.min(limit, 100))).map((h) => {
      const { rank: _rank, ...hit } = h;
      return hit;
    });
    return { hits, partial };
  }
}
