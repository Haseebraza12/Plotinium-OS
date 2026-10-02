
# System-call protocol

All shapes are Valibot schemas in `protocol/`. They are the single source of truth for four consumers:
- the kernel dispatcher;
- the Fastify `preValidation` hook;
- the WebSocket frames;
- the LLM tool schemas, generated server-side by `@valibot/to-json-schema` and post-processed into Claude's strict subset.

`protocol/ABI_VERSION` is bumped on any breaking change.

## 1. Channels and identity

| Channel | Ends | Carries | Caller identity comes from |
|---|---|---|---|
| Executor control port | kernel ↔ executor N | dispatch/resume/yield/exit, syscall envelopes of resident processes, page bytes | the port, plus `RUNNING_PID` stamped by the executor runtime. The kernel accepts a pid only if it is resident on **that** port and currently dispatched there |
| View port | kernel ↔ one app view (main thread) | syscalls issued by the view (e.g. open a file dialog result) | bound to `(pid, wid)` when `sys.window.create` runs |
| Display channel | process ↔ its view | state snapshots and diffs out, input events in (not syscalls) | created by the kernel; re-created on migration |
| Compositor port | kernel ↔ `wm/compositor.ts` | create/close/focus/minimise commands; final geometry back | kernel-only; the compositor ignores every other source |
| Router port | kernel ↔ main-thread router | boot progress, platform calls, `interactive` hint, `visibilitychange` | kernel-only |
| blkio / ai.embed ports | kernel ↔ special workers | swap I/O; embedding jobs | kernel-only |
| WSS `/ws` | syncd ↔ server | protocol v1 (see §9) | session cookie checked at upgrade + Origin allowlist; the server re-derives the uid for every op |

## 2. Envelopes

```ts
// user space -> kernel (the executor runtime adds `pid` from the control block; apps never set it)
type SysReq = { id: number; call: CallName; args: unknown };
type SysRes = { id: number; ok: true; value: unknown }
            | { id: number; ok: false; errno: Errno; msg?: string };
// kernel -> subscribers
type KEvent = { topic: Topic; seq: number; t: number; data: unknown };
```

- `id` is per-port and increasing, so replies may arrive out of order.
- Payloads over 64 KB always go in the transfer list. File reads return `ArrayBuffer`, never strings.
- Blocking calls (a read on an empty pipe, `lock` with wait, a page fault, `wait()`) put the PCB into BLOCKED with `waitingOn` set. The kernel replies when the process is woken.

Example:

```json
→ {"id":41,"call":"unlink","args":{"path":"/home/alice/old-drafts","recursive":true}}
← {"id":41,"ok":true,"value":{"removed":1000,"bytes":7340032,"sync":"pending","opId":"0192f0c1-…"}}
← {"id":42,"ok":false,"errno":"EACCES","msg":"write permission denied on /home/bob"}
```

## 3. Call catalogue (grouped; class = fast | blocking | bulk-nonpreemptive)

| Group | Calls | Notes |
|---|---|---|
| Files | `open read write close lseek stat lstat fstat readdir readdirPlus mkdir rmdir unlink rename symlink readlink link chmod chown truncate utimes statfs du find` | `write` takes `{expectedVersion}`. `unlink/rename/chmod/chown` accept `{recursive}` and run bulk-nonpreemptive. `readdirPlus` returns stat together with names, which saves `find` hops. `link` exists only if hard links are built (nlink kept correct) |
| Batch | `batch({txnId, ops[], expectedVersions, confirmToken?})` | one atomic IndexedDB transaction plus one outbox op; used by the agent (AGT-05) and multi-step shell ops |
| Process | `spawn exec exit wait kill getpid getppid setpgid tcsetpgrp nice setpriority sleep sigaction` | `kill` across uids requires root |
| Pipes and fds | `pipe dup dup2` | pipes are kernel ring buffers |
| Memory | `mem.declare mem.alloc mem.touch mem.stat` (+ `mmap msync` if MEM-08) | `declare` registers large assets for accounting |
| Windows | `window.create window.setTitle window.close window.requestFocus` | background processes cannot steal focus; `requestFocus` only flashes the taskbar |
| Locks | `lock.acquire lock.release lock.list` | S/X leases through `lockd` |
| Identity | `getuid id su` | `su` opens the kernel-owned secure prompt and gets a 15-minute server grant |
| System | `uname uptime bootlog dmesg shutdown reboot svc.status fsck lsof sys.subscribe` | shutdown/reboot need uid 0, or the console session's own user |
| AI | `ai.semsearch ai.index.status ai.plan ai.confirm predict` | `ai.confirm` is kernel-rendered (see §6) |
| Debug | `debug.inject({op, after})` | uid 0 only, `FAULT_INJECTION=1` only, one-shot, audited |

