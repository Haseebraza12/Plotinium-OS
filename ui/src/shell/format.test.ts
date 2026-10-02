import { describe, expect, it } from 'vitest';

import { falloff, magnify, restingMagnification } from './dock/magnify.ts';
import {
  badgeText,
  bytesAsMb,
  connectivitySpoken,
  connectivityText,
  formatClock,
  formatMb,
  formatTimeOfDay,
  memoryLevel,
  memoryRatio,
  memoryText,
  relativeTime,
  serviceIndicatorText,
  serviceRowText,
  serviceSummary,
} from './format.ts';
import type { SvcView } from './types.ts';

const NOW = Date.UTC(2026, 8, 24, 10, 42, 0); // Thu 24 Sep 2026 10:42 UTC

describe('UI-shell format', () => {
  it('OFF-04 connectivity uses the exact tray strings', () => {
    expect(connectivityText({ state: 'LIVE' }, NOW)).toBe('Online');
    expect(connectivityText({ state: 'SYNCING', ops: 1 }, NOW)).toBe('Syncing 1 op');
    expect(connectivityText({ state: 'SYNCING', ops: 3 }, NOW)).toBe('Syncing 3 ops');
    expect(connectivityText({ state: 'RECONNECTING', retryAt: NOW + 3200 }, NOW)).toBe(
      'Reconnecting in 4 s',
    );
    expect(connectivityText({ state: 'RECONNECTING', retryAt: NOW - 500 }, NOW)).toBe(
      'Reconnecting in 0 s',
    );
    expect(connectivityText({ state: 'OFFLINE', queued: 3 }, NOW)).toBe('Offline · 3 queued');
    expect(connectivityText({ state: 'AUTH_REQUIRED', queued: 2 }, NOW)).toBe('Sign in to sync');
  });

  it('OFF-04 the spoken connectivity label spells the state out (not colour alone)', () => {
    expect(connectivitySpoken({ state: 'LIVE' }, NOW)).toBe('Sync: Online, all changes synced');
    expect(connectivitySpoken({ state: 'OFFLINE', queued: 3 }, NOW)).toBe(
      'Sync: Offline · 3 queued',
    );
  });

  it('WMD-11 memory warns at 85% and is critical at 95%', () => {
    expect(memoryLevel({ usedMb: 142, budgetMb: 256 })).toBe('normal');
    expect(memoryLevel({ usedMb: 218, budgetMb: 256 })).toBe('warning');
    expect(memoryLevel({ usedMb: 244, budgetMb: 256 })).toBe('critical');
    expect(memoryLevel({ usedMb: 1, budgetMb: 0 })).toBe('critical');
    expect(memoryText({ usedMb: 142.4, budgetMb: 256 })).toBe('142/256 MB');
    expect(memoryRatio({ usedMb: 300, budgetMb: 256 })).toBe(1);
    expect(memoryRatio({ usedMb: 128, budgetMb: 256 })).toBe(0.5);
  });

  it('MEM-01 budget values read in MB below 1 GB and in GB above', () => {
    expect(formatMb(128)).toBe('128 MB');
    expect(formatMb(1024)).toBe('1 GB');
    expect(formatMb(1536)).toBe('1.5 GB');
    expect(bytesAsMb(3.1 * 1024 * 1024)).toBe('3.1');
  });

  it('OFF-04 degraded services use the tray wording and hide when healthy', () => {
    const services: SvcView[] = [
      { name: 'vfs', state: 'running', attempts: 0 },
      {
        name: 'sync',
        state: 'degraded',
        reason: 'backend unreachable',
        attempts: 3,
        nextRetryAt: NOW + 4000,
      },
      { name: 'lockd', state: 'blocked', blockedBy: 'sync', attempts: 0 },
      { name: 'ai.indexer', state: 'starting', attempts: 0 },
    ];
    const summary = serviceSummary(services);
    expect(summary).toEqual({ total: 4, healthy: 1, degraded: 2, starting: 1 });
    expect(serviceIndicatorText(summary)).toBe('2 degraded');
    expect(serviceIndicatorText(serviceSummary(services.slice(0, 1)))).toBeUndefined();
    expect(serviceIndicatorText(serviceSummary([services[3] as SvcView]))).toBe('starting (1)');
    expect(serviceRowText(services[1] as SvcView, NOW)).toBe(
      'sync — degraded · backend unreachable · retry in 4 s (attempt 3)',
    );
    expect(serviceRowText(services[2] as SvcView, NOW)).toBe('lockd — blocked by sync');
  });

  it('UI-MenuBar clock reads "Thu 24 Sep 10:42" in 24-hour time', () => {
    const clock = formatClock(NOW, { timeZone: 'UTC' });
    expect(clock.date).toBe('Thu 24 Sep');
    expect(clock.time).toBe('10:42');
    expect(clock.spoken).toBe('Thursday 24 September, 10:42');
    expect(formatTimeOfDay(NOW - 60_000, { timeZone: 'UTC' })).toBe('10:41');
  });

  it('WMD-18 notification times are relative and have a spoken form', () => {
    expect(relativeTime(NOW - 5_000, NOW)).toEqual({ short: 'now', spoken: 'just now' });
    expect(relativeTime(NOW - 120_000, NOW)).toEqual({ short: '2m ago', spoken: '2 minutes ago' });
    expect(relativeTime(NOW - 60_000, NOW).spoken).toBe('1 minute ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW).short).toBe('3h ago');
    expect(relativeTime(NOW - 50 * 3_600_000, NOW).short).toBe('2d ago');
    expect(relativeTime(NOW + 10_000, NOW).short).toBe('now');
  });

  it('UI-Dock badge counts cap at 99+', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(120)).toBe('99+');
  });
});

