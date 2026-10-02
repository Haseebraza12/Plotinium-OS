/**
 * The Terminal window's model without the DOM (./controller.ts; UI guide §3.6.3;
 * shell-and-terminal.md §3.3): tabs with one shell each, the title following the shell's
 * directory, background activity, the grid size reaching the TTY, and closing the window when the
 * last shell exits. Plus the backend choice of ./session.ts and the Terminal's descriptor.
 */
import { describe, expect, it } from 'vitest';

import type { TermSurface, TerminalViewState } from '../controller.ts';
import { TerminalController } from '../controller.ts';
import { ProcessHost } from '../host/host.ts';
import { bundledPrograms } from '../host/programs.ts';
import { descriptor, TERMINAL_MENU } from '../manifest.ts';
import term from '../proc.ts';
import type { SessionBackend } from '../session.ts';
import { autoBackend, callPortOf, localBackend, probeKernelTty } from '../session.ts';
import { FakeSys } from './fake-sys.ts';
import { ManualClock, Screen } from './harness.ts';

class Surface implements TermSurface {
  readonly screen = new Screen(100);
  cleared = 0;
  private readonly dec = new TextDecoder();
  private readonly grid = { cols: 100, rows: 30 };
  write(data: Uint8Array, parsed: () => void): void {
    this.screen.write(this.dec.decode(data, { stream: true }));
    parsed();
  }
  size(): { cols: number; rows: number } {
    return this.grid;
  }
  clear(): void {
    this.cleared += 1;
  }
}

function setup(): {
  controller: TerminalController;
  clock: ManualClock;
  states: TerminalViewState[];
  titles: string[];
  empty: () => number;
  last: () => TerminalViewState;
} {
  const fs = new FakeSys();
  const clock = new ManualClock();
  const host = new ProcessHost({ programs: bundledPrograms(), delegate: fs.call, clock });
  const states: TerminalViewState[] = [];
  const titles: string[] = [];
  let empty = 0;
  const controller = new TerminalController({
    backend: localBackend({ host }),
    onChange: (s) => states.push(s),
    setTitle: (t) => titles.push(t),
    onEmpty: () => {
      empty += 1;
    },
    frame: { next: (fn) => clock.defer(fn) },
    maxTabs: 3,
  });
  return {
    controller,
    clock,
    states,
    titles,
    empty: () => empty,
    last: () => states.at(-1) ?? controller.state(),
  };
}

async function openTab(t: ReturnType<typeof setup>): Promise<{ id: string; surface: Surface }> {
  const id = await t.controller.newTab();
  if (id === null) throw new Error('no tab');
  const surface = new Surface();
  t.controller.ready(id, surface);
  await t.clock.settle();
  return { id, surface };
}

async function type(t: ReturnType<typeof setup>, id: string, text: string): Promise<void> {
  t.controller.data(id, text);
  await t.clock.settle();
}

