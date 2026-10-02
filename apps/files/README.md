# apps/files

The File Explorer view and process, including semantic search results with citations.

- **Primary owner:** R3 WM / UI Subsystem Lead
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/05-wm/window-manager.md](../../specs/05-wm/window-manager.md), [specs/10-ai/rag-semantic-search.md](../../specs/10-ai/rag-semantic-search.md)
- **Requirement IDs:** VFS-07, VFS-09, RAG-06, OFF-01

## Layout

| File                           | What it is                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `manifest.ts` (and `index.ts`) | the `AppDescriptor`: window, menus, `/bin/files.json`, lazy `load()` and `program()`                        |
| `view.tsx`                     | mounts `FilesView` from `@plotinium/ui/apps/files`; sheets, context menu, drag and drop, toast              |
| `proc.ts`                      | the process: owns the window and makes the view's executor-only calls (`lib/relay.ts`)                      |
| `lib/controller.ts`            | framework-free view model and intent handlers                                                               |
| `lib/ops.ts`                   | every file operation as a generator over `call(name, args)`; runs in the view (`drive`) or the process      |
| `lib/relay.ts`                 | display-channel relay: `createRelaySys` (view side) and `appProcess` (process side); shared with the Editor |
| `lib/model.ts`, `lib/path.ts`  | pure helpers (rows, permissions, history, places, keyword scoring, paths)                                   |
| `dialogs.tsx`, `toast.tsx`     | New Folder / Rename / Save As, Change Permissions and confirmation sheets; the in-window toast              |

## How calls reach the kernel

View calls (`stat`, `lstat`, `readdir`, `statfs`, `quota`, `lock.status`, `proc.cred`, `users.list`,
`ai.semsearch`, `ai.search.focus`) go over the window's view port. Executor-only calls (`open`,
`read`, `close`, `writeFile`, `mkdir`, `rename`, `copy`, `unlink`, `chmod`, `lock.acquire`,
`lock.release`) are posted on the display channel and made by this app's process with `ctx.sys`,
so the kernel checks them against the app's pid, credentials and capabilities. The host builds the
view's client with `createRelaySys(viewSys, displayPort)`. Without a display channel those calls
fail with `ENOSYS` and the window says so.
