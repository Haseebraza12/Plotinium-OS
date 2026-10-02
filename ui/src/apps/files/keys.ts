/**
 * Keyboard map for the list and icon views (files-light notes; ui-design-system.md §3.8.11):
 * arrows, Home/End and PageUp/PageDown move (Shift extends, Ctrl/Cmd moves focus only), Space
 * toggles, Ctrl/Cmd+A selects all, Enter or Ctrl/Cmd+O opens, Ctrl/Cmd+I shows info, F2
 * renames, Ctrl/Cmd+C copies, Delete or Cmd+Backspace moves to Trash (Shift+Delete is left to
 * the window: Delete Permanently…), Shift+F10 or the Menu key opens the context menu. Browser-reserved chords (Ctrl+W/T/N) are never used.
 */
import type { FileAction } from './menu.ts';
import { isNavKey, keySelect, selectAll, toggleFocused, type Selection } from './selection.ts';

export type CollectionIntent =
  | { type: 'select'; selection: Selection }
  | { type: 'action'; action: FileAction }
  | { type: 'menu' };

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export function collectionIntent(
  event: KeyInput,
  state: Selection,
  order: readonly string[],
  layout: { columns?: number; page?: number } = {},
): CollectionIntent | undefined {
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey) return undefined;
  if (isNavKey(event.key)) {
    return {
      type: 'select',
      selection: keySelect(state, order, event.key, { shift: event.shiftKey, toggle: mod }, layout),
    };
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === ' ' && !mod) return { type: 'select', selection: toggleFocused(state) };
  if (mod && key === 'a') return { type: 'select', selection: selectAll(state, order) };
  if (key === 'Enter' && !event.shiftKey) return { type: 'action', action: 'open' };
  if (mod && key === 'o') return { type: 'action', action: 'open' };
  if (mod && key === 'i') return { type: 'action', action: 'get-info' };
  if (mod && key === 'c') return { type: 'action', action: 'copy' };
  if (key === 'F2') return { type: 'action', action: 'rename' };
  // Shift+Delete is Delete Permanently…, which the window handles (with its confirmation).
  if ((key === 'Delete' && !event.shiftKey) || (event.metaKey && key === 'Backspace'))
    return { type: 'action', action: 'trash' };
  if ((key === 'F10' && event.shiftKey) || key === 'ContextMenu') return { type: 'menu' };
  return undefined;
}
