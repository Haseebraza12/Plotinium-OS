/**
 * The Editor window (ui-design-system.md §3.8.12; VFS-07, VFS-09, VFS-10): the editor parts of
 * @plotinium/ui driven by EditorController. The controller loads and saves through the file
 * system calls (reads with open/read/close; saves with `writeFile` and `expectedVersion`), so a
 * stale save becomes a conflicted copy and the amber ConflictBanner ("This file changed on the
 * server. Your version was saved as “…”." [Compare] [Open conflicted copy]); nothing typed is
 * lost. Another user's lease makes the buffer read-only and shows the LockChip (VFS-09).
 *
 * Composition (the parts EditorApp bundles, arranged so that each document gets its own
 * CodeMirror instance and undo history, and the lock chip and banners sit in the window):
 * DocumentTabs with the LockChip at their right, the outline and folder sidebar, the conflict
 * banner and the other banners (changed on disk, locked, quota, permission, save errors), the
 * CodeEditor, and the status bar. The sheets (Open, Save As, unsaved changes) and the toast are
 * this view's own.
 *
 * Polish wave (docs/design/bug-hunt/BUGS.md): static layout lives in view.module.css (UI-118);
 * window-level keys skip only text fields, menus and this window's own sheets, not the window
 * frame (UI-015); toasts fade by id (UI-099); unsaved documents set the window's close guard
 * (UI-037, contract C4); a file already open here is revealed instead of opened twice (UI-104);
 * the status bar says "local only" while sync is not linked (UI-117).
 */
import Lock from 'lucide-solid/icons/lock';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  ErrorBoundary,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { render } from 'solid-js/web';

import type { NetStatus } from '@plotinium/protocol';
import type {
  BannerAction,
  BannerTone,
  CodeEditorHandle,
  CursorPosition,
  DocumentTab,
  SaveState,
  SyncState,
} from '@plotinium/ui/apps/editor';
import {
  activeHeading,
  CodeEditor,
  ConflictBanner,
  DocumentTabs,
  EditorBanner,
  EditorSidebar,
  EditorStatusBar,
  languageBadge,
  languageLabel,
  languageOf,
  LockChip,
  markdownOutline,
} from '@plotinium/ui/apps/editor';

import { ConfirmSheet, NameSheet } from '../files/dialogs.tsx';
import { isTypingTarget } from '../files/lib/keyboard.ts';
import { registerEditorWindow } from '../files/lib/open-docs.ts';
import { dirname, tildePath } from '../files/lib/path.ts';
import { toastLifetimeMs, ToastView } from '../files/toast.tsx';
import type { AppViewContext } from '../src/descriptor.ts';
import { setCloseGuard } from './lib/close-guard.ts';
import type { DocState, EditorState } from './lib/controller.ts';
import { EditorController } from './lib/controller.ts';
import type { BannerView } from './lib/model.ts';
import { bannerTitle, closeGuardReason, parseEditorArgs, saveAsSuggestion } from './lib/model.ts';
import styles from './view.module.css';

/** How often the selected document is checked on disk when no event arrives. */
const POLL_MS = 3_000;
/** How long the "Locked by …" hint stays after a refused key. */
const HINT_MS = 2_000;
/** How often the sync link is checked for the status bar (UI-117). */
const NET_POLL_MS = 15_000;

type Dialog =
  | { kind: 'open' }
  | { kind: 'save-as'; id: string; closeAfter: boolean }
  | { kind: 'close'; id: string };

/** A banner of the selected document as EditorBanner draws it. */
interface BannerSpec {
  tone: BannerTone;
  label: string;
  title: string;
  actions: BannerAction[];
  dismissible: boolean;
}

function isDirty(d: DocState): boolean {
  return d.text !== d.saved;
}

