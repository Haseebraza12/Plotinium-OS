/**
 * The Files window (ui-design-system.md §3.8.11; VFS-07, VFS-09, RAG-06): FilesView from
 * @plotinium/ui driven by FilesController. The controller runs the file operations of
 * lib/ops.ts through the window's system-call client (the host relays executor-only calls through
 * the app's process, so every change is a system call made as the app's pid).
 *
 * The view adds what FilesView leaves to its host: the sheets (New Folder, Rename, Change
 * Permissions, delete confirmation), the background context menu (New Folder, New File, Paste),
 * clipboard shortcuts, drag and drop (rows onto folders; files from the host OS), the in-window
 * toast, event subscription with a polling fallback, and the menu-bar commands.
 *
 * Reactivity: the controller replaces one state object on every change, so every effect here
 * keys on a memo of the one field it is about (Solid's `on()` re-runs whenever its source
 * notifies, even with an equal value). Keying on `state()` itself cleared the selection
 * ~150 ms after each click and kept toasts on screen (UI-014, UI-099).
 */
import { Menu, type MenuEntry } from '@plotinium/ui';
import type {
  FileEntry,
  FilesIntent,
  FilesResults,
  InspectorAction,
  Selection,
  ViewMode,
} from '@plotinium/ui/apps/files';
import { EMPTY_SELECTION, FilesView, sortEntries } from '@plotinium/ui/apps/files';
import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import { render } from 'solid-js/web';

import type { AppViewContext } from '../src/descriptor.ts';
import { ChmodSheet, ConfirmSheet, NameSheet } from './dialogs.tsx';
import type { FilesState } from './lib/controller.ts';
import { FilesController } from './lib/controller.ts';
import { inAppLayer, isTypingTarget } from './lib/keyboard.ts';
import type { EntryView } from './lib/model.ts';
import { editorWindowWith } from './lib/open-docs.ts';
import { basename, dirname, join } from './lib/path.ts';
import { toastLifetimeMs, ToastView } from './toast.tsx';
import styles from './view.module.css';

/** Largest host file a drop writes (writeFile carries it in one call). */
const DROP_MAX_BYTES = 16 * 1_048_576;
const POLL_MS = 4_000;
const DRAG_THRESHOLD_PX = 6;

/** What the inspector offers here: no version history viewer and no sharing in this build. */
const INSPECTOR_ACTIONS: readonly InspectorAction[] = [
  'open',
  'open-in-editor',
  'chmod',
  'unlock',
  'copy-value',
];

type Dialog =
  | { kind: 'new-folder' }
  | { kind: 'new-file' }
  | { kind: 'rename'; entry: EntryView }
  | { kind: 'chmod'; entries: EntryView[] }
  | { kind: 'delete'; entries: EntryView[] }
  | { kind: 'empty-trash'; entries: EntryView[] };

