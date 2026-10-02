/**
 * The cancel registry: op id -> backend pid of its running transaction (AGT-09, DBD-14).
 *
 * Spec: specs/09-database/database.md §3.9.5; specs/06-sync/offline-and-sync.md §3.10.
 * When a proc.signal for an op's process arrives on the control lane, the lock manager calls
 * markCancelled(opId) FIRST and then runs `SELECT pg_cancel_backend($pid)` on a separate pool
 * connection. The running statement fails with 57014; because the flag is set, toErrno maps that
 * 57014 to ECANCELED 'killed' (persisted), while a statement_timeout, also 57014, stays ETIMEDOUT.
 * One process, so an in-memory map is enough (C9).
 */
export class CancelRegistry {
  readonly #pids = new Map<string, number>();
  readonly #cancelled = new Set<string>();

  /** Records the backend pid of the op's current attempt (vfsTxn, first statements). */
  bind(opId: string, backendPid: number): void {
    this.#pids.set(opId, backendPid);
  }

  /**
   * Sets the op's cancel flag and returns the backend pid to cancel, or undefined when no
   * transaction of the op is running right now (the AbortSignal then stops the next attempt).
   */
  markCancelled(opId: string): number | undefined {
    this.#cancelled.add(opId);
    return this.#pids.get(opId);
  }

  wasCancelled(opId: string): boolean {
    return this.#cancelled.has(opId);
  }

  /** Forgets the binding after an attempt; `final` also clears the flag once the op is decided. */
  release(opId: string, final = false): void {
    this.#pids.delete(opId);
    if (final) this.#cancelled.delete(opId);
  }

  get size(): number {
    return this.#pids.size;
  }
}