/** EditorBanner props for a controller banner (exact titles from lib/model.ts bannerTitle). */
export function bannerSpec(b: BannerView): BannerSpec {
  const title = bannerTitle(b);
  switch (b.kind) {
    case 'changed':
      return {
        tone: 'warning',
        label: 'File changed',
        title,
        actions: [
          { id: 'reload', label: 'Reload', variant: 'primary' },
          { id: 'keep-mine', label: 'Keep mine' },
        ],
        dismissible: true,
      };
    case 'locked':
      return {
        tone: 'warning',
        label: 'File lock',
        title,
        actions: [{ id: 'try-again', label: 'Try again' }],
        dismissible: true,
      };
    case 'quota':
      return {
        tone: 'danger',
        label: 'Not saved',
        title,
        actions: [{ id: 'retry-save', label: 'Try again' }],
        dismissible: true,
      };
    case 'permission':
      return {
        tone: 'info',
        label: 'Read-only',
        title,
        actions: [{ id: 'save-as', label: 'Save As…' }],
        dismissible: true,
      };
    case 'error':
      return {
        tone: 'danger',
        label: 'Not saved',
        title,
        actions: [{ id: 'retry-save', label: 'Try again' }],
        dismissible: true,
      };
  }
}

/** `~/notes/a.md` → `/home/alice/notes/a.md`. */
function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}

