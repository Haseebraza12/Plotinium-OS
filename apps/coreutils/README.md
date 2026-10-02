# apps/coreutils

The required command set as real programs (SYS-01, SYS-02): each command is a `Program` (`init(argv)` → serialisable state, `*run(ctx, st)`) that reaches the OS only through `ctx.sys` system calls. File commands (ls pwd mkdir rmdir touch cat cp mv rm ln find tree stat chmod chown du df quota grep) are owned by R2; process and memory commands (ps top kill nice renice free vmstat pmap swapctl) by R1; system commands (whoami id su bootlog shutdown reboot svcctl debug) by R5; `echo help man` by R3; the AI front ends (`ai semsearch predict`) by R4. Each command has a man page.

- **Primary owner:** R2 VFS/DB (file commands); R1 Kernel (process and memory commands)
- **Secondary reviewer:** R3 WM/UI
- **Spec:** [specs/07-shell/shell-and-terminal.md](../../specs/07-shell/shell-and-terminal.md) §3.14 (command reference), [processes-and-scheduling.md](../../specs/03-kernel/processes-and-scheduling.md) §3.18 and [memory-and-paging.md](../../specs/03-kernel/memory-and-paging.md) §3.17 (process and memory formats), [boot-and-services.md](../../specs/02-boot/boot-and-services.md), [identity-and-branding.md](../../specs/00-product/identity-and-branding.md) §3.8 (`uname`), the AI specs for `ai`, `semsearch` and `predict`
- **Requirement IDs:** SYS-02, SHL-07, SHL-12, SHL-13, SHL-15, VFS-04..07, VFS-09, VFS-11, PROC-02, PROC-07, PROC-08, MEM-07, BOOT-04, BOOT-11, BOOT-12, DB-02, PLT-ID-07, AGT-08, RAG-06, PRE-06

## Layout

| Path                                                                  | Contents                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                                            | `PROGRAMS`: command name → program. `satisfies` makes a man page without a program (or the reverse) a type error. |
| `cmd/<name>.ts`                                                       | One program per command, plus its pure parsing and formatting helpers (exported for tests).                       |
| `lib/command.ts`                                                      | `defineCommand`: option parsing in `init`, usage errors (status 2), `--help`, closed pipe → 141, caught signals.  |
| `lib/io.ts`                                                           | Buffered stdout, stderr diagnostics, `isatty`, terminal size, time-zone offset.                                   |
| `lib/argspec.ts`, `lib/argspec.gen.ts`                                | GNU-style option parser driven by the man front matter (SHL-12, SHL-15).                                          |
| `lib/procs.ts`, `lib/mem.ts`                                          | Process fields of kernel spec §3.18.1 and memory-command data.                                                    |
| `lib/mode.ts`, `lib/markdown.ts`, `lib/signals.ts`, `lib/users.ts`, … | `chmod` modes (VFS §5.4), man rendering, signals, name lookups.                                                   |
| `man/<name>.md`                                                       | Man pages: JSON front matter (the only source of flags) and the body sections of shell spec §3.12.                |
| `scripts/gen-argspec.mjs`                                             | Regenerates `lib/argspec.gen.ts` from the man pages.                                                              |
| `tests/`                                                              | Per-command tests against a fake kernel (`harness.ts`, `fakefs.ts`); titles begin with requirement IDs.           |

## Conventions

- Every loop inside a generator yields (`local/no-yieldless-loop-in-generator`); pure formatting lives in plain functions.
- Diagnostics are `<cmd>: <operand>: <text>` with the shell spec's errno texts (`lib/errors.ts`), ` (<detail>)` from the call, and ` — rolled back` / ` — restored` for bulk operations.
- Names and command lines printed to a terminal are escaped (SHL-13); colours, columns and the man pager apply only on a terminal.
- Fields the protocol does not carry yet are read when present and printed as `-`; each such place carries a `TODO(Rn)`.

## Commands

```sh
node apps/coreutils/scripts/gen-argspec.mjs        # after editing a man page's front matter
pnpm exec vitest run --project apps apps/coreutils
pnpm exec eslint apps/coreutils --max-warnings 0
```
