# @plotinium/wm

The window manager and the system UI on the main thread: the framework-free compositor (the SOLE writer of window geometry and z-index), the framework-free inlined boot-ui (boot screen, boot menu, panic, recovery console), the Solid desktop shell (login, desktop, taskbar, secure prompt, notifications), the single `tokens.css`, and the frame meter (C11).

| Field              | Value                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary owner      | R3 WM / UI Subsystem Lead (`src/boot-ui/`: shared with R5)                                                                                                                                                                                                                                                             |
| Secondary reviewer | R1 Kernel (main-thread budget); R5 for `src/boot-ui/`                                                                                                                                                                                                                                                                  |
| Implements         | [specs/05-wm/window-manager.md](../specs/05-wm/window-manager.md)<br>[specs/05-wm/ui-design-system.md](../specs/05-wm/ui-design-system.md)<br>[specs/02-boot/boot-and-services.md](../specs/02-boot/boot-and-services.md)<br>[specs/00-product/identity-and-branding.md](../specs/00-product/identity-and-branding.md) |
| Requirement IDs    | WM-01..07, BOOT-01, BOOT-05, BOOT-06, BOOT-08, BOOT-13, BOOT-14, OFF-04                                                                                                                                                                                                                                                |
| May import         | `@plotinium/protocol`, `@plotinium/dsa`, `@plotinium/kernel/sys`, UI libraries. `src/compositor/` and `src/boot-ui/` import no Solid, lucide, xterm or CodeMirror.                                                                                                                                                     |
| Status             | Scaffold (v0.1.0): placeholder `src/index.ts` only.                                                                                                                                                                                                                                                                    |

## Layout

| Folder             | Contents                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/compositor/`  | registry, focus, z-order 1..n, drag and resize with pointer capture, `translate3d` batched per rAF; pushes only coarse events into Solid |
| `src/boot-ui/`     | boot screen, boot menu (hold Esc, `reboot --menu`, Settings flag), panic, recovery console; inlined into `index.html`                    |
| `src/shell/`       | Solid: login, desktop, taskbar, secure prompt, notifications (not the command shell, which is `apps/shell`)                              |
| `src/tokens/`      | `tokens.css`: light and dark themes plus reduced-motion tokens                                                                           |
| `src/frame-meter/` | on-screen frame meter for PROC-05 and WM-03 demonstrations                                                                               |

## Commands

```sh
pnpm --filter @plotinium/wm typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/wm test        # the Vitest project named "wm"
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
