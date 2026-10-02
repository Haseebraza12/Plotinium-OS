/**
 * Task Manager fixes of the polish wave (docs/design/bug-hunt/BUGS.md, fix-apps-settings-a11y):
 * UI-043, UI-044, UI-138, UI-141, UI-144, UI-145, UI-146, UI-161.
 */
import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import tableCss from '../../primitives/table/Table.module.css?raw';
import { AiPanel } from './AiPanel.tsx';
import {
  SAMPLE_AI,
  SAMPLE_MEMORY,
  SAMPLE_PERFORMANCE,
  SAMPLE_PREDICTIONS,
  SAMPLE_PROCESSES,
  SAMPLE_SCHEDULER,
  SAMPLE_SUMMARY,
} from './fixtures.ts';
import memoryCss from './MemoryPanel.module.css?raw';
import type { AiModel, TaskManagerTab } from './models.ts';
import { FrameCard, frameBuckets, frameVerdict } from './ProcessesPanel.tsx';
import processesCss from './ProcessesPanel.module.css?raw';
import schedulerCss from './SchedulerPanel.module.css?raw';
import pillCss from './StatePill.module.css?raw';
import { TaskManagerView, type TaskManagerViewProps } from './TaskManagerView.tsx';

function setup(overrides: Partial<TaskManagerViewProps> & { tab?: TaskManagerTab } = {}) {
  const onPinChange = vi.fn();
  const onReclaim = vi.fn();
  render(() => (
    <TaskManagerView
      processes={SAMPLE_PROCESSES}
      summary={SAMPLE_SUMMARY}
      performance={SAMPLE_PERFORMANCE}
      memory={SAMPLE_MEMORY}
      predictions={SAMPLE_PREDICTIONS}
      scheduler={SAMPLE_SCHEDULER}
      ai={SAMPLE_AI}
      version="0.3.0"
      build="a1f93c2"
      onSignal={vi.fn()}
      onRenice={vi.fn()}
      onPinChange={onPinChange}
      onReclaim={onReclaim}
      {...overrides}
    />
  ));
  return { onPinChange, onReclaim };
}

