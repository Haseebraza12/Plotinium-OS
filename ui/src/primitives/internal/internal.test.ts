import { describe, expect, it } from 'vitest';

import { createTypeahead, matchTypeahead, stepIndex } from './list-nav.ts';
import { computePosition, originFor } from './position.ts';

describe('UI-internal', () => {
  const viewport = { width: 1000, height: 800 };

  it('UI-Popover positions below the anchor, start-aligned, with the offset', () => {
    const pos = computePosition(
      { x: 100, y: 100, width: 80, height: 24 },
      { width: 200, height: 150 },
      'bottom-start',
      viewport,
    );
    expect(pos).toEqual({ x: 100, y: 130, side: 'bottom', align: 'start' });
    expect(originFor(pos)).toBe('top left');
  });

  it('UI-Popover flips above the anchor when there is no room below', () => {
    const pos = computePosition(
      { x: 100, y: 700, width: 80, height: 24 },
      { width: 200, height: 150 },
      'bottom-start',
      viewport,
    );
    expect(pos.side).toBe('top');
    expect(pos.y).toBe(700 - 150 - 6);
  });

  it('UI-Popover clamps into the viewport margin', () => {
    const pos = computePosition(
      { x: 950, y: 10, width: 0, height: 0 },
      { width: 200, height: 100 },
      'bottom-start',
      viewport,
    );
    expect(pos.x).toBe(1000 - 200 - 8);
  });

  it('UI-Menu arrow navigation skips disabled items and wraps', () => {
    const disabled = (i: number): boolean => i === 1;
    expect(stepIndex(0, 1, 4, disabled, true)).toBe(2);
    expect(stepIndex(3, 1, 4, disabled, true)).toBe(0);
    expect(stepIndex(0, -1, 4, disabled, true)).toBe(3);
    expect(stepIndex(3, 1, 4, disabled, false)).toBe(3);
  });

  it('UI-Menu type-ahead matches prefixes and cycles on a repeated letter', () => {
    const labels = ['Copy', 'Cut', 'Paste', 'Compress'];
    const none = (): boolean => false;
    const type = createTypeahead(500);
    expect(matchTypeahead(labels, type('c', 0), 0, none)).toBe(1);
    expect(matchTypeahead(labels, type('c', 100), 1, none)).toBe(3);
    const fresh = createTypeahead(500);
    expect(fresh('c', 0)).toBe('c');
    expect(fresh('o', 100)).toBe('co');
    expect(matchTypeahead(labels, 'com', 0, none)).toBe(3);
    expect(fresh('p', 2000)).toBe('p');
  });
});
