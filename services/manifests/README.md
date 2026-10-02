# services/manifests

One JSON manifest per service (C17). The service manager builds the boot DAG from the `requires` lists with `dsa/dag` (Kahn levels) and halts with a kernel panic that names the cycle if one exists (BOOT-04). The manifests are seeded into `/system/services` at first boot (VFS-02).

| Service      | Requires                 | Critical |
| ------------ | ------------------------ | -------- |
| kernel       | –                        | yes      |
| sched        | kernel                   | yes      |
| storage      | kernel                   | yes      |
| wm           | kernel                   | yes      |
| mm           | sched, storage           | yes      |
| vfs          | storage                  | yes      |
| login        | vfs, wm                  | yes      |
| session      | login, mm                | yes      |
| desktop      | session, wm              | yes      |
| auth         | login                    | no       |
| sync         | auth, vfs                | no       |
| lockd        | sync                     | no       |
| ai.runtime   | sched, mm                | no       |
| ai.indexer   | ai.runtime, vfs, session | no       |
| ai.predictor | sched, storage, login    | no       |
| ai.agent     | vfs, sched, sync         | no       |
| complete     | vfs, desktop             | no       |
| update       | desktop                  | no       |

Seven levels; the critical path is kernel > storage > vfs > login > session > desktop. The manifest schema is defined in [specs/02-boot/boot-and-services.md](../../specs/02-boot/boot-and-services.md).

- **Primary owner:** R5 QA / DevOps & Integration Engineer
- **Secondary reviewer:** R3 WM/UI
- **Requirement IDs:** BOOT-03, BOOT-04, BOOT-07, BOOT-08
