/**
 * Editor (ui-design-system.md §3.8.12; VFS-07, VFS-09, VFS-10): CodeMirror 6 from @plotinium/ui in
 * document tabs with an outline and a folder sidebar. Files open and save through the file
 * system calls; every save carries `expectedVersion`, so a concurrent change becomes a conflicted
 * copy with the amber banner "This file changed on the server." and [Open conflicted copy],
 * never a silent overwrite. Another user's lease makes the buffer read-only with the lock chip.
 *
 * argv: paths, each optionally followed by `+N` or `--line N` (a citation `path:line` from Files
 * or Search opens at that line).
 *
 * Descriptor only; the view and the process load lazily.
 */
import type { AppDescriptor, AppWindowSpec } from '../src/descriptor.ts';

export const EDITOR_WINDOW: AppWindowSpec = {
  width: 900,
  height: 640,
  minWidth: 560,
  minHeight: 360,
  resizable: true,
  maximizable: true,
  chrome: 'titlebar',
  singleInstance: false,
};

export const descriptor: AppDescriptor = {
  id: 'editor',
  title: 'Editor',
  icon: 'editor',
  dock: true,
  keywords: ['editor', 'text', 'notes', 'markdown', 'code', 'write', 'open file', 'save'],
  window: EDITOR_WINDOW,
  menus: [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'file.new', label: 'New Document' },
        { id: 'file.open', label: 'Open…' },
        { kind: 'separator' },
        { id: 'file.save', label: 'Save', shortcut: ['Ctrl', 'S'] },
        { id: 'file.save-as', label: 'Save As…', shortcut: ['Ctrl', 'Shift', 'S'] },
        { id: 'file.revert', label: 'Revert to Saved' },
        { kind: 'separator' },
        { id: 'file.lock', label: 'Lock or Unlock for Editing' },
        { id: 'file.reveal', label: 'Show in Files' },
        { kind: 'separator' },
        { id: 'file.close', label: 'Close Tab' },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [{ id: 'view.sidebar', label: 'Show or Hide Sidebar' }],
    },
  ],
  manifest: {
    name: 'editor',
    kind: 'app',
    title: 'Editor',
    icon: 'editor',
    entry: 'apps/editor/proc',
    view: 'apps/editor/view',
    requires: ['svc:wm', 'svc:vfs', 'svc:lockd?', 'svc:sync?'],
    checkpointable: true,
    caps: ['window', 'fs.read', 'fs.write', 'lock'],
  },
  load: () => import('./view.tsx').then((m) => m.mount),
  program: () => import('./proc.ts').then((m) => m.default),
};
