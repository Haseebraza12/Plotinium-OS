/**
 * The Files process (`/bin/files.json` entry `apps/files/proc`): owns the window and its
 * lifetime, and is the caller of record for the executor-only calls its view asks for on the
 * display channel (creating, renaming, copying, moving, trashing, deleting, chmod, locks and
 * reading file content for the keyword search). See lib/relay.ts.
 */
import { appProcess, FILE_RELAY_CALLS } from './lib/relay.ts';

const files = appProcess({
  app: 'files',
  title: 'Files',
  icon: 'files',
  minWidth: 640,
  minHeight: 400,
  relay: FILE_RELAY_CALLS,
});

export default files;
