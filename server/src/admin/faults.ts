/**
 * The fault-injection arms (backend-api.md §3.15; database.md §3.14, §4.16; DB-02, SRV-14, AGT-09).
 *
 * An arm is ONE-SHOT and SCOPED to the OS session named when it was armed: the next op of the
 * named kind submitted from that `os_session_id` within 5 minutes consumes it (SyncEngine's
 * `faultFor`), then it is gone. `target: 'client'` arms are only recorded (the kernel handles
 * them); `server` and `both` arm `plotinium.fault_after = failAtNode - 1` and `fault_on` in that
 * op's vfsTxn, so the row-counting trigger raises P0001 at node `failAtNode` and the op is
 * rejected EIO `injected` with nothing changed. Every arm, fire and expiry is audited
 * (`debug.inject`, actor 'system').
 *
 * In memory only (C9: one process); a restart disarms everything, which is the safe direction.
 */
import type { OpSubmit } from '@plotinium/protocol';

import type { ArmedFault } from '../vfs/types.ts';

export const FAULT_OPS = ['unlink', 'copy', 'rename', 'batch', 'chmod', 'chown'] as const;
export type FaultOp = (typeof FAULT_OPS)[number];
export const ARM_TTL_MS = 5 * 60_000;

export interface FaultArm {
  readonly op: FaultOp;
  readonly target: 'server' | 'client' | 'both';
  readonly failAtNode?: number;
  readonly on?: 'inodes' | 'dentries';
  readonly delayMs?: number;
}

export interface ArmRecord extends FaultArm {
  readonly osSessionId: string;
  /** Login uid of the auth session that armed it (alice under su to root). */
  readonly armedBy: number;
  readonly armedAt: string;
  readonly expiresAt: string;
}

export type FaultEvent = 'arm' | 'fire' | 'expire' | 'disarm';

export interface FaultArmingOptions {
  readonly now?: () => number;
  /** audit_log `debug.inject` (actor 'system'); errors are the caller's to log. */
  readonly audit?: (event: FaultEvent, arm: ArmRecord) => void;
}

/** rename and batch count dentries by default, the others inodes (database.md §4.16). */
export function defaultCounter(op: FaultOp): 'inodes' | 'dentries' {
  return op === 'rename' || op === 'batch' ? 'dentries' : 'inodes';
}

export class FaultArming {
  readonly #arms = new Map<string, ArmRecord>();
  readonly #now: () => number;
  readonly #audit: (event: FaultEvent, arm: ArmRecord) => void;

  constructor(options: FaultArmingOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#audit = options.audit ?? (() => undefined);
  }

  /** Arms (replacing any earlier arm of the OS session). */
  arm(osSessionId: string, armedBy: number, a: FaultArm): ArmRecord {
    this.#expire(osSessionId);
    const now = this.#now();
    const rec: ArmRecord = {
      ...a,
      osSessionId,
      armedBy,
      armedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ARM_TTL_MS).toISOString(),
    };
    const previous = this.#arms.get(osSessionId);
    if (previous !== undefined) this.#audit('disarm', previous);
    this.#arms.set(osSessionId, rec);
    this.#audit('arm', rec);
    return rec;
  }

  list(osSessionId: string | undefined): readonly ArmRecord[] {
    if (osSessionId !== undefined) {
      this.#expire(osSessionId);
      const a = this.#arms.get(osSessionId);
      return a === undefined ? [] : [a];
    }
    for (const id of [...this.#arms.keys()]) this.#expire(id);
    return [...this.#arms.values()];
  }

  disarm(osSessionId: string): boolean {
    const a = this.#arms.get(osSessionId);
    if (a === undefined) return false;
    this.#arms.delete(osSessionId);
    this.#audit('disarm', a);
    return true;
  }

  /**
   * SyncEngine `faultFor`: the arm for this op, consumed. Only server-side arms with a node count
   * produce an ArmedFault; a client-only or delay-only arm is consumed and recorded, nothing more.
   */
  take(submit: OpSubmit): ArmedFault | undefined {
    const id = submit.osSessionId;
    this.#expire(id);
    const a = this.#arms.get(id);
    if (a?.op !== submit.op.kind) return undefined;
    this.#arms.delete(id);
    this.#audit('fire', a);
    if (a.target === 'client' || a.failAtNode === undefined) return undefined;
    return {
      after: a.failAtNode - 1,
      on: a.on ?? defaultCounter(a.op),
      ...(a.delayMs === undefined || a.delayMs === 0 ? {} : { delayMs: a.delayMs }),
    };
  }

  #expire(osSessionId: string): void {
    const a = this.#arms.get(osSessionId);
    if (a !== undefined && Date.parse(a.expiresAt) <= this.#now()) {
      this.#arms.delete(osSessionId);
      this.#audit('expire', a);
    }
  }
}
