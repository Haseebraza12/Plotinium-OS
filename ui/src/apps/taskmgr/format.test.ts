import { describe, expect, it } from 'vitest';

import {
  agingBound,
  bandOf,
  basePriority,
  canEnd,
  formatBytes,
  formatMB,
  formatNice,
  formatUptime,
  formatWait,
  frameTone,
  matchesQuery,
  sparkPath,
  stateName,
  trendOf,
} from './format.ts';

const MB = 1048576;

describe('UI-TaskManager format', () => {
  it('PROC-04 the aging bound matches the declared values of processes-and-scheduling.md §3.12.5', () => {
    const declared = { p: 39, tAgeMs: 100, n: 51, e: 1, qMs: 20, deltaMs: 1, hKillMs: 400 };
    expect(agingBound(declared)).toBe(5450);
    expect(agingBound({ ...declared, n: 6, e: 1 })).toBe(4505);
    expect(agingBound({ ...declared, n: 6, e: 2 })).toBe(4463);
    expect(agingBound({ ...declared, n: 6, e: 5 })).toBe(4421);
    expect(agingBound({ ...declared, tAgeMs: 250 })).toBe(11450);
    expect(agingBound({ ...declared, e: 0 })).toBe(5450);
  });

  it('PROC-03 PRI is clamp(priority + nice, 0, 39) and maps to its band', () => {
    expect(basePriority(22, 10)).toBe(32);
    expect(basePriority(20, -20)).toBe(0);
    expect(basePriority(30, 19)).toBe(39);
    expect(bandOf(0)).toBe('interactive');
    expect(bandOf(9)).toBe('interactive');
    expect(bandOf(10)).toBe('normal');
    expect(bandOf(29)).toBe('normal');
    expect(bandOf(30)).toBe('background');
    expect(formatNice(12)).toBe('+12');
    expect(formatNice(-5)).toBe('-5');
    expect(formatNice(0)).toBe('0');
  });

  it('formats sizes in binary units with one label everywhere', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12.4 * MB)).toBe('12.4 MB');
    expect(formatBytes(1.2 * 1024 * MB)).toBe('1.2 GB');
    expect(formatMB(256 * MB)).toBe('256 MB');
    expect(formatMB(198.4 * MB)).toBe('198.4 MB');
  });

  it('formats uptime and waits', () => {
    expect(formatUptime((2 * 3600 + 14 * 60) * 1000)).toBe('2h 14m');
    expect(formatUptime(63_000)).toBe('1m 03s');
    expect(formatUptime(42_000)).toBe('42s');
    expect(formatWait(3920)).toBe('3.92 s');
    expect(formatWait(380)).toBe('380 ms');
  });

  it('PROC-05 frame tone: ok to 16.7 ms, warn to 33 ms, bad above', () => {
    expect(frameTone(14.2)).toBe('ok');
    expect(frameTone(16.7)).toBe('ok');
    expect(frameTone(20)).toBe('warn');
    expect(frameTone(40)).toBe('bad');
  });

  it('DSN-08 state names carry the reason in words', () => {
    expect(stateName({ state: 'BLOCKED', reason: 'awaiting llm' })).toBe('Blocked, awaiting llm');
    expect(stateName({ state: 'RUNNING' })).toBe('Running');
  });

  it('End Process is refused for pid 1 and kernel services', () => {
    expect(canEnd(undefined)).toBe(false);
    expect(canEnd({ pid: 1, badges: [] })).toBe(false);
    expect(canEnd({ pid: 3, badges: ['kernel'] })).toBe(false);
    expect(canEnd({ pid: 9, badges: [], protected: true })).toBe(false);
    expect(canEnd({ pid: 301, badges: [] })).toBe(true);
  });

  it('filters by name, pid prefix and user', () => {
    const row = { pid: 301, name: 'burn', user: 'student' };
    expect(matchesQuery(row, '')).toBe(true);
    expect(matchesQuery(row, 'BUR')).toBe(true);
    expect(matchesQuery(row, '30')).toBe(true);
    expect(matchesQuery(row, 'stud')).toBe(true);
    expect(matchesQuery(row, 'xyz')).toBe(false);
  });

  it('WM-03 sparkline geometry is a single path with a fixed step', () => {
    const g = sparkPath([0, 50, 100], 100, 20);
    expect(g.step).toBe(50);
    expect(g.line).toBe('M0.0,19.0L50.0,10.0L100.0,1.0');
    expect(g.area.endsWith('L100.0,20L0.0,20Z')).toBe(true);
    expect(sparkPath([], 100, 20).line).toBe('');
    expect(sparkPath([150, -10], 10, 10).line).toBe('M0.0,1.0L10.0,9.0');
  });

  it('describes trends for accessible chart summaries', () => {
    expect(trendOf([10, 12, 30])).toBe('rising');
    expect(trendOf([30, 12, 10])).toBe('falling');
    expect(trendOf([10, 10.2])).toBe('steady');
    expect(trendOf([5])).toBe('steady');
  });
});
