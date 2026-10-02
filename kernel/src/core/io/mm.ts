/**
 * The `mm` service's port (boot-and-services.md §3.3; memory-and-paging.md §3.7, §3.10.3):
 * the memory manager built on the process system with the host's swap device (blkio: OPFS or
 * IndexedDB) or an in-memory device, the boot sweep of stale swap files, the 1 s tick, and the
 * `mem.pressure` statistics the desktop shows (Control Centre, Task Manager, the menu bar).
 */
import type { BootProfile, MmPort, MmStarted } from '@plotinium/services';
import type { EventData } from '@plotinium/protocol';

import type { Kernel } from '../kernel.ts';
import { loadCalibration } from '../mm/accounting.ts';
import type { CalibrationConstants } from '../mm/accounting.ts';
import calibrationJson from '../mm/calibration.json';
import type { MemoryManager } from '../mm/mm.ts';
import { MemorySwapDevice } from '../mm/swap.ts';
import type { MemoryLink } from './types.ts';

/** In-memory swap when the host has no blkio device (tests, a host without OPFS or IndexedDB). */
export const MEMORY_SWAP_CAP = 256 * 1_048_576;

export interface MmIoDeps {
  readonly kernel: Kernel;
  readonly link: MemoryLink | undefined;
  /** (uid, osSession) pairs still referenced by saved layouts: their swap files are kept. */
  readonly keep: () => Promise<{ uid: number; osSession: string }[]>;
  /** A desktop notice (thrashing). */
  readonly notice: (text: string) => void;
  /** The accounting-model constants (§3.2.3); default kernel/src/core/mm/calibration.json. */
  readonly calibration?: unknown;
}

const KIB = 1_024;

/** The calibration line for the boot log: what the accounting model runs with (UI-133). */
function calibrationNote(c: CalibrationConstants, ok: boolean): string {
  const constants = `OVERHEAD_PROC ${String(Math.round(c.overheadProc / KIB))} KiB · κ ${String(c.kappa)}`;
  if (!ok) return `memory model: calibration.json is invalid, using the defaults (${constants})`;
  return c.lastError === undefined
    ? `memory model: ${constants} (placeholder constants, not yet calibrated on the lab machine)`
    : `memory model: ${constants} · calibrated ${c.lastError.date}, max error ${(c.lastError.max * 100).toFixed(1)} %`;
}

type Pressure = EventData['mem.pressure'];

export class MmIo implements MmPort {
  private readonly deps: MmIoDeps;
  private mm: MemoryManager | null = null;
  private last = '';

  constructor(deps: MmIoDeps) {
    this.deps = deps;
  }

  get manager(): MemoryManager | null {
    return this.mm;
  }

  async start(_profile: BootProfile): Promise<MmStarted> {
    const k = this.deps.kernel;
    const link = this.deps.link;
    const device =
      link?.device ??
      new MemorySwapDevice({
        capBytes: link?.localCap ?? MEMORY_SWAP_CAP,
        now: () => k.host.clock.epochMs(),
      });
    // The accounting model's constants (§3.2.3): OVERHEAD_PROC and the Kernel-line factors come
    // from calibration.json, not from the code defaults (UI-133).
    const cal = loadCalibration(this.deps.calibration ?? calibrationJson);
    const mm = k.startMemory({
      device,
      ...(link?.remote === undefined ? {} : { remote: link.remote }),
      localCap: link?.localCap ?? MEMORY_SWAP_CAP,
      notice: this.deps.notice,
      calibration: cal.constants,
      params: { overheadProc: cal.constants.overheadProc },
    });
    this.mm = mm;
    k.log('mm', cal.ok ? 'info' : 'warn', calibrationNote(cal.constants, cal.ok));
    let swept: { files: number; bytes: number } | null = null;
    try {
      swept = await mm.sweep(await this.deps.keep());
    } catch (e) {
      k.log('mm', 'warn', `swap sweep skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    const notes = [
      link?.note,
      link?.device === undefined
        ? 'swap in memory: paged-out state does not survive a reload'
        : undefined,
    ].filter((n): n is string => n !== undefined);
    return {
      budgetBytes: mm.budget,
      swap: device.kind === 'idb' ? 'indexeddb' : device.kind,
      paging: true,
      swept,
      note: notes.length === 0 ? null : notes.join(' · '),
    };
  }

  tick(): void {
    this.mm?.tick();
    this.syncProcs();
  }

  /**
   * Copy each process's memory numbers onto its PCB, which `proc.list` / `proc.info` report:
   * `residentBytes` is what the budget charges it (accounted, §3.2.1), `swappedBytes` its
   * paged-out pages, plus the fault and hit counters. Without this every process showed 0 B in
   * Task Manager and `ps` (UI-133). Runs on the 1 s mm tick.
   */
  syncProcs(): void {
    const mm = this.mm;
    if (mm === null) return;
    for (const pcb of this.deps.kernel.procs.table.values()) {
      const s = mm.procStats(pcb.pid);
      if (s === undefined) continue;
      pcb.residentBytes = s.accounted;
      pcb.mm.pagedOutBytes = s.pagedOutBytes;
      pcb.mm.swapLocalBytes = s.swapLocalBytes;
      pcb.mm.swapRemoteBytes = s.swapRemoteBytes;
      pcb.mm.faults = s.faults;
      pcb.mm.hits = s.hits;
      pcb.mm.bytesIn = s.bytesIn;
      pcb.mm.bytesOut = s.bytesOut;
      pcb.mm.lastPageInMs = s.lastPageInMs;
    }
  }

  /** The statistics the desktop shows, published as `mem.pressure` when they change. */
  pressure(): Pressure | null {
    const mm = this.mm;
    if (mm === null) return null;
    const s = mm.summary();
    const level: Pressure['level'] =
      s.blocked > 0 ? 'blocked' : s.reclaim === 'idle' ? 'ok' : 'reclaim';
    return {
      accounted: Math.max(0, Math.round(s.accounted)),
      budget: Math.max(0, Math.round(s.budget)),
      level,
    };
  }

  publish(): void {
    const p = this.pressure();
    if (p === null) return;
    // Round to 64 KiB so an idle desktop does not publish a new event every period.
    const key = `${String(Math.round(p.accounted / 65_536))}:${String(p.budget)}:${p.level}`;
    if (key === this.last) return;
    this.last = key;
    this.deps.kernel.bus.publish('mem.pressure', p);
  }

  /** Window events the pager cares about (WM-05, MEM-02). */
  minimised(pid: number, on: boolean): void {
    if (this.mm?.has(pid) === true) this.mm.setMinimised(pid, on);
  }

  stop(): Promise<void> {
    const mm = this.mm;
    if (mm === null) return Promise.resolve();
    return mm.drainUploads();
  }
}
