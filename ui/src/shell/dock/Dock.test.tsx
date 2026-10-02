import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DockItem } from '../types.ts';
import { Dock, type DockApi } from './Dock.tsx';

const ITEMS: readonly DockItem[] = [
  { id: 'files', label: 'Files', icon: 'files', running: true, windows: 1 },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', running: true, windows: 2 },
  { id: 'editor', label: 'Editor', icon: 'editor', badge: 3 },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UI-Dock', () => {
  it('WMD-10 renders a labelled toolbar of apps, a separator and Trash, with running state spoken', () => {
    render(() => <Dock items={ITEMS} trash={{ full: false }} onActivate={() => undefined} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Dock' });
    expect(toolbar.getAttribute('aria-orientation')).toBe('horizontal');
    expect(screen.getByRole('button', { name: 'Files, running, 1 window' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Terminal, running, 2 windows' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editor, 3 new' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trash, empty' })).toBeTruthy();
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('vertical');
    const slots = toolbar.querySelectorAll('[data-running="true"]');
    expect(slots).toHaveLength(2);
  });

  it('UI-Dock the badge shows the count and caps at 99+', () => {
    render(() => (
      <Dock
        items={[{ id: 'files', label: 'Files', icon: 'files', badge: 120 }]}
        onActivate={() => undefined}
      />
    ));
    const button = screen.getByRole('button', { name: 'Files, 99+ new' });
    expect(button.textContent).toContain('99+');
  });

  it('WM-07 one tab stop roves with the arrow keys, Home and End, and wraps', () => {
    render(() => <Dock items={ITEMS} onActivate={() => undefined} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
    const files = buttons[0] as HTMLElement;
    files.focus();
    fireEvent.keyDown(files, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Terminal/u);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Trash, empty');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(files);
    fireEvent.keyDown(files, { key: 'ArrowLeft' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Trash, empty');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(files);
    expect(files.getAttribute('tabindex')).toBe('0');
  });

  it('WMD-10 clicking an icon or Trash emits the intent', () => {
    const onActivate = vi.fn();
    const onTrash = vi.fn();
    render(() => <Dock items={ITEMS} onActivate={onActivate} onTrash={onTrash} />);
    fireEvent.click(screen.getByRole('button', { name: /^Editor/u }));
    expect(onActivate).toHaveBeenCalledWith('editor');
    fireEvent.click(screen.getByRole('button', { name: /^Trash/u }));
    expect(onTrash).toHaveBeenCalledOnce();
  });

  it('WM-07 Shift+F10 and right-click open the item menu anchored to the icon', () => {
    const onItemMenu = vi.fn();
    render(() => <Dock items={ITEMS} onActivate={() => undefined} onItemMenu={onItemMenu} />);
    const terminal = screen.getByRole('button', { name: /^Terminal/u });
    fireEvent.keyDown(terminal, { key: 'F10', shiftKey: true });
    expect(onItemMenu).toHaveBeenCalledWith('terminal', terminal);
    fireEvent.contextMenu(terminal);
    expect(onItemMenu).toHaveBeenCalledTimes(2);
  });

  it('WM-04 getIconRect gives the genie target for an app or Trash; focus() enters the dock', () => {
    let api: DockApi | undefined;
    render(() => <Dock items={ITEMS} onActivate={() => undefined} apiRef={(a) => (api = a)} />);
    expect(api?.getIconRect('files')).toBeInstanceOf(DOMRect);
    expect(api?.getIconRect('trash')).toBeInstanceOf(DOMRect);
    expect(api?.getIconRect('missing')).toBeUndefined();
    api?.focus('terminal');
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Terminal/u);
  });

  it('WMD-10 a launch plays one bounce, replayed on the next launch', async () => {
    const [launching, setLaunching] = createSignal(false);
    render(() => (
      <Dock
        items={[{ id: 'files', label: 'Files', icon: 'files', launching: launching() }]}
        onActivate={() => undefined}
      />
    ));
    const hop = (): Element | null => document.querySelector('.pl-anim-dock-bounce');
    expect(hop()).toBeNull();
    setLaunching(true);
    await waitFor(() => expect(hop()).not.toBeNull());
    fireEvent.animationEnd(hop() as Element);
    expect(hop()).toBeNull();
  });

  it('DSN-30 under reduced motion the dock neither bounces nor magnifies', async () => {
    document.documentElement.dataset.motion = 'reduce';
    const [launching, setLaunching] = createSignal(false);
    render(() => (
      <Dock
        items={[{ id: 'files', label: 'Files', icon: 'files', launching: launching() }]}
        onActivate={() => undefined}
      />
    ));
    setLaunching(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(document.querySelector('.pl-anim-dock-bounce')).toBeNull();
    const toolbar = screen.getByRole('toolbar');
    fireEvent.pointerEnter(toolbar, { clientX: 30, pointerType: 'mouse' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const scaled = Array.from(toolbar.querySelectorAll<HTMLElement>('*')).filter((el) =>
      el.style.transform.startsWith('scale('),
    );
    expect(scaled).toHaveLength(0);
  });

  it('WM-03 magnification writes only transforms, promotes layers while tracking and rests on leave', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(52);
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(0);
    render(() => <Dock items={ITEMS} onActivate={() => undefined} />);
    const toolbar = screen.getByRole('toolbar');
    fireEvent.pointerEnter(toolbar, { clientX: 26, pointerType: 'mouse' });
    await waitFor(() => {
      const scaled = Array.from(toolbar.querySelectorAll<HTMLElement>('*')).filter((el) =>
        el.style.transform.startsWith('scale('),
      );
      expect(scaled.length).toBeGreaterThan(0);
    });
    const icon = Array.from(toolbar.querySelectorAll<HTMLElement>('*')).find((el) =>
      el.style.transform.startsWith('scale('),
    );
    expect(icon?.style.transform).toBe('scale(1.5)');
    expect(icon?.style.willChange).toBe('transform');
    // Nothing but transform is written inline.
    expect(icon?.getAttribute('style')).not.toMatch(/width|height|left|top/u);
    fireEvent.pointerLeave(toolbar);
    expect(icon?.style.transform).toBe('');
  });
});
