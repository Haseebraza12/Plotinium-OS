import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';

import { FrameMeterHUD, type FrameMeterStats } from './FrameMeterHUD.tsx';

const STATS: FrameMeterStats = {
  refreshHz: 60,
  p95Ms: 14.2,
  droppedShare: 0.004,
  loafOurs: 0,
  loafOther: 1,
};
const SAMPLES = [16.7, 16.7, 16.6, 33.4, 16.7, 16.8, 16.7, 16.6, 16.7, 16.7];

describe('UI-FrameMeterHUD', () => {
  it('WMD-19 reports p95, refresh rate and the budget state in words', () => {
    render(() => <FrameMeterHUD stats={STATS} samples={SAMPLES} contained />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(
      'Frame meter: p95 14.2 milliseconds at 60 hertz, within budget',
    );
    expect(status.textContent).toContain('p95 14.2 ms · 60 Hz');
    expect(status.textContent).toContain('OK');
    expect(status.textContent).toContain('dropped 0.4% · LoAF 0');
    const bars = status.querySelectorAll('[style*="--pl-bar"]');
    expect(bars).toHaveLength(24);
    expect(status.querySelectorAll('[data-over="true"]')).toHaveLength(1);
  });

  it('WM-03 a p95 over 16.7 ms is flagged as over budget, not by colour alone', () => {
    render(() => <FrameMeterHUD stats={{ ...STATS, p95Ms: 21.4 }} samples={SAMPLES} contained />);
    expect(screen.getByText('over budget')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('over budget');
  });

  it('UI-FrameMeterHUD collects before the first summary and expands on request', () => {
    const [stats, setStats] = createSignal<FrameMeterStats>();
    const [expanded, setExpanded] = createSignal(false);
    render(() => (
      <FrameMeterHUD
        stats={stats()}
        samples={SAMPLES}
        expanded={expanded()}
        onToggleExpanded={() => setExpanded((v) => !v)}
        contained
      />
    ));
    expect(screen.getByText('collecting…')).toBeTruthy();
    setStats(STATS);
    const toggle = screen.getByRole('button', { name: 'Frame meter details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('LoAF>50 ours 0 / other 1');
    expect(toggle.querySelectorAll('[style*="--pl-bar"]')).toHaveLength(60);
  });
});