/** The colour scheme applied to the page (the desktop sets `data-theme`; else the OS setting). */
function appliedScheme(el: Element): 'light' | 'dark' {
  const scoped = el.closest('[data-theme]')?.getAttribute('data-theme');
  if (scoped === 'light' || scoped === 'dark') return scoped;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * What the status bar says about sync (UI-117): "synced" only while the sync client is linked
 * and online. Without it (the `sync` service degraded, or no answer from `net.status`) a save is
 * only local, and the bar says so.
 */
export function syncStateOf(
  doc: Pick<DocState, 'conflict' | 'sync'> | undefined,
  net: NetStatus | null | undefined,
): SyncState {
  if (doc?.conflict?.kind === 'conflict') return { kind: 'conflict', count: 1 };
  if (net === undefined || net === null || net.degraded.includes('sync')) return { kind: 'local' };
  if (net.state !== 'online') return { kind: 'offline', queued: net.queuedOps };
  return doc?.sync === 'syncing' ? { kind: 'syncing' } : { kind: 'synced' };
}

/**
 * The status bar's save and sync parts. An untitled document is in no file yet: it is "not
 * saved" (never "saved v0") and has no sync state (never "synced"), UI-117.
 */
export function statusOf(
  doc: Pick<DocState, 'conflict' | 'sync' | 'save' | 'path'> | undefined,
  net: NetStatus | null | undefined,
): { save: SaveState; sync: SyncState } {
  if (doc === undefined) return { save: { kind: 'new' }, sync: { kind: 'none' } };
  if (doc.path === undefined)
    return { save: doc.save.kind === 'saved' ? { kind: 'new' } : doc.save, sync: { kind: 'none' } };
  return { save: doc.save, sync: syncStateOf(doc, net) };
}

/** The Editor window's root component, closed over the window's (non-reactive) context. */
function editorApp(ctx: AppViewContext): () => JSX.Element {
  return function EditorWindow(): JSX.Element {
    const ctrl = new EditorController({
      sys: ctx.sys,
      now: () => Date.now(),
      ...(ctx.env.user === undefined
        ? {}
        : { user: { name: ctx.env.user.name, uid: ctx.env.user.uid } }),
    });
    const uid = createUniqueId();
    const [state, setState] = createSignal<EditorState>(ctrl.state);
    const [dialog, setDialog] = createSignal<Dialog>();
    const [sidebar, setSidebar] = createSignal(true);
    const [position, setPosition] = createSignal<CursorPosition>({ line: 1, col: 1 });
    const [attempts, setAttempts] = createSignal(0);
    const [hint, setHint] = createSignal<{ left: number; top: number }>();
    const [scheme, setScheme] = createSignal<'light' | 'dark'>(appliedScheme(ctx.container));
    /** `net.status` (undefined until asked, null when the call failed). */
    const [net, setNet] = createSignal<NetStatus | null>();
    let handle: CodeEditorHandle | undefined;
    let root: HTMLDivElement | undefined;
    let codeArea: HTMLDivElement | undefined;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    /** The next editor to mount takes the focus ("+ New tab", UI-103). */
    let focusNextEditor = false;

    onCleanup(ctrl.subscribe(setState));
    onCleanup(() => {
      clearTimeout(hintTimer);
      void ctrl.dispose();
    });

    const home = (): string => state().who?.home ?? '/';
    const selectedId = createMemo(() => state().selected);
    const current = createMemo((): DocState | undefined =>
      state().docs.find((d) => d.id === selectedId()),
    );
    /** The CodeMirror instance is keyed by the document and mounted once it has loaded. */
    const editorKey = createMemo((): string | undefined => {
      const d = current();
      return d === undefined || d.loading ? undefined : d.id;
    });
    const language = createMemo(() => languageOf(current()?.name ?? ''));
    const locked = (): boolean => {
      const d = current();
      return d !== undefined && (d.lock?.kind === 'other' || !d.writable || d.error !== undefined);
    };
    const lockHolder = (): string | undefined => {
      const lock = current()?.lock;
      return lock?.kind === 'other' ? lock.holder : undefined;
    };
    const outline = createMemo(() =>
      language() === 'markdown' ? markdownOutline(current()?.text ?? '') : [],
    );
    const tabs = createMemo((): DocumentTab[] =>
      state().docs.map((d) => ({
        id: d.id,
        label: d.name,
        ...(d.path === undefined ? {} : { title: d.path }),
        badge: languageBadge(languageOf(d.name)),
        state: d.conflict?.kind === 'conflict' ? 'conflict' : isDirty(d) ? 'dirty' : 'clean',
      })),
    );
    const status = (): { save: SaveState; sync: SyncState } => statusOf(current(), net());
    const banner = createMemo((): BannerSpec | undefined => {
      const d = current();
      if (d === undefined) return undefined;
      if (d.error !== undefined) {
        return {
          tone: 'danger',
          label: 'Could not open',
          title: `Could not open ${d.name}: ${d.error.message} (${d.error.errno})`,
          actions: [
            { id: 'reload', label: 'Try again', variant: 'primary' },
            { id: 'close', label: 'Close' },
          ],
          dismissible: false,
        };
      }
      return d.banner === undefined ? undefined : bannerSpec(d.banner);
    });

    // ---- lifecycle ---------------------------------------------------------------------------

    const refreshNet = (): void => {
      ctx.sys.call('net.status', {}).then(setNet, () => setNet(null));
    };

    onMount(() => {
      void ctrl.start(parseEditorArgs(ctx.argv)).catch((e: unknown) => ctx.reportCrash(e));
      const unsubscribe = ctx.subscribe(['vfs.*', 'lock.*'], (batch) => ctrl.onEvents(batch));
      const poll = setInterval(() => {
        if (document.visibilityState === 'visible') void ctrl.poll();
      }, POLL_MS);
      refreshNet();
      const netPoll = setInterval(() => {
        if (document.visibilityState === 'visible') refreshNet();
      }, NET_POLL_MS);
      // Files asks here before opening a second Editor for a file this window shows (UI-104).
      const unregister = registerEditorWindow({
        wid: ctx.wid,
        has: (path) => ctrl.state.docs.some((d) => d.path === path),
        reveal: async (path, line) => {
          await ctrl.open(path, line);
          const r = await ctx.sys
            .call('window.focus', { wid: ctx.wid })
            .catch(() => ({ focused: false }));
          return r.focused;
        },
      });
      const offMenu = ctx.onMenuCommand(onMenuCommand);
      // Follow the desktop's theme (data-theme on an ancestor) and the OS setting.
      const observer = new MutationObserver(() => setScheme(appliedScheme(ctx.container)));
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      const media =
        typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');
      const onMedia = (): void => {
        setScheme(appliedScheme(ctx.container));
      };
      media?.addEventListener('change', onMedia);
      onCleanup(() => {
        unregister();
        unsubscribe();
        offMenu();
        clearInterval(poll);
        clearInterval(netPoll);
        observer.disconnect();
        media?.removeEventListener('change', onMedia);
      });
    });

    // The window title follows the document ("report.md — Edited").
    createEffect(() => {
      const d = current();
      if (d === undefined) return;
      ctx.window.setTitle(`${d.name}${isDirty(d) ? ' — Edited' : ''}`);
    });

    // A citation line for a document that is already open moves the caret there.
    createEffect(
      on(
        () => [current()?.id, current()?.line, editorKey()] as const,
        ([id, line, key]) => {
          if (id === undefined || line === undefined || key !== id || handle === undefined) return;
          handle.goTo(line);
          ctrl.lineShown(id);
        },
      ),
    );

    // Toasts fade on their own, one timer per toast. Keyed on the toast's id: the controller
    // replaces its state on every change, and a timer restarted by each change never fired
    // while the document was being edited (UI-099).
    const toast = createMemo(() => state().toast, undefined, {
      equals: (a, b) => a?.id === b?.id,
    });
    createEffect(
      on(toast, (t) => {
        if (t === undefined) return;
        const timer = setTimeout(() => ctrl.dismissToast(t.id), toastLifetimeMs(t));
        onCleanup(() => clearTimeout(timer));
      }),
    );

    // Unsaved documents keep the window from closing without a question (UI-037, contract C4).
    // An ENOSYS answer (a kernel without the call) is no guard, and no error is shown.
    const guard = createMemo(() =>
      closeGuardReason(state().docs.map((d) => ({ name: d.name, dirty: isDirty(d) }))),
    );
    createEffect(
      on(guard, (reason) => void setCloseGuard(ctx.sys, ctx.wid, reason), { defer: true }),
    );

    // ---- intents -----------------------------------------------------------------------------

    const save = async (id = selectedId()): Promise<boolean> => {
      if (id === undefined) return false;
      const hasPath = await ctrl.save(id);
      if (!hasPath) {
        setDialog({ kind: 'save-as', id, closeAfter: false });
        return false;
      }
      return ctrl.doc(id)?.save.kind === 'saved';
    };

    const requestClose = (id: string): void => {
      if (ctrl.isDirty(id)) setDialog({ kind: 'close', id });
      else void ctrl.close(id);
    };

    /** The folder the sidebar shows (home for a new document), never a guess (UI-102). */
    const saveAsInitial = (id: string): string => {
      const d = ctrl.doc(id);
      if (d === undefined) return `${tildePath(state().folder, home())}/`;
      return tildePath(saveAsSuggestion(d, state().folder, languageOf(d.name)), home());
    };

    const newTab = (): void => {
      focusNextEditor = true;
      ctrl.newDocument();
    };

    const toggleLock = (): void => {
      const d = current();
      if (d?.path === undefined) return;
      if (d.lock?.kind === 'other') void ctrl.refreshLock(d.id);
      else void ctrl.toggleLease(d.id);
    };

    const onBannerAction = (actionId: string): void => {
      const d = current();
      if (d === undefined) return;
      switch (actionId) {
        case 'reload':
          if (d.error !== undefined) void ctrl.reload(d.id);
          else void ctrl.bannerAction(d.id, 'reload');
          break;
        case 'keep-mine':
          void ctrl.bannerAction(d.id, 'keep-mine');
          break;
        case 'try-again':
          void ctrl.bannerAction(d.id, 'try-again');
          break;
        case 'retry-save':
          void save(d.id);
          break;
        case 'save-as':
          setDialog({ kind: 'save-as', id: d.id, closeAfter: false });
          break;
        case 'close':
          void ctrl.close(d.id);
          break;
        default:
          break;
      }
    };

    const onReadOnlyAttempt = (): void => {
      setAttempts((n) => n + 1);
      const caret = handle?.caretRect();
      const box = codeArea?.getBoundingClientRect();
      setHint(
        caret === undefined || box === undefined
          ? { left: 16, top: 16 }
          : { left: caret.left - box.left, top: caret.top - box.top },
      );
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => setHint(undefined), HINT_MS);
    };

    const onMenuCommand = (id: string): void => {
      const d = current();
      switch (id) {
        case 'file.new':
          newTab();
          break;
        case 'file.open':
          setDialog({ kind: 'open' });
          break;
        case 'file.save':
          void save();
          break;
        case 'file.save-as':
          if (d !== undefined) setDialog({ kind: 'save-as', id: d.id, closeAfter: false });
          break;
        case 'file.revert':
          if (d !== undefined) void ctrl.reload(d.id);
          break;
        case 'file.lock':
          toggleLock();
          break;
        case 'file.reveal':
          if (d?.path !== undefined) ctx.launch('files', { argv: [dirname(d.path)] });
          break;
        case 'file.close':
          if (d !== undefined) requestClose(d.id);
          break;
        case 'view.sidebar':
          setSidebar((on) => !on);
          break;
        default:
          break;
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || dialog() !== undefined) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && key === 's') {
        event.preventDefault();
        if (event.shiftKey) onMenuCommand('file.save-as');
        else void save();
      } else if (mod && event.altKey && key === 'o' && !isTypingTarget(event.target, root)) {
        // The window frame is a non-modal dialog: only text fields, menus and this window's
        // own sheets keep the key (UI-015).
        event.preventDefault();
        setDialog({ kind: 'open' });
      }
    };

    // ---- render --------------------------------------------------------------------------------

    const dialogDoc = (): DocState | undefined => {
      const d = dialog();
      return d === undefined || d.kind === 'open' ? undefined : ctrl.doc(d.id);
    };

    return (
      <div ref={(el) => (root = el)} data-app="editor" class={styles.root} onKeyDown={onKeyDown}>
        <div class={styles.tabRow}>
          <div class={styles.tabs}>
            <DocumentTabs
              variant="editor"
              label="Open files"
              tabs={tabs()}
              selected={selectedId() ?? ''}
              onSelect={(id) => ctrl.select(id)}
              onClose={(id) => requestClose(id)}
              onNew={newTab}
              panelId={`pl-editor-panel-${uid}`}
            />
          </div>
          <Show when={current()?.lock}>
            {(lock) => (
              <div class={styles.lockSlot}>
                <LockChip state={lock()} attemptKey={attempts()} onActivate={toggleLock} />
              </div>
            )}
          </Show>
        </div>

        <div class={styles.body}>
          <Show when={sidebar()}>
            <EditorSidebar
              outline={outline()}
              activeLine={activeHeading(outline(), position().line)?.line}
              onOutlineSelect={(line) => handle?.goTo(line)}
              folder={tildePath(state().folder, home())}
              files={state().files}
              selectedFile={current()?.path}
              onFileSelect={(id) => void ctrl.open(id)}
            />
          </Show>
          <div id={`pl-editor-panel-${uid}`} role="tabpanel" class={styles.panel}>
            <ConflictBanner
              state={current()?.conflict}
              onAction={(action) => {
                const d = current();
                if (d !== undefined) void ctrl.conflictAction(d.id, action);
              }}
              onDismiss={() => {
                const d = current();
                if (d !== undefined) ctrl.dismissConflict(d.id);
              }}
            />
            <Show when={banner()}>
              {(b) => (
                <EditorBanner
                  tone={b().tone}
                  label={b().label}
                  title={b().title}
                  actions={b().actions}
                  assertive={b().tone === 'danger'}
                  onAction={onBannerAction}
                  onDismiss={
                    b().dismissible
                      ? () => {
                          const d = current();
                          if (d !== undefined) ctrl.dismissBanner(d.id);
                        }
                      : undefined
                  }
                />
              )}
            </Show>
            <div ref={(el) => (codeArea = el)} class={styles.codeArea}>
              <Show when={editorKey()} keyed>
                {(id) => {
                  const opened = ctrl.doc(id);
                  const line = opened?.line;
                  const docOf = (): DocState | undefined => state().docs.find((d) => d.id === id);
                  return (
                    <CodeEditor
                      doc={docOf()?.text ?? handle?.doc() ?? ''}
                      language={languageOf(opened?.name ?? '')}
                      readOnly={locked()}
                      label={`${docOf()?.name ?? 'Untitled'}${locked() ? ' (read-only)' : ''}`}
                      {...(line === undefined ? {} : { cursor: { line, col: 1 } })}
                      scheme={scheme()}
                      onChange={(text) => ctrl.edit(id, text)}
                      onCursor={setPosition}
                      onReadOnlyAttempt={onReadOnlyAttempt}
                      onSave={() => void save(id)}
                      onSaveAs={() => setDialog({ kind: 'save-as', id, closeAfter: false })}
                      onReady={(h) => {
                        handle = h;
                        // A new CodeMirror starts at the cited line (clamped as CodeMirror does) or
                        // at the top; it reports the caret only after the first change.
                        const lines = h.doc().split('\n').length;
                        setPosition({ line: Math.min(Math.max(1, line ?? 1), lines), col: 1 });
                        if (line !== undefined) {
                          ctrl.lineShown(id);
                          h.focus();
                        } else if (focusNextEditor) {
                          // "+ New tab" and New Document: type at once, focus never stays on "+".
                          h.focus();
                        }
                        focusNextEditor = false;
                        onCleanup(() => {
                          if (handle === h) handle = undefined;
                        });
                      }}
                    />
                  );
                }}
              </Show>
              <Show when={current()?.loading === true}>
                <p role="status" class={styles.opening}>
                  Opening {current()?.name}…
                </p>
              </Show>
              <Show when={locked() ? hint() : undefined}>
                {(at) => (
                  <div
                    role="status"
                    class={`${styles.hint} pl-anim-pop-in`}
                    style={{ left: `${String(at().left)}px`, top: `${String(at().top)}px` }}
                  >
                    <Lock size={12} stroke-width={2.2} aria-hidden="true" />
                    {lockHolder() === undefined
                      ? 'You can read this file but not write it.'
                      : `Locked by ${lockHolder() ?? ''} · you can read, not edit`}
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>

        <EditorStatusBar
          line={position().line}
          col={position().col}
          language={languageLabel(language())}
          save={status().save}
          sync={status().sync}
          readOnly={locked()}
          indent="Spaces: 2"
          onGoToLine={() => handle?.focus()}
          onRetrySave={() => void save()}
        />

        <NameSheet
          open={dialog()?.kind === 'open'}
          title="Open"
          label="Path"
          path
          initial={`${tildePath(state().folder, home())}/`}
          confirm="Open"
          onCancel={() => setDialog(undefined)}
          onSubmit={(value) => {
            setDialog(undefined);
            void ctrl.open(expandHome(value, home()));
          }}
        />

        <NameSheet
          open={dialog()?.kind === 'save-as'}
          title="Save As"
          label="Save as"
          path
          selectStem
          initial={(() => {
            const d = dialog();
            return d?.kind === 'save-as' ? saveAsInitial(d.id) : '';
          })()}
          confirm="Save"
          onCancel={() => setDialog(undefined)}
          onSubmit={(value) => {
            const d = dialog();
            setDialog(undefined);
            if (d?.kind !== 'save-as') return;
            void ctrl.saveAs(d.id, expandHome(value, home())).then((ok) => {
              if (ok && d.closeAfter) void ctrl.close(d.id);
            });
          }}
        />

        <ConfirmSheet
          open={dialog()?.kind === 'close'}
          title={`Do you want to save the changes you made to “${dialogDoc()?.name ?? ''}”?`}
          description="Your changes will be lost if you don’t save them."
          confirm="Save"
          confirmVariant="primary"
          alternative="Don’t Save"
          onCancel={() => setDialog(undefined)}
          onAlternative={() => {
            const d = dialog();
            setDialog(undefined);
            if (d?.kind === 'close') void ctrl.close(d.id);
          }}
          onConfirm={() => {
            const d = dialog();
            setDialog(undefined);
            if (d?.kind !== 'close') return;
            if (ctrl.doc(d.id)?.path === undefined) {
              setDialog({ kind: 'save-as', id: d.id, closeAfter: true });
              return;
            }
            void save(d.id).then((ok) => {
              if (ok) void ctrl.close(d.id);
            });
          }}
        />

        <ToastView toast={toast()} onDismiss={(id) => ctrl.dismissToast(id)} />
      </div>
    );
  };
}

/** The view module's entry (apps/src/descriptor.ts `AppMount`). */
export function mount(ctx: AppViewContext): () => void {
  const EditorWindow = editorApp(ctx);
  return render(
    () => (
      <ErrorBoundary
        fallback={(err: unknown) => {
          ctx.reportCrash(err);
          return null;
        }}
      >
        <EditorWindow />
      </ErrorBoundary>
    ),
    ctx.container,
  );
}

export default mount;
