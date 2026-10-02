/**
 * Files (ui-design-system.md §3.8.11; VFS-07, VFS-09, RAG-06): the File Explorer. List and icon
 * views over `readdir`/`lstat`, Back/Forward and the path bar, New Folder, Rename, Copy/Paste,
 * Move to Trash (`/home/<user>/.Trash`) or Delete with confirmation, Change Permissions (`chmod`),
 * Lock for Editing (`lock.acquire`), the quota (`quota`/`statfs`), semantic search
 * (`ai.semsearch`, keyword fallback) whose citations open the Editor at `path:line`, and drag
 * and drop.
 *
 * This module is the app's descriptor only (kept light for the Dock and the executor bundles):
 * the view (view.tsx) and the process (proc.ts) load lazily.
 */
import type { AppDescriptor, AppWindowSpec } from '../src/descriptor.ts';

export const FILES_WINDOW: AppWindowSpec = {
  width: 960,
  height: 600,
  minWidth: 640,
  minHeight: 400,
  resizable: true,
  maximizable: true,
  // The sidebar runs under the traffic lights and the toolbar is the drag region (Finder style).
  chrome: 'unified',
  singleInstance: false,
};

export const descriptor: AppDescriptor = {
  id: 'files',
  title: 'Files',
  icon: 'files',
  dock: true,
  keywords: [
    'files',
    'finder',
    'folders',
    'explorer',
    'documents',
    'trash',
    'permissions',
    'chmod',
    'search',
    'semantic search',
  ],
  window: FILES_WINDOW,
  menus: [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'file.new-folder', label: 'New Folder', shortcut: ['Ctrl', 'Shift', 'N'] },
        { id: 'file.new-file', label: 'New File' },
        { kind: 'separator' },
        { id: 'file.open', label: 'Open', shortcut: ['Ctrl', 'O'] },
        { id: 'file.info', label: 'Get Info', shortcut: ['Alt', 'Enter'] },
        { kind: 'separator' },
        { id: 'file.trash', label: 'Move to Trash', shortcut: ['Delete'] },
        {
          id: 'file.delete',
          label: 'Delete Permanently…',
          shortcut: ['Shift', 'Delete'],
          danger: true,
        },
        { id: 'file.empty-trash', label: 'Empty Trash…', danger: true },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { id: 'edit.cut', label: 'Cut', shortcut: ['Ctrl', 'X'] },
        { id: 'edit.copy', label: 'Copy', shortcut: ['Ctrl', 'C'] },
        { id: 'edit.paste', label: 'Paste', shortcut: ['Ctrl', 'V'] },
        { kind: 'separator' },
        { id: 'edit.select-all', label: 'Select All', shortcut: ['Ctrl', 'A'] },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'view.icons', label: 'as Icons' },
        { id: 'view.list', label: 'as List' },
        { kind: 'separator' },
        { id: 'view.inspector', label: 'Show or Hide Inspector' },
        { id: 'view.hidden', label: 'Show or Hide Hidden Files', shortcut: ['Ctrl', 'Shift', '.'] },
        { id: 'view.refresh', label: 'Refresh' },
      ],
    },
    {
      id: 'go',
      label: 'Go',
      items: [
        { id: 'go.back', label: 'Back', shortcut: ['Alt', '←'] },
        { id: 'go.forward', label: 'Forward', shortcut: ['Alt', '→'] },
        { id: 'go.up', label: 'Enclosing Folder', shortcut: ['Alt', '↑'] },
        { kind: 'separator' },
        { id: 'go.home', label: 'Home' },
        { id: 'go.documents', label: 'Documents' },
        { id: 'go.downloads', label: 'Downloads' },
        { id: 'go.trash', label: 'Trash' },
        { id: 'go.tmp', label: 'Temporary' },
        { id: 'go.root', label: 'Root' },
      ],
    },
  ],
  manifest: {
    name: 'files',
    kind: 'app',
    title: 'Files',
    icon: 'files',
    entry: 'apps/files/proc',
    view: 'apps/files/view',
    requires: ['svc:wm', 'svc:vfs', 'svc:lockd?', 'svc:ai.indexer?'],
    checkpointable: true,
    caps: ['window', 'fs.read', 'fs.write', 'lock'],
  },
  load: () => import('./view.tsx').then((m) => m.mount),
  program: () => import('./proc.ts').then((m) => m.default),
};
