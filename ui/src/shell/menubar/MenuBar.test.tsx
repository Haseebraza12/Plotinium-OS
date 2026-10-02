import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import type { NetView, StatusItemId, SvcView, SystemAction } from '../types.ts';
import { MenuBar, type MenuBarMenu } from './MenuBar.tsx';

const NOW = Date.UTC(2026, 8, 24, 10, 42, 0);

const MENUS: readonly MenuBarMenu[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new', label: 'New Window', shortcut: ['Ctrl', 'N'] },
      { id: 'close', label: 'Close Window' },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { id: 'copy', label: 'Copy' },
      { id: 'paste', label: 'Paste', disabled: true },
    ],
  },
  { id: 'help', label: 'Help', items: [{ id: 'docs', label: 'Files Help' }] },
];

interface HarnessProps {
  net?: NetView;
  services?: readonly SvcView[];
  usedMb?: number;
  openStatus?: StatusItemId;
  onMenuSelect?: (menu: string, item: string) => void;
  onSystemAction?: (action: SystemAction) => void;
  onStatus?: (item: StatusItemId, anchor: HTMLElement) => void;
}

function Harness(props: HarnessProps) {
  return (
    <MenuBar
      appName="Files"
      menus={MENUS}
      net={props.net ?? { state: 'LIVE' }}
      now={NOW}
      clock={{ timeZone: 'UTC' }}
      ai={{ state: 'idle' }}
      memory={{ usedMb: props.usedMb ?? 142, budgetMb: 256 }}
      services={props.services}
      unreadNotifications={3}
      openStatus={props.openStatus}
      onMenuSelect={(m, i) => props.onMenuSelect?.(m, i)}
      onSystemAction={(a) => props.onSystemAction?.(a)}
      onStatus={(item, anchor) => props.onStatus?.(item, anchor)}
    />
  );
}

