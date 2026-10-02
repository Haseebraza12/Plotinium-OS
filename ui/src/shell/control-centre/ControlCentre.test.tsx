import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import type { NetView, SvcView, ThemeChoice } from '../types.ts';
import {
  ControlCentre,
  type ControlCentreCloseReason,
  type MemoryBudgetView,
} from './ControlCentre.tsx';

const NOW = Date.UTC(2026, 8, 24, 10, 42, 0);
const HEALTHY: readonly SvcView[] = Array.from({ length: 9 }, (_, i) => ({
  name: `svc${i}`,
  state: 'running' as const,
  attempts: 0,
}));

function intents() {
  return {
    onClose: vi.fn<(reason: ControlCentreCloseReason) => void>(),
    onThemeChange: vi.fn<(theme: ThemeChoice) => void>(),
    onReducedMotionChange: vi.fn<(on: boolean) => void>(),
    onMemoryBudgetCommit: vi.fn<(mb: number) => void>(),
    onFocusModeChange: vi.fn<(on: boolean) => void>(),
    onFrameMeterChange: vi.fn<(on: boolean) => void>(),
    onRetryService: vi.fn<(name: string) => void>(),
    onOpenSync: vi.fn<() => void>(),
    onOpenSettings: vi.fn<() => void>(),
  };
}

function Harness(props: {
  intents: ReturnType<typeof intents>;
  net?: NetView;
  services?: readonly SvcView[];
  memory?: MemoryBudgetView;
  withAnchor?: boolean;
}) {
  const [open, setOpen] = createSignal(true);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  return (
    <>
      <button type="button" ref={setAnchor}>
        Control Centre trigger
      </button>
      <ControlCentre
        open={open()}
        anchor={props.withAnchor === true ? anchor() : undefined}
        inline={props.withAnchor !== true}
        net={props.net ?? { state: 'LIVE' }}
        now={NOW}
        clock={{ timeZone: 'UTC' }}
        lastSyncAt={NOW - 60_000}
        syncQueue={{ pending: 0 }}
        services={props.services ?? HEALTHY}
        theme="dark"
        reducedMotion={false}
        memory={props.memory ?? { budgetMb: 256, usedMb: 142 }}
        focusMode={false}
        frameMeter
        frameMeterSummary="p95 16.7 ms · 60 Hz"
        version="Plotinium 0.3.0 · build a1f93c2"
        {...props.intents}
        onClose={(reason) => {
          props.intents.onClose(reason);
          setOpen(false);
        }}
      />
    </>
  );
}

