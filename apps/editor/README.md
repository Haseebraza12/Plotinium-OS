# apps/editor

The Text Editor: CodeMirror 6, lazy-loaded. Saves carry `expectedVersion`, so a concurrent change becomes a conflicted copy instead of a silent overwrite.

- **Primary owner:** R3 WM / UI Subsystem Lead
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/05-wm/window-manager.md](../../specs/05-wm/window-manager.md), [specs/06-sync/offline-and-sync.md](../../specs/06-sync/offline-and-sync.md)
- **Requirement IDs:** VFS-07, VFS-09, VFS-10, OFF-01

## Layout

| File                           | What it is                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.ts` (and `index.ts`) | the `AppDescriptor`; argv is paths, each optionally followed by `+N` or `--line N`                                                                                         |
| `view.tsx`                     | document tabs with the lock chip, outline and folder sidebar, conflict and other banners, one CodeMirror per document, status bar, Open / Save As / unsaved-changes sheets |
| `proc.ts`                      | the process: owns the window and makes the relayed executor calls (`../files/lib/relay.ts`)                                                                                |
| `lib/controller.ts`            | open, edit, save with `expectedVersion`, conflicts (VFS-10), leases (VFS-09), change polling                                                                               |
| `lib/model.ts`                 | argv parsing, the lock chip state and the exact banner strings                                                                                                             |

A stale save keeps the typed bytes in `name (conflict from user, YYYY-MM-DD).ext`, reloads the
server's version into the tab and shows "This file changed on the server. Your version was saved
as “…”." with [Compare] and [Open conflicted copy]. Another user's lease makes the buffer
read-only with "Read-only — locked by bob (lease 27 s)".
