# @plotinium/services

The 18 service manifests (C17) and the service manager: it builds the boot DAG with `dsa/dag` (Kahn levels), starts services in topological order, halts with a kernel panic that names a cycle, degrades non-critical services with back-off, and records per-stage and per-service timings for `bootlog --critical-path`. The same DAG code resolves app start-up dependencies from `/bin/<app>.json` in `sys.spawn`.

| Field              | Value                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary owner      | R5 QA / DevOps & Integration Engineer                                                                                                                                                                                                                                 |
| Secondary reviewer | R3 WM/UI (each reviews the other's side of the boot surface)                                                                                                                                                                                                          |
| Implements         | [specs/02-boot/boot-and-services.md](../specs/02-boot/boot-and-services.md)                                                                                                                                                                                           |
| Requirement IDs    | BOOT-02, BOOT-03, BOOT-04, BOOT-06, BOOT-07, BOOT-08, BOOT-11, BOOT-12                                                                                                                                                                                                |
| May import         | `@plotinium/protocol`, `@plotinium/dsa`. Never the kernel (the kernel imports this package), `wm`, `apps`, `ai`, `server` or `db`.                                                                                                                                    |
| Status             | v0.1.0: 18 manifests, validation V1–V10, `dsa/dag` levels (marked fallback while the flag is false, with a bootlog WARN), completion-driven start with timeouts on `KernelTimers`, degraded and back-off, reverse-order stop, truthful progress model, critical path. |

## Layout

- `manifests/`: one JSON manifest per service (see `manifests/README.md`).
- `src/`: the service manager. Timeouts go through the kernel timer heap and never move boot progress (BOOT-02).

## Commands

```sh
pnpm --filter @plotinium/services typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/services test        # the Vitest project named "services"
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
