# apps/shell

The command shell process: lexer, parser and executor (pipes, redirection, `;`, `&&`, `||`, trailing `&`, `$VARS`, history, job control, line editor, completion client) running on an executor worker.

- **Primary owner:** R3 WM / UI Subsystem Lead
- **Secondary reviewer:** R4 AI
- **Spec:** [specs/07-shell/shell-and-terminal.md](../../specs/07-shell/shell-and-terminal.md) (program model and job control: [processes-and-scheduling.md](../../specs/03-kernel/processes-and-scheduling.md) §3.5, §3.17)
- **Requirement IDs:** SYS-02, SYS-03 (client side), PROC-08, SHL-02 … SHL-10, SHL-13, SHL-17, SHL-18
- **Status:** implemented against the protocol catalogue; runs on the fake kernel in `tests/`. Waits for `@plotinium/kernel/sys` (see `../src/_sys.ts`).

## Layout

| File                                                         | Role (spec section)                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `proc.ts`                                                    | the `sh` program: `init(argv)`, `run(ctx, st)`, `signal` hook; start-up (§3.4)                       |
| `state.ts`                                                   | the serialisable `ShellState` and the per-dispatch `Sh` handle                                       |
| `lexer.ts`, `parser.ts`, `ast.ts`, `print.ts`                | grammar and AST (§3.5, §4.3); `print` is the inverse of `parse`                                      |
| `expand.ts`, `glob.ts`                                       | tilde, parameters, field splitting, pathname expansion (§3.6)                                        |
| `exec.ts`, `redir.ts`, `lookup.ts`                           | pipelines, redirections, command lookup, statuses (§3.7)                                             |
| `jobs.ts`, `wait.ts`                                         | job table, waiting, terminal hand-over, notices (§3.8, §4.4)                                         |
| `history.ts`                                                 | in-memory list and `$HISTFILE` (§3.9, §4.6)                                                          |
| `keys.ts`, `editor.ts`, `wcwidth.ts`, `prompt.ts`, `repl.ts` | line editor and the read–eval loop (§3.4, §3.9)                                                      |
| `complete.ts`                                                | completion context, the `Completer` interface over `complete.query`, directory-scan fallback (§3.10) |
| `vars.ts`, `env.ts`                                          | variables and their side effects                                                                     |
| `builtins/`                                                  | `cd pwd echo export unset exit history jobs fg bg wait kill help type true false` (§3.7.1, §3.14)    |
| `tests/`                                                     | fake kernel, test-double programs, terminal screen emulator and the SYS-02 suites                    |

The terminal device side (input chunking, output batches) is `../terminal/tty.ts`.
