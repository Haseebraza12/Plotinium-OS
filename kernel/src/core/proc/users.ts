/**
 * uid → user name, for `ps`, `uname` and `proc.list`. The `login` service and the VFS `users`
 * store fill it in; until a user is known the name is `u<uid>` (which satisfies the protocol
 * `Username` pattern). TODO(R2): back it with the VFS `users` store mirror.
 */
export interface UserDirectory {
  nameOf(uid: number): string;
}

export class StaticUserDirectory implements UserDirectory {
  private readonly names = new Map<number, string>([[0, 'root']]);

  constructor(entries: Iterable<readonly [number, string]> = []) {
    for (const [uid, name] of entries) this.names.set(uid, name);
  }

  set(uid: number, name: string): void {
    this.names.set(uid, name);
  }

  nameOf(uid: number): string {
    return this.names.get(uid) ?? `u${String(uid)}`;
  }
}
