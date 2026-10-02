/**
 * The Editor app's view model and intent handlers (ui-design-system.md §3.8.12; VFS-09, VFS-10).
 *
 * Saves always carry `expectedVersion` (the version this tab loaded or last saved). A stale base
 * never overwrites: the kernel keeps the bytes as a conflicted copy and the save succeeds with
 * `conflict.keptAs` (VFS-10). The tab then shows the amber banner "This file changed on the
 * server. Your version was saved as “…”." with [Compare] [Open conflicted copy], reloads the
 * current version from disk, and nothing typed is ever lost.
 *
 * A lease held by another user (`lock.status`) makes the buffer read-only with the lock chip
 * (VFS-09); the first edit of a writable file takes this window's own X lease.
 *
 * Framework-free like the Files controller; view.tsx mirrors the state into Solid.
 */
import type { KEvent } from '@plotinium/protocol';

import type { Who } from '../../files/lib/model.ts';
import { accessFor, isConflictedCopy, looksBinary } from '../../files/lib/model.ts';
import type { Lease, WriteOutcome } from '../../files/lib/ops.ts';
import {
  acquireLock,
  createText,
  lockHolders,
  quotaOf,
  readFile,
  releaseLock,
  whoami,
  writeText,
} from '../../files/lib/ops.ts';
import { basename, dirname, join, normalize, tildePath } from '../../files/lib/path.ts';
import type { Failure, PromiseSys, SysGen } from '../../files/lib/sys.ts';
import { AppError, drive, failureOf, isErrno, STUBS } from '../../files/lib/sys.ts';
import type { BannerView, LockView, OpenRequest } from './model.ts';
import { holderName, lockViewOf, megabytes } from './model.ts';

export type SaveView =
  | { kind: 'saved'; version: number }
  | { kind: 'edited' }
  | { kind: 'saving' }
  | { kind: 'queued'; queued: number }
  | { kind: 'failed' };

/** The sync-conflict banner state (ui `ConflictState`) plus the copy's path. */
export type ConflictView =
  | { kind: 'conflict'; copyName: string; copyPath: string; offline?: boolean }
  | { kind: 'checking' }
  | { kind: 'resolved'; version: number }
  | { kind: 'error'; retryInSeconds?: number };

export interface DocState {
  id: string;
  /** undefined for a new, unsaved document. */
  path: string | undefined;
  name: string;
  ino: string | undefined;
  /** The base for `expectedVersion`: the version loaded or last saved. */
  version: number;
  /** The content at the last load or save. */
  saved: string;
  /** The buffer. */
  text: string;
  loading: boolean;
  /** The file could not be opened. */
  error: Failure | undefined;
  save: SaveView;
  sync: 'synced' | 'syncing';
  conflict: ConflictView | undefined;
  banner: BannerView | undefined;
  lock: LockView | undefined;
  lease: Lease | undefined;
  writable: boolean;
  /** Line to show once loaded (a citation `path:line`). */
  line: number | undefined;
  /** A newer version seen on disk while this buffer had edits. */
  remoteVersion: number | undefined;
}

export interface SidebarEntry {
  id: string;
  name: string;
  conflict?: boolean;
}

export interface EditorState {
  ready: boolean;
  who: Who | undefined;
  docs: DocState[];
  selected: string | undefined;
  /** Folder of the selected document, for the sidebar. */
  folder: string;
  files: SidebarEntry[];
  toast:
    { id: number; tone: 'info' | 'success' | 'error'; text: string; errno?: string } | undefined;
}

export interface EditorDeps {
  readonly sys: PromiseSys;
  readonly now: () => number;
  readonly user?: { readonly name: string; readonly uid: number };
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** How long the green "Editable" chip stays after a lease ends. */
export const RELEASED_SHOWN_MS = 3_000;

function isDirty(d: DocState): boolean {
  return d.text !== d.saved;
}

export class EditorController {
  private s: EditorState = {
    ready: false,
    who: undefined,
    docs: [],
    selected: undefined,
    folder: '/',
    files: [],
    toast: undefined,
  };
  private readonly listeners = new Set<(s: EditorState) => void>();
  private readonly deps: EditorDeps;
  private untitled = 0;
  private toastSeq = 0;
  private disposed = false;
  private readonly polling = new Set<string>();
  private readonly releasedAt = new Map<string, number>();

