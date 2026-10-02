/**
 * The client fault-injection hook (virtual-file-system.md §3.20, DB-02, PVFS-08). `debug.inject`
 * (root, capability `debug.fault`, audited) arms the next matching bulk op on this device, once;
 * an unused arm expires after 10 minutes. The store aborts the transaction from the onsuccess of
 * the Nth inode-row write (store/idb-store.ts), so N writes really ran before the rollback.
 */
import { FAULT_ARM_TTL_MS } from './limits.ts';
import type { OpKind } from './store/records.ts';

export type FaultOp = 'unlink' | 'rename' | 'copy' | 'batch' | 'chmod' | 'chown';

/** The `debug inject` command's names (shell-and-terminal.md). */
const COMMANDS: Readonly<Record<string, FaultOp>> = {
  rm: 'unlink',
  unlink: 'unlink',
  mv: 'rename',
  cp: 'copy',
  copy: 'copy',
  chmod: 'chmod',
  chown: 'chown',
  rename: 'batch',
  batch: 'batch',
};

export function faultOpOf(command: string): FaultOp | undefined {
  return COMMANDS[command];
}

interface Arm {
  readonly op: FaultOp;
  readonly after: number;
  readonly at: number;
}

export class FaultHook {
  private arm: Arm | null = null;

  armFor(op: FaultOp, after: number, now: number): void {
    if (!Number.isInteger(after) || after < 1)
      throw new RangeError('fault: after must be a positive integer');
    this.arm = { op, after, at: now };
  }

  get armed(): boolean {
    return this.arm !== null;
  }

  /** Consume the arm if `call` matches it (one-shot); expired arms are dropped. */
  take(call: OpKind, now: number): { after: number } | undefined {
    const a = this.arm;
    if (a === null) return undefined;
    if (now - a.at > FAULT_ARM_TTL_MS) {
      this.arm = null;
      return undefined;
    }
    if (a.op !== call) return undefined;
    this.arm = null;
    return { after: a.after };
  }
}
