/**
 * The Task Manager's process (`/bin/taskmgr.json` entry `apps/taskmgr/proc`): owns the window and
 * its lifetime, and makes the executor-only calls its view asks for on the display channel
 * (apps/files/lib/relay.ts): End Process and Suspend/Resume (`kill`), Renice (`setpriority`) and
 * Restart predictor (`svc.restart`). The kernel sees this process's pid, uid and capabilities, so
 * `kill` of another user's process still needs root (`kill.other`). The live model runs in the
 * view (controller.ts).
 */
import type { CallName } from '@plotinium/protocol';

import { appProcess } from '../files/lib/relay.ts';
import { TASKMGR_WINDOW } from './index.ts';

/** The calls the Task Manager view may have its process make. */
export const TASKMGR_RELAY: readonly CallName[] = ['kill', 'setpriority', 'svc.restart'];

const taskmgr = appProcess({
  app: 'taskmgr',
  title: 'Task Manager',
  icon: 'task-manager',
  minWidth: TASKMGR_WINDOW.minWidth,
  minHeight: TASKMGR_WINDOW.minHeight,
  relay: TASKMGR_RELAY,
});

export default taskmgr;
