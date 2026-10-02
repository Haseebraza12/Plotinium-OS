/**
 * The desktop-shell polish wave, overlays part (docs/design/bug-hunt/BUGS.md, owner
 * fix-desktop-shell): the connectivity popover, Search without a provider, Overview, the frame
 * meter and the new help and about sheets.
 */
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { NetView } from '../shell/types.ts';
import hudCss from './frame-meter/FrameMeterHUD.module.css?raw';
import { FrameMeterHUD } from './frame-meter/FrameMeterHUD.tsx';
import { AboutAppDialog, HelpSheet } from './help/HelpSheet.tsx';
import offlineCss from './offline/Offline.module.css?raw';
import { headerFor, OfflinePopover } from './offline/OfflinePopover.tsx';
import { layoutRect, Overview, type OverviewWindow } from './overview/Overview.tsx';
import { SearchPalette, type SearchResult } from './search/SearchPalette.tsx';

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at) + 1);
}

describe('UI-desktop-shell connectivity popover', () => {
  it('UI-025 the header follows the net state instead of always saying "You\'re offline"', () => {
    const title = (net: NetView | undefined): string => headerFor(net, undefined, 0).title;
    expect(title({ state: 'LIVE' })).toBe('Online · synced');
    expect(title({ state: 'SYNCING', ops: 2 })).toBe('Syncing 2 ops');
    expect(title({ state: 'RECONNECTING', retryAt: 0 })).toBe('Reconnecting');
    expect(title({ state: 'OFFLINE', queued: 1 })).toBe("You're offline");
    expect(title({ state: 'AUTH_REQUIRED', queued: 1 })).toBe('Sign in to sync');
    const unlinked = headerFor(
      { state: 'UNAVAILABLE', queued: 0, reason: 'sync client not linked' },
      undefined,
      4,
    );
    expect(unlinked.title).toBe('Sync unavailable');
    expect(unlinked.subtitle).toBe('Sync client not linked. Changes are saved on this device.');
    expect(headerFor({ state: 'LIVE' }, 'services', 4)).toMatchObject({
      title: 'Degraded services',
      subtitle: '4 services run in a limited mode; your work is kept.',
    });
  });

  it('UI-025 opened from the degraded pill it is titled "Degraded services"; nothing claims "synced" while unavailable', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    render(() => (
      <OfflinePopover
        open
        onClose={() => undefined}
        anchor={anchor}
        net={{ state: 'UNAVAILABLE', queued: 0, reason: 'sync client not linked' }}
        focus="services"
        queued={[]}
        degraded={[{ id: 'sync', name: 'sync', detail: 'sync client not linked', since: '09:19' }]}
        retry="idle"
        onRetry={() => undefined}
      />
    ));
    const dialog = screen.getByRole('dialog', { name: 'Degraded services' });
    expect(dialog.textContent).toContain('Degraded services');
    expect(dialog.textContent).toContain('Nothing queued');
    expect(dialog.textContent).not.toContain('all changes are on the server');
    anchor.remove();
  });

  it('UI-074 each degraded row has its own Retry, with "Retrying…" and a failure reason', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const onRetryService = vi.fn();
    render(() => (
      <OfflinePopover
        open
        onClose={() => undefined}
        anchor={anchor}
        net={{ state: 'LIVE' }}
        queued={[]}
        degraded={[
          { id: 'lockd', name: 'lockd', detail: 'local advisory locks only', since: '09:19' },
          { id: 'update', name: 'update', detail: 'no Service Worker', since: '09:19' },
        ]}
        retry="idle"
        onRetry={() => undefined}
        onRetryService={onRetryService}
        retryingServices={['update']}
        retryErrors={{ lockd: 'Could not retry: no answer' }}
      />
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Retry lockd now' }));
    expect(onRetryService).toHaveBeenCalledWith('lockd');
    const busy = screen.getByRole('button', { name: 'Retrying update' });
    expect(busy.textContent).toBe('Retrying…');
    fireEvent.click(busy);
    expect(onRetryService).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Could not retry: no answer')).toBeTruthy();
    // Reasons wrap instead of being cut with an ellipsis.
    expect(rule(offlineCss, '.serviceText')).not.toContain('text-overflow: ellipsis');
    expect(rule(offlineCss, '.serviceRetry')).toContain('white-space: nowrap');
    anchor.remove();
  });
});

