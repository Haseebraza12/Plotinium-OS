# apps/terminal

The Terminal app: a Solid view hosting xterm.js as the TTY device only (DOM renderer, fit addon, screen-reader mode). The line discipline, lexer, parser and completion are the team's own code (C11).

- **Primary owner:** R3 WM / UI Subsystem Lead
- **Secondary reviewer:** R4 AI (the `ai` command runs in this terminal)
- **Spec:** [specs/07-shell/shell-and-terminal.md](../../specs/07-shell/shell-and-terminal.md)
- **Requirement IDs:** SYS-02, SYS-03, PROC-08, SHL-01..SHL-03, SHL-08, SHL-14, SHL-17, AGT-03, AGT-08

## Modules

| File                    | Role                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`           | `descriptor: AppDescriptor` (Dock, menus, window, `/bin/terminal.json`), `TERMINAL_RELAY_CALLS`. Light: no view or program code.                                                                                                                                                                  |
| `index.ts`              | Re-exports the descriptor (the registry imports it).                                                                                                                                                                                                                                              |
| `view.tsx`              | `mount(ctx)`: ui's `TerminalApp` (tabs, one xterm per session, status strip) wired to `TerminalController`.                                                                                                                                                                                       |
| `controller.ts`         | Tabs, titles (`demo@plotinium: ~/notes`), background activity, the byte stream through the pumps of `tty.ts`.                                                                                                                                                                                     |
| `tty.ts`                | View-side TTY glue: `tty.input` chunks (never split inside a character or escape sequence, EAGAIN retried next frame) and one-batch-at-a-time output acknowledged after xterm parsed it (SHL-03).                                                                                                 |
| `session.ts`            | Session backends: the kernel TTY (`tty.input` / `tty.resize` / `tty.output`) or the local process host; `autoBackend` probes with `tty.resize`.                                                                                                                                                   |
| `ldisc.ts`              | The line discipline: canonical and raw modes, echo, VERASE/VWERASE/VKILL/VEOF, ISIG (Ctrl-C SIGINT, Ctrl-Z SIGTSTP, Ctrl-\ SIGQUIT), ONLCR, the confirmation takeover.                                                                                                                            |
| `host/`                 | The process host: a pseudo-terminal pair per tab, the real shell (`apps/shell`) and coreutils as processes, pipes, process groups, job control, SIGTTIN, SIGWINCH, SIGHUP, `proc.list`/`proc.info` for `ps`, and the kernel-owned `ai.agent.confirm` prompt. Every other call goes to the kernel. |
| `plan.ts`, `confirm.ts` | The agent plan as ui's ANSI confirmation block (`formatConfirmationBlock`), and the outcome lines.                                                                                                                                                                                                |
| `proc.ts`               | The `term` process behind `/bin/terminal.json`.                                                                                                                                                                                                                                                   |

## How a session runs today

The kernel has no TTY subsystem yet (`tty.open` / `tty.input` answer ENOSYS, TODO(R1)), so `autoBackend` picks the local process host:

1. The desktop spawns `/bin/terminal.json`; `term` creates the window and, because `tty.open` fails, becomes its owner (`phase: 'owner'`).
2. The view mounts, the process host opens a TTY per tab and starts `-sh` on it. Keys from xterm go through the line discipline; Ctrl-C and Ctrl-Z become SIGINT and SIGTSTP for the foreground process group.
3. View-origin calls (`stat`, `readdir`, `proc.cred`, `uname`, …) go to the view port. Executor-only calls (`open`, `read`, `mkdir`, `unlink`, `kill`, `ai.agent.*`, …; `TERMINAL_RELAY_CALLS`) are posted on the window's display channel and made by `term` as itself (apps/files/lib/relay.ts wire format), so the kernel checks the user's credentials, capabilities, rwx and quota.
4. Tab completion calls `complete.query`; while the kernel does not route it, the host completes command names (builtins and `/bin`), paths, and flags from the man index itself, without a "service unavailable" notice (SHL-17, UI-123).
5. `ai "…"` starts `/bin/lib/ai.agent.json` in the host (a host passes the agent program as `programs`). The agent's `ai.agent.confirm` takes the TTY over: type-ahead is discarded, the block is written by the TTY owner, and the one answer is read from this TTY's keyboard only (`echo y | ai …` cannot confirm, AGT-03). The status strip shows `ai.agent pid N · waiting on your confirmation`.

When the kernel serves the TTY, `term` opens it and spawns the shell itself, and the view uses `tty.input`, `tty.resize` and the `tty.output` view events instead (one session per window).

## Keys, CSP and restore

- **Chords** (`ui/src/apps/terminal/keys.ts`, shown in the menus from `TERMINAL_SHORTCUTS`): new tab Alt+Shift+N, close tab Alt+Shift+W, next and previous tab Alt+Shift+] and Alt+Shift+[, copy Ctrl+Shift+C, paste Ctrl+V (the browser's paste). None is a chord Chrome keeps for itself (Ctrl+Shift+W would close the browser window) or a window-manager binding (UI-022, UI-126).
- **Strict CSP:** xterm's run-time `<style>` elements are created as inert stand-ins and applied through adopted sheets (`ui/src/primitives/internal/csp-styles.ts`), and its per-cell colours (selection, true colour, contrast fixes) go through the CSSOM instead of a `style` attribute (`ui/src/apps/terminal/csp-rows.ts`). Opening, using and selecting in a Terminal raises no `securitypolicyviolation` (UI-050; e2e `tests/e2e/polish-terminal.spec.ts`).
- **Restore (UI-127):** `controller.snapshot()` gives each tab's directory and last 2,000 lines of plain text (≤ 512 KiB, shell-and-terminal.md §3.3); a host that keeps it with the session layout passes it back as `restore` and reads it through `onSnapshot` (`TerminalExtras` in `view.tsx`). The shell does not pass these yet, so a reloaded window still starts empty.

## Verify

```sh
pnpm exec tsc -p apps/terminal/tsconfig.verify.json --noEmit
pnpm exec vitest run --project apps apps/terminal
```

`tsconfig.verify.json` maps `@plotinium/ui/apps/*` to `ui/src/apps/*/index.ts` until ui/package.json exports that subpath.
