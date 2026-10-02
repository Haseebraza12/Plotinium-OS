import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  SAMPLE_AI,
  SAMPLE_MEMORY,
  SAMPLE_PERFORMANCE,
  SAMPLE_PREDICTIONS,
  SAMPLE_PROCESSES,
  SAMPLE_SCHEDULER,
  SAMPLE_SUMMARY,
} from './fixtures.ts';
import type { TaskManagerTab } from './models.ts';
import { TaskManagerView, type TaskManagerViewProps } from './TaskManagerView.tsx';

type Intents = Pick<
  TaskManagerViewProps,
  'onSignal' | 'onRenice' | 'onPinChange' | 'onReclaim' | 'onPauseChange' | 'onCopy'
>;

function setup(overrides: Partial<TaskManagerViewProps> & { tab?: TaskManagerTab } = {}) {
  const intents: Intents = {
    onSignal: vi.fn(),
    onRenice: vi.fn(),
    onPinChange: vi.fn(),
    onReclaim: vi.fn(),
    onPauseChange: vi.fn(),
    onCopy: vi.fn(),
  };
  const result = render(() => (
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
      {...intents}
      {...overrides}
    />
  ));
  return { ...result, intents };
}

const grid = (): HTMLElement => screen.getByRole('grid', { name: 'Processes' });
const rowOf = (name: string): HTMLElement => {
  const row = within(grid())
    .getAllByRole('row')
    .find((r) => within(r).queryByText(name, { exact: true }) !== null);
  if (row === undefined) throw new Error(`no row ${name}`);
  return row;
};
const endButton = (): HTMLElement =>
  within(screen.getByRole('group', { name: 'End process' })).getAllByRole(
    'button',
  )[0] as HTMLElement;

