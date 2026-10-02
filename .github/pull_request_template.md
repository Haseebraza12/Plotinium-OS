<!--
Branch: <type>/<REQ-ID>-<slug>, for example feat/VFS-06-quota-in-txn.
Title:  <type>(<scope>): <imperative summary> (<REQ-IDs>)
Keep it to 400 changed lines or fewer, not counting tests, fixtures and generated files.
-->

## Requirement IDs

<!-- Every ID this PR implements or tests, for example VFS-06, DB-02. -->

-

## Spec

<!-- Link the spec section this PR implements, for example specs/04-vfs/virtual-file-system.md §3.2. -->

-

## What changed and why

## Tests

<!-- Test titles begin with the requirement ID. List the tests that prove the behaviour, and attach a trace or screenshot for UI and performance changes. -->

- [ ] New or changed behaviour is covered by tests whose titles begin with the requirement ID
- [ ] Edge cases are covered (empty, one element, duplicates, errors and their errno)
- [ ] Integration tests added if the change crosses a boundary (syscall to database, kernel to worker)
- [ ] `pnpm run ci` passes locally (format, lint, type check, tests with coverage)

## Performance impact

<!-- Budget diff, or "none". -->

## Documentation

- [ ] The relevant root document is updated (ARCHITECTURE, DSA, DATABASE, AI, BOOT, TESTING or SECURITY)
- [ ] `man` pages updated for new or changed commands
- [ ] CHANGELOG.md updated under Unreleased if users will notice the change
- [ ] THIRD_PARTY.md updated if a dependency was added (with R5 approval)

## AI assistance (spec §18)

- [ ] No AI assistant was used for this PR, **or**
- [ ] An AI assistant was used, and I added an entry to AI_USAGE.md with the tool, what it was asked, what I accepted, and what I rejected and why

## Author checklist

- [ ] I can explain every line in this PR
- [ ] Mandatory `dsa/` structures in this PR are my own work, written from first principles
- [ ] No secrets, credentials or tokens are included

## Reviewer checklist

- [ ] Boundaries: no app touches storage or kernel globals; identity comes from the port; the change goes through syscalls
- [ ] Main thread: no geometry in reactive state; no unbounded work on the main thread
- [ ] IndexedDB: one transaction per user-visible operation; no `await` inside a builder; events only after `oncomplete`
- [ ] Server: goes through `vfsTxn` and the lock plan; side effects only after commit; errno mapping correct
- [ ] Schema changes are dbmate migrations with a working `down`
- [ ] Security: permission checks through `vfs/src/perm.ts`; no HTML sinks; AI content rendered as text
- [ ] Tests exercise behaviour rather than inflate coverage