interface DragState {
  paths: string[];
  label: string;
  x: number;
  y: number;
  over: string | undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** The same items in the same order (for memos over freshly built arrays). */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The Files window's root component, closed over the window's (non-reactive) context. */
function filesApp(ctx: AppViewContext): () => JSX.Element {
  return function FilesApp(): JSX.Element {
    const ctrl = new FilesController({
      sys: ctx.sys,
      now: () => Date.now(),
      launch: (app, argv) => ctx.launch(app, { argv }),
      aiAvailable: ctx.env.aiAvailable,
      reveal: (file, line) => editorWindowWith(file)?.reveal(file, line),
      ...(ctx.env.user === undefined
        ? {}
        : { user: { name: ctx.env.user.name, uid: ctx.env.user.uid } }),
    });
    const [state, setState] = createSignal<FilesState>(ctrl.state);
    const [selection, setSelection] = createSignal<Selection>(EMPTY_SELECTION);
    const [dialog, setDialog] = createSignal<Dialog>();
    const [menuAt, setMenuAt] = createSignal<{ x: number; y: number }>();
    const [now, setNow] = createSignal(Date.now());
    const [drag, setDrag] = createSignal<DragState>();
    const [hostDrop, setHostDrop] = createSignal(false);
    const [hostOver, setHostOver] = createSignal<string>();
    const mac = typeof navigator !== 'undefined' && /Mac/u.test(navigator.userAgent);
    let root: HTMLDivElement | undefined;
    let pendingSelect: string | undefined;

    onCleanup(ctrl.subscribe(setState));
    onCleanup(() => ctrl.dispose());

    // ---- derived state (each a memo of the one field it is about) ----------------------------

    const who = createMemo(() => state().who);
    const path = createMemo(() => state().path);
    const title = createMemo(() => state().title);
    const allRows = createMemo(() => state().rows);
    const sort = createMemo(() => state().sort);
    const filter = createMemo(() => {
      const s = state();
      return s.search === undefined ? s.query.trim().toLowerCase() : '';
    });
    const toast = createMemo(() => state().toast, undefined, {
      equals: (a, b) => a?.id === b?.id,
    });
    const rows = createMemo(
      (): FileEntry[] => {
        const q = filter();
        const list =
          q === '' ? allRows() : allRows().filter((r) => r.name.toLowerCase().includes(q));
        return sortEntries(list, sort());
      },
      [],
      { equals: sameItems },
    );
    const byId = createMemo(() => new Map(allRows().map((r) => [r.id, r] as const)));
    const selected = createMemo(
      (): EntryView[] =>
        [...selection().selected]
          .map((id) => byId().get(id))
          .filter((e): e is EntryView => e !== undefined),
      [],
      { equals: sameItems },
    );
    /** The one file whose lock state the inspector shows. */
    const inspectTarget = createMemo(() => {
      const list = selected();
      const only = list.length === 1 ? list[0] : undefined;
      return only?.type === 'file' ? only.id : undefined;
    });

    const results = createMemo((): FilesResults | undefined => {
      const s = state().search;
      if (s === undefined) return undefined;
      return {
        mode: s.mode,
        hits: s.hits,
        ...(s.elapsedMs === undefined ? {} : { elapsedMs: s.elapsedMs }),
        notices: s.notices,
        loading: s.loading,
        ...(s.error === undefined
          ? {}
          : { error: { code: s.error.errno, message: s.error.message } }),
        status: { results: s.hits.length, indexedFiles: s.indexedFiles },
      };
    });

    /** The folder row under a drag (ours or the host's), for the drop-target highlight. */
    const dropTarget = createMemo((): string | undefined => {
      const over = drag()?.over ?? (hostDrop() ? hostOver() : undefined);
      return over === undefined ? undefined : allRows().find((r) => r.path === over)?.id;
    });

    // ---- lifecycle ---------------------------------------------------------------------------

    onMount(() => {
      const start = ctx.argv.find((a) => a.startsWith('/') || a.startsWith('~'));
      void ctrl
        .start(start?.startsWith('~') === true ? undefined : start)
        .catch((e: unknown) => ctx.reportCrash(e));
      const unsubscribe = ctx.subscribe(['vfs.*', 'lock.*', 'ai.model'], (batch) =>
        ctrl.onEvents(batch),
      );
      const poll = setInterval(() => {
        if (document.visibilityState === 'visible') void ctrl.poll();
      }, POLL_MS);
      const clock = setInterval(() => setNow(Date.now()), 30_000);
      const offMenu = ctx.onMenuCommand(onMenuCommand);
      // A click that ends a drag must not also select the row under the pointer.
      root?.addEventListener('click', onClickCapture, true);
      onCleanup(() => {
        root?.removeEventListener('click', onClickCapture, true);
        unsubscribe();
        offMenu();
        clearInterval(poll);
        clearInterval(clock);
      });
    });

    // The window title follows the folder.
    createEffect(on(title, (t) => ctx.window.setTitle(t === '' ? 'Files' : t)));

    // Another folder: nothing stays selected.
    createEffect(on(path, () => setSelection(EMPTY_SELECTION), { defer: true }));

    /**
     * Selects `target` once the listing has it (after New Folder, New File, Rename). It runs from
     * promise callbacks, so it reads the listing untracked: nothing here should subscribe.
     */
    const selectWhenListed = (target: string): void => {
      const row = untrack(rows).find((r) => r.path === target);
      if (row === undefined) {
        pendingSelect = target;
        return;
      }
      pendingSelect = undefined;
      setSelection({ selected: new Set([row.id]), anchor: row.id, focus: row.id });
      focusList();
    };
    createEffect(
      on(rows, (list) => {
        if (pendingSelect === undefined) return;
        const row = list.find((r) => r.path === pendingSelect);
        if (row === undefined) return;
        pendingSelect = undefined;
        setSelection({ selected: new Set([row.id]), anchor: row.id, focus: row.id });
        focusList();
      }),
    );

    // The inspector's lock state for a single selected file (VFS-09), once per selection.
    let inspectTimer: ReturnType<typeof setTimeout> | undefined;
    createEffect(
      on(inspectTarget, (id) => {
        clearTimeout(inspectTimer);
        if (id === undefined) return;
        inspectTimer = setTimeout(() => {
          const entry = byId().get(id);
          if (entry !== undefined) void ctrl.inspect(entry);
        }, 150);
      }),
    );
    onCleanup(() => clearTimeout(inspectTimer));

    // Toasts fade on their own, one timer per toast.
    createEffect(
      on(toast, (t) => {
        if (t === undefined) return;
        const timer = setTimeout(() => ctrl.dismissToast(t.id), toastLifetimeMs(t));
        onCleanup(() => clearTimeout(timer));
      }),
    );

    // ---- focus (UI-108) ------------------------------------------------------------------------

    /** The keyboard's place in the list: the row with the tab stop, else the list itself. */
    const listTarget = (): HTMLElement | null =>
      root?.querySelector<HTMLElement>(
        '[role="grid"] [role="row"][tabindex="0"], [role="listbox"] [role="option"][tabindex="0"]',
      ) ??
      root?.querySelector<HTMLElement>('[role="grid"] [role="rowgroup"][tabindex="-1"]') ??
      root?.querySelector<HTMLElement>('[role="listbox"][tabindex="-1"]') ??
      null;

    /** Moves focus into the list once the current update has settled. */
    const focusList = (): void => {
      queueMicrotask(() => listTarget()?.focus({ preventScroll: true }));
    };

    /**
     * After a sheet or the folder menu closes, focus goes back to where it was; when that place
     * is gone (a menu item, a trashed row) it lands in the list, never on the page.
     */
    const refocusSoon = (): void => {
      setTimeout(() => {
        const active = document.activeElement;
        // A closed menu stays mounted for its exit fade (100 ms) with focus still on its item;
        // that item is about to go, so it does not count as "where focus was" (UI-108).
        const leaving = active?.closest('[role="menu"]') != null;
        if (active !== null && active !== document.body && active.isConnected && !leaving) return;
        listTarget()?.focus({ preventScroll: true });
      }, 0);
    };
    createEffect(
      on(
        () => dialog() === undefined,
        (closed, wasClosed) => {
          if (closed && wasClosed === false) refocusSoon();
        },
      ),
    );

    // ---- intents -----------------------------------------------------------------------------

    const openEntries = (entries: readonly EntryView[]): void => {
      const dir = entries.find((e) => e.type !== 'file');
      if (entries.length === 1 || dir !== undefined) {
        const first = dir ?? entries[0];
        if (first !== undefined) void ctrl.open(first);
        return;
      }
      for (const e of entries) void ctrl.open(e);
    };

    const trashOrDelete = (entries: EntryView[]): void => {
      if (entries.length === 0) return;
      if (state().inTrash) setDialog({ kind: 'delete', entries });
      else void ctrl.trash(entries);
    };

    /** A menu-bar command that needs a selection says so instead of doing nothing (UI-110). */
    const needSelection = (sel: readonly EntryView[]): boolean => {
      if (sel.length > 0) return true;
      ctrl.notify('info', 'Select a file or folder first');
      return false;
    };
    const canWriteHere = (): boolean => {
      if (state().folderWritable) return true;
      ctrl.notify('error', 'You can’t change items in this folder', 'EACCES');
      return false;
    };

    const onAction = (intent: FilesIntent, targets: readonly FileEntry[]): void => {
      const entries = targets
        .map((t) => byId().get(t.id))
        .filter((e): e is EntryView => e !== undefined);
      const first = entries[0];
      switch (intent) {
        case 'open':
          openEntries(entries);
          break;
        case 'open-with':
          break;
        case 'open-with:editor':
          ctrl.openWith('editor', entries);
          break;
        case 'open-with:terminal':
          ctrl.openWith('terminal', entries);
          break;
        case 'open-with:choose':
          ctrl.openWith('choose', entries);
          break;
        case 'get-info':
          ctrl.toggleInspector(true);
          if (first !== undefined) void ctrl.inspect(first);
          break;
        case 'rename':
          if (first !== undefined) setDialog({ kind: 'rename', entry: first });
          break;
        case 'copy':
          ctrl.copy(entries);
          break;
        case 'chmod':
          if (entries.length > 0) setDialog({ kind: 'chmod', entries });
          break;
        case 'lock':
          if (first !== undefined) void ctrl.lock(first);
          break;
        case 'unlock':
          if (first !== undefined) void ctrl.unlock(first);
          break;
        case 'trash':
          trashOrDelete(entries);
          break;
        case 'put-back':
          void ctrl.putBack(entries);
          break;
        case 'delete':
          if (entries.length > 0) setDialog({ kind: 'delete', entries });
          break;
      }
    };

    const onMenuCommand = (id: string): void => {
      const sel = selected();
      switch (id) {
        case 'file.new-folder':
          if (canWriteHere()) setDialog({ kind: 'new-folder' });
          break;
        case 'file.new-file':
          if (canWriteHere()) setDialog({ kind: 'new-file' });
          break;
        case 'file.open':
          if (needSelection(sel)) openEntries(sel);
          break;
        case 'file.info': {
          ctrl.toggleInspector(true);
          const only = sel.length === 1 ? sel[0] : undefined;
          if (only !== undefined) void ctrl.inspect(only);
          break;
        }
        case 'file.trash':
          if (needSelection(sel)) trashOrDelete(sel);
          break;
        case 'file.delete':
          if (needSelection(sel)) setDialog({ kind: 'delete', entries: sel });
          break;
        case 'file.empty-trash':
          void emptyTrash();
          break;
        case 'edit.copy':
          if (needSelection(sel)) ctrl.copy(sel);
          break;
        case 'edit.cut':
          if (needSelection(sel)) ctrl.cut(sel);
          break;
        case 'edit.paste':
          if (state().clipboard === undefined)
            ctrl.notify('info', 'Nothing to paste: copy or cut items first');
          else void ctrl.paste();
          break;
        case 'edit.select-all':
          setSelection({ selected: new Set(rows().map((r) => r.id)) });
          focusList();
          break;
        case 'view.icons':
          ctrl.setView('icons');
          break;
        case 'view.list':
          ctrl.setView('list');
          break;
        case 'view.inspector':
          ctrl.toggleInspector();
          break;
        case 'view.hidden':
          void ctrl.toggleHidden();
          break;
        case 'view.refresh':
          void ctrl.refresh();
          break;
        case 'go.back':
          if (state().history.back.length === 0) ctrl.notify('info', 'There is no previous folder');
          else void ctrl.back();
          break;
        case 'go.forward':
          if (state().history.forward.length === 0) ctrl.notify('info', 'There is no next folder');
          else void ctrl.forward();
          break;
        case 'go.up':
          if (path() === '/') ctrl.notify('info', 'This is the top folder');
          else void ctrl.up();
          break;
        default:
          if (id.startsWith('go.')) void ctrl.goPlace(id.slice(3));
      }
    };

    const emptyTrash = async (): Promise<void> => {
      if (who() === undefined) return;
      await ctrl.goPlace('trash');
      const entries = state().rows;
      if (entries.length > 0) setDialog({ kind: 'empty-trash', entries: [...entries] });
      else ctrl.notify('info', 'The Trash is empty');
    };

    // ---- keyboard ----------------------------------------------------------------------------

    const onKeyDown = (event: KeyboardEvent): void => {
      // The desktop prevents the default of Alt+← and Alt+→ in its capture phase so the browser
      // never goes back a page (window-manager.md §3.9 rule 2). They are still this window's
      // Back and Forward (UI-015), so they are handled although their default is prevented.
      const historyKey =
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
      if ((event.defaultPrevented && !historyKey) || dialog() !== undefined) return;
      if (isTypingTarget(event.target, root)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      let handled = true;
      if (mod && event.shiftKey && key === 'n') onMenuCommand('file.new-folder');
      else if (mod && !event.shiftKey && key === 'x') onMenuCommand('edit.cut');
      else if (mod && !event.shiftKey && key === 'v') onMenuCommand('edit.paste');
      else if (event.shiftKey && key === 'Delete') {
        if (selected().length > 0) setDialog({ kind: 'delete', entries: selected() });
      } else if ((event.altKey || event.metaKey) && key === 'ArrowUp') void ctrl.up();
      else if (event.altKey && key === 'ArrowLeft') void ctrl.back();
      else if (event.altKey && key === 'ArrowRight') void ctrl.forward();
      else if (mod && event.shiftKey && (key === '.' || key === '>' || event.code === 'Period'))
        void ctrl.toggleHidden();
      else if (event.altKey && key === 'Enter') ctrl.toggleInspector();
      else if (key === 'Backspace' && !mod && !event.altKey) void ctrl.up();
      else handled = false;
      if (handled) event.preventDefault();
    };

    // ---- background menu -----------------------------------------------------------------------

    const backgroundItems = (): MenuEntry[] => {
      const s = state();
      const cantWrite = s.folderWritable ? undefined : 'You can’t change items in this folder';
      return [
        {
          id: 'file.new-folder',
          label: 'New Folder',
          shortcut: mac ? ['⇧', '⌘', 'N'] : ['Ctrl', 'Shift', 'N'],
          disabled: cantWrite !== undefined,
          ...(cantWrite === undefined ? {} : { description: cantWrite }),
        },
        {
          id: 'file.new-file',
          label: 'New File',
          disabled: cantWrite !== undefined,
          ...(cantWrite === undefined ? {} : { description: cantWrite }),
        },
        {
          id: 'edit.paste',
          label:
            s.clipboard === undefined
              ? 'Paste'
              : `Paste ${String(s.clipboard.paths.length)} ${s.clipboard.paths.length === 1 ? 'item' : 'items'}`,
          shortcut: mac ? ['⌘', 'V'] : ['Ctrl', 'V'],
          disabled: s.clipboard === undefined || cantWrite !== undefined,
          ...(s.clipboard === undefined ? { description: 'Nothing to paste' } : {}),
        },
        { kind: 'separator', id: 'bg-sep-1' },
        { id: 'view.hidden', label: s.hidden ? 'Hide Hidden Files' : 'Show Hidden Files' },
        { id: 'view.inspector', label: s.inspector ? 'Hide Inspector' : 'Show Inspector' },
        { id: 'view.refresh', label: 'Refresh' },
        { kind: 'separator', id: 'bg-sep-2' },
        { id: 'bg.terminal', label: 'Open in Terminal' },
        ...(s.inTrash
          ? [
              {
                id: 'file.empty-trash',
                label: 'Empty Trash…',
                danger: true,
                disabled: s.rows.length === 0,
              },
            ]
          : []),
      ];
    };

    const onContextMenu = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Rows, controls, the sidebar, the path bar and the inspector have their own menus (or
      // the browser's); so do this app's sheets and menus. The window frame around the app is
      // a non-modal dialog too, and does not count (UI-016).
      if (
        target.closest(
          '[data-id], input, textarea, button, a, [role="toolbar"], [role="search"], aside, nav',
        ) !== null ||
        inAppLayer(target, root)
      )
        return;
      event.preventDefault();
      setMenuAt({ x: event.clientX, y: event.clientY });
    };

    // ---- drag and drop -----------------------------------------------------------------------

    let press: { id: string; x: number; y: number; pointer: number } | undefined;
    let suppressClick = false;

    const dirAt = (x: number, y: number): EntryView | undefined => {
      const el = document.elementFromPoint(x, y);
      const id =
        el instanceof HTMLElement ? el.closest<HTMLElement>('[data-id]')?.dataset['id'] : undefined;
      const entry = id === undefined ? undefined : byId().get(id);
      return entry?.type === 'dir' ? entry : undefined;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !(event.target instanceof HTMLElement)) return;
      const id = event.target.closest<HTMLElement>('[data-id]')?.dataset['id'];
      if (id === undefined || !root?.contains(event.target)) return;
      press = { id, x: event.clientX, y: event.clientY, pointer: event.pointerId };
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (press === undefined || event.pointerId !== press.pointer) return;
      const d = drag();
      if (d === undefined) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX)
          return;
        const sel = selection().selected.has(press.id)
          ? selected()
          : [byId().get(press.id)].filter((e): e is EntryView => e !== undefined);
        if (sel.length === 0) return;
        // The drag owns the pointer: no text selection, and a release outside the window still
        // ends it here.
        window.getSelection()?.removeAllRanges();
        try {
          root?.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is already gone.
        }
        setDrag({
          paths: sel.map((e) => e.path),
          label: sel.length === 1 ? (sel[0]?.name ?? '') : `${String(sel.length)} items`,
          x: event.clientX,
          y: event.clientY,
          over: undefined,
        });
        return;
      }
      const over = dirAt(event.clientX, event.clientY);
      setDrag({
        ...d,
        x: event.clientX,
        y: event.clientY,
        over: over !== undefined && !d.paths.includes(over.path) ? over.path : undefined,
      });
    };

