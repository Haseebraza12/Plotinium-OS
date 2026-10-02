/**
 * The Files context menu (files-light notes; ui-design-system.md §3.8.11). Items are enabled
 * only when the user may do them, and a disabled item says why (it stays focusable in the
 * menu). Move to Trash is last, red and never the default. Inside the Trash the menu offers
 * Put Back and Delete Immediately instead.
 */
import AppWindow from 'lucide-solid/icons/app-window';
import Copy from 'lucide-solid/icons/copy';
import ExternalLink from 'lucide-solid/icons/external-link';
import FilePen from 'lucide-solid/icons/file-pen';
import Info from 'lucide-solid/icons/info';
import Lock from 'lucide-solid/icons/lock';
import LockOpen from 'lucide-solid/icons/lock-open';
import Pencil from 'lucide-solid/icons/pencil';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import SquareTerminal from 'lucide-solid/icons/square-terminal';
import Trash2 from 'lucide-solid/icons/trash-2';
import Undo2 from 'lucide-solid/icons/undo-2';

import type { MenuEntry, MenuItemEntry } from '../../primitives/menu/Menu.tsx';
import { extensionOf } from './format.ts';
import type { FileEntry, Viewer } from './types.ts';

export type FileAction =
  | 'open'
  | 'open-with'
  | 'get-info'
  | 'rename'
  | 'copy'
  | 'chmod'
  | 'lock'
  | 'unlock'
  | 'trash'
  | 'put-back'
  | 'delete';

export type OpenWithTarget = 'editor' | 'terminal' | 'choose';

export interface MenuContext {
  viewer: Viewer;
  /** The user has `w` on the folder being shown (rename and trash need it). */
  folderWritable: boolean;
  /** Show ⌘ shortcuts (macOS) instead of Ctrl. */
  mac?: boolean;
  /** The folder shown is the Trash: Put Back and Delete Immediately replace Move to Trash. */
  inTrash?: boolean;
}

function mod(ctx: MenuContext, key: string): string[] {
  return [ctx.mac === true ? '⌘' : 'Ctrl', key];
}

/**
 * Whether `viewer` owns `entry` (or is root). Compared by uid when both sides have one, since a
 * name can be missing or stale; by name otherwise. Change Permissions needs it (owner or root).
 */
export function ownsEntry(viewer: Viewer, entry: Pick<FileEntry, 'owner' | 'uid'>): boolean {
  if (viewer.root === true) return true;
  if (viewer.uid !== undefined && entry.uid !== undefined) return viewer.uid === entry.uid;
  return entry.owner === viewer.user;
}

/** The reason an action is not allowed, or undefined when it is. */
export function denyReason(
  action: FileAction,
  targets: readonly FileEntry[],
  ctx: MenuContext,
): string | undefined {
  const single = targets.length === 1 ? targets[0] : undefined;
  switch (action) {
    case 'open':
    case 'open-with':
    case 'copy':
    case 'get-info':
      if (targets.length === 0) return 'Nothing selected';
      if (action !== 'get-info' && targets.some((e) => e.readable === false))
        return 'Permission denied';
      return undefined;
    case 'rename':
      if (single === undefined) return 'Select one item to rename';
      if (!ctx.folderWritable) return 'You can’t change items in this folder';
      return undefined;
    case 'chmod':
      if (targets.length === 0) return 'Nothing selected';
      return targets.every((e) => ownsEntry(ctx.viewer, e))
        ? undefined
        : 'Only the owner can change permissions';
    case 'lock':
    case 'unlock':
      if (single === undefined || single.type === 'dir') return 'Select one file to lock';
      if (single.lock !== undefined && single.lock.mine !== true && single.lock.stale !== true)
        return `Locked by ${single.lock.holder}`;
      if (single.writable === false) return 'You can read this file but not write it';
      return undefined;
    case 'trash':
    case 'put-back':
    case 'delete':
      if (targets.length === 0) return 'Nothing selected';
      return ctx.folderWritable ? undefined : 'You can’t change items in this folder';
  }
}

/** Menu items for the targets of a right-click, Shift+F10 or the Menu key. */
export function fileMenuItems(targets: readonly FileEntry[], ctx: MenuContext): MenuEntry[] {
  const item = (
    action: FileAction,
    label: string,
    extra: Partial<MenuItemEntry> = {},
  ): MenuItemEntry => {
    const reason = denyReason(action, targets, ctx);
    return {
      id: action,
      label,
      ...extra,
      disabled: reason !== undefined,
      description: reason,
    };
  };
  if (ctx.inTrash === true) {
    return [
      item('open', 'Open', { icon: ExternalLink, shortcut: mod(ctx, 'O') }),
      item('open-with', 'Open With…', { icon: AppWindow }),
      { kind: 'separator', id: 'sep-1' },
      item('get-info', 'Get Info', { icon: Info, shortcut: mod(ctx, 'I') }),
      item('copy', 'Copy', { icon: Copy, shortcut: mod(ctx, 'C') }),
      { kind: 'separator', id: 'sep-2' },
      item('put-back', 'Put Back', { icon: Undo2 }),
      { kind: 'separator', id: 'sep-3' },
      item('delete', 'Delete Immediately…', {
        icon: Trash2,
        danger: true,
        shortcut: ctx.mac === true ? ['⌘', '⌫'] : ['Delete'],
      }),
    ];
  }
  const single = targets.length === 1 ? targets[0] : undefined;
  const lockedByMe = single?.lock?.mine === true && single.lock.stale !== true;
  return [
    item('open', 'Open', { icon: ExternalLink, shortcut: mod(ctx, 'O') }),
    item('open-with', 'Open With…', { icon: AppWindow }),
    { kind: 'separator', id: 'sep-1' },
    item('get-info', 'Get Info', { icon: Info, shortcut: mod(ctx, 'I') }),
    item('rename', 'Rename', { icon: Pencil, shortcut: [ctx.mac === true ? 'Enter' : 'F2'] }),
    item('copy', 'Copy', { icon: Copy, shortcut: mod(ctx, 'C') }),
    { kind: 'separator', id: 'sep-2' },
    item('chmod', 'Change Permissions…', { icon: ShieldCheck }),
    lockedByMe
      ? item('unlock', 'Unlock', { icon: LockOpen })
      : item('lock', 'Lock for Editing', { icon: Lock }),
    { kind: 'separator', id: 'sep-3' },
    item('trash', 'Move to Trash', {
      icon: Trash2,
      danger: true,
      shortcut: ctx.mac === true ? ['⌘', '⌫'] : ['Delete'],
    }),
  ];
}

/**
 * The "Open With" follow-up menu: Editor always, Terminal for shell scripts, Choose…. Every row
 * has an icon, so the labels line up (the menu leaves an empty cell for a missing icon).
 */
export function openWithItems(targets: readonly FileEntry[]): MenuEntry[] {
  const scripts = targets.length > 0 && targets.every((e) => extensionOf(e.name) === 'sh');
  return [
    { kind: 'header', label: 'Open With', id: 'h' },
    { id: 'editor', label: 'Editor', icon: FilePen },
    ...(scripts ? [{ id: 'terminal', label: 'Terminal', icon: SquareTerminal }] : []),
    { kind: 'separator', id: 's' },
    { id: 'choose', label: 'Choose…', icon: AppWindow },
  ];
}

/** `Actions for kernel-notes.txt` or `Actions for 3 items`. */
export function menuLabel(targets: readonly FileEntry[]): string {
  const single = targets.length === 1 ? targets[0] : undefined;
  return single === undefined
    ? `Actions for ${targets.length} items`
    : `Actions for ${single.name}`;
}
