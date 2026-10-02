/**
 * Task Manager (ui-design-system.md §3.8.13; PROC-08, MEM-07, PRE-06): processes with state, CPU
 * share and memory; End Process (`kill`) and Renice (`setpriority`); the Memory tab (budget, page
 * faults, hit ratio, bytes paged, swap tiers, per-process rows); the Scheduler tab (ready bands,
 * running slices, the PROC-04 bound); the AI tab (indexer, agent, audit log); predictions.
 *
 * This module is the app's descriptor only (kept light for the Dock and the executor bundles); the
 * view and the process load lazily.
 */
import type { AppDescriptor } from '../src/descriptor.ts';

/**
 * Sized for the unified toolbar (title, the four tabs, End Process, Renice and search), which
 * needs about 1,080 px before its controls collide; the Stitch reference is 1,240 × 705.
 */
export const TASKMGR_WINDOW = {
  width: 1160,
  height: 700,
  minWidth: 1080,
  minHeight: 520,
  resizable: true,
  maximizable: true,
  chrome: 'unified',
  singleInstance: true,
} as const;

export const descriptor: AppDescriptor = {
  id: 'taskmgr',
  title: 'Task Manager',
  icon: 'task-manager',
  dock: true,
  keywords: [
    'processes',
    'process',
    'kill',
    'end process',
    'renice',
    'cpu',
    'memory',
    'swap',
    'scheduler',
    'top',
    'ps',
  ],
  window: TASKMGR_WINDOW,
  menus: [
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'view.processes', label: 'Processes', shortcut: ['Ctrl', '1'] },
        { id: 'view.memory', label: 'Memory', shortcut: ['Ctrl', '2'] },
        { id: 'view.scheduler', label: 'Scheduler', shortcut: ['Ctrl', '3'] },
        { id: 'view.ai', label: 'AI', shortcut: ['Ctrl', '4'] },
        { kind: 'separator' },
        { id: 'view.refresh', label: 'Refresh Now', shortcut: ['Ctrl', 'R'] },
        // Menus are static descriptors, so the item names both states (UI-162); the status bar
        // button shows which one is current.
        { id: 'view.pause', label: 'Pause or Resume Live Updates' },
      ],
    },
  ],
  manifest: {
    name: 'taskmgr',
    kind: 'app',
    title: 'Task Manager',
    icon: 'task-manager',
    entry: 'apps/taskmgr/proc',
    view: 'apps/taskmgr/view',
    requires: ['svc:wm', 'svc:mm?', 'svc:ai.predictor?'],
    checkpointable: true,
    // `kill.other` and `sys.admin` (ending another user's process, restarting ai.predictor) only
    // reach a root session: caps are intersected with the caller's bounding set at spawn.
    caps: ['proc', 'window', 'mem', 'fs.read', 'kill.other', 'sys.admin'],
  },
  // Executor-only calls the view has its process make (the process's TASKMGR_RELAY /
  // SETTINGS_RELAY allow-list is the boundary; kept in sync by the registry test).
  relay: ['kill', 'setpriority', 'svc.restart'],
  load: () => import('./view.tsx').then((m) => m.mount),
  program: () => import('./proc.ts').then((m) => m.default),
};
