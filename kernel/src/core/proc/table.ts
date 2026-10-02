/**
 * The process table (Spec §9.1 PROC-01: a hash map from pid to PCB, O(1) average).
 *
 * The mandated structure is the team's `dsa/hashtable` PidTable (C16, owner R1). The kernel codes
 * against the small `ProcessTable` interface below; `createProcessTable` uses the PidTable as
 * soon as HASHTABLE_IMPLEMENTED is true and a `Map` until then.
 * TODO(dsa/hashtable): delete MapProcessTable once the PidTable ships.
 */
import type { IntHashTable } from '@plotinium/dsa';
import { HASHTABLE_IMPLEMENTED, OpenAddressingTable } from '@plotinium/dsa';

import type { PCB } from './pcb.ts';

export interface ProcessTable {
  get(pid: number): PCB | undefined;
  set(pid: number, pcb: PCB): void;
  delete(pid: number): boolean;
  has(pid: number): boolean;
  readonly size: number;
  /** Every PCB, in no particular order. */
  values(): PCB[];
}

/** Stand-in backed by `Map`. TODO(dsa/hashtable): remove (see module comment). */
export class MapProcessTable implements ProcessTable {
  private readonly map = new Map<number, PCB>();

  get(pid: number): PCB | undefined {
    return this.map.get(pid);
  }

  set(pid: number, pcb: PCB): void {
    this.map.set(pid, pcb);
  }

  delete(pid: number): boolean {
    return this.map.delete(pid);
  }

  has(pid: number): boolean {
    return this.map.has(pid);
  }

  get size(): number {
    return this.map.size;
  }

  values(): PCB[] {
    return [...this.map.values()];
  }
}

/** Adapter from the dsa `IntHashTable` (the PidTable) to `ProcessTable`. */
export class PidTableProcessTable implements ProcessTable {
  private readonly table: IntHashTable<PCB>;

  constructor(table: IntHashTable<PCB>) {
    this.table = table;
  }

  get(pid: number): PCB | undefined {
    return this.table.get(pid);
  }

  set(pid: number, pcb: PCB): void {
    this.table.set(pid, pcb);
  }

  delete(pid: number): boolean {
    return this.table.delete(pid);
  }

  has(pid: number): boolean {
    return this.table.has(pid);
  }

  get size(): number {
    return this.table.size;
  }

  values(): PCB[] {
    const out: PCB[] = [];
    this.table.forEach((pcb) => out.push(pcb));
    return out;
  }
}

/** How the process table is backed in this build (printed in the kernel's first klog line). */
export const PROCESS_TABLE_KIND = HASHTABLE_IMPLEMENTED
  ? 'hash table'
  : 'Map, dsa/hashtable pending';

export function createProcessTable(): ProcessTable {
  return HASHTABLE_IMPLEMENTED
    ? new PidTableProcessTable(new OpenAddressingTable<PCB>(64))
    : new MapProcessTable();
}
