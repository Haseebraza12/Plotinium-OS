/**
 * KPS-08 executor loss through the whole kernel on the process loopback host
 * (processes-and-scheduling.md §3.15): a crashed realm terminates its executor, the running
 * process and its co-residents exit 137 (`collateral`, no clean checkpoint to restore from), and a
 * fresh executor is started for the same isolation key so later spawns work; a forged frame that
 * claims another process's slice is audited and marks the executor SUSPECT, and a second one
 * terminates it (ABI-02, INV-P6).
 */
import { describe, expect, it } from 'vitest';

import { CTL, CTL_FLAG } from '../../core/sched/control-block.ts';
import { exited, loopback, trace } from './proc-harness.ts';

describe('KPS-08 executor loss', () => {
  it('KPS-08 a realm crash ends the running process and its co-residents with 137 collateral and respawns the executor', async () => {
    const lb = loopback({ cores: 3, sched: { maxExecutors: 2 } });
    const a = await lb.spawn('burn');
    const b = await lb.spawn('script', { argv: ['script', 'forever'] });
    await lb.runFor(20);
    const e = a.worker;
    expect(e).not.toBeNull();
    const coResidents = [...lb.kernel.proc.pool.slot(e ?? 0).residents];
    expect(coResidents).toContain(a.pid);
    const startsBefore = lb.executors.starts.filter((i) => i === e).length;

    lb.executors.crash(e ?? 0, 'simulated realm error');
    await lb.until(
      () =>
        coResidents.every(
          (pid) => lb.kernel.procs.get(pid) === undefined || exited(lb.kernel.procs.get(pid) ?? a),
        ),
      1_000,
    );
    for (const pid of coResidents) {
      const t = trace(lb, pid);
      expect(t.some((x) => x.endsWith('>TERMINATED:collateral'))).toBe(true);
    }
    expect(a.exitCode).toBe(137);
    expect(a.exitReason).toBe('collateral');
    // A fresh realm for the same isolation key.
    expect(lb.executors.starts.filter((i) => i === e).length).toBe(startsBefore + 1);
    expect(lb.executors.terminations).toContain(e);
    // Later spawns still run to completion.
    const c = await lb.spawn('burn', { argv: ['burn', '40'] });
    await lb.until(() => exited(c), 2_000);
    expect(c.exitCode).toBe(0);
    if (!coResidents.includes(b.pid)) lb.kernel.proc.signalPid(b.pid, 'SIGKILL');
    lb.checkInvariants();
  });

  it('KPS-08 a forged frame for another slice is audited and marks the executor SUSPECT; a second one terminates it', async () => {
    const lb = loopback({ cores: 3 });
    const a = await lb.spawn('burn');
    expect(await lb.until(() => a.state === 'RUNNING', 1_000)).toBe(true);
    const e = a.worker ?? 0;
    const slice = lb.kernel.proc.sched.sliceOf(e);
    expect(slice?.pid).toBe(a.pid);
    const seq = slice?.sliceSeq ?? 0;
    lb.executors.inject(e, {
      t: 'yield',
      pid: a.pid + 100,
      sliceSeq: seq,
      cpuMs: 1,
      steps: 1,
      maxStepUs: 1,
    });
    const audit = lb.kernel.klog.read({
      filter: (r) => r.kind === 'line' && r.msg.includes('identity-mismatch'),
    });
    expect(audit.length).toBe(1);
    const ctl = lb.executors.ctl(e);
    expect(ctl).not.toBeNull();
    if (ctl !== null) expect((Atomics.load(ctl, CTL.FLAGS) & CTL_FLAG.SUSPECT) !== 0).toBe(true);
    expect(a.state).toBe('RUNNING');
    lb.executors.inject(e, {
      t: 'yield',
      pid: a.pid + 100,
      sliceSeq: seq,
      cpuMs: 1,
      steps: 1,
      maxStepUs: 1,
    });
    await lb.until(() => exited(a), 1_000);
    expect(a.exitCode).toBe(137);
    expect(lb.executors.terminations).toContain(e);
    lb.checkInvariants();
  });
});