describe('UI-MenuBar', () => {
  it('WM-07 renders a labelled menubar, the atom menu, the bold app name and a status group', () => {
    render(() => <Harness />);
    const bar = screen.getByRole('menubar', { name: 'Application menu' });
    const titles = screen.getAllByRole('menuitem');
    expect(titles.map((t) => t.getAttribute('aria-label') ?? t.textContent)).toEqual([
      'Plotinium',
      'Files',
      'File',
      'Edit',
      'Help',
    ]);
    expect(bar.contains(titles[0] ?? null)).toBe(true);
    // One roving tab stop.
    expect(titles.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    const status = screen.getByRole('group', { name: 'Status' });
    expect(status).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync: Online, all changes synced' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AI: ready' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '142/256 MB memory used, 55 percent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Control Centre' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-keyshortcuts')).toBe(
      'Control+Space',
    );
    const clock = screen.getByRole('button', { name: 'Thu 24 Sep 10:42, notifications, 3 unread' });
    expect(clock.textContent).toContain('Thu 24 Sep');
    expect(clock.textContent).toContain('10:42');
  });

  it('OFF-04 shows the offline pill "Offline · 3 queued" and the degraded-services item', () => {
    render(() => (
      <Harness
        net={{ state: 'OFFLINE', queued: 3 }}
        services={[
          { name: 'vfs', state: 'running', attempts: 0 },
          { name: 'sync', state: 'degraded', reason: 'backend unreachable', attempts: 2 },
        ]}
      />
    ));
    const net = screen.getByRole('button', { name: 'Sync: Offline · 3 queued' });
    expect(net.textContent).toContain('Offline · 3 queued');
    const services = screen.getByRole('button', { name: '1 degraded services' });
    expect(services.textContent).toContain('1 degraded');
  });

  it('OFF-04 hides the degraded-services item while every service is healthy', () => {
    render(() => <Harness services={[{ name: 'vfs', state: 'running', attempts: 0 }]} />);
    expect(screen.queryByRole('button', { name: /degraded services/u })).toBeNull();
  });

  it('WMD-11 the memory meter warns at 85% and is critical at 95%, in words as well as colour', () => {
    const [used, setUsed] = createSignal(220);
    render(() => (
      <MenuBar
        appName="Files"
        menus={[]}
        net={{ state: 'LIVE' }}
        now={NOW}
        memory={{ usedMb: used(), budgetMb: 256 }}
        onMenuSelect={() => undefined}
        onSystemAction={() => undefined}
        onStatus={() => undefined}
      />
    ));
    const meter = screen.getByRole('button', { name: /memory used/u });
    expect(meter.dataset.level).toBe('warning');
    expect(meter.getAttribute('aria-label')).toContain('above 85%');
    setUsed(250);
    expect(meter.dataset.level).toBe('critical');
    expect(meter.getAttribute('aria-label')).toContain('above 95%');
  });

  it('WM-07 Left and Right move along the bar, Down opens a menu, and Left/Right switch menus', async () => {
    render(() => <Harness />);
    const [system, app] = screen.getAllByRole('menuitem');
    system?.focus();
    fireEvent.keyDown(system as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(app);
    expect(app?.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(app as HTMLElement, { key: 'ArrowDown' });
    const appMenu = await screen.findByRole('menu', { name: 'Files' });
    expect(app?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toContain('About Files');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    await screen.findByRole('menu', { name: 'File' });
    await waitFor(() => expect(appMenu.isConnected).toBe(false));
    expect(document.activeElement?.textContent).toContain('New Window');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    await screen.findByRole('menu', { name: 'Files' });
  });

  it('WM-07 Left wraps from the atom menu to the last title; Home and End jump', () => {
    render(() => <Harness />);
    const titles = screen.getAllByRole('menuitem');
    titles[0]?.focus();
    fireEvent.keyDown(titles[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(titles[titles.length - 1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(titles[0]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(titles[titles.length - 1]);
  });

  it('UI-MenuBar the atom menu lists the system commands and emits them', async () => {
    const onSystemAction = vi.fn();
    render(() => <Harness onSystemAction={onSystemAction} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plotinium' }));
    const menu = await screen.findByRole('menu', { name: 'Plotinium' });
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) =>
      el.textContent?.trim(),
    );
    // ui-implementation-guide.md §3.4.2 order, with Log Out (UI-028).
    expect(labels).toEqual([
      'About Plotinium',
      'Settings…',
      'Lock Screen',
      'Log Out…',
      'Restart…',
      'Shut Down…',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lock Screen' }));
    expect(onSystemAction).toHaveBeenCalledWith('lock');
  });

  it('UI-MenuBar app menu items reach onMenuSelect with the menu id', async () => {
    const onMenuSelect = vi.fn();
    render(() => <Harness onMenuSelect={onMenuSelect} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('menu', { name: 'Edit' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(onMenuSelect).toHaveBeenCalledWith('edit', 'copy');
  });

  it('UI-MenuBar hovering another title while a menu is open switches to it', async () => {
    render(() => <Harness />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    await screen.findByRole('menu', { name: 'File' });
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('menu', { name: 'Edit' });
  });

  it('UI-MenuBar status items report their anchor and show the open one as expanded', () => {
    const onStatus = vi.fn();
    render(() => <Harness onStatus={onStatus} openStatus="control-centre" />);
    const cc = screen.getByRole('button', { name: 'Control Centre' });
    expect(cc.getAttribute('aria-expanded')).toBe('true');
    expect(cc.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(cc);
    expect(onStatus).toHaveBeenCalledWith('control-centre', cc);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onStatus).toHaveBeenLastCalledWith(
      'search',
      screen.getByRole('button', { name: 'Search' }),
    );
  });

  it('OFF-04 connectivity changes are announced in the polite status region', async () => {
    const [net, setNet] = createSignal<NetView>({ state: 'LIVE' });
    render(() => (
      <MenuBar
        appName="Plotinium"
        menus={[]}
        net={net()}
        now={NOW}
        onMenuSelect={() => undefined}
        onSystemAction={() => undefined}
        onStatus={() => undefined}
      />
    ));
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');
    setNet({ state: 'OFFLINE', queued: 3 });
    await waitFor(() => expect(live.textContent).toBe('Sync: Offline · 3 queued'));
  });
});
