/**
 * Credentials and the injected permission oracle. ai/ may not import `vfs/perm.ts`
 * (architecture.md §3.7), so the kernel passes its implementation in: there is exactly one
 * permission implementation, used by the syscalls, the readable set and the plan validator alike
 * (agentic-shell.md §3.11 "no second permission implementation").
 */
export interface Cred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
}

/** The inode fields a permission decision reads. */
export interface PermSubject {
  readonly type: 'f' | 'd' | 'l';
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export type PermBit = 'r' | 'w' | 'x';

export interface PermOracle {
  may(cred: Cred, node: PermSubject, bit: PermBit): boolean;
}