describe('TerminalController', () => {
  it('SYS-02 a tab runs a login shell and its output reaches xterm', async () => {
    const t = setup();
    const { id, surface } = await openTab(t);
    expect(surface.screen.lines()[surface.screen.cursorRow]).toBe('demo@plotinium:~$');
    await type(t, id, 'echo hi | cat\r');
    expect(surface.screen.text()).toMatch(/^hi$/m);
  });

  it('SHL-02 the title follows the shell’s directory (demo@plotinium: ~/…)', async () => {
    const t = setup();
    const { id } = await openTab(t);
    expect(t.titles.at(-1)).toBe('demo@plotinium: ~');
    await type(t, id, 'cd /tmp\r');
    expect(t.titles.at(-1)).toBe('demo@plotinium: /tmp');
    expect(t.last().cwd).toBe('/tmp');
    expect(t.last().tabs[0]?.label).toBe('sh 1 — /tmp');
    expect(t.last().tabs[0]?.title).toBe('/tmp');
  });

  it('UI-122 tabs in the same directory get distinct labels', async () => {
    const t = setup();
    await openTab(t);
    await openTab(t);
    expect(t.last().tabs.map((x) => x.label)).toEqual(['sh 1 — ~', 'sh 2 — ~']);
  });

  it('SHL-08 each tab has its own shell; background output marks the tab', async () => {
    const t = setup();
    const a = await openTab(t);
    const b = await openTab(t);
    expect(t.last().tabs.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(t.last().selected).toBe(b.id);
    await type(t, a.id, 'echo from-a\r');
    expect(a.surface.screen.text()).toMatch(/^from-a$/m);
    expect(b.surface.screen.text()).not.toMatch(/from-a/);
    expect(t.last().tabs[0]?.activity).toBe('output');
    t.controller.step(-1);
    expect(t.last().selected).toBe(a.id);
    expect(t.last().tabs[0]?.activity).toBe('none');
  });

  it('SHL-02 the tab limit disables new tabs', async () => {
    const t = setup();
    await openTab(t);
    await openTab(t);
    await openTab(t);
    expect(t.last().canAddTab).toBe(false);
    expect(await t.controller.newTab()).toBeNull();
  });

  it('SHL-02 exit in the last tab closes the window; closing a tab hangs it up', async () => {
    const t = setup();
    const a = await openTab(t);
    const b = await openTab(t);
    t.controller.closeTab(b.id);
    await t.clock.advance(1_000);
    expect(t.last().tabs.map((x) => x.id)).toEqual([a.id]);
    expect(t.empty()).toBe(0);
    await type(t, a.id, 'exit\r');
    await t.clock.settle();
    expect(t.last().tabs).toEqual([]);
    expect(t.empty()).toBe(1);
  });

  it('SHL-02 a new grid size reaches the TTY (SIGWINCH, $COLUMNS)', async () => {
    const t = setup();
    const { id, surface } = await openTab(t);
    t.controller.resize(id, { cols: 132, rows: 43 });
    await t.clock.settle();
    await type(t, id, 'echo $COLUMNS x $LINES\r');
    expect(surface.screen.text()).toMatch(/^132 x 43$/m);
  });

  it('SHL-01 Clear Scrollback clears the selected xterm', async () => {
    const t = setup();
    const { id, surface } = await openTab(t);
    t.controller.clear(id);
    expect(surface.cleared).toBe(1);
  });
});

describe('backend choice', () => {
  function fakeBackend(kind: 'kernel' | 'local'): SessionBackend & { disposed: number } {
    const b = {
      kind,
      tabs: kind === 'local',
      disposed: 0,
      user: () => kind,
      open: () => Promise.reject(new Error(kind)),
      dispose: () => {
        b.disposed += 1;
      },
    };
    return b;
  }

  it('SHL-01 the kernel TTY is used when tty.resize succeeds, the process host otherwise', async () => {
    const ok = { call: () => Promise.resolve({}) };
    const nosys = {
      call: () => Promise.reject(Object.assign(new Error('ENOSYS'), { errno: 'ENOSYS' })),
    };
    expect(await probeKernelTty(ok, { cols: 80, rows: 24 })).toBe(true);
    expect(await probeKernelTty(nosys, { cols: 80, rows: 24 })).toBe(false);
    const auto = autoBackend(
      () => probeKernelTty(nosys, { cols: 80, rows: 24 }),
      () => fakeBackend('kernel'),
      () => fakeBackend('local'),
    );
    expect(auto.tabs).toBe(true);
    await expect(auto.open({ cols: 80, rows: 24 })).rejects.toThrow('local');
    expect(auto.kind).toBe('local');
  });

  it('SYS-01 the typed view client is used as the untyped delegate unchanged', async () => {
    const seen: [string, unknown][] = [];
    const port = callPortOf({
      call: (name, args) => {
        seen.push([name, args]);
        return Promise.resolve({ ok: true });
      },
    });
    expect(await port.call('stat', { path: '/tmp' })).toEqual({ ok: true });
    expect(seen).toEqual([['stat', { path: '/tmp' }]]);
  });
});

describe('the Terminal descriptor', () => {
  it('SYS-02 descriptor: id, manifest, window and menus agree', async () => {
    expect(descriptor.id).toBe('terminal');
    expect(descriptor.manifest.name).toBe(descriptor.id);
    expect(descriptor.manifest.kind).toBe('app');
    expect(descriptor.manifest.entry).toBe('apps/terminal/proc');
    expect(descriptor.icon).toBe('terminal');
    expect(descriptor.window.resizable).toBe(true);
    const ids = (descriptor.menus ?? []).flatMap((m) =>
      m.items.flatMap((i) => ('id' in i && i.id !== undefined ? [i.id] : [])),
    );
    expect(new Set(ids)).toEqual(new Set(Object.values(TERMINAL_MENU)));
    const program = await descriptor.program?.();
    expect(program).toBe(term);
  });
});
