/**
 * The desktop-shell polish wave (docs/design/bug-hunt/BUGS.md, owner fix-desktop-shell): the menu
 * bar, its status items, the Dock, Control Centre and the notifications, each against the bug it
 * fixes. Styles are checked in the CSS text (`?raw`); layout and contrast are checked in Chrome.
 */
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import ccCss from './control-centre/ControlCentre.module.css?raw';
import { ControlCentre } from './control-centre/ControlCentre.tsx';
import dockCss from './dock/Dock.module.css?raw';
import { Dock } from './dock/Dock.tsx';
import { dockItemLabel } from './dock/DockIcon.tsx';
import {
  connectivityDetail,
  connectivityShort,
  connectivitySpoken,
  connectivityText,
  formatClock,
  formatMb,
  formatTimeOfDay,
  memorySpoken,
  memoryText,
} from './format.ts';
import menuCss from './menubar/MenuBar.module.css?raw';
import { appMenuItems, MenuBar, systemMenuItems } from './menubar/MenuBar.tsx';
import { NotificationCenter } from './notifications/NotificationCenter.tsx';
import notesCss from './notifications/Notifications.module.css?raw';
import { NotificationCard } from './notifications/NotificationCard.tsx';
import type { DockItem, MemoryView, NetView, ShellNotification, SvcView } from './types.ts';

const NOW = Date.UTC(2026, 8, 24, 21, 5, 0);
const UNLINKED: NetView = { state: 'UNAVAILABLE', queued: 0, reason: 'sync client not linked' };