## 4. Errno list

| Errno | Meaning | Typical sources |
|---|---|---|
| ENOENT | no such file or directory | resolver; PG `23503` on a missing parent |
| EEXIST | name exists | IndexedDB `ConstraintError` on `dentries.add`; PG `23505` |
| ENOTDIR / EISDIR | wrong inode type | resolver |
| ENOTEMPTY | `rmdir` or `rename` onto a non-empty directory | VFS |
| EINVAL | bad arguments (Valibot failure), a move into the directory's own subtree | dispatcher; acyclicity trigger |
| EACCES | rwx denied | perm check |
| EPERM | operation reserved for the owner or root (`chown`, sticky `/tmp`, `/system` for the agent) | perm check |
| ELOOP | more than 40 symlink hops | resolver |
| EDQUOT | byte or inode quota exceeded, or the device is full | `users` row CHECK `23514`; IndexedDB `QuotaExceededError` |
| EBUSY | locked by another holder, stale fence, or `lock_timeout` | lock manager; PG `55P03` |
| ENAMETOOLONG | name over 255 bytes or path over 4096 bytes | resolver; CHECK |
| ESRCH | no such process, or the pid is not resident on this port | dispatcher |
| EBADF | bad fd | fd table |
| ENOSYS | unknown call | dispatcher |
| EINTR | interrupted by a signal (kill during a blocking call or agent plan) | scheduler |
| EAGAIN | retryable (transient `40001`/`40P01` after retries, a full pipe) | server `vfsTxn` |
| EIO | injected fault or storage failure; the operation was rolled back | fault trigger `P0001`; IndexedDB `AbortError` |
| ESTALE | the agent plan's dry-run fingerprint changed before commit | agent executor |
| EAIRATE / EAIBUDGET / EAIUNAVAIL / EAIREFUSED | AI gateway degraded states | LLM gateway |

A write whose version conflicts with another write is not an error. It succeeds with `value.conflict = {keptAs: {ino, path}}`, and a notification is shown (VFS-10).

## 5. Dispatch pipeline (the order is part of the contract)

1. **Resident check.** The port and pid must be resident and dispatched here. Otherwise `ESRCH`.
2. **Table lookup.** `table[call]` must exist. Otherwise `ENOSYS`.
3. **Schema.** `v.safeParse(schema, args)`. On failure, `EINVAL` (about 0.9 µs; no `eval`, so it is CSP-safe).
4. **Capability check** against `pcb.caps` (§7). On failure, `EPERM`.
5. **Permission check** with `vfs/perm.ts`, using `pcb.cred` (§6).
6. **Audit hook** (§8).
7. **Handler.** It is `fast`, `blocking` (the PCB goes BLOCKED), or `bulk-nonpreemptive` (phase 1 can be pre-empted; phase 2 is a single IndexedDB transaction).
8. **Reply.** Kernel events are published only after the IndexedDB `oncomplete`.

## 6. Permission check (`vfs/perm.ts`, shared by kernel and server)

```ts
function may(cred, ino, want /* 4=r 2=w 1=x */): boolean {
  if (cred.uid === 0) return want !== 1 || ino.type === 'dir' || (ino.mode & 0o111) !== 0; // root bypass (x needs some x bit on files)
  const cls = cred.uid === ino.uid ? 6 : cred.groups.includes(ino.gid) ? 3 : 0;
  return (((ino.mode >> cls) & 7) & want) === want;
}
```

- **Path resolution** requires `x` on every directory traversed (`EACCES`). `lstat`, `unlink` and `readlink` stop one step early.
- **create / unlink / rename** require `w+x` on the parent. **Sticky bit** (`/tmp` is `1777`): only the file owner, the directory owner or root may unlink or rename.
- **rm -r** requires `w+x` on the parent and on every directory in the subtree. The kernel checks this before the transaction and the server checks it again inside it.
- **chmod** is allowed for the owner or root. **chown** is root-only. **umask** defaults to 022 and applies at create.
- **One truth table.** The same test matrix of 3 users × 9 modes × 8 operations runs against the kernel and against the server.

## 7. Capabilities (least privilege on top of rwx)

