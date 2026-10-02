/**
 * A non-waiting admission gate: at most `limit` holders; a full gate refuses at once. Used for the
 * login concurrency cap (LOGIN_MAX_CONCURRENCY = 4; full -> 429 EAGAIN rate with retryAfterMs
 * 1000, backend-api.md §3.6.1 step 1). The Argon2 cap itself waits in line (argon2.ts Semaphore).
 */
export class Slots {
  readonly limit: number;
  #held = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Slots limit must be >= 1');
    this.limit = limit;
  }

  get held(): number {
    return this.#held;
  }

  tryAcquire(): boolean {
    if (this.#held >= this.limit) return false;
    this.#held++;
    return true;
  }

  release(): void {
    if (this.#held > 0) this.#held--;
  }
}