describe('UI-ControlCentre', () => {
  it('WMD-18 is a labelled non-modal dialog holding every module', () => {
    render(() => <Harness intents={intents()} />);
    const panel = screen.getByRole('dialog', { name: 'Control Centre' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(
      screen.getByRole('button', {
        name: 'Connectivity: Online, All changes synced · last sync 10:41',
      }),
    ).toBeTruthy();
    expect(panel.textContent).toContain('Sync queue');
    expect(panel.textContent).toContain('0 pending');
    expect(panel.textContent).toContain('Degraded services: none');
    expect(panel.textContent).toContain('All 9 services healthy');
    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByRole('switch', { name: 'Reduced motion' }).getAttribute('aria-checked'),
    ).toBe('false');
    const slider = screen.getByRole('slider', { name: 'Memory budget' });
    expect(slider.getAttribute('aria-valuetext')).toBe('256 MB');
    expect(screen.getByRole('switch', { name: 'Focus' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Frame meter' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(panel.textContent).toContain('p95 16.7 ms · 60 Hz');
    expect(panel.textContent).toContain('Plotinium 0.3.0 · build a1f93c2');
  });

  it('DSN-30 the panel springs in and its tiles stagger with the cc motion classes', () => {
    render(() => <Harness intents={intents()} />);
    const panel = screen.getByRole('dialog', { name: 'Control Centre' });
    expect(panel.classList.contains('pl-anim-cc-in')).toBe(true);
    const tiles = panel.querySelectorAll<HTMLElement>('.pl-anim-cc-tile');
    expect(tiles.length).toBeGreaterThanOrEqual(7);
    expect(tiles[2]?.style.getPropertyValue('--pl-stagger-index')).toBe('2');
  });

  it('OFF-04 shows the offline state in words and lists degraded services with Retry now', () => {
    const i = intents();
    render(() => (
      <Harness
        intents={i}
        net={{ state: 'OFFLINE', queued: 3 }}
        services={[
          ...HEALTHY.slice(0, 7),
          {
            name: 'sync',
            state: 'degraded',
            reason: 'backend unreachable',
            attempts: 3,
            nextRetryAt: NOW + 4000,
          },
          { name: 'lockd', state: 'blocked', blockedBy: 'sync', attempts: 0 },
        ]}
      />
    ));
    expect(screen.getByRole('button', { name: /^Connectivity: Offline · 3 queued/u })).toBeTruthy();
    const header = screen.getByRole('button', { name: /Degraded services: 2 degraded/u });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('list', { name: 'Services' });
    expect(list.textContent).toContain(
      'sync — degraded · backend unreachable · retry in 4 s (attempt 3)',
    );
    expect(list.textContent).toContain('lockd — blocked by sync');
    fireEvent.click(screen.getByRole('button', { name: 'Retry sync now' }));
    expect(i.onRetryService).toHaveBeenCalledWith('sync');
  });

  it('UI-ControlCentre switches, the Appearance radios and the tiles emit intents', () => {
    const i = intents();
    render(() => <Harness intents={i} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Reduced motion' }));
    expect(i.onReducedMotionChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(i.onThemeChange).toHaveBeenCalledWith('light');
    fireEvent.click(screen.getByRole('switch', { name: 'Focus' }));
    expect(i.onFocusModeChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Frame meter' }));
    expect(i.onFrameMeterChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: /^Connectivity/u }));
    expect(i.onOpenSync).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Settings…' }));
    expect(i.onOpenSettings).toHaveBeenCalledOnce();
  });

  it('MEM-01 the memory budget commits on release only and snaps back when refused', () => {
    const i = intents();
    const [memory, setMemory] = createSignal<MemoryBudgetView>({ budgetMb: 256, usedMb: 198 });
    render(() => <Harness intents={i} memory={memory()} />);
    const slider = screen.getByRole<HTMLInputElement>('slider', { name: 'Memory budget' });
    slider.value = '128';
    fireEvent.input(slider);
    expect(i.onMemoryBudgetCommit).not.toHaveBeenCalled();
    expect(slider.getAttribute('aria-valuetext')).toBe('128 MB');
    fireEvent.change(slider);
    expect(i.onMemoryBudgetCommit).toHaveBeenCalledWith(128);
    setMemory({ budgetMb: 256, usedMb: 198, error: "Budget can't be below current use (198 MB)" });
    expect(slider.getAttribute('aria-valuetext')).toBe('256 MB');
    expect(screen.getByRole('alert').textContent).toBe(
      "Budget can't be below current use (198 MB)",
    );
  });

  it('WM-07 opening moves focus to the first tile; Escape closes and returns focus to the trigger', async () => {
    const i = intents();
    render(() => <Harness intents={i} withAnchor />);
    const panel = await screen.findByRole('dialog', { name: 'Control Centre' });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Connectivity/u);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(i.onClose).toHaveBeenCalledWith('escape');
    expect(document.activeElement?.textContent).toBe('Control Centre trigger');
  });

  it('WM-07 a pointer-down outside closes it', () => {
    const i = intents();
    render(() => <Harness intents={i} withAnchor />);
    fireEvent.pointerDown(document.body);
    expect(i.onClose).toHaveBeenCalledWith('outside');
  });
});
