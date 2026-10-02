# @plotinium/apps

The built-in applications. Each app is a Solid view (`view.tsx`, main thread) plus a program (`proc.ts`) that runs as a process on an executor worker. Apps reach the OS only through typed system calls; not even a built-in app touches storage, the process table or another app's windows (SYS-01, boundary B1).

| Field              | Value                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary owner      | R3 WM/UI (terminal, shell, files, editor, taskmgr, settings); R2 VFS/DB (file coreutils); R1 Kernel (process and memory commands, demo programs)                                                                                                                                                             |
| Secondary reviewer | see each folder's README                                                                                                                                                                                                                                                                                     |
| Implements         | [specs/07-shell/shell-and-terminal.md](../specs/07-shell/shell-and-terminal.md)<br>[specs/05-wm/window-manager.md](../specs/05-wm/window-manager.md)<br>[specs/05-wm/ui-design-system.md](../specs/05-wm/ui-design-system.md)<br>[specs/10-ai/rag-semantic-search.md](../specs/10-ai/rag-semantic-search.md) |
| Requirement IDs    | SYS-01, SYS-02, SYS-03, PROC-08, VFS-07, MEM-07, RAG-06, PRE-05, PRE-06, OFF-01                                                                                                                                                                                                                              |
| May import         | `@plotinium/protocol` and `@plotinium/kernel/sys` ONLY, plus UI libraries. No storage, worker or network globals (ESLint `no-restricted-globals`; the executor runtime shadows them at run time).                                                                                                            |
| Status             | Scaffold (v0.1.0): placeholder `src/index.ts` only.                                                                                                                                                                                                                                                          |

## Layout

| Folder         | App                                                          | Owner   |
| -------------- | ------------------------------------------------------------ | ------- |
| `terminal/`    | Terminal view and xterm.js TTY device                        | R3      |
| `shell/`       | shell lexer, parser, executor (pipes, redirection, jobs)     | R3      |
| `coreutils/`   | file commands (R2); process and memory commands (R1)         | R2 + R1 |
| `files/`       | File Explorer                                                | R3      |
| `editor/`      | Text Editor (CodeMirror 6, lazy)                             | R3      |
| `taskmgr/`     | Task Manager                                                 | R3      |
| `settings/`    | Settings (including Privacy and Developer)                   | R3      |
| `demo/`        | `burn`, `memhog`: real programs for the defence stress tests | R1      |
| `src/index.ts` | package entry point (placeholder)                            | R3      |

## Commands

```sh
pnpm --filter @plotinium/apps typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/apps test        # the Vitest project named "apps"
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
