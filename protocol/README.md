# @plotinium/protocol

The single source of truth for every message shape in Plotinium: Valibot schemas for the system calls, errno values, kernel events, WebSocket protocol v1 frames, op-log entries and agent tools, plus `ABI_VERSION` and the well-known inode UUIDs shared by client `mkfs` and the server seed (C5). The kernel dispatcher, the Fastify `preValidation` hook, the WebSocket frames and the LLM tool schemas all use these schemas (C3).

| Field              | Value                                                                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary owner      | R1 Kernel / Systems Architect                                                                                                                                                                                                                                                                                    |
| Secondary reviewer | R2 VFS/DB **and** R4 AI (two approvals: an ABI change affects every consumer)                                                                                                                                                                                                                                    |
| Implements         | [specs/01-architecture/syscall-abi.md](../specs/01-architecture/syscall-abi.md)<br>[specs/06-sync/offline-and-sync.md](../specs/06-sync/offline-and-sync.md)<br>[specs/10-ai/agentic-shell.md](../specs/10-ai/agentic-shell.md)<br>[specs/04-vfs/virtual-file-system.md](../specs/04-vfs/virtual-file-system.md) |
| Requirement IDs    | SYS-01, AGT-01, AGT-02, AGT-08, VFS-02 (well-known UUIDs), OFF-02 (protocol v1 frames)                                                                                                                                                                                                                           |
| May import         | `valibot` only. No DOM-only, worker-only or Node globals and no other workspace package (ESLint-enforced). Tests may also import `vitest`, `fast-check` and `node:` built-ins.                                                                                                                                   |
| Status             | Scaffold (v0.1.0): placeholder `src/index.ts` only.                                                                                                                                                                                                                                                              |

## Layout

- `src/index.ts`: public entry point (placeholder).
- Valibot is the ONLY schema library (C3). `@valibot/to-json-schema` is used server-side only, to emit strict LLM tool schemas.

## Commands

```sh
pnpm --filter @plotinium/protocol typecheck   # this package against its own tsconfig.json
pnpm --filter @plotinium/protocol test        # the Vitest project named "protocol"
```

Test titles MUST begin with the requirement ID, for example `VFS-06 rejects a write beyond quota with EDQUOT and no partial data` (C18).
