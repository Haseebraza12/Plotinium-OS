/**
 * Terminal (shell-and-terminal.md §3.1–§3.3; ui-implementation-guide.md §3.6.3; SYS-02, SYS-03,
 * PROC-08): xterm.js as the TTY device, a line discipline between it and the login shell
 * (apps/shell) on a pseudo-terminal, job-control keys through the TTY (Ctrl-C SIGINT, Ctrl-Z
 * SIGTSTP), tab completion from the `complete.*` calls, and the kernel-owned confirmation of the
 * `ai` command (AGT-03). Tabs, each with its own TTY and shell.
 *
 * This module is the app's descriptor only (kept light for the Dock and the executor bundles):
 * the view (./view.tsx, which pulls in xterm, the shell and coreutils) and the `term` process
 * (./proc.ts) load lazily.
 */
import type { CallName } from '@plotinium/protocol';

import type { AppDescriptor, AppWindowSpec } from '../src/descriptor.ts';

/**
 * The executor-only calls (registry origin E) the Terminal's view has its `term` process make
 * over the window's display channel (window-manager.md §3.13; apps/files/lib/relay.ts). The
 * view's process host (./host/host.ts) runs processes, pipes, TTYs, `chdir`, `sleep` and signals
 * itself; every file, lock, memory, AI and admin call its programs make goes to the kernel as the
 * `term` process, so the kernel checks the user's credentials, capabilities, rwx and quota as for
 * any program. Calls that would act on `term` itself (`exit`, `spawn`, `wait`, `chdir`, `tty.*`,
 * `window.create`, `su`) are never relayed: the process refuses them with EPERM.
 */
export const TERMINAL_RELAY_CALLS = [
  // files and descriptors opened in the kernel
  'open',
  'read',
  'write',
  'writeFile',
  'close',
  'seek',
  'fstat',
  'mkdir',
  'rmdir',
  'unlink',
  'rename',
  'symlink',
  'link',
  'chmod',
  'chown',
  'truncate',
  'utimes',
  'copy',
  'find',
  'grep',
  'du',
  'wc',
  'batch',
  // processes outside this window (`kill 42`, `renice`)
  'kill',
  'setpriority',
  // memory, leases and sync (demo programs, `swapctl`, `sync`)
  'mem.alloc',
  'mem.declare',
  'mem.free',
  'mem.prefetch',
  'mem.hint',
  'lock.acquire',
  'lock.release',
  'sync.flush',
  // the agent (`ai`) and administration; the kernel refuses what the user may not do
  'ai.agent.plan',
  'ai.agent.submit',
  'ai.agent.confirm',
  'ai.undo',
  'ai.telemetry.read',
  'svc.restart',
  'sysctl.set',
  'shutdown',
  'reboot',
  'fsck',
] as const satisfies readonly CallName[];

/** Menu item ids the view handles (`onMenuCommand`). */
export const TERMINAL_MENU = {
  newTab: 'shell.newTab',
  closeTab: 'shell.closeTab',
  clear: 'shell.clear',
  interrupt: 'shell.interrupt',
  copy: 'edit.copy',
  paste: 'edit.paste',
  selectAll: 'edit.selectAll',
  nextTab: 'view.nextTab',
  prevTab: 'view.prevTab',
} as const;

export type TerminalMenuItem = (typeof TERMINAL_MENU)[keyof typeof TERMINAL_MENU];

/**
 * The keycaps the menus show. They are the chords ui's Terminal handles
 * (`@plotinium/ui/apps/terminal` TERMINAL_KEYS; a test keeps the two equal), none of them a key
 * Chrome keeps for itself (Ctrl+Shift+W would close the browser window, UI-022) or a
 * window-manager binding (window-manager.md §3.9). They are strings here because this descriptor
 * module must not pull in the view bundle.
 */
export const TERMINAL_SHORTCUTS = {
  newTab: ['Alt', 'Shift', 'N'],
  closeTab: ['Alt', 'Shift', 'W'],
  nextTab: ['Alt', 'Shift', ']'],
  prevTab: ['Alt', 'Shift', '['],
  interrupt: ['Ctrl', 'C'],
  copy: ['Ctrl', 'Shift', 'C'],
  paste: ['Ctrl', 'V'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * 80 × 24 cells of the `--pl-font-mono` face at 14 px (8.4 × 21 px cells, DSN §3.8.10): the grid
 * (672 × 504) plus the terminal's padding (32 × 16) and scrollbar (14), the tab strip (40), the
 * status strip (26) and the title bar (38).
 */
export const TERMINAL_WINDOW: AppWindowSpec = {
  width: 760,
  height: 624,
  minWidth: 420,
  minHeight: 240,
  resizable: true,
  maximizable: true,
  chrome: 'titlebar',
  singleInstance: false,
};

export const descriptor: AppDescriptor = {
  id: 'terminal',
  title: 'Terminal',
  icon: 'terminal',
  dock: true,
  keywords: ['shell', 'sh', 'console', 'command line', 'cli', 'tty', 'bash', 'prompt', 'ai'],
  window: TERMINAL_WINDOW,
  menus: [
    {
      id: 'shell',
      label: 'Shell',
      items: [
        { id: TERMINAL_MENU.newTab, label: 'New Tab', shortcut: TERMINAL_SHORTCUTS.newTab },
        { id: TERMINAL_MENU.closeTab, label: 'Close Tab', shortcut: TERMINAL_SHORTCUTS.closeTab },
        { kind: 'separator' },
        {
          id: TERMINAL_MENU.interrupt,
          label: 'Send Interrupt (SIGINT)',
          shortcut: TERMINAL_SHORTCUTS.interrupt,
        },
        { id: TERMINAL_MENU.clear, label: 'Clear Scrollback' },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { id: TERMINAL_MENU.copy, label: 'Copy', shortcut: TERMINAL_SHORTCUTS.copy },
        { id: TERMINAL_MENU.paste, label: 'Paste', shortcut: TERMINAL_SHORTCUTS.paste },
        { kind: 'separator' },
        { id: TERMINAL_MENU.selectAll, label: 'Select All' },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { id: TERMINAL_MENU.nextTab, label: 'Next Tab', shortcut: TERMINAL_SHORTCUTS.nextTab },
        {
          id: TERMINAL_MENU.prevTab,
          label: 'Previous Tab',
          shortcut: TERMINAL_SHORTCUTS.prevTab,
        },
      ],
    },
  ],
  manifest: {
    name: 'terminal',
    kind: 'app',
    title: 'Terminal',
    icon: 'terminal',
    entry: 'apps/terminal/proc',
    view: 'apps/terminal/view',
    requires: ['svc:wm', 'svc:complete?'],
    checkpointable: true,
    caps: ['proc', 'window', 'tty', 'fs.read', 'fs.write', 'lock', 'mem'],
  },
  relay: TERMINAL_RELAY_CALLS,
  load: () => import('./view.tsx').then((m) => m.mount),
  program: () => import('./proc.ts').then((m) => m.default),
};