| Capability | Default holders | Scope |
|---|---|---|
| `fs.read`, `fs.write` | user processes | bounded by rwx |
| `fs.scope` | agent: `cwd` and `$HOME` only; `/system` and `/bin` → EPERM unless uid 0 and the user types a confirmation | path prefixes |
| `batch.grant` | agent, after confirmation only | the exact confirmed `(op, ino)` set plus an HMAC `confirmToken = HMAC_k(pid ‖ planHash ‖ dryRunHash ‖ exp 120 s)` |
| `spawn`, `window` | apps and shells | windows limited to the process's own `wid`s |
| `net.sync` | `syncd` only | the WebSocket |
| `ai.index` | `ai.indexer` | read-only file access and index writes |
| `ai.plan` | `ai.agent` | the `/api/llm/*` gateway |
| `mm.speculative` | `prefetch:*` | page-in into speculative pages only; no writes |
| `kill.other`, `debug.fault` | uid 0 (`debug.fault` also needs `FAULT_INJECTION=1`) | audited |

Children inherit a subset of their parent's capabilities; they can never gain one. The kernel narrows capabilities; nothing widens them except `su` through the secure prompt.

## 8. Audit hook

| Level | What | Where |
|---|---|---|
| Trace | every syscall (sampled), with `{t, pid, uid, call, errno, µs}` | klog ring buffer (`dmesg`, Task Manager trace) |
| Security | `su`, `chown`, cross-uid `kill`, `debug.inject`, login failures, lock breaks | IndexedDB `audit` mirror, then the outbox, then server `audit_log` |
| Agent (AGT-08) | every agent-originated syscall, with `actor='agent'`, `prompt_id`, plan hash and result | written **in the same IndexedDB transaction** as the operation, then queued in the outbox. The server inserts `audit_log` inside the op transaction. Rejected or killed plans are logged in a separate autocommit after ROLLBACK. `ai log` reads the local mirror, so it works offline |

`audit_log` is INSERT/SELECT-only for the app database role.

## 9. Event bus

| Topic | Emitted by | Typical subscribers |
|---|---|---|
| `vfs.create/write/rename/unlink/chmod/chown` | VFS after `oncomplete`; `syncd` re-emits server `vfs.changed` | Files windows, `ai.indexer`, completion trie service, Editor (reload banner) |
| `proc.spawn/state/exit` | scheduler | Task Manager, `top`, shell job table |
| `wm.focus/minimise/restore/close` | compositor via the kernel | mm (pinning, eviction class), predictor telemetry |
| `mem.fault/evict/pressure` | mm | Task Manager, `vmstat` |
| `net.state`, `lock.granted/lost/released`, `svc.started/degraded/failed`, `update.available` | syncd, lockd, svcmgr, router | taskbar (OFF-04), Editor, boot log |
| `ai.index.progress`, `ai.predict` | AI processes | Task Manager, Settings |

Delivery rules:
- In-memory, at most once, in order per topic.
- UI subscribers receive at most one batch per animation frame.
- Every `vfs.*` event carries inode numbers. It is delivered only to subscribers with `r` on the parent directory and `x` on its ancestors.
- Subscriptions are handles in the fd table, so killing a process drops them.
- Durable consumers do not rely on the bus alone. At start, `ai.indexer` reconciles its indexed `inodeVersion` against the current versions (a chunked read-only scan) and then follows the bus.

## 10. Server mirror (WSS protocol v1)

- **Frames.** JSON text of at most 64 KB: `{v:1, t, id, ack?, body}`.
  - Client to server: `hello`, `op.submit`, `op.batch` (≤ 32 ops, credit window 16), `lock.acquire/release`, `hb` (every 10 s), `watch/unwatch`, `proc.signal`, `bye`.
  - Server to client: `welcome`, `op.result` (`applied | duplicate | conflict | rejected`), `vfs.changed`, `lock.granted/queued/denied/lost`, `quota`, `proc.event`, `resync`, `throttle`, `error`.
- **Two lanes.** Control frames (`hb`, `lock.*`, `proc.signal`) bypass the serial op queue.
- **Size limit.** Ops larger than 60 KB go through `POST /api/ops/{opId}` using the same pipeline.
- **Close codes:** 1008, 1009, 1012, 1013, 4401, 4408, 4409, 4429, 4508.

## 11. Tests

- **Contract test:** every `CallName` has a schema, a handler, a capability entry and a doc line in `man 2`.
- **Fuzz test:** fast-check generates arbitrary `args`, and the kernel must answer with `EINVAL`. It must never throw and never leave a pending id.
- **SYS-01 bypass suite.**
- **Strict-tool test:** walks every generated LLM tool schema and fails on keywords Claude's strict mode does not support.
- **Replay determinism test:** the same op log applied twice gives the same tree checksum.
