/**
 * The Files app's view model and intent handlers (ui-design-system.md §3.8.11; VFS-07, RAG-06).
 *
 * Framework-free: it holds one immutable state object, replaces it on every change and tells
 * subscribers; view.tsx mirrors it into Solid. Every file-system effect is a generator operation
 * from ops.ts, driven through the view's system-call client (`drive`), so the same operations
 * also run unchanged in the app's process.
 */
import type { KEvent, SemsearchResult } from '@plotinium/protocol';

import type { EntryLock, EntryView, History, KeywordHit, PlaceView, Who } from './model.ts';
import {
  accessFor,
  EMPTY_HISTORY,
  highlightRanges,
  isConflictedCopy,
  ownerName,
  placeFor,
  placesFor,
  pushHistory,
  queryTerms,
  reuseRows,
  stepBack,
  stepForward,
  toEntry,
  trashOf,
} from './model.ts';
import type { ItemResult, Lease } from './ops.ts';
import {
  acquireLock,
  chmodEntries,
  copyInto,
  deleteEntries,
  dirVersionOf,
  existing,
  forgetTrashInfo,
  keywordSearch,
  listDir,
  lockHolders,
  makeFile,
  makeFolder,
  moveInto,
  putBackEntries,
  quotaOf,
  releaseLock,
  renameEntry,
  semanticSearch,
  trashEntries,
  uploadFile,
  userNames,
  whoami,
} from './ops.ts';
import { basename, dirname, isInside, join, normalize, tildePath } from './path.ts';
import type { Failure, PromiseSys, SysGen } from './sys.ts';
import { drive, failureOf, isErrno, STUBS } from './sys.ts';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export type ViewMode = 'icons' | 'list';
export type SortKey = 'name' | 'modified' | 'size' | 'kind' | 'permissions';
export interface Sort {
  key: SortKey;
  direction: 'ascending' | 'descending';
}
export type SearchMode = 'semantic' | 'keyword';

/** A search result card (ui `SemanticHit`), plus the absolute path to open. */
export interface HitView {
  id: string;
  /** `~/notes/week6.md` (the citation's path). */
  path: string;
  absPath: string;
  name: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
  highlights: [number, number][];
  owner: string;
  verified: 'own' | 'server';
}

/** Notices above the results (ui `SearchNotice`; exact strings live in the ui). */
export type NoticeView =
  | { kind: 'model-loading'; progress: number }
  | { kind: 'model-ready' }
  | { kind: 'unavailable' }
  | { kind: 'shared-hidden'; count: number }
  | { kind: 'truncated' };

export interface SearchView {
  query: string;
  scope: string;
  mode: SearchMode;
  loading: boolean;
  hits: HitView[];
  elapsedMs?: number;
  notices: NoticeView[];
  error?: Failure;
  indexedFiles: number;
}

/** A short message in the window: progress, success or a failure with its errno. */
export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error';
  text: string;
  errno?: string;
  /** One button in the toast, for example Undo after Move to Trash (view: `toastAction`). */
  action?: { id: 'undo-trash'; label: string };
}

export interface Clipboard {
  mode: 'copy' | 'cut';
  paths: string[];
}

export interface FilesState {
  /** `proc.cred` answered and the first listing ran. */
  ready: boolean;
  who: Who | undefined;
  path: string;
  /** Folder name for the title and heading (`Documents`, `/`). */
  title: string;
  history: History;
  /** Rows of the folder (hidden files filtered), decorated with cut and lock state. */
  rows: EntryView[];
  loading: boolean;
  /** The folder could not be listed. */
  error: Failure | undefined;
  dirIno: string | undefined;
  dirVersion: number;
  folderWritable: boolean;
  truncated: boolean;
  view: ViewMode;
  sort: Sort;
  hidden: boolean;
  inspector: boolean;
  favourites: PlaceView[];
  locations: PlaceView[];
  selectedPlace: string | undefined;
  quota: { used: number; total: number } | undefined;
  clipboard: Clipboard | undefined;
  query: string;
  searchMode: SearchMode;
  semanticAvailable: boolean;
  search: SearchView | undefined;
  selectedHit: string | undefined;
  hitEntries: Record<string, EntryView>;
  /** Leases this window holds, by path. */
  leases: Record<string, Lease>;
  /** Lease holders seen on inspected files, by path. */
  locks: Record<string, EntryLock>;
  toast: Toast | undefined;
  /** In the Trash folder (Delete means delete for good). */
  inTrash: boolean;
}

export interface FilesDeps {
  readonly sys: PromiseSys;
  readonly now: () => number;
  /** Opens another app (the Editor at a path and line, the Terminal in a folder). */
  readonly launch: (app: string, argv: readonly string[]) => void;
  /** The host's AI flag (C12); false hides semantic search. */
  readonly aiAvailable: boolean;
  /** The logged-in user when `proc.cred` is not available. */
  readonly user?: { readonly name: string; readonly uid: number };
  /**
   * Shows `path` in the Editor window that already has it open (UI-104): undefined when no
   * window has it, else whether that window got the focus (open-docs.ts).
   */
  readonly reveal?: (path: string, line?: number) => Promise<boolean> | undefined;
}

