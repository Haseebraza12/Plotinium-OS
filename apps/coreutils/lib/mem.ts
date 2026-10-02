/**
 * Memory-command data (memory-and-paging.md §3.17). Protocol `MemStat` and `ProcDetail.pages` do
 * not yet carry every column of `free`, `vmstat` and `pmap`; these optional fields are read when
 * the kernel supplies them and printed as `-` otherwise.
 * TODO(R1): add the fields below to protocol `MemStat` / `ProcDetail` (syscall-abi.md §4.4.5).
 */
import type { MemStat, ProcDetail } from '@plotinium/protocol';

import { binSize } from './format.ts';

export interface MemExtra {
  readonly pinned: number;
  readonly avail: number;
  readonly localCap: number;
  readonly device: 'opfs' | 'idb';
  readonly uploadPending: number;
  readonly uploadFailed: number;
  readonly pagesIn: number;
  readonly pagesOut: number;
  readonly bytesUploaded: number;
}

export interface ProcMemExtra {
  readonly swapLocal: number;
  readonly swapRemote: number;
  readonly ws: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly lastPageInMs: number;
}

export type MemStatX = MemStat & Partial<MemExtra>;
export type ProcMem = NonNullable<MemStat['procs']>[number] & Partial<ProcMemExtra>;

type Page = NonNullable<ProcDetail['pages']>[number];

export interface PageExtra {
  readonly kind: string;
  readonly label: string;
  readonly copies: string;
  readonly sha256: string;
  readonly gen: number;
  readonly pinReasons: readonly string[];
  readonly swapKey: string;
  readonly io: boolean;
}

export type PageX = Page & Partial<PageExtra>;

/** `free` = budget − committed, where committed = accounted + outstanding reservations. */
export function freeBytes(m: MemStat): number {
  return Math.max(0, m.budget - m.accounted - m.reservedWaiting);
}

export type Unit = 'h' | 'b' | 'k' | 'm' | 'g';

const DIVISOR = { b: 1, k: 1024, m: 1_048_576, g: 1_073_741_824 } as const;

/** A size in the chosen unit; `-h` picks a binary unit per value with one decimal. */
export function unitSize(bytes: number | undefined, unit: Unit): string {
  if (bytes === undefined) return '-';
  if (unit === 'h') return binSize(bytes);
  return String(Math.round(bytes / DIVISOR[unit]));
}

export function orDash(n: number | undefined, f: (x: number) => string = String): string {
  return n === undefined ? '-' : f(n);
}
