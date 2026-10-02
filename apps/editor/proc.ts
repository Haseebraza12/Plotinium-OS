/**
 * The Editor process (`/bin/editor.json` entry `apps/editor/proc`): owns the window and is the
 * caller of record for the executor-only calls of its view (open/read/close to load a document,
 * `writeFile` with `expectedVersion` to save it, VFS-10, and `lock.acquire`/`lock.release` for
 * the lease, VFS-09), relayed on the display channel (../files/lib/relay.ts), and possibly
 * `window.setCloseGuard` for unsaved documents (UI-037).
 */
import { appProcess, FILE_RELAY_CALLS } from '../files/lib/relay.ts';
import { SET_CLOSE_GUARD } from './lib/close-guard.ts';

/**
 * Its view's relayed calls: the file calls, and the close guard (UI-037) in case the kernel
 * admits it only from the window's owner process (contract C4 names caps ['window']).
 */
export const EDITOR_RELAY_CALLS: readonly string[] = [...FILE_RELAY_CALLS, SET_CLOSE_GUARD];

const editor = appProcess({
  app: 'editor',
  title: 'Editor',
  icon: 'editor',
  minWidth: 560,
  minHeight: 360,
  relay: EDITOR_RELAY_CALLS,
});

export default editor;
