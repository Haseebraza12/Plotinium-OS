/**
 * @plotinium/vfs: the Unix-style virtual file system of the kernel worker
 * (specs/04-vfs/virtual-file-system.md). `@plotinium/vfs/path` and `@plotinium/vfs/perm` are the
 * isomorphic modules the server imports; everything else runs in the kernel worker only.
 *
 * Flow of a mutation (§3.11): plan against the tree through a `PlanBuilder` (phase 1, synchronous,
 * re-run after `NotLoaded`), `quotaCheck` + `prepareCommit`, `applyCommit` as ONE transaction (phase
 * 2), then `VfsTree.apply(plan.writes)` and the stamped events (phase 3).
 */
export const PACKAGE_NAME = '@plotinium/vfs';

export * from './path.ts';
export * from './perm.ts';
export * from './names.ts';
export * from './digest.ts';
export * from './limits.ts';
export * from './errors.ts';
export * from './view.ts';
export * from './content.ts';
export * from './events.ts';
export * from './fault.ts';
export * from './mkfs.ts';

export * from './quota/quota.ts';

export * from './ops/plan.ts';
export * from './ops/overlay.ts';
export * from './ops/common.ts';
export * from './ops/create.ts';
export * from './ops/write.ts';
export * from './ops/unlink.ts';
export * from './ops/rename.ts';
export * from './ops/link.ts';
export * from './ops/copy.ts';
export * from './ops/attr.ts';
export * from './ops/batch.ts';
export * from './ops/commit.ts';
export * from './ops/read.ts';

export * from './tree/vfs-tree.ts';

export * from './oft/session.ts';
export * from './oft/table.ts';

export * from './store/records.ts';
export * from './store/store.ts';
export * from './store/schema.ts';
export * from './store/idb-store.ts';
export * from './store/apply.ts';
export * from './store/load.ts';

export * from './fsck/state.ts';
export * from './fsck/check.ts';
export * from './fsck/repair.ts';
export * from './fsck/fsck.ts';
