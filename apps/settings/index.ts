/**
 * Settings (ui-design-system.md §3.8.14; MEM-01, PROC-03, PRE-05, BOOT-06): general, appearance
 * (theme, accent, reduced motion and transparency through the desktop preferences), Desktop & Dock,
 * memory budget and soft limit, scheduler quanta and T_age (kernel parameters through `sysctl`),
 * network, Privacy & AI (the telemetry ring: view, clear, export, opt-in sync; the index; the
 * agent's budget and audit), users, storage, updates and About.
 *
 * `argv[0]` opens a section (`memory`, `privacy`, `scheduler`, …) so the Task Manager and the
 * Control Centre can deep-link into it. Descriptor only; the view and the process load lazily.
 */
import type { AppDescriptor, AppMenu } from '../src/descriptor.ts';

/**
 * Section ids and labels in sidebar order (ui/src/apps/settings `SECTIONS`; the View menu uses
 * the same words as the sidebar, UI-162).
 */
export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'desktop', label: 'Desktop & Dock' },
  { id: 'memory', label: 'Memory' },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'network', label: 'Network & Sync' },
  { id: 'privacy', label: 'Privacy & AI' },
  { id: 'users', label: 'Users & Groups' },
  { id: 'storage', label: 'Storage' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' },
] as const;

const VIEW_MENU: AppMenu = {
  id: 'view',
  label: 'View',
  items: SETTINGS_SECTIONS.map((s) => ({ id: `go.${s.id}`, label: s.label })),
};

export const descriptor: AppDescriptor = {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',
  dock: true,
  keywords: [
    'settings',
    'preferences',
    'appearance',
    'dark mode',
    'theme',
    'reduce motion',
    'memory budget',
    'scheduler',
    'quantum',
    'privacy',
    'telemetry',
    'users',
    'storage',
    'updates',
  ],
  window: {
    width: 880,
    height: 620,
    minWidth: 880,
    minHeight: 620,
    resizable: false,
    maximizable: false,
    chrome: 'unified',
    singleInstance: true,
  },
  menus: [VIEW_MENU],
  manifest: {
    name: 'settings',
    kind: 'app',
    title: 'Settings',
    icon: 'settings',
    entry: 'apps/settings/proc',
    view: 'apps/settings/view',
    requires: ['svc:wm'],
    checkpointable: true,
    // syscall-abi.md §4.5: the user set plus `privacy` (telemetry); `sys.admin` only reaches a
    // root session (caps are intersected with the caller's bounding set at spawn).
    caps: ['fs.read', 'fs.write', 'proc', 'window', 'mem', 'privacy', 'sys.admin'],
  },
  // Executor-only calls the view has its process make (the process's TASKMGR_RELAY /
  // SETTINGS_RELAY allow-list is the boundary; kept in sync by the registry test).
  relay: ['sysctl.set', 'writeFile', 'sync.flush', 'reboot'],
  load: () => import('./view.tsx').then((m) => m.mount),
  program: () => import('./proc.ts').then((m) => m.default),
};
