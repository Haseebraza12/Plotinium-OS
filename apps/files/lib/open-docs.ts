/**
 * Which Editor window already has a document open (UI-104). The Files and Editor views of one
 * desktop run in the same page, so a small in-memory table shared by their modules is enough:
 * each Editor window registers itself while it is mounted, and Files asks it before launching
 * another Editor. Opening a file that a window already shows selects its tab there (and asks
 * for that window's focus) instead of spawning a second window that could only read the file
 * (the first window holds its lease, VFS-09).
 *
 * Nothing here reaches the OS: the Editor window itself makes any system call (`window.focus`
 * for its own wid), so every call still has the right caller (SYS-01).
 */

/** What an Editor window offers the other views of the page. */
export interface EditorWindowHandle {
  readonly wid: number;
  /** The window has a tab for this absolute path. */
  has(path: string): boolean;
  /**
   * Selects the path's tab (moving the caret to `line`) and asks for the window's focus.
   * Resolves true when the window got the focus, false when the kernel only drew attention to
   * it (window.focus needs recent input in that window, WMD-09).
   */
  reveal(path: string, line?: number): Promise<boolean>;
}

const windows = new Map<number, EditorWindowHandle>();

/** Registers an Editor window while it is mounted; returns the unregister function. */
export function registerEditorWindow(handle: EditorWindowHandle): () => void {
  windows.set(handle.wid, handle);
  return () => {
    if (windows.get(handle.wid) === handle) windows.delete(handle.wid);
  };
}

/** The Editor window that has `path` open, if any (the most recently registered wins). */
export function editorWindowWith(path: string): EditorWindowHandle | undefined {
  let found: EditorWindowHandle | undefined;
  for (const w of windows.values()) if (w.has(path)) found = w;
  return found;
}
