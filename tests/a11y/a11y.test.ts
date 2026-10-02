import { describe, expect, it } from 'vitest';

import { tooFrequent, type Announcement } from './announce.ts';
import { AXE_TAGS, blocking, describeViolations, THEME_PASSES, type AxeViolation } from './axe.ts';

function violation(
  id: string,
  impact: AxeViolation['impact'],
  targets: string[] = ['#x'],
): AxeViolation {
  return {
    id,
    impact,
    help: `${id} help`,
    description: '',
    helpUrl: '',
    tags: [],
    nodes: targets.map((t) => ({ target: [t], html: '', any: [], all: [], none: [], impact })),
  };
}

describe('WM-07 axe gate', () => {
  it('WM-07 only serious and critical violations fail the gate; moderate and minor are reported', () => {
    const vs = [
      violation('color-contrast', 'serious'),
      violation('region', 'moderate'),
      violation('aria-roles', 'critical'),
      violation('x', 'minor'),
      violation('y', null),
    ];
    expect(blocking(vs)).toEqual([0, 2]);
  });

  it('WM-07 every screen is scanned in both themes and with the theme forced against the system scheme', () => {
    expect(THEME_PASSES.map((p) => [p.colorScheme, p.forced])).toEqual([
      ['light', null],
      ['dark', null],
      ['light', 'dark'],
      ['dark', 'light'],
    ]);
    expect(AXE_TAGS).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  });

  it('WM-07 violation reports name the rule, the impact and the first offending nodes', () => {
    const text = describeViolations(
      [violation('color-contrast', 'serious', ['#a', '#b', '#c', '#d'])],
      2,
    );
    expect(text).toBe('[serious] color-contrast: color-contrast help (4 node(s): #a, #b)');
    expect(describeViolations([violation('z', undefined)])).toContain('[unknown]');
  });
});

describe('BOOT-13 status announcements', () => {
  const a = (t: number, text: string): Announcement => ({ t, text });

  it('BOOT-13 two ordinary announcements closer than 750 ms are flagged', () => {
    const list = [
      a(0, 'Loading kernel · 12 of 104 KB'),
      a(400, 'Loading kernel · 60 of 104 KB'),
      a(1300, 'vfs: mounting /'),
    ];
    expect(tooFrequent(list)).toEqual([[list[0], list[1]]]);
  });

  it('BOOT-13 stage changes and failures may be announced at any time', () => {
    const list = [
      a(0, 'Loading kernel · 12 of 104 KB'),
      a(100, 'Stage 4 · Service start'),
      a(200, 'sync: DEGRADED (backend unreachable)'),
      a(900, 'login: ready'),
    ];
    expect(tooFrequent(list)).toEqual([]);
  });
});