describe('UI-desktop-shell Search without a provider', () => {
  const apps: SearchResult[] = [
    { id: 'app:files', group: 'apps', kind: 'app', title: 'Files', app: 'files', running: true },
  ];
  const file: SearchResult = {
    id: 'file:/home/demo/notes.md',
    group: 'top',
    kind: 'file',
    title: 'notes.md',
  };

  it('UI-046 "Search apps": no Semantic pill, no reveal hint, an app preview that says what Open does', async () => {
    render(() => (
      <SearchPalette
        open
        contained
        scope="apps"
        onClose={() => undefined}
        query=""
        onQueryChange={() => undefined}
        results={apps}
        onOpen={() => undefined}
      />
    ));
    const box = screen.getByRole('combobox', { name: 'Search apps' });
    expect(box.getAttribute('placeholder')).toBe('Search apps');
    const dialog = screen.getByRole('dialog', { name: 'Search' });
    expect(dialog.textContent).not.toContain('Semantic');
    expect(dialog.textContent).not.toContain('reveal in Files');
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        'Files is running. Open brings its window to the front or opens a new one.',
      ),
    );
  });

  it('UI-046 with a provider the palette still offers files, the Semantic pill and reveal', () => {
    render(() => (
      <SearchPalette
        open
        contained
        onClose={() => undefined}
        query=""
        onQueryChange={() => undefined}
        results={[file, ...apps]}
        onOpen={() => undefined}
        onReveal={() => undefined}
      />
    ));
    expect(screen.getByRole('combobox', { name: 'Search files, apps and commands' })).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'Search' });
    expect(dialog.textContent).toContain('Semantic');
    expect(dialog.textContent).toContain('reveal in Files');
  });

  it('UI-046 with a provider an app result offers no "reveal in Files" (apps cannot be revealed)', () => {
    render(() => (
      <SearchPalette
        open
        contained
        onClose={() => undefined}
        query=""
        onQueryChange={() => undefined}
        results={apps}
        onOpen={() => undefined}
        onReveal={() => undefined}
      />
    ));
    const dialog = screen.getByRole('dialog', { name: 'Search' });
    expect(dialog.textContent).toContain('Semantic');
    expect(dialog.textContent).not.toContain('reveal in Files');
  });

  it('UI-046 no results with apps only suggests another app name, not a file name', () => {
    render(() => (
      <SearchPalette
        open
        contained
        scope="apps"
        onClose={() => undefined}
        query="zzz"
        onQueryChange={() => undefined}
        results={[]}
        onOpen={() => undefined}
      />
    ));
    expect(screen.getByText('Try another app name.')).toBeTruthy();
  });
});

describe('UI-desktop-shell Overview', () => {
  it('UI-029 slots are measured without transforms (the zoom-in FLIP and the hover scale)', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    outer.append(inner);
    document.body.append(outer);
    const set = (el: HTMLElement, v: Record<string, unknown>): void => {
      for (const [k, value] of Object.entries(v))
        Object.defineProperty(el, k, { configurable: true, value });
    };
    set(outer, { offsetLeft: 100, offsetTop: 50, offsetParent: null });
    set(inner, {
      offsetLeft: 20,
      offsetTop: 10,
      offsetWidth: 440,
      offsetHeight: 275,
      offsetParent: outer,
    });
    inner.style.transform = 'translate(-300px, 200px) scale(2.2)';
    inner.getBoundingClientRect = () => new DOMRect(-180, 260, 968, 605);
    expect(layoutRect(inner)).toEqual({ x: 120, y: 60, width: 440, height: 275 });
    outer.remove();
  });

  it('UI-083 a click on the empty space between tiles leaves Overview; a tile click picks', () => {
    const onCancel = vi.fn();
    const onPick = vi.fn();
    const windows: OverviewWindow[] = [
      { id: '1', title: 'Files', app: 'files', appName: 'Files', aspect: 1.5 },
    ];
    render(() => (
      <Overview
        open
        contained
        windows={windows}
        selectedId="1"
        onSelect={() => undefined}
        onPick={onPick}
        onCancel={onCancel}
      />
    ));
    const grid = screen.getByRole('listbox', { name: 'Open windows' });
    fireEvent.click(screen.getByRole('option'));
    expect(onPick).toHaveBeenCalledWith('1');
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(grid);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('UI-desktop-shell frame meter', () => {
  const stats = { refreshHz: 60, p95Ms: 16.7, droppedShare: 0, loafOurs: 0, loafOther: 0 };

  it('UI-072 the headline says Hz for the refresh rate, and the HUD moves left of Control Centre', () => {
    render(() => <FrameMeterHUD stats={stats} samples={[]} shifted />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('p95 16.7 ms · 60 Hz');
    expect(status.textContent).not.toContain('fps');
    expect(status.dataset.shifted).toBe('true');
    expect(rule(hudCss, ".fixed[data-shifted='true']")).toContain('transform: translateX(');
  });
});

describe('UI-desktop-shell help and about', () => {
  it('UI-077 the help sheet lists shortcuts with their keys; Done and the second action work', () => {
    const onClose = vi.fn();
    const onMore = vi.fn();
    render(() => (
      <HelpSheet
        open
        onClose={onClose}
        title="Task Manager Help"
        app="task-manager"
        groups={[
          {
            id: 'view',
            title: 'View',
            rows: [{ id: 'view.memory', label: 'Memory', keys: ['Ctrl', '2'] }],
          },
        ]}
        secondary={{ label: 'All Keyboard Shortcuts', onSelect: onMore }}
      />
    ));
    const dialog = screen.getByRole('dialog', { name: 'Task Manager Help' });
    expect(dialog.querySelector('dt')?.textContent).toBe('Memory');
    expect(dialog.querySelector('dd')?.textContent).toContain('Ctrl');
    fireEvent.click(screen.getByRole('button', { name: 'All Keyboard Shortcuts' }));
    expect(onMore).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('UI-077 an app without shortcuts says so', () => {
    render(() => (
      <HelpSheet
        open
        onClose={() => undefined}
        title="About Help"
        groups={[]}
        empty="About has no keyboard shortcuts of its own."
      />
    ));
    expect(screen.getByText('About has no keyboard shortcuts of its own.')).toBeTruthy();
  });

  it('UI-076 "About <App>" names the app and the build', () => {
    render(() => (
      <AboutAppDialog
        open
        onClose={() => undefined}
        app="files"
        name="Files"
        version="0.3.0"
        build="a1f93c2"
      />
    ));
    const dialog = screen.getByRole('dialog', { name: 'Files' });
    expect(dialog.textContent).toContain('Version 0.3.0 · build a1f93c2');
  });
});