const INITIAL: FilesState = {
  ready: false,
  who: undefined,
  path: '/',
  title: 'Files',
  history: EMPTY_HISTORY,
  rows: [],
  loading: true,
  error: undefined,
  dirIno: undefined,
  dirVersion: -1,
  folderWritable: false,
  truncated: false,
  view: 'list',
  sort: { key: 'name', direction: 'ascending' },
  hidden: false,
  inspector: true,
  favourites: [],
  locations: [],
  selectedPlace: undefined,
  quota: undefined,
  clipboard: undefined,
  query: '',
  searchMode: 'semantic',
  semanticAvailable: true,
  search: undefined,
  selectedHit: undefined,
  hitEntries: {},
  leases: {},
  locks: {},
  toast: undefined,
  inTrash: false,
};

/** Folder errors in the words of ui-design-system.md §3.8.11. */
function folderFailure(e: unknown): Failure {
  const f = failureOf(e);
  if (f.errno === 'EACCES')
    return { errno: 'EACCES', message: 'You do not have permission to open this folder' };
  if (f.errno === 'ENOENT') return { errno: 'ENOENT', message: 'This folder does not exist' };
  if (f.errno === 'ENOTDIR') return { errno: 'ENOTDIR', message: 'That is not a folder' };
  return f;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The same rows in the same order (the objects themselves, not copies). */
function sameRows(a: readonly EntryView[], b: readonly EntryView[]): boolean {
  return a.length === b.length && a.every((row, i) => row === b[i]);
}

/** Folders re-listed on every poll (content changes do not move a folder's version, UI-105). */
export const POLL_RELIST_MAX = 1_000;

/** Go-menu places that exist only when their folder does, by id. */
const OPTIONAL_PLACES: Readonly<Record<string, string>> = {
  documents: 'Documents',
  downloads: 'Downloads',
  shared: 'Shared',
};

/** Whether a vfs event concerns the folder `dirIno` or one of `ids`. */
export function touchesFolder(
  ev: KEvent,
  dirIno: string | undefined,
  ids: ReadonlySet<string>,
): boolean {
  if (ev.topic === 'vfs.create' || ev.topic === 'vfs.write') {
    return ev.data.parent === dirIno || ids.has(ev.data.ino);
  }
  if (ev.topic === 'vfs.rename') {
    return ev.data.fromParent === dirIno || ev.data.toParent === dirIno || ids.has(ev.data.ino);
  }
  if (ev.topic === 'vfs.unlink')
    return ev.data.parent === dirIno || ev.data.inos.some((i) => ids.has(i));
  if (ev.topic === 'vfs.chmod' || ev.topic === 'vfs.chown') {
    return ev.data.root === dirIno || ev.data.inos.some((i) => ids.has(i) || i === dirIno);
  }
  if (ev.topic === 'vfs.conflict') return ids.has(ev.data.ino);
  return false;
}

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

export class FilesController {
  private s: FilesState = INITIAL;
  private readonly listeners = new Set<(s: FilesState) => void>();
  private entries: EntryView[] = [];
  private names = new Map<number, string>();
  private groups = new Map<number, string>();
  private navSeq = 0;
  private searchSeq = 0;
  private toastSeq = 0;
  private refreshing = false;
  private disposed = false;
  /** The last Move to Trash, for the toast's Undo: trash path to original path. */
  private lastTrash: Map<string, string> | undefined;
  private readonly deps: FilesDeps;

  constructor(deps: FilesDeps) {
    this.deps = deps;
  }

  get state(): FilesState {
    return this.s;
  }

  subscribe(fn: (s: FilesState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<FilesState>): void {
    if (this.disposed) return;
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.s);
  }

  private run<T>(gen: SysGen<T>): Promise<T> {
    return drive(gen, this.deps.sys);
  }

  private say(
    tone: Toast['tone'],
    text: string,
    errno?: string,
    action?: NonNullable<Toast['action']>,
  ): void {
    this.toastSeq += 1;
    this.set({
      toast: {
        id: this.toastSeq,
        tone,
        text,
        ...(errno === undefined ? {} : { errno }),
        ...(action === undefined ? {} : { action }),
      },
    });
  }

  /** A message from the view (for example a refused drop). */
  notify(tone: Toast['tone'], text: string, errno?: string): void {
    this.say(tone, text, errno);
  }

  dismissToast(id?: number): void {
    if (id === undefined || this.s.toast?.id === id) this.set({ toast: undefined });
  }

  /** Reports a bulk result: all done, or how many failed and the first reason. */
  private report(results: readonly ItemResult[], done: (n: number) => string): void {
    const failed = results.filter((r) => r.error !== undefined);
    const ok = results.length - failed.length;
    if (failed.length === 0) {
      if (ok > 0) this.say('success', done(ok));
      return;
    }
    const first = failureOf(failed[0]?.error);
    const prefix =
      results.length === 1
        ? `“${basename(failed[0]?.path ?? '')}”: `
        : `${String(failed.length)} of ${plural(results.length, 'item')} failed. `;
    this.say('error', `${prefix}${first.message}`, first.errno);
  }

  // -------------------------------------------------------------------------------------------
  // Start, identity, listing
  // -------------------------------------------------------------------------------------------

  /** Resolves the user, the places and the quota, then lists `start` (or the home folder). */
  async start(start?: string): Promise<void> {
    let who: Who;
    try {
      who = await this.run(whoami(STUBS));
    } catch {
      const name = this.deps.user?.name ?? 'guest';
      const uid = this.deps.user?.uid ?? 1000;
      who = { uid, gid: uid, groups: [], user: name, home: uid === 0 ? '/root' : `/home/${name}` };
    }
    const names = await this.run(userNames(STUBS));
    this.names = names.users;
    this.groups = names.groups;
    if (!this.names.has(who.uid)) this.names.set(who.uid, who.user);
    const optional = [join(who.home, 'Documents'), join(who.home, 'Downloads'), '/home/shared'];
    const present = await this.run(existing(STUBS, optional));
    const places = placesFor(who, (p) => present.has(p));
    this.set({
      who,
      favourites: places.favourites,
      locations: places.locations,
      semanticAvailable: this.deps.aiAvailable,
      searchMode: this.deps.aiAvailable ? 'semantic' : 'keyword',
    });
    const first = start === undefined || start === '' ? who.home : normalize(start, who.home);
    await Promise.all([this.navigate(first, { push: false }), this.refreshQuota()]);
    this.set({ ready: true });
  }

  async refreshQuota(): Promise<void> {
    const quota = await this.run(quotaOf(STUBS)).catch(() => undefined);
    this.set({ quota });
  }

  /** Lists `path`; Back gets the current folder unless `push` is false. */
  async navigate(path: string, opts: { push?: boolean } = {}): Promise<void> {
    const who = this.s.who;
    if (who === undefined) return;
    const target = normalize(path, this.s.path);
    const seq = ++this.navSeq;
    const push = opts.push !== false && target !== this.s.path && this.s.ready;
    const history = push ? pushHistory(this.s.history, this.s.path) : this.s.history;
    this.set({
      path: target,
      // The Trash is called Trash, not by its folder name (.Trash).
      title: target === trashOf(who) ? 'Trash' : basename(target),
      history,
      loading: true,
      error: undefined,
      search: undefined,
      query: '',
      selectedHit: undefined,
      selectedPlace: placeFor(target, {
        favourites: this.s.favourites,
        locations: this.s.locations,
      }),
      inTrash: isInside(target, trashOf(who)),
    });
    await this.load(seq, target, who);
  }

  private async load(seq: number, path: string, who: Who): Promise<void> {
    try {
      const listing = await this.run(
        listDir(STUBS, path, who, this.names, { hidden: this.s.hidden, groups: this.groups }),
      );
      if (seq !== this.navSeq) return;
      this.entries = listing.entries;
      const access = accessFor(listing.dir, who);
      this.set({
        loading: false,
        error: undefined,
        dirIno: listing.dir.ino,
        dirVersion: listing.dirVersion,
        folderWritable: access.w && access.x,
        truncated: listing.truncated,
        rows: this.decorate(),
      });
    } catch (e) {
      if (seq !== this.navSeq) return;
      this.entries = [];
      const failure = folderFailure(e);
      // UI-084: a fresh user has no ~/.Trash until the first Move to Trash makes it, so a
      // missing Trash is an empty Trash, not a "does not exist" error.
      const emptyTrash = failure.errno === 'ENOENT' && path === trashOf(who);
      this.set({
        loading: false,
        error: emptyTrash ? undefined : failure,
        rows: [],
        dirIno: undefined,
        folderWritable: false,
      });
    }
  }

  /**
   * Rows with the clipboard's cut marks and the known lock holders, reusing unchanged rows. When
   * nothing changed it is the previous array itself, so a refresh that finds the same folder
   * does not re-render the list or disturb the selection.
   */
  private decorate(): EntryView[] {
    const prev = this.s.rows;
    const cut = this.s.clipboard?.mode === 'cut' ? new Set(this.s.clipboard.paths) : undefined;
    const rows = this.entries.map((e) => {
      const lock = this.s.locks[e.path];
      const conflict = isConflictedCopy(e.name);
      if (cut?.has(e.path) !== true && lock === undefined && !conflict) return e;
      return {
        ...e,
        ...(cut?.has(e.path) === true ? { cut: true } : {}),
        ...(lock === undefined ? {} : { lock }),
        ...(conflict ? { sync: 'conflict' as const } : {}),
      };
    });
    const next = reuseRows(prev, rows);
    return sameRows(prev, next) ? prev : next;
  }

  /** Re-lists the current folder in place (no loading state, selection kept by the view). */
  async refresh(): Promise<void> {
    const who = this.s.who;
    if (who === undefined || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.load(this.navSeq, this.s.path, who);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * The event-less fallback: re-list when the folder's version moved. A folder's version moves
   * only when entries come and go, not when a file's content (size, date) changes, so a folder
   * of up to POLL_RELIST_MAX rows is re-listed on every poll as well (UI-105); unchanged rows
   * keep their objects, so nothing re-renders.
   */
  async poll(): Promise<void> {
    if (!this.s.ready || this.s.loading || this.s.error !== undefined) return;
    const version = await this.run(dirVersionOf(STUBS, this.s.path)).catch(() => undefined);
    if (version === undefined) return;
    if (version !== this.s.dirVersion || this.entries.length <= POLL_RELIST_MAX)
      await this.refresh();
  }

  /** Kernel events for this window: re-list when one touches the folder or a shown item. */
  onEvents(batch: readonly KEvent[]): void {
    const ids = new Set(this.entries.map((e) => e.id));
    if (batch.some((ev) => touchesFolder(ev, this.s.dirIno, ids))) void this.refresh();
    for (const ev of batch) {
      if (ev.topic !== 'lock.granted' && ev.topic !== 'lock.released' && ev.topic !== 'lock.lost')
        continue;
      const entry = this.entries.find((e) => e.id === ev.data.ino);
      if (entry !== undefined) void this.inspect(entry);
    }
    if (batch.some((ev) => ev.topic === 'ai.model' && ev.data.state === 'ready')) this.modelReady();
  }

  back(): Promise<void> {
    const step = stepBack(this.s.history, this.s.path);
    if (step === undefined) return Promise.resolve();
    this.set({ history: step.history });
    return this.navigate(step.path, { push: false });
  }

  forward(): Promise<void> {
    const step = stepForward(this.s.history, this.s.path);
    if (step === undefined) return Promise.resolve();
    this.set({ history: step.history });
    return this.navigate(step.path, { push: false });
  }

  up(): Promise<void> {
    return this.s.path === '/' ? Promise.resolve() : this.navigate(dirname(this.s.path));
  }

  /** A sidebar or Go-menu place; a place whose folder does not exist says so (UI-110). */
  goPlace(id: string): Promise<void> {
    const place = [...this.s.favourites, ...this.s.locations].find((p) => p.id === id);
    if (place !== undefined) return this.navigate(place.path);
    const name = OPTIONAL_PLACES[id];
    if (name !== undefined) this.say('info', `There is no ${name} folder`, 'ENOENT');
    return Promise.resolve();
  }

  setView(view: ViewMode): void {
    this.set({ view });
  }

  setSort(sort: Sort): void {
    this.set({ sort });
  }

  toggleInspector(on?: boolean): void {
    this.set({ inspector: on ?? !this.s.inspector });
  }

  async toggleHidden(): Promise<void> {
    this.set({ hidden: !this.s.hidden });
    await this.refresh();
  }

  // -------------------------------------------------------------------------------------------
  // Open
  // -------------------------------------------------------------------------------------------

  /** Folders (and links to folders) open here; files open in the Editor. */
  async open(entry: EntryView): Promise<void> {
    if (entry.readable === false) {
      this.say(
        'error',
        entry.type === 'dir'
          ? 'You do not have permission to open this folder'
          : 'You do not have permission to open this file',
        'EACCES',
      );
      return;
    }
    let isDir = entry.type === 'dir';
    if (entry.type === 'symlink') {
      try {
        const st = await this.deps.sys.call('stat', { path: entry.path });
        isDir = st.type === 'd';
      } catch (e) {
        const f = failureOf(e);
        this.say('error', `The link “${entry.name}” points nowhere: ${f.message}`, f.errno);
        return;
      }
    }
    if (isDir) await this.navigate(entry.path);
    else this.openInEditor(entry.path);
  }

  /**
   * Opens a file in the Editor. A file that an Editor window already shows is selected there
   * instead of opening a second window, which could only read it (UI-104); when that window
   * could not take the focus, a toast says where the file is.
   */
  private openInEditor(path: string, line?: number): void {
    const shown = this.deps.reveal?.(path, line);
    if (shown === undefined) {
      this.deps.launch('editor', line === undefined ? [path] : [path, `+${String(line)}`]);
      return;
    }
    void shown.then(
      (focused) => {
        if (!focused) this.say('info', `“${basename(path)}” is already open in an Editor window`);
      },
      () => undefined,
    );
  }

  openWith(target: 'editor' | 'terminal' | 'choose', entries: readonly EntryView[]): void {
    const first = entries[0];
    if (first === undefined) return;
    if (target === 'editor') for (const e of entries) this.openInEditor(e.path);
    else if (target === 'terminal')
      this.deps.launch('terminal', [first.type === 'dir' ? first.path : dirname(first.path)]);
    else this.say('info', 'Only the Editor and the Terminal can open files in this build.');
  }

  // -------------------------------------------------------------------------------------------
  // Create, rename, clipboard, trash, delete, chmod, upload
  // -------------------------------------------------------------------------------------------

  /** Creates a folder in the current folder; returns its path, or undefined on failure. */
  async newFolder(name: string): Promise<string | undefined> {
    try {
      const path = await this.run(makeFolder(STUBS, this.s.path, name));
      await this.refresh();
      this.say('success', `Created folder “${name}”`);
      return path;
    } catch (e) {
      const f = failureOf(e);
      this.say('error', `Could not create “${name}”: ${f.message}`, f.errno);
      return undefined;
    }
  }

  /** Creates an empty file in the current folder; returns its path, or undefined on failure. */
  async newFile(name: string): Promise<string | undefined> {
    try {
      const path = await this.run(makeFile(STUBS, this.s.path, name));
      await this.refresh();
      this.say('success', `Created “${name}”`);
      return path;
    } catch (e) {
      const f = failureOf(e);
      this.say('error', `Could not create “${name}”: ${f.message}`, f.errno);
      return undefined;
    }
  }

  async rename(entry: EntryView, name: string): Promise<boolean> {
    if (name === entry.name) return true;
    try {
      await this.run(renameEntry(STUBS, entry.path, name));
      await this.refresh();
      this.say('success', `Renamed to “${name}”`);
      return true;
    } catch (e) {
      const f = failureOf(e);
      this.say('error', `Could not rename “${entry.name}”: ${f.message}`, f.errno);
      return false;
    }
  }

  copy(entries: readonly EntryView[]): void {
    if (entries.length === 0) return;
    this.set({ clipboard: { mode: 'copy', paths: entries.map((e) => e.path) } });
    this.set({ rows: this.decorate() });
    this.say('info', `Copied ${plural(entries.length, 'item')} — paste with Ctrl+V`);
  }

  cut(entries: readonly EntryView[]): void {
    if (entries.length === 0) return;
    this.set({ clipboard: { mode: 'cut', paths: entries.map((e) => e.path) } });
    this.set({ rows: this.decorate() });
    this.say('info', `Cut ${plural(entries.length, 'item')} — paste with Ctrl+V to move`);
  }

  /** Pastes the clipboard into `dest` (default: the current folder). Cut items move. */
  async paste(dest?: string): Promise<void> {
    const clip = this.s.clipboard;
    if (clip === undefined) return;
    const target = dest ?? this.s.path;
    this.say(
      'info',
      `${clip.mode === 'cut' ? 'Moving' : 'Copying'} ${plural(clip.paths.length, 'item')}…`,
    );
    const results =
      clip.mode === 'cut'
        ? await this.run(moveInto(STUBS, clip.paths, target))
        : await this.run(copyInto(STUBS, clip.paths, target));
    if (clip.mode === 'cut') this.set({ clipboard: undefined });
    await this.refresh();
    this.report(results, (n) => `${clip.mode === 'cut' ? 'Moved' : 'Copied'} ${plural(n, 'item')}`);
    void this.refreshQuota();
  }

  /** Moves or copies dragged paths into a folder (drag and drop). */
  async drop(paths: readonly string[], dest: string, copy: boolean): Promise<void> {
    const moving = paths.filter((p) => p !== dest && !isInside(dest, p));
    if (moving.length === 0) return;
    const results = copy
      ? await this.run(copyInto(STUBS, moving, dest))
      : await this.run(moveInto(STUBS, moving, dest));
    await this.refresh();
    this.report(
      results,
      (n) => `${copy ? 'Copied' : 'Moved'} ${plural(n, 'item')} to “${basename(dest)}”`,
    );
  }

  /**
   * Moves to `~/.Trash` (no confirmation: it can be moved back). The toast offers Undo, and
   * Put Back in the Trash works later too.
   */
  async trash(entries: readonly EntryView[]): Promise<void> {
    const who = this.s.who;
    if (who === undefined || entries.length === 0) return;
    const results = await this.run(
      trashEntries(
        STUBS,
        entries.map((e) => e.path),
        who,
        this.deps.now(),
      ),
    );
    await this.refresh();
    const moved = results.flatMap((r) =>
      r.error === undefined && r.to !== undefined ? [[r.to, r.path] as const] : [],
    );
    this.lastTrash = moved.length > 0 ? new Map(moved) : undefined;
    const failed = results.some((r) => r.error !== undefined);
    if (!failed && moved.length > 0) {
      this.say('success', `Moved ${plural(moved.length, 'item')} to the Trash`, undefined, {
        id: 'undo-trash',
        label: 'Undo',
      });
      return;
    }
    this.report(results, (n) => `Moved ${plural(n, 'item')} to the Trash`);
  }

  /** Undo of the last Move to Trash: the items go back where they were. */
  async undoTrash(): Promise<void> {
    const who = this.s.who;
    const last = this.lastTrash;
    this.lastTrash = undefined;
    if (who === undefined || last === undefined) return;
    this.dismissToast();
    const results = await this.run(putBackEntries(STUBS, [...last.keys()], who, last));
    await this.refresh();
    this.report(results, (n) => `Put back ${plural(n, 'item')}`);
  }

  /** Put Back: Trash items return to the folder they were trashed from. */
  async putBack(entries: readonly EntryView[]): Promise<void> {
    const who = this.s.who;
    if (who === undefined || entries.length === 0) return;
    const results = await this.run(
      putBackEntries(
        STUBS,
        entries.map((e) => e.path),
        who,
      ),
    );
    await this.refresh();
    this.report(results, (n) => `Put back ${plural(n, 'item')}`);
  }

  /** Deletes for good (the view has asked for confirmation). */
  async deleteForever(entries: readonly EntryView[]): Promise<void> {
    if (entries.length === 0) return;
    const paths = entries.map((e) => e.path);
    const results = await this.run(deleteEntries(STUBS, paths));
    const who = this.s.who;
    const gone = results.filter((r) => r.error === undefined).map((r) => r.path);
    if (who !== undefined && gone.length > 0) await this.run(forgetTrashInfo(STUBS, who, gone));
    await this.refresh();
    this.report(results, (n) => `Deleted ${plural(n, 'item')}`);
    void this.refreshQuota();
  }

  /** Empty Trash: every item, and then the Put Back records with them. */
  async emptyTrash(entries: readonly EntryView[]): Promise<void> {
    const who = this.s.who;
    if (who === undefined) return;
    const results = await this.run(
      deleteEntries(
        STUBS,
        entries.map((e) => e.path),
      ),
    );
    if (results.every((r) => r.error === undefined))
      await this.run(forgetTrashInfo(STUBS, who, [], true));
    await this.refresh();
    this.report(results, (n) => `Deleted ${plural(n, 'item')}`);
    void this.refreshQuota();
  }

  async chmod(entries: readonly EntryView[], mode: number): Promise<void> {
    const results = await this.run(
      chmodEntries(
        STUBS,
        entries.map((e) => e.path),
        mode,
      ),
    );
    await this.refresh();
    this.report(results, (n) => `Changed permissions of ${plural(n, 'item')}`);
  }

  /** Writes dropped host files into `dest` under free names. */
  async upload(
    files: readonly { name: string; data: ArrayBuffer }[],
    dest?: string,
  ): Promise<void> {
    const target = dest ?? this.s.path;
    const results: ItemResult[] = [];
    for (const f of files) {
      try {
        const to = await this.run(uploadFile(STUBS, target, f.name, f.data));
        results.push({ path: f.name, to });
      } catch (error) {
        results.push({ path: f.name, error });
      }
    }
    await this.refresh();
    this.report(results, (n) => `Added ${plural(n, 'file')}`);
    void this.refreshQuota();
  }

  // -------------------------------------------------------------------------------------------
  // Locks (VFS-09)
  // -------------------------------------------------------------------------------------------

  /** Reads the lease holders of one file for the inspector and the menu. */
  async inspect(entry: EntryView): Promise<void> {
    if (entry.type !== 'file') return;
    const holders = await this.run(lockHolders(STUBS, entry.path));
    const mine = this.s.leases[entry.path];
    const now = this.deps.now();
    const x = holders.find((h) => h.mode === 'X');
    const locks = { ...this.s.locks };
    if (mine !== undefined && mine.expiresAt > now) {
      locks[entry.path] = { holder: this.s.who?.user ?? 'you', since: now, mine: true };
    } else if (x !== undefined) {
      const self =
        this.s.who !== undefined &&
        x.holder.split('@')[0] === this.s.who.user &&
        mine !== undefined;
      locks[entry.path] = {
        holder: x.holder,
        since: x.expiresAt - 30_000,
        ...(self ? { mine: true } : {}),
        ...(x.expiresAt < now ? { stale: true } : {}),
      };
    } else {
      delete locks[entry.path];
    }
    this.set({ locks });
    this.set({ rows: this.decorate() });
  }

  async lock(entry: EntryView): Promise<void> {
    try {
      const lease = await this.run(acquireLock(STUBS, entry.path));
      this.set({ leases: { ...this.s.leases, [entry.path]: lease } });
      await this.inspect(entry);
      this.say('success', `Locked “${entry.name}” for editing — others can only read it`);
    } catch (e) {
      const f = failureOf(e);
      const text = isErrno(e, 'EBUSY')
        ? `“${entry.name}” is locked by someone else`
        : `Could not lock “${entry.name}”: ${f.message}`;
      this.say('error', text, f.errno);
      await this.inspect(entry);
    }
  }

  async unlock(entry: EntryView): Promise<void> {
    const lease = this.s.leases[entry.path];
    if (lease === undefined) {
      this.say('error', `This window does not hold the lock on “${entry.name}”`, 'EPERM');
      return;
    }
    try {
      await this.run(releaseLock(STUBS, lease.leaseId));
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) {
        const f = failureOf(e);
        this.say('error', `Could not unlock “${entry.name}”: ${f.message}`, f.errno);
        return;
      }
    }
    const leases = { ...this.s.leases };
    delete leases[entry.path];
    this.set({ leases });
    await this.inspect(entry);
    this.say('success', `Unlocked “${entry.name}”`);
  }

  // -------------------------------------------------------------------------------------------
  // Search (RAG-06)
  // -------------------------------------------------------------------------------------------

  setQuery(query: string): void {
    this.set(query === '' ? { query, search: undefined, selectedHit: undefined } : { query });
  }

  setSearchMode(mode: SearchMode): void {
    this.set({ searchMode: mode });
    if (this.s.search !== undefined) void this.search(this.s.search.query, this.s.search.scope);
  }

  /** The Files search box gained or lost focus: warm the model (rag-semantic-search.md §3.5). */
  searchFocus(on: boolean): void {
    if (!this.s.semanticAvailable) return;
    this.deps.sys.call('ai.search.focus', { on }).catch(() => undefined);
  }

  /**
   * `ai.semsearch` over the folder (or `scope`). The folder is walked for keyword matches
   * (ops.keywordSearch) instead when the AI subsystem is absent or fails, and also when the
   * index answers nothing because it cannot yet: its model is not ready or it holds no files
   * (UI-048). A semantic search that falls back says so with the RAG-06 notice ("semantic model
   * loading — showing keyword matches" or "Semantic search unavailable — showing keyword
   * matches"); a keyword search the user chose falls back silently.
   */
  async search(query = this.s.query, scope = this.s.path): Promise<void> {
    const who = this.s.who;
    const q = query.trim();
    if (who === undefined || q === '') return;
    const seq = ++this.searchSeq;
    const mode = this.s.searchMode;
    // The fallback notice is for a semantic search that could not run, not for a keyword search
    // the user chose (or the AI-off build, which never offers semantic search).
    const wantedSemantic = this.s.semanticAvailable && mode === 'semantic';
    const started = this.deps.now();
    this.set({
      search: { query: q, scope, mode, loading: true, hits: [], notices: [], indexedFiles: 0 },
      selectedHit: undefined,
    });
    let view: SearchView;
    let fallback: NoticeView[] = wantedSemantic ? [{ kind: 'unavailable' }] : [];
    if (this.s.semanticAvailable) {
      try {
        const r = await this.run(
          semanticSearch(STUBS, q, scope, mode === 'semantic' ? 'auto' : 'keyword'),
        );
        if (seq !== this.searchSeq) return;
        const status = await this.deps.sys.call('ai.index.status', {}).catch(() => undefined);
        if (seq !== this.searchSeq) return;
        view = this.fromSemsearch(r, q, scope, who, started, status?.indexedFiles ?? 0, status);
        const indexEmpty = status === undefined || status.indexedFiles === 0;
        // A semantic answer of "nothing" from a ready, non-empty index stands. Keyword mode
        // always has a word match to fall back on: the index's keyword pass sees only indexed
        // chunks, the folder walk also sees names and files not indexed yet.
        if (
          view.hits.length > 0 ||
          (mode === 'semantic' && r.model.state === 'ready' && !indexEmpty)
        ) {
          this.showResults(view);
          return;
        }
        // Nothing, from an index that cannot answer yet: walk the folder instead, keeping the
        // index's own notices (a loading model, shared results hidden while offline).
        const loading = view.notices.filter((n) => n.kind === 'model-loading');
        const others = view.notices.filter(
          (n) => n.kind !== 'model-loading' && n.kind !== 'unavailable',
        );
        fallback = wantedSemantic
          ? [...(loading.length > 0 ? loading : [{ kind: 'unavailable' as const }]), ...others]
          : others;
      } catch (e) {
        if (seq !== this.searchSeq) return;
        if (isErrno(e, 'ENOSYS')) this.set({ semanticAvailable: false, searchMode: 'keyword' });
      }
    }
    try {
      const r = await this.run(keywordSearch(STUBS, q, scope));
      if (seq !== this.searchSeq) return;
      view = {
        query: q,
        scope,
        mode: 'keyword',
        loading: false,
        hits: r.hits.map((h) => this.keywordHit(h, q, who)),
        elapsedMs: this.deps.now() - started,
        notices: [...fallback, ...(r.truncated ? [{ kind: 'truncated' as const }] : [])],
        indexedFiles: r.scanned,
      };
    } catch (e) {
      if (seq !== this.searchSeq) return;
      view = {
        query: q,
        scope,
        mode: 'keyword',
        loading: false,
        hits: [],
        notices: [],
        error: failureOf(e),
        indexedFiles: 0,
      };
    }
    this.showResults(view);
  }

  /** Shows results with the first card selected and its row loaded for the inspector. */
  private showResults(view: SearchView): void {
    const first = view.hits[0]?.id;
    this.set({ search: view, selectedHit: first });
    if (first !== undefined) void this.selectHit(first);
  }

  /** Searches the whole home folder instead of the current one. */
  searchAll(): Promise<void> {
    return this.search(this.s.search?.query ?? this.s.query, this.s.who?.home ?? '/');
  }

  clearSearch(): void {
    this.searchSeq += 1;
    this.set({ search: undefined, query: '', selectedHit: undefined });
  }

  private hitBase(path: string, who: Who): { path: string; name: string } {
    return { path: tildePath(path, who.home), name: basename(path) };
  }

  private keywordHit(h: KeywordHit, q: string, who: Who): HitView {
    const terms = queryTerms(q);
    return {
      id: `${h.ino}:${String(h.lineStart)}`,
      ...this.hitBase(h.path, who),
      absPath: h.path,
      lineStart: h.lineStart,
      lineEnd: h.lineEnd,
      score: Math.max(0, Math.min(1, h.score)),
      snippet: h.snippet,
      highlights: highlightRanges(h.snippet, terms),
      owner: ownerName(h.uid, this.names),
      verified: 'own',
    };
  }

  private fromSemsearch(
    r: SemsearchResult,
    q: string,
    scope: string,
    who: Who,
    started: number,
    indexedFiles: number,
    status: { loadedBytes?: number; totalBytes?: number } | undefined,
  ): SearchView {
    const terms = queryTerms(q);
    const notices: NoticeView[] = [];
    if (r.model.state === 'loading') {
      const total = status?.totalBytes ?? 0;
      notices.push({
        kind: 'model-loading',
        progress: total > 0 ? (status?.loadedBytes ?? 0) / total : 0,
      });
    } else if (r.model.state === 'unavailable') {
      notices.push({ kind: 'unavailable' });
    }
    for (const text of r.notices) {
      const hidden = /(\d+) shared results? hidden/u.exec(text);
      if (hidden !== null) notices.push({ kind: 'shared-hidden', count: Number(hidden[1]) });
      else if (/shortened|truncated/u.test(text)) notices.push({ kind: 'truncated' });
    }
    return {
      query: q,
      scope,
      mode: r.mode === 'keyword' ? 'keyword' : 'semantic',
      loading: false,
      hits: r.results.map((h) => ({
        id: `${h.ino}:${String(h.lineStart)}`,
        ...this.hitBase(h.path, who),
        absPath: h.path,
        lineStart: h.lineStart,
        lineEnd: h.lineEnd,
        score: Math.max(0, Math.min(1, h.score)),
        snippet: h.snippet,
        highlights: highlightRanges(h.snippet, terms),
        owner: h.verified === 'own' ? who.user : 'shared',
        verified: h.verified,
      })),
      elapsedMs: r.timings.totalMs > 0 ? r.timings.totalMs : this.deps.now() - started,
      notices,
      indexedFiles,
    };
  }

  private modelReady(): void {
    const search = this.s.search;
    if (search === undefined || !search.notices.some((n) => n.kind === 'model-loading')) return;
    this.set({
      search: {
        ...search,
        notices: [
          { kind: 'model-ready' },
          ...search.notices.filter((n) => n.kind !== 'model-loading'),
        ],
      },
    });
  }

  /** Selects a result card and loads its row for the inspector. */
  async selectHit(id: string): Promise<void> {
    this.set({ selectedHit: id });
    const hit = this.s.search?.hits.find((h) => h.id === id);
    const who = this.s.who;
    if (hit === undefined || who === undefined || this.s.hitEntries[id] !== undefined) return;
    try {
      const st = await this.deps.sys.call('lstat', { path: hit.absPath });
      const entry = toEntry(
        dirname(hit.absPath),
        basename(hit.absPath),
        st,
        who,
        this.names,
        this.groups,
      );
      this.set({ hitEntries: { ...this.s.hitEntries, [id]: entry } });
    } catch {
      // The file went away; the card stays and opening reports the errno.
    }
  }

  /** Opens a citation in the Editor at its first line (`editor <path> +<line>`). */
  openHit(hit: { id: string }): void {
    const found = this.s.search?.hits.find((h) => h.id === hit.id);
    if (found === undefined) return;
    this.openInEditor(found.absPath, found.lineStart);
  }
}
