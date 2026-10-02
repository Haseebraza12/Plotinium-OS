/**
 * UI-133: the memory numbers the desktop shows come from the accounting model. The `mm` service
 * loads the model's constants from calibration.json (not the code defaults) and copies each
 * process's charge onto its PCB on the 1 s tick, so `proc.list` (Task Manager, `ps`) no longer
 * reports 0 B for every process.
 */
import { describe, expect, it } from 'vitest';

import type { PlatformInfo } from '../../host.ts';
import { DEV_IDENTITY } from '../../host.ts';
import { createKernel } from '../../kernel.ts';
import { messageOf } from '../../klog/format.ts';
import type { PCB } from '../../proc/pcb.ts';
import { toProcInfo } from '../../proc/info.ts';
import { MmIo } from '../mm.ts';
import { TestClock } from './world.ts';

const PLATFORM: PlatformInfo = {
  browser: { brand: 'Chrome', major: 154 },
  cores: 8,
  crossOriginIsolated: false,
};

const KiB = 1_024;

async function world(calibration?: unknown): Promise<{
  readonly io: MmIo;
  readonly pcb: PCB;
  readonly lines: () => string[];
}> {
  const clock = new TestClock();
  const kernel = createKernel({
    host: { clock, identity: DEV_IDENTITY, platform: PLATFORM },
  });
  const io = new MmIo({
    kernel,
    link: undefined,
    keep: () => Promise.resolve([]),
    notice: () => undefined,
    ...(calibration === undefined ? {} : { calibration }),
  });
  await io.start('normal');
  const pcb = kernel.procs.create({
    ppid: 1,
    kind: 'user',
    cls: 'user',
    name: 'files',
    cred: { uid: 1_100, gid: 100, groups: [100], ruid: 1_100 },
  });
  const mm = io.manager;
  if (mm === null) throw new Error('no memory manager');
  mm.register(pcb.pid, { uid: 1_100, app: 'files', osSession: kernel.osSessionId });
  await mm.admit(pcb.pid);
  return {
    io,
    pcb,
    lines: () => kernel.klog.read().map((r) => messageOf(r)),
  };
}

const info = (pcb: PCB) =>
  toProcInfo(pcb, {
    viewer: pcb.cred,
    users: { nameOf: () => 'alice' },
    epochAtZero: 0,
    now: 1,
  });

describe('UI-133 memory numbers from the accounting model', () => {
  it('UI-133 proc.list reports each process charge once the mm tick ran', async () => {
    const w = await world();
    expect(info(w.pcb).residentBytes).toBe(0); // before the first tick
    w.io.tick();
    // initial state page 64 KiB + OVERHEAD_PROC 64 KiB (calibration.json), §3.2.1.
    expect(info(w.pcb).residentBytes).toBe(128 * KiB);
    expect(info(w.pcb).swappedBytes).toBe(0);
    expect(info(w.pcb).hitRatio).toBe(1);
  });

  it('UI-133 the constants come from the calibration file and are logged', async () => {
    const w = await world({ overheadProc: 1_024 * KiB, kappa: 1, bMain: 0, bExec: 0, bSpecial: 0 });
    w.io.tick();
    expect(info(w.pcb).residentBytes).toBe((64 + 1_024) * KiB);
    expect(w.lines().some((l) => l.startsWith('memory model: OVERHEAD_PROC 1024 KiB'))).toBe(true);
  });

  it('UI-133 a malformed calibration file falls back to the defaults with a warning', async () => {
    const w = await world({ overheadProc: 'lots' });
    w.io.tick();
    expect(info(w.pcb).residentBytes).toBe(128 * KiB);
    expect(w.lines()).toContain(
      'memory model: calibration.json is invalid, using the defaults (OVERHEAD_PROC 64 KiB · κ 1)',
    );
  });

  it('UI-133 the shipped calibration.json is the placeholder, and the log says so', async () => {
    const w = await world();
    expect(
      w
        .lines()
        .some((l) => l.includes('placeholder constants, not yet calibrated on the lab machine')),
    ).toBe(true);
  });
});
