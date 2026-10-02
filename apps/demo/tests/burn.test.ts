import { describe, expect, it } from 'vitest';

import type { Program } from '@plotinium/kernel/sys';
import { SysError } from '@plotinium/kernel/sys';

import burn, { BURN_MANIFEST, parseBurn, spin, threadArgv } from '../cmd/burn.ts';
import { FakeKernel } from './fakesys.ts';

const program = burn as unknown as Program<unknown>;
const FINAL = /^burn: (\d+) iterations, (\d+) ms CPU, max step (\d+) us\n$/;

describe('burn (processes-and-scheduling.md §3.18.10)', () => {
  it('KPS-14 burn --ms N computes N ms of CPU and prints the final line', () => {
    const k = new FakeKernel();
    const r = k.run(program, ['burn', '--ms', '5']);
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    const m = FINAL.exec(r.out);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
    expect(Number(m?.[2])).toBe(5);
    expect(Number(m?.[3])).toBeGreaterThanOrEqual(100);
    expect(r.proc.ticks).toBeGreaterThanOrEqual(45);
  });

  it('PROC-05 burn never computes longer than --step-us between two yield points', () => {
    for (const stepUs of [50, 100, 400]) {
      const k = new FakeKernel();
      const r = k.run(program, ['burn', '--ms', '20', '--step-us', String(stepUs)]);
      expect(r.status).toBe(0);
      // One step is at most S µs plus the few clock reads that start and end it.
      expect(r.proc.maxGapMs).toBeLessThanOrEqual(stepUs / 1000 + 3 * k.cpuStepMs);
    }
  });

  it('PROC-03 three burns sharing one executor all progress in round-robin slices', () => {
    const k = new FakeKernel();
    k.quantum = 10;
    const ps = [0, 1, 2].map(() => k.start(program, ['burn', '--ms', '10']));
    k.runUntil(() => ps.every((p) => p.state !== 'run'));
    for (const p of ps) {
      expect(k.statusOf(p)).toBe(0);
      expect(p.slices).toBeGreaterThan(5);
      expect(p.out).toMatch(FINAL);
    }
    // Round robin: no burn finishes before the others have had most of their slices.
    const slices = ps.map((p) => p.slices);
    expect(Math.max(...slices) - Math.min(...slices)).toBeLessThanOrEqual(2);
  });

  it('PROC-04 burn --priority and --nice are applied with setpriority before the first step', () => {
    const k = new FakeKernel();
    const r = k.run(program, ['burn', '--ms', '1', '--priority', '0', '--nice', '5']);
    expect(r.status).toBe(0);
    expect(k.callsOf('setpriority')).toEqual([{ pid: 0, priority: 0, nice: 5 }]);
    const first = k.calls.findIndex((c) => c.call === 'setpriority');
    const write = k.calls.findIndex((c) => c.call === 'write');
    expect(first).toBeLessThan(write);
  });

  it('PROC-04 a refused priority is reported and burn exits 1 without computing', () => {
    const k = new FakeKernel().fail('setpriority', 'EPERM');
    const r = k.run(program, ['burn', '--ms', '5', '--priority', '0']);
    expect(r.status).toBe(1);
    expect(r.err).toBe('burn: cannot set priority: Operation not permitted\n');
    expect(r.out).toBe('');
    expect(r.proc.ticks).toBe(0);
  });

  it('KPS-14 burn continues from its state after a page-in instead of starting again', () => {
    const k = new FakeKernel();
    const p = k.start(program, ['burn', '--ms', '10']);
    k.runUntil(() => p.ticks >= 30);
    k.restore(p, 'page-in');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(0);
    const m = FINAL.exec(p.out);
    expect(Number(m?.[2])).toBe(10);
  });

  it('KPS-14 SIGINT ends burn early with the final line and status 130', () => {
    const k = new FakeKernel();
    const p = k.start(program, ['burn']);
    k.runUntil(() => p.ticks >= 200);
    k.signal(p, 'SIGINT');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(130);
    expect(p.out).toMatch(
      /^burn: \d+ iterations, \d+ ms CPU, max step \d+ us \(stopped by SIGINT\)\n$/,
    );
  });

  it('KPS-14 SIGUSR1 prints a progress line and burn goes on', () => {
    const k = new FakeKernel();
    const p = k.start(program, ['burn', '--ms', '8']);
    k.runUntil(() => p.ticks >= 20);
    k.signal(p, 'SIGUSR1');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(0);
    const lines = p.out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^burn: \d+ of 8 ms CPU \(\d+%\), \d+ iterations, max step \d+ us$/);
    expect(lines[1]).toMatch(/ 8 ms CPU/);
  });

  it('KPS-14 --progress prints a progress line every SECS seconds', () => {
    const k = new FakeKernel();
    k.cpuStepMs = 0.05;
    const t0 = k.time;
    const r = k.run(program, ['burn', '--ms', '2500', '--progress', '1']);
    const wallSeconds = Math.floor((k.time - t0) / 1000);
    expect(r.status).toBe(0);
    const lines = r.out.trimEnd().split('\n');
    const progress = lines.filter((l) => l.includes(' of 2500 ms CPU'));
    // One line per second of wall time (the virtual clock also moves while burn reads it).
    expect(progress.length).toBeGreaterThanOrEqual(Math.max(2, wallSeconds - 1));
    expect(progress.length).toBeLessThanOrEqual(wallSeconds);
    const pct = progress.map((l) => Number(/\((\d+)%\)/.exec(l)?.[1]));
    expect([...pct].sort((a, b) => a - b)).toEqual(pct);
    expect(lines.at(-1)).toMatch(/ 2500 ms CPU, /);
  });

  it('KPS-14 --json prints the final report as one JSON object', () => {
    const k = new FakeKernel();
    const r = k.run(program, ['burn', '--ms', '3', '--json']);
    const report = JSON.parse(r.out) as Record<string, unknown>;
    expect(report['cpuMs']).toBe(3);
    expect(report['stoppedBy']).toBeNull();
    expect(Number(report['iterations'])).toBeGreaterThan(0);
  });

  it('PROC-05 burn -t 3 spawns three single-thread burns in its group and reports their status', () => {
    const k = new FakeKernel();
    k.programs.set(BURN_MANIFEST, program);
    const r = k.run(program, ['burn', '-t', '3', '--ms', '4']);
    expect(r.status).toBe(0);
    const spawns = k.callsOf('spawn') as { path: string; argv: string[] }[];
    expect(spawns).toHaveLength(3);
    for (const s of spawns)
      expect(s).toEqual({
        path: BURN_MANIFEST,
        argv: ['burn', '-t', '1', '--step-us', '100', '--ms', '4'],
      });
    const children = [...k.procs.values()].filter((p) => p.ppid === r.proc.pid);
    expect(children.every((c) => c.pgid === r.proc.pgid)).toBe(true);
    expect(k.out.match(/ 4 ms CPU, /g)).toHaveLength(3);
    expect(r.out).toBe('burn: 3 threads done, exit status 0 0 0\n');
  });

  it('PROC-04 burn --exclusive asks for exclusive executors and falls back when the kernel refuses', () => {
    const k = new FakeKernel();
    k.programs.set(BURN_MANIFEST, program);
    k.on('spawn', (a, p, kk) => {
      if ('exclusive' in a) throw new SysError('EPERM');
      return kk.spawnDefault(a, p);
    });
    const r = k.run(program, ['burn', '--exclusive', '-t', '2', '--ms', '2']);
    expect(r.status).toBe(0);
    expect(r.err).toBe(
      'burn: warning: exclusive placement refused (Operation not permitted); threads share executors\n',
    );
    const spawns = k.callsOf('spawn') as Record<string, unknown>[];
    expect(spawns[0]?.['exclusive']).toBe(true);
    expect(spawns.slice(1).every((s) => !('exclusive' in s))).toBe(true);
    expect(r.out).toBe('burn: 2 threads done, exit status 0 0\n');
  });

  it('PROC-04 SIGTERM to a threaded burn is passed on to every thread', () => {
    const k = new FakeKernel();
    k.programs.set(BURN_MANIFEST, program);
    const p = k.start(program, ['burn', '-t', '2']);
    k.runUntil(
      () => [...k.procs.values()].filter((c) => c.ppid === p.pid && c.ticks > 20).length === 2,
    );
    k.signal(p, 'SIGTERM');
    k.runUntil(() => p.state !== 'run');
    expect(k.statusOf(p)).toBe(143);
    expect(p.out).toBe('burn: 2 threads done, exit status 143 143 (stopped by SIGTERM)\n');
  });

  it('KPS-14 a failed thread spawn stops the threads already started and exits 1', () => {
    const k = new FakeKernel();
    k.programs.set(BURN_MANIFEST, program);
    let n = 0;
    k.on('spawn', (a, p, kk) => {
      n++;
      if (n === 2) throw new SysError('EAGAIN', undefined, { reason: 'nproc' });
      return kk.spawnDefault(a, p);
    });
    const r = k.run(program, ['burn', '-t', '3']);
    expect(r.status).toBe(1);
    expect(r.err).toBe('burn: cannot spawn thread: Resource temporarily unavailable (nproc)\n');
    expect(r.out).toBe('burn: 1 threads done, exit status 143\n');
  });

  it('SYS-02 burn rejects bad options with the usage and status 2', () => {
    const k = new FakeKernel();
    for (const argv of [
      ['burn', '--ms', 'x'],
      ['burn', '--step-us', '0'],
      ['burn', '-t', '65'],
      ['burn', 'extra'],
      ['burn', '--priority', '40'],
    ]) {
      const r = k.run(program, argv);
      expect(r.status).toBe(2);
      expect(r.err).toContain('Usage: burn [--ms N]');
      expect(r.out).toBe('');
    }
  });

  it('KPS-14 parseBurn and threadArgv keep every option of a thread', () => {
    const o = parseBurn([
      '--ms',
      '120000',
      '-t',
      '3',
      '--step-us',
      '200',
      '--priority',
      '39',
      '-n',
      '-2',
      '-p',
      '10',
      '--json',
    ]);
    expect(o).toEqual({
      ms: 120000,
      stepUs: 200,
      threads: 3,
      priority: 39,
      nice: -2,
      exclusive: false,
      progress: 10,
      json: true,
    });
    expect(parseBurn(threadArgv(o).slice(1))).toEqual({ ...o, threads: 1 });
  });

  it('PROC-05 spin measures its own elapsed time and always does at least one iteration', () => {
    let t = 0;
    const now = (): number => (t += 0.01);
    const r = spin(now, 0.1, 0);
    expect(r.iterations).toBeGreaterThanOrEqual(9);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0.1);
    expect(r.acc).not.toBe(0);
    expect(spin(now, 0, r.acc).iterations).toBe(1);
  });
});