describe('UI-TaskManager polish', () => {
  it('UI-144 the view carries the task-manager test id of tests/e2e/SELECTORS.md', () => {
    setup();
    expect(document.querySelector('[data-testid="task-manager"]')).not.toBeNull();
  });

  it('UI-138 the summary counts running executors against the pool ceiling', () => {
    setup({ summary: { ...SAMPLE_SUMMARY, executors: 1, executorsMax: 11 } });
    expect(screen.getByText(/of 11 executors/u).textContent).toBe('1 of 11 executors');
  });

  it('UI-161 the verdict matches the value and the histogram uses 4 ms buckets', () => {
    expect(frameVerdict({ p95Ms: 16.7, longFrames: 0 })).toBe('within the 16.7 ms budget');
    expect(frameVerdict({ p95Ms: 20, longFrames: 0 })).toBe('over budget · 16.7 to 33 ms');
    expect(frameVerdict({ p95Ms: 33.3, longFrames: 0 })).toBe('over 33 ms');
    expect(frameVerdict({ p95Ms: 60, longFrames: 3 })).toBe('over 33 ms · 3 long frames');
    const histogram = [0, 0, 0, 0, 240, 3, 0, 0, 0, 0, 0, 0, 2];
    expect(frameBuckets({ histogram })).toEqual([
      // 60 Hz frames (16.7 ms) land in 16–20 ms, which is not all over budget.
      { label: '16–20 ms', count: 240, over: false },
      { label: '20–24 ms', count: 3, over: true },
      { label: '48+ ms', count: 2, over: true },
    ]);
    expect(frameBuckets({ histogram: [1, 0], bucketMs: 8 })).toEqual([
      { label: '0–8 ms', count: 1, over: false },
    ]);
  });

  it('UI-044 View as table lists the buckets with frames in a box that scrolls, not grows', () => {
    const histogram = [0, 0, 0, 0, 240, 0, 0, 0, 0, 0, 0, 0, 0];
    render(() => <FrameCard frame={{ p95Ms: 16.7, histogram, longFrames: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const box = screen.getByRole('group', { name: 'Frame-time histogram' });
    const rows = within(box).getAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual(['Frame timeFrames', '16–20 ms240']);
    expect(box.getAttribute('tabindex')).toBe('0');
    // The table box has a height cap and the process table a floor (layout is checked on screen).
    expect(processesCss).toMatch(/\.histTableBox \{[^}]*max-height:[^}]*overflow: auto;/u);
    expect(processesCss).toMatch(/\.tableWrap \{[^}]*min-height: calc\(var\(--pl-row-h\) \* 5/u);
  });

  it('UI-043 a selected row draws its state pill and muted cells in the row colour', () => {
    expect(pillCss).toMatch(
      /:global\(\[role='row'\]\[aria-selected='true'\]\) \.pill \{\s*--pl-pill-fg: currentColor;\s*--pl-pill-bg: transparent;/u,
    );
    expect(tableCss).toMatch(
      /\.table:focus-within \.body > \.row\[aria-selected='true'\] \.muted \{\s*color: inherit;\s*\}/u,
    );
    expect(processesCss).toMatch(/\[aria-selected='true'\] \.slash \{/u);
  });

  it('UI-145 no reason text, idle slot or chip is dimmed with opacity', () => {
    expect(pillCss).not.toMatch(/\.reason \{[^}]*opacity/u);
    expect(schedulerCss).not.toMatch(/\.slotIdle \{[^}]*opacity/u);
    expect(memoryCss).toMatch(/\.chip-success \{[^}]*--pl-chip-bg: var\(--pl-success-subtle\)/u);
  });

  it('UI-146 Pin and Reclaim are disabled with the reason when the kernel has no call', () => {
    const { onPinChange, onReclaim } = setup({
      tab: 'memory',
      memory: {
        ...SAMPLE_MEMORY,
        pinUnavailable: 'Pinning needs a kernel pin call.',
        reclaimUnavailable: 'Reclaim needs mem.pageOut.',
      },
    });
    const pins = screen.getAllByRole('switch', { name: /^Pin / });
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(pin);
    }
    expect(onPinChange).not.toHaveBeenCalled();
    const descriptions = (el: HTMLElement): string[] =>
      (el.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '');
    expect(pins.some((p) => descriptions(p).includes('Pinning needs a kernel pin call.'))).toBe(
      true,
    );
    const reclaim = screen.getByRole('button', { name: /Reclaim now/u });
    expect(reclaim.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(reclaim);
    expect(onReclaim).not.toHaveBeenCalled();
  });
});

describe('UI-141 AI tab says only what it knows', () => {
  const ai = (agent: Partial<AiModel['agent']>, pid = 23): AiModel => ({
    ...SAMPLE_AI,
    indexer: { ...SAMPLE_AI.indexer, pid },
    agent: { ...SAMPLE_AI.agent, ...agent },
  });

  it('UI-141 an unreported budget is not "$0.00 of $0.00"; a degraded agent is "Degraded"', () => {
    render(() => <AiPanel ai={ai({ usedCents: 0, capCents: 0, status: 'degraded' })} />);
    expect(screen.queryByRole('meter', { name: 'Agent budget used' })).toBeNull();
    expect(screen.queryByText(/\$0\.00/u)).toBeNull();
    expect(screen.getByText(/has not reported this month’s budget/u)).toBeTruthy();
    expect(screen.getByText('Degraded')).toBeTruthy();
    expect(screen.queryByText('Slow responses')).toBeNull();
  });

  it('UI-141 confirmation is what the kernel does, and a missing indexer is not "pid 0"', () => {
    render(() => <AiPanel ai={ai({ requireConfirm: false }, 0)} />);
    expect(screen.getByText(/^Asks before deletes, overwrites/u)).toBeTruthy();
    expect(screen.getByText('ai.indexer is not running')).toBeTruthy();
    expect(screen.queryByText(/^ai\.indexer pid 0/u)).toBeNull();
  });

  it('UI-146 the log button opens the Terminal and says how to read the full log', () => {
    const onOpenLog = vi.fn();
    render(() => <AiPanel ai={SAMPLE_AI} onOpenLog={onOpenLog} />);
    const button = screen.getByRole('button', { name: 'Open Terminal…' });
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/run ai log in the Terminal/u);
    fireEvent.click(button);
    expect(onOpenLog).toHaveBeenCalledOnce();
  });
});