/** The text of the CSS rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at) + 1);
}

describe('UI-desktop-shell format', () => {
  it('UI-040 the clock follows Settings › 24-hour time: "21:05" or "9:05 PM"', () => {
    expect(formatClock(NOW, { timeZone: 'UTC' }).time).toBe('21:05');
    expect(formatClock(NOW, { timeZone: 'UTC', hour12: true }).time).toBe('9:05 PM');
    expect(formatClock(NOW, { timeZone: 'UTC', hour12: true }).spoken).toBe(
      'Thursday 24 September, 9:05 PM',
    );
    expect(formatTimeOfDay(Date.UTC(2026, 8, 24, 0, 7), { timeZone: 'UTC', hour12: true })).toBe(
      '12:07 AM',
    );
    expect(formatTimeOfDay(Date.UTC(2026, 8, 24, 0, 7), { timeZone: 'UTC' })).toBe('00:07');
  });

  it('UI-090 small memory values never round to "0/256 MB"; one format for menu bar and Control Centre', () => {
    const m = (usedMb: number): MemoryView => ({ usedMb, budgetMb: 256 });
    expect(memoryText(m(0.1))).toBe('102 KB/256 MB');
    expect(memoryText(m(0.0001))).toBe('1 KB/256 MB');
    expect(memoryText(m(3.25))).toBe('3.3/256 MB');
    expect(memoryText(m(9.96))).toBe('10/256 MB');
    expect(memoryText(m(0))).toBe('0/256 MB');
    expect(memoryText(m(142.4))).toBe('142/256 MB');
    expect(formatMb(0.1)).toBe('102 KB');
    expect(formatMb(0.9999)).toBe('1 MB');
    expect(formatMb(3.25)).toBe('3.3 MB');
    expect(formatMb(9.96)).toBe('10 MB');
    // UI-085: the accessible name starts with the visible text and says the share in words.
    expect(memorySpoken(m(0.1))).toBe('102 KB/256 MB memory used, less than 1 percent');
    expect(memorySpoken(m(142))).toBe('142/256 MB memory used, 55 percent');
  });

  it('UI-025 a degraded sync service reads "Sync unavailable", never "all changes synced"', () => {
    expect(connectivityText(UNLINKED, NOW)).toBe('Sync unavailable');
    expect(connectivityText({ ...UNLINKED, queued: 2 }, NOW)).toBe('Sync unavailable · 2 queued');
    expect(connectivitySpoken(UNLINKED, NOW)).toBe(
      'Sync: Sync unavailable, sync client not linked',
    );
    expect(connectivityDetail(UNLINKED, undefined)).toBe(
      'Sync client not linked · changes stay on this device',
    );
    expect(connectivityShort(UNLINKED, undefined)).toBe('Client not linked');
    expect(connectivityShort({ state: 'LIVE' }, '10:41')).toBe('Synced at 10:41');
    expect(connectivitySpoken({ state: 'LIVE' }, NOW)).toBe('Sync: Online, all changes synced');
  });
});

describe('UI-desktop-shell menu bar', () => {
  it('UI-023 a status change never re-creates the titles: focus stays on the atom menu', async () => {
    // A conditional spread in the parent makes every prop read track `memory` (the bug's cause).
    const [memory, setMemory] = createSignal<MemoryView | undefined>(undefined);
    const [appName, setAppName] = createSignal('Files');
    render(() => (
      <MenuBar
        appName={appName()}
        menus={[]}
        net={{ state: 'LIVE' }}
        now={NOW}
        onMenuSelect={() => undefined}
        onSystemAction={() => undefined}
        onStatus={() => undefined}
        {...(memory() === undefined ? {} : { memory: memory() })}
      />
    ));
    const atom = screen.getByRole('menuitem', { name: 'Plotinium' });
    const app = screen.getByRole('menuitem', { name: 'Files' });
    const label = app.firstElementChild;
    atom.focus();
    for (let i = 1; i <= 5; i++) setMemory({ usedMb: i, budgetMb: 256 });
    expect(screen.getByRole('menuitem', { name: 'Plotinium' })).toBe(atom);
    expect(atom.isConnected).toBe(true);
    expect(document.activeElement).toBe(atom);
    expect(app.firstElementChild).toBe(label);
    // The label animates (a new element) only when the focused app really changes.
    setAppName('Terminal');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeTruthy());
    expect(document.activeElement).toBe(atom);
  });

  it('UI-028 the atom menu offers "Log Out <user>…" in the specified order', async () => {
    const onSystemAction = vi.fn();
    render(() => (
      <MenuBar
        appName="Files"
        userName="alice"
        menus={[]}
        net={{ state: 'LIVE' }}
        now={NOW}
        onMenuSelect={() => undefined}
        onSystemAction={onSystemAction}
        onStatus={() => undefined}
      />
    ));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plotinium' }));
    const menu = await screen.findByRole('menu', { name: 'Plotinium' });
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent.trim()),
    ).toEqual([
      'About Plotinium',
      'Settings…',
      'Lock Screen',
      'Log Out alice…',
      'Restart…',
      'Shut Down…',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log Out alice…' }));
    expect(onSystemAction).toHaveBeenCalledWith('logout');
    expect(systemMenuItems().some((i) => 'label' in i && i.label === 'Log Out…')).toBe(true);
  });

  it('UI-086 Quit <App> carries no Alt+Q hint (Alt+Q closes only the focused window)', () => {
    const quit = appMenuItems('Files').find((i) => i.kind !== 'separator' && i.id === 'quit');
    expect(quit).toEqual({ id: 'quit', label: 'Quit Files' });
  });

  it('UI-085 a "Menu bar" landmark; distinct names; both triggers of one popup say it is open', () => {
    render(() => (
      <MenuBar
        appName="Plotinium"
        appLabel="Plotinium desktop"
        menus={[]}
        net={UNLINKED}
        now={NOW}
        clock={{ timeZone: 'UTC' }}
        memory={{ usedMb: 0.1, budgetMb: 256 }}
        services={[{ name: 'sync', state: 'degraded', attempts: 1, reason: 'not linked' }]}
        openStatus="connectivity"
        onMenuSelect={() => undefined}
        onSystemAction={() => undefined}
        onStatus={() => undefined}
      />
    ));
    const nav = screen.getByRole('navigation', { name: 'Menu bar' });
    expect(nav.contains(screen.getByRole('menubar'))).toBe(true);
    expect(nav.contains(screen.getByRole('group', { name: 'Status' }))).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Plotinium' })).toBeTruthy();
    const desktop = screen.getByRole('menuitem', { name: 'Plotinium desktop' });
    expect(desktop.textContent).toContain('Plotinium');
    expect(
      screen.getByRole('button', { name: '1 degraded services' }).getAttribute('aria-expanded'),
    ).toBe('true');
    const chip = screen.getByRole('button', {
      name: 'Sync: Sync unavailable, sync client not linked',
    });
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.textContent).toContain('Sync unavailable');
    expect(chip.dataset.net).toBe('UNAVAILABLE');
    expect(
      screen.getByRole('button', { name: '102 KB/256 MB memory used, less than 1 percent' }),
    ).toBeTruthy();
  });

  it('UI-085 the clock reports Control Centre open, since it opens the same panel', () => {
    render(() => (
      <MenuBar
        appName="Files"
        menus={[]}
        net={{ state: 'LIVE' }}
        now={NOW}
        clock={{ timeZone: 'UTC' }}
        openStatus="control-centre"
        controlCentreId="cc"
        onMenuSelect={() => undefined}
        onSystemAction={() => undefined}
        onStatus={() => undefined}
      />
    ));
    const clock = screen.getByRole('button', { name: /^Thu 24 Sep 21:05, notifications/u });
    expect(clock.getAttribute('aria-expanded')).toBe('true');
    expect(clock.getAttribute('aria-controls')).toBe('cc');
    expect(clock.dataset.statusItem).toBe('clock');
  });

  it('UI-152 the mark is 16 px (whole pixels) with a 1 px glow', () => {
    render(() => (
      <MenuBar
        appName="Files"
        menus={[]}
        net={{ state: 'LIVE' }}
        now={NOW}
        onMenuSelect={() => undefined}
        onSystemAction={() => undefined}
        onStatus={() => undefined}
      />
    ));
    const svg = screen.getByRole('menuitem', { name: 'Plotinium' }).querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(rule(menuCss, '.atom')).toContain('drop-shadow(0 0 1px');
  });

  it('UI-089 chip text is mixed toward the primary text colour for contrast on glass', () => {
    expect(rule(menuCss, '.warning')).toContain(
      'color-mix(in srgb, var(--pl-warning) 72%, var(--pl-text))',
    );
    expect(rule(menuCss, '.ai')).toContain(
      'color-mix(in srgb, var(--pl-accent-text) 72%, var(--pl-text))',
    );
  });
});

describe('UI-desktop-shell dock', () => {
  const items: readonly DockItem[] = [
    { id: 'files', label: 'Files', icon: 'files', running: true, windows: 2, minimised: 1 },
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  ];

  it('UI-078 Alt+N lands on the first app, not Trash; Escape hands focus back', () => {
    const onEscape = vi.fn();
    let api: { focus: (id?: string) => void } | undefined;
    render(() => (
      <Dock
        items={items}
        onActivate={() => undefined}
        onEscape={onEscape}
        apiRef={(a) => (api = a)}
      />
    ));
    api?.focus();
    const files = screen.getByRole('button', { name: /^Files,/u });
    expect(document.activeElement).toBe(files);
    expect(files.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('button', { name: 'Trash, empty' }).getAttribute('tabindex')).toBe(
      '-1',
    );
    fireEvent.keyDown(files, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('UI-093 a minimised window shows the minimised marker and is spoken', () => {
    render(() => <Dock items={items} onActivate={() => undefined} />);
    const files = screen.getByRole('button', { name: 'Files, running, 2 windows, 1 minimised' });
    expect(files.querySelector('[class*="minMark"]')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Terminal' }).querySelector('[class*="minMark"]'),
    ).toBeNull();
    expect(dockItemLabel({ id: 'x', label: 'X', icon: 'files', windows: 1, minimised: 3 })).toBe(
      'X, 1 window, 1 minimised',
    );
  });

  it('UI-085 the Dock is a "Dock" navigation landmark around its toolbar', () => {
    render(() => <Dock items={items} onActivate={() => undefined} />);
    const nav = screen.getByRole('navigation', { name: 'Dock' });
    expect(nav.contains(screen.getByRole('toolbar', { name: 'Dock' }))).toBe(true);
  });

  it('UI-040 Dock size, auto-hide and indicators come from Settings', async () => {
    const [size, setSize] = createSignal(64);
    render(() => (
      <Dock
        items={items}
        onActivate={() => undefined}
        iconSize={size()}
        autoHide
        indicators={false}
        magnifiedScale={1.8}
      />
    ));
    const nav = screen.getByRole('navigation', { name: 'Dock' });
    expect(nav.style.getPropertyValue('--pl-dock-icon')).toBe('64px');
    setSize(40);
    expect(nav.style.getPropertyValue('--pl-dock-icon')).toBe('40px');
    expect(nav.dataset.indicators).toBe('false');
    expect(nav.dataset.autohide).toBe('true');
    expect(nav.dataset.revealed).toBeUndefined();
    const zone = nav.querySelector('[class*="hotZone"]');
    expect(zone).not.toBeNull();
    fireEvent.pointerEnter(zone as Element);
    expect(nav.dataset.revealed).toBe('true');
    // Hidden by transform and opacity only; keyboard focus inside reveals it.
    const hidden = rule(dockCss, ".wrap[data-autohide='true'] .dock");
    expect(hidden).toContain('transform: translateY(');
    expect(hidden).toContain('opacity: 0');
    expect(dockCss).toContain(".wrap[data-autohide='true'] .dock:focus-within");
    await Promise.resolve();
  });
});

describe('UI-desktop-shell Control Centre', () => {
  const base = {
    onClose: () => undefined,
    now: NOW,
    clock: { timeZone: 'UTC' },
    syncQueue: { pending: 0 },
    theme: 'light' as const,
    onThemeChange: () => undefined,
    reducedMotion: false,
    onReducedMotionChange: () => undefined,
    memory: { budgetMb: 256, usedMb: 0.1 },
    onMemoryBudgetCommit: () => undefined,
    focusMode: false,
    onFocusModeChange: () => undefined,
    frameMeter: false,
    onFrameMeterChange: () => undefined,
  };
  const degraded: readonly SvcView[] = [
    { name: 'lockd', state: 'degraded', attempts: 1, reason: 'local advisory locks only' },
  ];

  it('UI-091 tiles carry their stagger as data attributes, never a static style attribute', () => {
    render(() => (
      <ControlCentre open inline net={{ state: 'LIVE' }} services={[]} version="v" {...base} />
    ));
    const dialog = screen.getByRole('dialog', { name: 'Control Centre' });
    const staggered = Array.from(dialog.querySelectorAll('[data-stagger]'));
    expect(staggered.map((el) => el.getAttribute('data-stagger'))).toEqual([
      '0',
      '1',
      '3',
      '4',
      '7',
    ]);
    for (const el of staggered) expect(el.getAttribute('style')).toBeNull();
    expect(rule(ccCss, "[data-stagger='3']")).toContain('--pl-stagger-index: 3');
  });

  it('UI-081 an inline panel opened from the keyboard moves focus in; opened by pointer it does not', async () => {
    const { unmount } = render(() => (
      <ControlCentre open inline autoFocus net={{ state: 'LIVE' }} services={[]} {...base} />
    ));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Connectivity: /u),
    );
    unmount();
    render(() => <ControlCentre open inline net={{ state: 'LIVE' }} services={[]} {...base} />);
    await Promise.resolve();
    expect(document.activeElement?.getAttribute('aria-label') ?? '').not.toMatch(/^Connectivity/u);
  });

  it('UI-081 Escape returns focus to the anchor it was opened from', () => {
    const onClose = vi.fn();
    render(() => {
      const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
      return (
        <>
          <button type="button" ref={setAnchor}>
            trigger
          </button>
          <ControlCentre
            open
            inline
            anchor={anchor()}
            net={{ state: 'LIVE' }}
            services={[]}
            {...base}
            onClose={onClose}
          />
        </>
      );
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(document.activeElement?.textContent).toBe('trigger');
  });

  it('UI-074 a failed retry is written on its row and the button keeps its whole label', () => {
    render(() => (
      <ControlCentre
        open
        inline
        net={{ state: 'LIVE' }}
        services={degraded}
        onRetryService={() => undefined}
        retryErrors={{ lockd: 'Could not retry: no answer' }}
        {...base}
      />
    ));
    fireEvent.click(screen.getByRole('button', { name: /^Degraded services: 1 degraded/u }));
    expect(screen.getByText('Could not retry: no answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry lockd now' }).textContent).toBe('Retry now');
    expect(rule(ccCss, '.retryButton')).toContain('white-space: nowrap');
    expect(rule(ccCss, '.retryButton')).toContain('flex: none');
  });

  it('UI-025 the connectivity tile says "Sync unavailable" with the reason', () => {
    render(() => <ControlCentre open inline net={UNLINKED} services={[]} {...base} />);
    const tile = screen.getByRole('button', {
      name: 'Connectivity: Sync unavailable, Sync client not linked · changes stay on this device',
    });
    expect(tile.textContent).toContain('Sync unavailable');
    expect(tile.textContent).toContain('Client not linked');
    expect(tile.textContent).not.toContain('synced');
  });

  it('UI-151 the connectivity tile keeps its reason on one line, the whole of it in a tooltip', () => {
    render(() => <ControlCentre open inline net={UNLINKED} services={[]} {...base} />);
    const line = screen.getByText('Client not linked');
    expect(line.getAttribute('title')).toBe('Sync client not linked · changes stay on this device');
    expect(rule(ccCss, '.oneLine')).toContain('white-space: nowrap');
    expect(rule(ccCss, '.oneLine')).toContain('text-overflow: ellipsis');
  });

  it('UI-090 Control Centre shows the used memory like the menu bar ("Using 102 KB")', () => {
    render(() => <ControlCentre open inline net={{ state: 'LIVE' }} services={[]} {...base} />);
    expect(screen.getByText('Using 102 KB')).toBeTruthy();
  });

  it('UI-151 the version footer stays on one line beside Settings…', () => {
    expect(rule(ccCss, '.versionText')).toContain('white-space: nowrap');
    expect(rule(ccCss, '.version')).not.toContain('font-family: var(--pl-font-mono)');
  });
});

describe('UI-desktop-shell notifications', () => {
  const note = (id: string, extra: Partial<ShellNotification> = {}): ShellNotification => ({
    id,
    level: 'info',
    title: `Title ${id}`,
    at: NOW,
    ...extra,
  });

  it('UI-082 Escape never deletes a card; Delete moves focus to the next card first', async () => {
    const [list, setList] = createSignal([note('a'), note('b'), note('c')]);
    const onDismiss = vi.fn((id: string) => setList((l) => l.filter((n) => n.id !== id)));
    render(() => (
      <NotificationCenter
        notifications={list()}
        now={NOW}
        onDismiss={onDismiss}
        onClearAll={() => undefined}
        onAction={() => undefined}
      />
    ));
    const first = screen.getByRole('article', { name: /Title a/u });
    first.focus();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(first, { key: 'Delete' });
    expect(document.activeElement).toBe(screen.getByRole('article', { name: /Title b/u }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('a'));
  });

  it('UI-082 deleting the last card moves focus to "Clear all"', async () => {
    const [list, setList] = createSignal([note('only')]);
    render(() => (
      <NotificationCenter
        notifications={list()}
        now={NOW}
        onDismiss={(id) => setList((l) => l.filter((n) => n.id !== id))}
        onClearAll={() => undefined}
        onAction={() => undefined}
      />
    ));
    const card = screen.getByRole('article', { name: /Title only/u });
    card.focus();
    fireEvent.keyDown(card, { key: 'Backspace' });
    expect(document.activeElement?.textContent).toBe('Clear all');
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });

  it("UI-082 deleting the top card of a collapsed group moves focus to the group's next card", async () => {
    const files = { app: 'files' as const, appName: 'Files' };
    const [list, setList] = createSignal([note('1', files), note('2', files), note('3', files)]);
    render(() => (
      <NotificationCenter
        notifications={list()}
        now={NOW}
        onDismiss={(id) => setList((l) => l.filter((n) => n.id !== id))}
        onClearAll={() => undefined}
        onAction={() => undefined}
      />
    ));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    const top = screen.getByRole('article', { name: /Title 1/u });
    top.focus();
    fireEvent.keyDown(top, { key: 'Delete' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('article', { name: /Title 2/u })),
    );
  });

  it('UI-079 the "+N from <App>" button sits above the slabs, which take no clicks', () => {
    render(() => (
      <NotificationCenter
        notifications={[
          note('1', { app: 'files', appName: 'Files' }),
          note('2', { app: 'files', appName: 'Files' }),
          note('3', { app: 'files', appName: 'Files' }),
        ]}
        now={NOW}
        onDismiss={() => undefined}
        onClearAll={() => undefined}
        onAction={() => undefined}
      />
    ));
    const more = screen.getByRole('button', { name: '+2 from Files' });
    expect(more).toBeTruthy();
    // UI-091: the slabs' stack positions are data attributes, not static style attributes.
    const slabs = Array.from(document.querySelectorAll('[data-stack]'));
    expect(slabs.map((s) => s.getAttribute('data-stack'))).toEqual(['1', '2']);
    for (const s of slabs) expect(s.getAttribute('style')).toBeNull();
    expect(rule(notesCss, '.slab')).toContain('pointer-events: none');
    expect(rule(notesCss, '.more')).toContain('z-index: 1');
    fireEvent.click(more);
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });

  it('UI-151 a warning without an app shows a warning tile; repeats show "×3"', () => {
    render(() => (
      <NotificationCard
        notification={note('w', { level: 'warning', title: 'Sync is degraded', count: 3 })}
        now={NOW}
        onDismiss={() => undefined}
      />
    ));
    const card = screen.getByRole('article', { name: /Warning: Sync is degraded/u });
    expect(card.querySelector('[data-level="warning"]')).not.toBeNull();
    expect(card.textContent).toContain('×3');
    expect(card.textContent).toContain('3 times');
    expect(rule(notesCss, ".levelTile[data-level='warning']")).toContain('var(--pl-warning)');
  });

  it('UI-151 the centre leaves room below the cards for their shadows', () => {
    expect(rule(notesCss, '.centre')).toContain('var(--pl-space-5)');
  });
});