describe('UI-TaskManager view', () => {
  it('PROC-08 shows the four views as a segmented control and every process in the grid', () => {
    setup();
    const views = screen.getByRole('radiogroup', { name: 'Task Manager view' });
    expect(
      within(views)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Processes', 'Memory', 'Scheduler', 'AI']);
    expect(
      within(views).getByRole('radio', { name: 'Processes' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(within(grid()).getAllByRole('row')).toHaveLength(SAMPLE_PROCESSES.length + 1);
    expect(screen.getByText('12').closest('p')?.textContent).toContain('uptime 2h 14m');
    expect(screen.getByRole('columnheader', { name: /CPU %/ }).getAttribute('aria-sort')).toBe(
      'descending',
    );
  });

  it('DSN-08 state pills carry a glyph, the word and the reason', () => {
    setup();
    const row = rowOf('ai.agent');
    expect(row.textContent).toContain('Blocked');
    expect(row.textContent).toContain('awaiting llm');
    expect(rowOf('files').textContent).toContain('0 B (38 MB swapped)');
    expect(within(rowOf('ai.indexer')).getByText('background')).toBeTruthy();
    expect(within(rowOf('ai.indexer')).getByText('niced')).toBeTruthy();
  });

  it('PROC-08 End Process asks once ("End burn (301)?") and then sends SIGTERM', () => {
    const { intents } = setup();
    expect(endButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(rowOf('burn'));
    fireEvent.click(endButton());
    expect(intents.onSignal).not.toHaveBeenCalled();
    expect(endButton().textContent).toContain('End burn (301)?');
    fireEvent.click(endButton());
    expect(intents.onSignal).toHaveBeenCalledWith(301, 'SIGTERM');
  });

  it('UI-TaskManager defaultSelectedPid selects that row on mount and enables End Process', () => {
    setup({ defaultSelectedPid: 301 });
    expect(rowOf('burn').getAttribute('aria-selected')).toBe('true');
    expect(endButton().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('PROC-08 End Process stays disabled for pid 1 and kernel services', () => {
    const { intents } = setup();
    fireEvent.click(rowOf('init'));
    expect(endButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(endButton());
    fireEvent.click(endButton());
    expect(intents.onSignal).not.toHaveBeenCalled();
  });

  it('PROC-08 Force kill (kill -9) always goes through an alertdialog naming the process', () => {
    const { intents } = setup();
    fireEvent.click(rowOf('burn'));
    fireEvent.click(screen.getByRole('button', { name: 'More ways to end the process' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Force kill/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Force kill burn (301)?' });
    expect(intents.onSignal).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Force kill' }));
    expect(intents.onSignal).toHaveBeenCalledWith(301, 'SIGKILL');
  });

  it('PROC-08 Delete on a selected row asks before ending it', () => {
    const { intents } = setup();
    const row = rowOf('editor');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Delete' });
    const dialog = screen.getByRole('alertdialog', { name: 'End editor (131)?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(intents.onSignal).not.toHaveBeenCalled();
  });

  it('UI-TaskManager search filters live and offers a clear action when nothing matches', () => {
    setup();
    const box = screen.getByRole('searchbox', { name: 'Search processes' });
    fireEvent.input(box, { target: { value: 'ai.' } });
    expect(within(grid()).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('status', { hidden: false }).textContent).toContain(
      '2 processes match',
    );
    fireEvent.input(box, { target: { value: 'xyz' } });
    expect(screen.getByText('No process matches “xyz”')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all processes' }));
    expect(within(grid()).getAllByRole('row')).toHaveLength(SAMPLE_PROCESSES.length + 1);
  });

  it('UI-TaskManager "/" focuses the search field', () => {
    setup();
    fireEvent.keyDown(rowOf('burn'), { key: '/' });
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Search processes' }),
    );
  });

  it('PROC-03 Renice shows the resulting priority and refuses a negative nice without root', () => {
    const { intents } = setup();
    fireEvent.click(rowOf('burn'));
    fireEvent.click(screen.getByRole('button', { name: 'Renice…' }));
    const slider = screen.getByRole('slider', { name: 'Nice value' });
    fireEvent.input(slider, { target: { value: '-5' } });
    expect(screen.getByRole('alert').textContent).toBe('EPERM: only root may lower nice below 0');
    fireEvent.input(slider, { target: { value: '12' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('nice +12, priority 32');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(intents.onRenice).toHaveBeenCalledWith(301, 12);
  });

  it('UI-TaskManager the status-bar pause stops live updates and says so (WCAG 2.2.2)', () => {
    const { intents } = setup();
    const pause = screen.getByRole('button', { name: 'Updated every 1 s' });
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pause);
    expect(intents.onPauseChange).toHaveBeenCalledWith(true);
    expect(
      screen.getByRole('button', { name: 'Paused · click to resume' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('PROC-08 executor sparklines are images with text summaries, and p95 is stated in words', () => {
    setup();
    expect(
      screen.getByRole('img', { name: /exec-4, CPU 99 percent, rising, hot, runs burn/ }),
    ).toBeTruthy();
    // UI-161: 16.7 ms is the budget itself, so the verdict says "within", not "under".
    expect(screen.getByText('within the 16.7 ms budget')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    expect(screen.getByRole('table')).toBeTruthy();
  });
});

describe('UI-TaskManager memory', () => {
  it('MEM-01 the budget is a meter with its value in words and an announced threshold chip', () => {
    setup({ tab: 'memory' });
    const meter = screen.getByRole('meter', { name: 'Memory budget' });
    expect(meter.getAttribute('aria-valuetext')).toBe(
      '231 of 256 MB accounted, 90%, above high watermark',
    );
    expect(screen.getByText('90% · above high watermark 85%')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Memory by category' }).textContent).toContain(
      'evictable',
    );
  });

  it('MEM-02 Pin switches send intents; kernel pins are locked', () => {
    const { intents } = setup({ tab: 'memory' });
    const pin = screen.getByRole('switch', { name: 'Pin memhog, pid 151' });
    expect(pin.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(pin);
    expect(intents.onPinChange).toHaveBeenCalledWith(151, true);
    const locked = screen.getByRole('switch', { name: 'Pin init, pid 1' });
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(locked);
    expect(intents.onPinChange).toHaveBeenCalledTimes(1);
  });

  it('MEM-01 Reclaim now sends an intent above the low watermark', () => {
    const { intents } = setup({ tab: 'memory' });
    fireEvent.click(screen.getByRole('button', { name: 'Reclaim now' }));
    expect(intents.onReclaim).toHaveBeenCalledTimes(1);
  });

  it('PRE-06 predictions show confidence as text and meters', () => {
    setup({ tab: 'memory' });
    const aside = screen.getByRole('complementary', { name: 'Predictions' });
    expect(
      within(aside)
        .getByRole('meter', { name: 'Terminal confidence' })
        .getAttribute('aria-valuenow'),
    ).toBe('62');
    expect(aside.textContent).toContain('62%');
    expect(aside.textContent).toContain('pre-fetched');
  });

  it('MEM-01 segments are reachable with the arrow keys and show their tooltip on focus', () => {
    setup({ tab: 'memory' });
    const items = within(screen.getByRole('list', { name: 'Memory by category' })).getAllByRole(
      'listitem',
    );
    const first = items[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[1]);
    expect(screen.getByRole('tooltip').textContent).toContain('Apps · 86 MB');
  });
});

describe('UI-TaskManager scheduler and AI', () => {
  it('PROC-04 the scheduler tab states the declared bound and the ready queue by band', () => {
    setup({ tab: 'scheduler' });
    expect(screen.getAllByText('5,450 ms').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('list', { name: 'Background band, ready processes' }).textContent,
    ).toContain('priority 39, aged to 0');
    expect(screen.getByText('Interactive')).toBeTruthy();
  });

  it('AGT-08 the AI tab shows the indexer, the budget in words and a filterable audit log', () => {
    setup({ tab: 'ai' });
    expect(
      screen.getByRole('meter', { name: 'Agent budget used' }).getAttribute('aria-valuetext'),
    ).toBe('$3.20 of $50.00 used this month');
    const log = screen.getByRole('list', { name: 'Audit entries, newest first' });
    expect(within(log).getAllByRole('listitem')).toHaveLength(SAMPLE_AI.audit.length);
    fireEvent.click(screen.getByRole('radio', { name: 'User' }));
    expect(within(log).getAllByRole('listitem')).toHaveLength(1);
  });
});