  constructor(deps: EditorDeps) {
    this.deps = deps;
  }

  get state(): EditorState {
    return this.s;
  }

  subscribe(fn: (s: EditorState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(patch: Partial<EditorState>): void {
    if (this.disposed) return;
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.s);
  }

  private patchDoc(id: string, patch: Partial<DocState>): void {
    this.set({ docs: this.s.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
  }

  doc(id: string | undefined = this.s.selected): DocState | undefined {
    return this.s.docs.find((d) => d.id === id);
  }

  private run<T>(gen: SysGen<T>): Promise<T> {
    return drive(gen, this.deps.sys);
  }

  private say(tone: 'info' | 'success' | 'error', text: string, errno?: string): void {
    this.toastSeq += 1;
    this.set({
      toast: { id: this.toastSeq, tone, text, ...(errno === undefined ? {} : { errno }) },
    });
  }

  dismissToast(id?: number): void {
    if (id === undefined || this.s.toast?.id === id) this.set({ toast: undefined });
  }

  /** Releases every lease this window holds (the kernel also does at process exit, PROC-07). */
  async dispose(): Promise<void> {
    const leases = this.s.docs.flatMap((d) => (d.lease === undefined ? [] : [d.lease.leaseId]));
    this.disposed = true;
    this.listeners.clear();
    for (const id of leases) await this.run(releaseLock(STUBS, id)).catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Open, new, select, close
  // -------------------------------------------------------------------------------------------

  async start(requests: readonly OpenRequest[]): Promise<void> {
    let who: Who;
    try {
      who = await this.run(whoami(STUBS));
    } catch {
      const name = this.deps.user?.name ?? 'guest';
      const uid = this.deps.user?.uid ?? 1000;
      who = { uid, gid: uid, groups: [], user: name, home: uid === 0 ? '/root' : `/home/${name}` };
    }
    this.set({ who, folder: who.home });
    if (requests.length === 0) this.newDocument();
    for (const r of requests) await this.open(r.path, r.line);
    this.set({ ready: true });
  }

  /** Opens `path` in a tab (or selects its tab), optionally at a line. */
  async open(path: string, line?: number): Promise<void> {
    const home = this.s.who?.home ?? '/';
    // `~/notes/a.md` (Search and the shell cite paths under the home folder this way).
    const expanded = path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
    const abs = normalize(expanded, home);
    const existing = this.s.docs.find((d) => d.path === abs);
    if (existing !== undefined) {
      this.patchDoc(existing.id, { line });
      this.select(existing.id);
      return;
    }
    const id = `doc:${abs}`;
    const doc: DocState = {
      id,
      path: abs,
      name: basename(abs),
      ino: undefined,
      version: 0,
      saved: '',
      text: '',
      loading: true,
      error: undefined,
      save: { kind: 'saved', version: 0 },
      sync: 'synced',
      conflict: undefined,
      banner: undefined,
      lock: undefined,
      lease: undefined,
      writable: false,
      line,
      remoteVersion: undefined,
    };
    // An untouched Untitled tab gives way to the first real file.
    const docs = this.s.docs.filter((d) => d.path !== undefined || isDirty(d));
    this.set({ docs: [...docs, doc], selected: id });
    await this.load(id);
    void this.refreshSidebar();
  }

  /** (Re)reads the document from disk, keeping the tab. */
  private async load(id: string): Promise<void> {
    const d = this.doc(id);
    const who = this.s.who;
    if (d?.path === undefined || who === undefined) return;
    try {
      const st = await this.deps.sys.call('stat', { path: d.path });
      if (st.type === 'd') throw new AppError('EISDIR', 'That is a folder: open it in Files');
      const f = await this.run(readFile(STUBS, d.path));
      if (looksBinary(f.bytes)) {
        this.patchDoc(id, {
          loading: false,
          error: {
            errno: 'EINVAL',
            message: 'This file is not text, so the Editor cannot show it',
          },
        });
        return;
      }
      const text = decoder.decode(f.bytes);
      const access = accessFor(st, who);
      this.patchDoc(id, {
        ino: f.ino,
        version: f.version,
        saved: text,
        text,
        loading: false,
        error: undefined,
        save: { kind: 'saved', version: f.version },
        writable: access.w,
        banner: access.w ? undefined : { kind: 'permission' },
        remoteVersion: undefined,
      });
      await this.refreshLock(id);
    } catch (e) {
      const f = failureOf(e);
      this.patchDoc(id, { loading: false, error: f });
    }
  }

  /** Reads the document from disk again, dropping unsaved edits (Revert, Try again). */
  async reload(id: string = this.s.selected ?? ''): Promise<void> {
    const d = this.doc(id);
    if (d?.path === undefined) return;
    this.patchDoc(id, { loading: true, error: undefined, remoteVersion: undefined });
    await this.load(id);
  }

  /** A new, empty, unsaved document. */
  newDocument(): string {
    this.untitled += 1;
    const id = `new:${String(this.untitled)}`;
    const doc: DocState = {
      id,
      path: undefined,
      name: this.untitled === 1 ? 'Untitled' : `Untitled ${String(this.untitled)}`,
      ino: undefined,
      version: 0,
      saved: '',
      text: '',
      loading: false,
      error: undefined,
      save: { kind: 'saved', version: 0 },
      sync: 'synced',
      conflict: undefined,
      banner: undefined,
      lock: undefined,
      lease: undefined,
      writable: true,
      line: undefined,
      remoteVersion: undefined,
    };
    this.set({ docs: [...this.s.docs, doc], selected: id });
    return id;
  }

  select(id: string): void {
    if (this.doc(id) === undefined) return;
    this.set({ selected: id });
    void this.refreshSidebar();
  }

  /** The line was shown; do not jump there again. */
  lineShown(id: string): void {
    this.patchDoc(id, { line: undefined });
  }

  isDirty(id: string): boolean {
    const d = this.doc(id);
    return d !== undefined && isDirty(d);
  }

  /** Closes a tab (the view asks first when it has edits) and releases its lease. */
  async close(id: string): Promise<void> {
    const d = this.doc(id);
    if (d === undefined) return;
    const index = this.s.docs.indexOf(d);
    const docs = this.s.docs.filter((x) => x.id !== id);
    const next = docs[Math.min(index, docs.length - 1)]?.id;
    this.set({ docs, selected: this.s.selected === id ? next : this.s.selected });
    if (d.lease !== undefined)
      await this.run(releaseLock(STUBS, d.lease.leaseId)).catch(() => undefined);
    if (docs.length === 0) this.newDocument();
    void this.refreshSidebar();
  }

  /** Files of the selected document's folder, for the sidebar (conflicted copies marked). */
  async refreshSidebar(): Promise<void> {
    const d = this.doc();
    const folder = d?.path === undefined ? (this.s.who?.home ?? '/') : dirname(d.path);
    try {
      const page = await this.deps.sys.call('readdir', { path: folder, limit: 200 });
      const files = page.entries
        .filter((e) => e.type === 'f' && !e.name.startsWith('.'))
        .map((e) => ({
          id: join(folder, e.name),
          name: e.name,
          ...(isConflictedCopy(e.name) ? { conflict: true } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      this.set({ folder, files });
    } catch {
      this.set({ folder, files: [] });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Editing and locks (VFS-09)
  // -------------------------------------------------------------------------------------------

  /** The buffer changed. The first edit of a saved file takes this window's X lease. */
  edit(id: string, text: string): void {
    const d = this.doc(id);
    if (d === undefined || d.text === text) return;
    // A read-only buffer (another user's lease, no write permission) never changes (VFS-09).
    if (d.lock?.kind === 'other' || !d.writable) return;
    const dirty = text !== d.saved;
    this.patchDoc(id, {
      text,
      save: dirty ? { kind: 'edited' } : { kind: 'saved', version: d.version },
    });
    if (dirty && d.lease === undefined && d.path !== undefined) void this.takeLease(id);
  }

  private async takeLease(id: string): Promise<void> {
    const d = this.doc(id);
    if (d?.path === undefined || d.lease !== undefined) return;
    try {
      const lease = await this.run(acquireLock(STUBS, d.path));
      this.patchDoc(id, { lease, lock: { kind: 'mine' } });
    } catch (e) {
      if (isErrno(e, 'EBUSY')) {
        // Someone else took the lease first: nothing typed is lost, but the buffer turns read-only.
        await this.refreshLock(id);
        const now = this.doc(id);
        if (now?.lock?.kind === 'other') {
          this.say(
            'error',
            `${now.name} is locked by ${now.lock.holder}; your edits stay in this tab`,
            'EBUSY',
          );
        }
      }
      // ENOSYS or EPERM: no lock service; saving still carries expectedVersion (VFS-10).
    }
  }

  /** Reads the holders of the document's lease (poll, events, Try again). */
  async refreshLock(id: string): Promise<void> {
    const d = this.doc(id);
    const who = this.s.who;
    if (d?.path === undefined || who === undefined) return;
    const holders = await this.run(lockHolders(STUBS, d.path));
    const now = this.deps.now();
    const current = this.doc(id);
    if (current === undefined) return;
    // lockd renews this window's lease in the background (VFS-09), so its expiry at acquire time
    // says nothing: the lease is still ours while `lock.status` lists our X lease (or has no
    // answer at all, when there is no lock service to ask).
    const ownX = holders.some((h) => h.mode === 'X' && holderName(h.holder) === who.user);
    let lock = lockViewOf(holders, {
      user: who.user,
      mine: current.lease !== undefined && (ownX || holders.length === 0),
      ...(current.lock === undefined ? {} : { previous: current.lock }),
      now,
    });
    // "Editable" stays for a moment after the other user's lease ends, then the chip goes.
    if (lock?.kind === 'released' && current.lock?.kind !== 'released')
      this.releasedAt.set(id, now);
    if (lock === undefined && current.lock?.kind === 'released') {
      const at = this.releasedAt.get(id) ?? 0;
      if (now - at < RELEASED_SHOWN_MS) lock = current.lock;
      else this.releasedAt.delete(id);
    }
    const banner =
      lock?.kind === 'other'
        ? ({
            kind: 'locked',
            holder: lock.holder,
            seconds: Math.max(0, Math.ceil((lock.expiresAt - now) / 1000)),
          } as const)
        : current.banner?.kind === 'locked'
          ? undefined
          : current.banner;
    this.patchDoc(id, { lock, banner });
  }

  /** Explicitly takes or gives back the lease (the header's lock button). */
  async toggleLease(id: string): Promise<void> {
    const d = this.doc(id);
    if (d?.path === undefined) return;
    if (d.lease !== undefined) {
      await this.run(releaseLock(STUBS, d.lease.leaseId)).catch(() => undefined);
      this.patchDoc(id, { lease: undefined, lock: undefined });
      this.say('info', `Released the lock on ${d.name}`);
      return;
    }
    try {
      const lease = await this.run(acquireLock(STUBS, d.path));
      this.patchDoc(id, { lease, lock: { kind: 'mine' } });
      this.say('success', `You hold the lock on ${d.name}; others can only read it`);
    } catch (e) {
      const f = failureOf(e);
      await this.refreshLock(id);
      this.say(
        'error',
        isErrno(e, 'EBUSY')
          ? `${d.name} is locked by someone else`
          : `Could not lock ${d.name}: ${f.message}`,
        f.errno,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Saving (VFS-10)
  // -------------------------------------------------------------------------------------------

  /**
   * Saves the buffer with `expectedVersion` = the tab's base version. Returns false when the tab
   * has no path yet (the view asks for one and calls saveAs).
   */
  async save(id: string = this.s.selected ?? ''): Promise<boolean> {
    const d = this.doc(id);
    if (d === undefined) return true;
    if (d.path === undefined) return false;
    if (d.lock?.kind === 'other') {
      this.patchDoc(id, {
        banner: {
          kind: 'locked',
          holder: d.lock.holder,
          seconds: Math.max(0, Math.ceil((d.lock.expiresAt - this.deps.now()) / 1000)),
        },
      });
      return true;
    }
    const text = d.text;
    this.patchDoc(id, { save: { kind: 'saving' } });
    try {
      const r = await this.run(writeText(STUBS, d.path, text, d.version));
      await this.afterWrite(id, text, r);
    } catch (e) {
      await this.saveFailed(id, e);
    }
    return true;
  }

  private async afterWrite(id: string, text: string, r: WriteOutcome): Promise<void> {
    const d = this.doc(id);
    if (d === undefined) return;
    if (r.keptAs !== undefined) {
      // VFS-10: our bytes are in the conflicted copy; show the server's version in this tab.
      const conflict: ConflictView = {
        kind: 'conflict',
        copyName: basename(r.keptAs.path),
        copyPath: r.keptAs.path,
      };
      this.patchDoc(id, { conflict, text: d.saved, banner: undefined, remoteVersion: undefined });
      await this.load(id);
      this.patchDoc(id, { conflict });
      void this.refreshSidebar();
      return;
    }
    const stillSame = d.text === text;
    this.patchDoc(id, {
      version: r.version,
      ino: r.ino,
      saved: text,
      save: stillSame ? { kind: 'saved', version: r.version } : { kind: 'edited' },
      sync: r.sync === 'pending' ? 'syncing' : 'synced',
      banner:
        d.banner?.kind === 'changed' || d.banner?.kind === 'quota' || d.banner?.kind === 'error'
          ? undefined
          : d.banner,
      remoteVersion: undefined,
    });
  }

  private async saveFailed(id: string, e: unknown): Promise<void> {
    const f = failureOf(e);
    let banner: BannerView;
    if (f.errno === 'EDQUOT') {
      const q = await this.run(quotaOf(STUBS)).catch(() => undefined);
      banner = {
        kind: 'quota',
        usedMb: megabytes(q?.used ?? 0),
        totalMb: megabytes(q?.total ?? 0),
      };
    } else if (f.errno === 'EACCES') {
      banner = { kind: 'permission' };
      this.patchDoc(id, { writable: false });
    } else if (f.errno === 'EBUSY') {
      await this.refreshLock(id);
      const d = this.doc(id);
      banner =
        d?.lock?.kind === 'other'
          ? {
              kind: 'locked',
              holder: d.lock.holder,
              seconds: Math.max(0, Math.ceil((d.lock.expiresAt - this.deps.now()) / 1000)),
            }
          : { kind: 'error', text: f.message, errno: f.errno };
    } else {
      banner = { kind: 'error', text: f.message, errno: f.errno };
    }
    this.patchDoc(id, { save: { kind: 'failed' }, banner });
  }

  /** Save As: creates `path` (never overwriting) and points the tab at it. */
  async saveAs(id: string, path: string): Promise<boolean> {
    const d = this.doc(id);
    const who = this.s.who;
    if (d === undefined || who === undefined) return false;
    const abs = normalize(path, d.path === undefined ? who.home : dirname(d.path));
    const text = d.text;
    this.patchDoc(id, { save: { kind: 'saving' } });
    try {
      const r = await this.run(createText(STUBS, abs, text));
      if (d.lease !== undefined)
        await this.run(releaseLock(STUBS, d.lease.leaseId)).catch(() => undefined);
      this.patchDoc(id, {
        path: abs,
        name: basename(abs),
        ino: r.ino,
        version: r.version,
        saved: text,
        save: { kind: 'saved', version: r.version },
        sync: r.sync === 'pending' ? 'syncing' : 'synced',
        writable: true,
        banner: undefined,
        lease: undefined,
        lock: undefined,
      });
      void this.refreshSidebar();
      this.say('success', `Saved as ${tildePath(abs, who.home)}`);
      return true;
    } catch (e) {
      const f = failureOf(e);
      this.patchDoc(id, {
        save: isDirty(d) ? { kind: 'edited' } : { kind: 'saved', version: d.version },
      });
      // A missing folder is named, so the user knows which part of the path to fix (UI-102).
      const why =
        f.errno === 'ENOENT'
          ? `the folder ${tildePath(dirname(abs), who.home)} does not exist`
          : f.message;
      this.say('error', `Could not save as ${basename(abs)}: ${why}`, f.errno);
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Banners
  // -------------------------------------------------------------------------------------------

  /** [Compare] and [Open conflicted copy] both open the copy in its own tab; [Retry] saves. */
  async conflictAction(id: string, action: 'compare' | 'open-copy' | 'retry'): Promise<void> {
    const d = this.doc(id);
    if (d === undefined) return;
    if (action === 'retry') {
      await this.save(id);
      return;
    }
    if (d.conflict?.kind !== 'conflict') return;
    try {
      await this.deps.sys.call('lstat', { path: d.conflict.copyPath });
    } catch {
      this.patchDoc(id, { conflict: { ...d.conflict } });
      this.say('error', 'The conflicted copy was deleted', 'ENOENT');
      return;
    }
    await this.open(d.conflict.copyPath);
    if (action === 'compare')
      this.say('info', `Your version is open beside the server's in its own tab`);
  }

  dismissConflict(id: string): void {
    this.patchDoc(id, { conflict: undefined });
  }

  dismissBanner(id: string): void {
    this.patchDoc(id, { banner: undefined });
  }

  /** [Reload], [Keep mine] (save on the old base: a conflicted copy, never an overwrite), [Try again]. */
  async bannerAction(id: string, action: 'reload' | 'keep-mine' | 'try-again'): Promise<void> {
    const d = this.doc(id);
    if (d === undefined) return;
    if (action === 'reload') {
      if (d.lease === undefined) this.patchDoc(id, { lock: undefined });
      await this.load(id);
      return;
    }
    if (action === 'keep-mine') {
      this.patchDoc(id, { banner: undefined });
      await this.save(id);
      return;
    }
    await this.refreshLock(id);
    const now = this.doc(id);
    if (now?.lock?.kind !== 'other' && isDirty(now ?? d)) await this.takeLease(id);
  }

  // -------------------------------------------------------------------------------------------
  // Change detection
  // -------------------------------------------------------------------------------------------

  /** Checks the selected document on disk: reload a clean buffer, warn a dirty one. */
  async poll(id: string | undefined = this.s.selected): Promise<void> {
    const d = this.doc(id);
    if (
      d?.path === undefined ||
      d.loading ||
      d.error !== undefined ||
      d.save.kind === 'saving' ||
      this.polling.has(d.id)
    )
      return;
    this.polling.add(d.id);
    try {
      const st = await this.deps.sys.call('stat', { path: d.path }).catch(() => undefined);
      const now = this.doc(d.id);
      if (
        st !== undefined &&
        now !== undefined &&
        st.version !== now.version &&
        now.save.kind !== 'saving'
      ) {
        if (isDirty(now)) {
          if (now.remoteVersion !== st.version)
            this.patchDoc(d.id, {
              remoteVersion: st.version,
              banner: { kind: 'changed', name: now.name },
            });
        } else {
          await this.load(d.id);
        }
      }
      await this.refreshLock(d.id);
    } finally {
      this.polling.delete(d.id);
    }
  }

  /** Kernel events: writes and conflicts on open files, lease changes. */
  onEvents(batch: readonly KEvent[]): void {
    for (const ev of batch) {
      if (ev.topic === 'vfs.write') {
        const d = this.s.docs.find((x) => x.ino === ev.data.ino);
        if (d !== undefined && ev.data.version !== d.version) void this.poll(d.id);
      } else if (ev.topic === 'vfs.conflict') {
        const d = this.s.docs.find((x) => x.ino === ev.data.ino);
        if (d !== undefined) {
          this.patchDoc(d.id, {
            conflict: {
              kind: 'conflict',
              copyName: basename(ev.data.keptAs.path),
              copyPath: ev.data.keptAs.path,
              offline: true,
            },
          });
          void this.load(d.id).then(() => this.refreshSidebar());
        }
      } else if (
        ev.topic === 'lock.granted' ||
        ev.topic === 'lock.released' ||
        ev.topic === 'lock.lost' ||
        ev.topic === 'lock.queued'
      ) {
        const d = this.s.docs.find((x) => x.ino === ev.data.ino);
        if (d !== undefined) {
          if (ev.topic === 'lock.lost' && d.lease !== undefined)
            this.patchDoc(d.id, { lease: undefined });
          void this.refreshLock(d.id);
        }
      }
    }
  }
}