describe('UI-Dock magnification', () => {
  it('WM-03 the icon under the pointer reaches the maximum and the fall-off ends at 2.5 widths', () => {
    expect(falloff(0)).toBeCloseTo(1.5);
    expect(falloff(2.5)).toBe(1);
    expect(falloff(-3)).toBe(1);
    expect(falloff(1)).toBeGreaterThan(falloff(2));
    expect(falloff(1)).toBeCloseTo(falloff(-1));
  });

  it('WM-03 magnified slots stay contiguous and grow evenly about the dock centre', () => {
    const size = 52;
    const slots = [0, 1, 2, 3, 4].map((i) => ({ centre: 100 + i * 58, magnify: true }));
    const m = magnify(slots[2]?.centre ?? 0, slots, size);
    expect(m.scales[2]).toBeCloseTo(1.5);
    expect(m.scales[1]).toBeCloseTo(m.scales[3] ?? 0);
    // Symmetric about the middle slot: the middle one does not move.
    expect(m.shifts[2]).toBeCloseTo(0);
    expect(m.shifts[0]).toBeCloseTo(-(m.shifts[4] ?? 0));
    // Neighbours never overlap: each gap grows by half of both icons' growth.
    for (let i = 1; i < slots.length; i++) {
      const prev = (slots[i - 1]?.centre ?? 0) + (m.shifts[i - 1] ?? 0);
      const next = (slots[i]?.centre ?? 0) + (m.shifts[i] ?? 0);
      const halfWidths = ((m.scales[i - 1] ?? 1) * size + (m.scales[i] ?? 1) * size) / 2;
      expect(next - prev).toBeGreaterThanOrEqual(halfWidths - 1e-9);
    }
    const grow = m.scales.reduce((sum, s) => sum + (s - 1) * size, 0);
    expect(m.extra).toBeCloseTo(grow);
  });

  it('WM-03 separators never scale but move with their neighbours', () => {
    const slots = [
      { centre: 100, magnify: true },
      { centre: 140, magnify: false },
      { centre: 180, magnify: true },
    ];
    const m = magnify(100, slots, 52);
    expect(m.scales[1]).toBe(1);
    expect(m.shifts[1]).not.toBe(0);
    expect(restingMagnification(3)).toEqual({ scales: [1, 1, 1], shifts: [0, 0, 0], extra: 0 });
  });
});