    const onPointerUp = (event: PointerEvent): void => {
      const d = drag();
      press = undefined;
      if (d === undefined) return;
      setDrag(undefined);
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      if (d.over !== undefined)
        void ctrl.drop(d.paths, d.over, event.altKey || (mac ? false : event.ctrlKey));
    };

    const onClickCapture = (event: MouseEvent): void => {
      if (suppressClick) {
        event.stopPropagation();
        event.preventDefault();
        suppressClick = false;
      }
    };

    const hasFiles = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes('Files') === true;

    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
      setHostDrop(true);
      setHostOver(dirAt(event.clientX, event.clientY)?.path);
    };

    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setHostDrop(false);
      setHostOver(undefined);
      const list = [...(event.dataTransfer?.files ?? [])];
      const dest = dirAt(event.clientX, event.clientY)?.path;
      const tooBig = list.filter((f) => f.size > DROP_MAX_BYTES);
      const ok = list.filter((f) => f.size <= DROP_MAX_BYTES);
      void Promise.all(ok.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })))
        .then((files) => (files.length > 0 ? ctrl.upload(files, dest) : undefined))
        .then(() => {
          if (tooBig.length > 0) {
            ctrl.notify(
              'error',
              `${String(tooBig.length)} ${tooBig.length === 1 ? 'file is' : 'files are'} larger than 16 MB and ${tooBig.length === 1 ? 'was' : 'were'} not added`,
              'EINVAL',
            );
          }
        });
    };

    // ---- render --------------------------------------------------------------------------------

    const dialogEntries = (): EntryView[] => {
      const d = dialog();
      return d !== undefined && 'entries' in d ? d.entries : [];
    };
    const deleteText = (entries: readonly EntryView[]): string => {
      const bytes = entries.reduce((sum, e) => sum + (e.type === 'dir' ? 0 : e.size), 0);
      const what =
        entries.length === 1 ? `“${entries[0]?.name ?? ''}”` : `${String(entries.length)} items`;
      return `Delete ${what} (${formatBytes(bytes)})? This cannot be undone.`;
    };
    const viewer = createMemo(() => {
      const w = who();
      return {
        user: w?.user ?? 'guest',
        ...(w === undefined ? {} : { uid: w.uid }),
        root: w?.uid === 0,
      };
    });

    return (
      <div
        ref={(el) => (root = el)}
        data-testid="files"
        class={drag() === undefined ? styles.root : `${styles.root} ${styles.dragging}`}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press = undefined;
          setDrag(undefined);
        }}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          const to = event.relatedTarget;
          if (!(to instanceof Node) || root?.contains(to) !== true) {
            setHostDrop(false);
            setHostOver(undefined);
          }
        }}
        onDrop={onDrop}
      >
        <FilesView
          title={title()}
          path={path()}
          onNavigate={(p) => void ctrl.navigate(p)}
          canBack={state().history.back.length > 0}
          canForward={state().history.forward.length > 0}
          onBack={() => void ctrl.back()}
          onForward={() => void ctrl.forward()}
          favourites={state().favourites}
          locations={state().locations}
          tags={[]}
          {...(state().selectedPlace === undefined ? {} : { selectedPlace: state().selectedPlace })}
          onPlace={(id) => void ctrl.goPlace(id)}
          {...(state().quota === undefined ? {} : { quota: state().quota })}
          entries={rows()}
          loading={state().loading && allRows().length === 0}
          {...(state().error === undefined
            ? {}
            : {
                error: {
                  code: state().error?.errno ?? 'EIO',
                  message: state().error?.message ?? '',
                },
              })}
          onRetry={() =>
            state().search === undefined
              ? void ctrl.refresh()
              : void ctrl.search(state().search?.query)
          }
          view={state().view}
          onView={(view: ViewMode) => ctrl.setView(view === 'icons' ? 'icons' : 'list')}
          sort={sort()}
          onSort={(next) => ctrl.setSort(next)}
          selection={selection()}
          onSelection={setSelection}
          viewer={viewer()}
          folderWritable={state().folderWritable}
          inTrash={state().inTrash}
          {...(dropTarget() === undefined ? {} : { dropTarget: dropTarget() })}
          now={now()}
          mac={mac}
          onAction={onAction}
          query={state().query}
          onQuery={(q) => ctrl.setQuery(q)}
          onSubmit={(q) => void ctrl.search(q)}
          searchMode={state().searchMode}
          onSearchMode={(mode) => ctrl.setSearchMode(mode)}
          onSearchFocus={(focused) => ctrl.searchFocus(focused)}
          semanticAvailable={state().semanticAvailable}
          {...(results() === undefined ? {} : { results: results() })}
          {...(state().selectedHit === undefined ? {} : { selectedHit: state().selectedHit })}
          onSelectHit={(id) => void ctrl.selectHit(id)}
          onOpenHit={(hit) => ctrl.openHit(hit)}
          onSearchAll={() => void ctrl.searchAll()}
          hitEntries={state().hitEntries}
          showInspector={state().inspector}
          inspectorActions={INSPECTOR_ACTIONS}
          onInspectorAction={(action, entry) => {
            const e =
              entry === undefined
                ? undefined
                : (byId().get(entry.id) ?? state().hitEntries[state().selectedHit ?? '']);
            if (e === undefined) return;
            switch (action) {
              case 'open':
                void ctrl.open(e);
                break;
              case 'open-in-editor':
                ctrl.openWith('editor', [e]);
                break;
              case 'chmod':
                setDialog({ kind: 'chmod', entries: [e] });
                break;
              case 'unlock':
                void ctrl.unlock(e);
                break;
              case 'copy-value':
                void navigator.clipboard.writeText(e.path).catch(() => undefined);
                break;
              case 'history':
              case 'share':
                // Not offered here (INSPECTOR_ACTIONS); never another action's message.
                break;
            }
          }}
          user={who()?.user ?? ''}
          titlebarInset
        />

        <Menu
          open={menuAt() !== undefined}
          {...(menuAt() === undefined ? {} : { at: menuAt() })}
          label={`Actions for ${title()}`}
          items={backgroundItems()}
          onSelect={(id) => {
            setMenuAt(undefined);
            if (id === 'bg.terminal') ctx.launch('terminal', { argv: [path()] });
            else onMenuCommand(id);
            refocusSoon();
          }}
          onClose={(reason) => {
            setMenuAt(undefined);
            if (reason !== 'outside') refocusSoon();
          }}
        />

        <NameSheet
          open={dialog()?.kind === 'new-folder' || dialog()?.kind === 'new-file'}
          title={dialog()?.kind === 'new-file' ? 'New File' : 'New Folder'}
          label="Name"
          initial={dialog()?.kind === 'new-file' ? 'untitled.txt' : 'untitled folder'}
          confirm="Create"
          selectStem={dialog()?.kind === 'new-file'}
          onCancel={() => setDialog(undefined)}
          onSubmit={(name) => {
            const kind = dialog()?.kind;
            setDialog(undefined);
            void (kind === 'new-file' ? ctrl.newFile(name) : ctrl.newFolder(name)).then(
              (created) => {
                if (created !== undefined) selectWhenListed(created);
              },
            );
          }}
        />

        <NameSheet
          open={dialog()?.kind === 'rename'}
          title="Rename"
          label="New name"
          initial={(() => {
            const d = dialog();
            return d?.kind === 'rename' ? d.entry.name : '';
          })()}
          confirm="Rename"
          selectStem
          onCancel={() => setDialog(undefined)}
          onSubmit={(name) => {
            const d = dialog();
            setDialog(undefined);
            if (d?.kind !== 'rename') return;
            void ctrl.rename(d.entry, name).then((ok) => {
              if (ok) selectWhenListed(join(dirname(d.entry.path), name));
            });
          }}
        />

        <ChmodSheet
          open={dialog()?.kind === 'chmod'}
          subject={
            dialogEntries().length === 1
              ? `“${dialogEntries()[0]?.name ?? ''}”`
              : `${String(dialogEntries().length)} items`
          }
          mode={dialogEntries()[0]?.mode ?? 0o644}
          folder={dialogEntries().some((e) => e.type === 'dir')}
          onCancel={() => setDialog(undefined)}
          onApply={(mode) => {
            const entries = dialogEntries();
            setDialog(undefined);
            void ctrl.chmod(entries, mode);
          }}
        />

        <ConfirmSheet
          open={dialog()?.kind === 'delete' || dialog()?.kind === 'empty-trash'}
          title={dialog()?.kind === 'empty-trash' ? 'Empty the Trash?' : 'Delete permanently?'}
          description={deleteText(dialogEntries())}
          confirm={dialog()?.kind === 'empty-trash' ? 'Empty Trash' : 'Delete'}
          onCancel={() => setDialog(undefined)}
          onConfirm={() => {
            const d = dialog();
            const entries = dialogEntries();
            setDialog(undefined);
            if (d?.kind === 'empty-trash') void ctrl.emptyTrash(entries);
            else void ctrl.deleteForever(entries);
          }}
        />

        <Show when={drag()}>
          {(d) => (
            <div
              aria-hidden="true"
              class={styles.dragChip}
              style={{ transform: `translate(${String(d().x + 12)}px, ${String(d().y + 8)}px)` }}
            >
              {d().over === undefined ? d().label : `${d().label} → ${basename(d().over ?? '')}`}
            </div>
          )}
        </Show>

        <Show when={hostDrop()}>
          <div aria-hidden="true" class={styles.hostDrop}>
            {hostOver() === undefined
              ? `Drop to copy into “${title()}”`
              : `Drop to copy into “${basename(hostOver() ?? '')}”`}
          </div>
        </Show>

        <ToastView
          toast={toast()}
          onDismiss={(id) => ctrl.dismissToast(id)}
          onAction={(actionId) => {
            if (actionId === 'undo-trash') void ctrl.undoTrash();
          }}
        />
      </div>
    );
  };
}

/** The view module's entry (apps/src/descriptor.ts `AppMount`). */
export function mount(ctx: AppViewContext): () => void {
  const FilesApp = filesApp(ctx);
  return render(
    () => (
      <ErrorBoundary
        fallback={(err: unknown) => {
          ctx.reportCrash(err);
          return null;
        }}
      >
        <FilesApp />
      </ErrorBoundary>
    ),
    ctx.container,
  );
}

export default mount;
