/**
 * The Lamport counter (offline-and-sync.md §3.5; C6, Spec §9.5 "logical timestamp"). On every local
 * op `L := L + 1` (the commit transaction of the VFS does this in `meta.lamport`); on `hello.ok`,
 * `op.result` and `vfs.changed`, `L := max(L, received)`. Lamport values order events for
 * diagnostics; they never decide conflicts (P7).
 */
import type { MetaRec } from '../store/records.ts';
import type { TxHandle } from '../store/store.ts';

export const LAMPORT_KEY = 'lamport';

/** `max(local, received)`; ignores values that are not safe non-negative integers. */
export function lamportMerge(local: number, received: number): number {
  if (!Number.isSafeInteger(received) || received < 0) return local;
  return Math.max(local, received);
}

/** The next local value. */
export function lamportTick(local: number): number {
  return local + 1;
}

export function metaNumber(v: MetaRec | undefined): number {
  return typeof v?.v === 'number' && Number.isFinite(v.v) ? v.v : 0;
}

/**
 * The in-memory view of the counter. The stored counter is authoritative (local commits bump it in
 * their own transaction); this copy only feeds `hello.lamport` and `hb.lamport`.
 */
export class Lamport {
  private v: number;

  constructor(initial = 0) {
    this.v = Math.max(0, initial);
  }

  get value(): number {
    return this.v;
  }

  observe(received: number): number {
    this.v = lamportMerge(this.v, received);
    return this.v;
  }
}

/** Inside a transaction: `meta.lamport := max(meta.lamport, received)`; never decreases. */
export function mergeLamportInTx(t: TxHandle, received: number): void {
  t.get<MetaRec>('meta', LAMPORT_KEY, undefined, (cur) => {
    const stored = metaNumber(cur);
    const next = lamportMerge(stored, received);
    if (next !== stored) t.put('meta', { k: LAMPORT_KEY, v: next });
  });
}
