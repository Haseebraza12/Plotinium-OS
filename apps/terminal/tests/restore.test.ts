/**
 * A restored Terminal window shows its previous text (UI-127; shell-and-terminal.md §3.3 "term
 * snapshot"): the controller's snapshot of its tabs, the checks on a snapshot a host hands back,
 * and the restore that reopens the tabs in their directories with their text first.
 */
import { describe, expect, it } from 'vitest';

import type { TermSurface, TerminalViewState } from '../controller.ts';
import {
  parseSnapshot,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_LINES,
  snapshotText,
  TerminalController,
} from '../controller.ts';
import { ProcessHost } from '../host/host.ts';
import { bundledPrograms } from '../host/programs.ts';
import { localBackend } from '../session.ts';
import { FakeSys } from './fake-sys.ts';
import { ManualClock, Screen } from './harness.ts';

class Surface implements TermSurface {
  readonly screen = new Screen(100);
  private readonly dec = new TextDecoder();
  constructor(initialText = '') {
    // TerminalHost writes the restored text before any shell output.
    this.screen.write(initialText);
  }
  write(data: Uint8Array, parsed: () => void): void {
    this.screen.write(this.dec.decode(data, { stream: true }));
    parsed();
  }
  size(): { cols: number; rows: number } {
    return { cols: 100, rows: 30 };
  }
  snapshot(): string {
    return snapshotText(this.screen.lines());
  }
}

function setup(): {
  controller: TerminalController;
  clock: ManualClock;
  last: () => TerminalViewState;
} {
  const fs = new FakeSys();
  const clock = new ManualClock();
  const host = new ProcessHost({ programs: bundledPrograms(), delegate: fs.call, clock });
  const states: TerminalViewState[] = [];
  const controller = new TerminalController({
    backend: localBackend({ host }),
    onChange: (s) => states.push(s),
    frame: { next: (fn) => clock.defer(fn) },
    maxTabs: 4,
  });
  return { controller, clock, last: () => states.at(-1) ?? controller.state() };
}

/** Mounts a surface for every tab the way TerminalApp does: with the tab's initial text. */
async function mountAll(t: ReturnType<typeof setup>): Promise<Map<string, Surface>> {
  const surfaces = new Map<string, Surface>();
  for (const tab of t.last().tabs) {
    const surface = new Surface(tab.initialText);
    surfaces.set(tab.id, surface);
    t.controller.ready(tab.id, surface);
  }
  await t.clock.settle();
  return surfaces;
}

describe('UI-127 snapshot text', () => {
  it('UI-127 drops the blank rows below the last line and keeps the last 2,000 lines', () => {
    expect(snapshotText(['a', 'b', '', '  ', ''])).toBe('a\nb');
    expect(snapshotText(['', ''])).toBe('');
    const many = Array.from({ length: SNAPSHOT_MAX_LINES + 5 }, (_, i) => `line ${String(i)}`);
    const text = snapshotText(many).split('\n');
    expect(text).toHaveLength(SNAPSHOT_MAX_LINES);
    expect(text[0]).toBe('line 5');
    expect(text.at(-1)).toBe(`line ${String(SNAPSHOT_MAX_LINES + 4)}`);
  });

  it('UI-127 keeps whole lines from the end within 512 KiB of UTF-8', () => {
    const wide = 'é'.repeat(1_000); // 2,000 bytes a line
    const text = snapshotText(Array.from({ length: 400 }, () => wide));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(text.split('\n').every((l) => l === wide)).toBe(true);
    expect(snapshotText(['abc', 'def'], 10, 5)).toBe('def');
  });
});

describe('UI-127 snapshots a host hands back', () => {
  it('UI-127 anything but a v1 snapshot is ignored, and a valid one is capped', () => {
    for (const bad of [
      undefined,
      null,
      'text',
      { v: 2, tabs: [{ cwd: '/', text: '' }], selected: 0 },
      { v: 1, tabs: [], selected: 0 },
      { v: 1, tabs: [{ cwd: 1, text: '' }], selected: 0 },
      { v: 1, tabs: 'x', selected: 0 },
    ]) {
      expect(parseSnapshot(bad)).toBeNull();
    }
    const five = Array.from({ length: 5 }, (_, i) => ({ cwd: `/t${String(i)}`, text: 'x' }));
    const parsed = parseSnapshot({ v: 1, tabs: five, selected: 9 }, 3);
    expect(parsed?.tabs.map((t) => t.cwd)).toEqual(['/t0', '/t1', '/t2']);
    expect(parsed?.selected).toBe(2);
    // A relative directory is not trusted: that tab starts in home.
    expect(parseSnapshot({ v: 1, tabs: [{ cwd: 'rel', text: 'a\n\n' }] })?.tabs[0]).toEqual({
      cwd: '',
      text: 'a',
    });
  });
});

describe('UI-127 restoring a Terminal window', () => {
  it('UI-127 a snapshot of the tabs reopens them in their folders with their text before the new prompt', async () => {
    const t = setup();
    await t.controller.newTab();
    const first = await mountAll(t);
    const a = t.last().tabs[0]?.id ?? '';
    t.controller.data(a, 'cd /tmp\r');
    await t.clock.settle();
    t.controller.data(a, 'echo remembered\r');
    await t.clock.settle();
    await t.controller.newTab();
    const b = t.last().tabs[1]?.id ?? '';
    t.controller.ready(b, new Surface());
    await t.clock.settle();
    t.controller.select(a);
    expect(first.get(a)?.screen.text()).toMatch(/^remembered$/m);

    const snap = t.controller.snapshot();
    expect(snap.selected).toBe(0);
    expect(snap.tabs.map((x) => x.cwd)).toEqual(['/tmp', '/home/demo']);
    expect(snap.tabs[0]?.text).toMatch(/^remembered$/m);
    t.controller.dispose();

    // A new window of the next session, handed the saved snapshot.
    const r = setup();
    await r.controller.restore(snap);
    const tabs = r.last().tabs;
    expect(tabs).toHaveLength(2);
    expect(r.last().selected).toBe(tabs[0]?.id);
    expect(tabs[0]?.initialText).toContain('remembered\r\n');
    const surfaces = await mountAll(r);
    const screen = surfaces.get(tabs[0]?.id ?? '')?.screen;
    const lines = screen?.lines() ?? [];
    // The old text first, then the new shell's prompt, in the saved folder.
    expect(lines.indexOf('remembered')).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('remembered')).toBeLessThan(screen?.cursorRow ?? 0);
    expect(lines[screen?.cursorRow ?? 0]).toBe('demo@plotinium:/tmp$');
    expect(r.last().tabs.map((x) => x.title)).toEqual(['/tmp', '/home/demo']);
    r.controller.dispose();
  });

  it('UI-127 a saved folder that is gone starts the shell in home; a tab not mounted yet keeps its text', async () => {
    const r = setup();
    await r.controller.restore({
      v: 1,
      tabs: [{ cwd: '/no/such/folder', text: 'old line' }],
      selected: 0,
    });
    expect(r.controller.snapshot().tabs[0]?.text).toBe('old line');
    const surfaces = await mountAll(r);
    const screen = [...surfaces.values()][0]?.screen;
    expect(screen?.lines()[0]).toBe('old line');
    expect(screen?.lines()[screen.cursorRow]).toBe('demo@plotinium:~$');
    r.controller.dispose();
  });
});
