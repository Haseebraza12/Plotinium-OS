import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentConfirmSheet,
  toneOfOp,
  type AgentConfirmSheetProps,
  type AgentPlanStep,
} from './AgentConfirmSheet.tsx';
import {
  AGENT_BLAST,
  AGENT_POLICY,
  AGENT_REASONS,
  AGENT_REQUEST,
  AGENT_STEPS,
} from './fixtures.ts';

function renderSheet(overrides: Partial<AgentConfirmSheetProps> = {}) {
  const props: AgentConfirmSheetProps = {
    open: true,
    agent: 'ai.agent',
    pid: 212,
    request: AGENT_REQUEST,
    steps: AGENT_STEPS,
    blast: AGENT_BLAST,
    quota: { ok: true, text: 'within quota · 1.2 GB free' },
    runAs: { user: 'student', uid: 1001 },
    reasons: AGENT_REASONS,
    policy: AGENT_POLICY,
    provider: 'Claude via gateway',
    onCancel: () => undefined,
    onRun: () => undefined,
    onEditPlan: () => undefined,
    onOpenLog: () => undefined,
    ...overrides,
  };
  return render(() => (
    <div style={{ position: 'relative', width: '900px', height: '700px' }}>
      <AgentConfirmSheet {...props} />
    </div>
  ));
}

describe('UI-AgentConfirmSheet', () => {
  it('AGT-03 DSN-15 the sheet is a modal alertdialog and Cancel is the default focus', async () => {
    renderSheet();
    const sheet = screen.getByRole('alertdialog', { name: 'Confirm destructive plan' });
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    const described = (sheet.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('ai.agent wants to run 5 steps in one transaction');
    expect(described).toContain('23 inodes, 3 deletions, 0 overwrites');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );
  });

  it('AGT-03 plain Enter on the default answers Cancel; only Ctrl+Enter runs the plan', async () => {
    const onCancel = vi.fn();
    const onRun = vi.fn();
    renderSheet({ onCancel, onRun });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.keyDown(cancel, { key: 'Enter' });
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledWith('button');
    fireEvent.keyDown(cancel, { key: 'Enter', ctrlKey: true });
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('AGT-03 Escape cancels and E edits the plan', () => {
    const onCancel = vi.fn();
    const onEditPlan = vi.fn();
    renderSheet({ onCancel, onEditPlan });
    const sheet = screen.getByRole('alertdialog');
    fireEvent.keyDown(sheet, { key: 'e' });
    expect(onEditPlan).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledWith('escape');
  });

  it('DSN-08 the plan table names every operation in text and shows the effects', () => {
    renderSheet();
    const table = screen.getByRole('table', { name: 'Plan steps' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(within(table).getAllByText('DELETE')).toHaveLength(3);
    expect(within(table).getByText('MOVE')).toBeTruthy();
    expect(within(table).getByText('CHMOD')).toBeTruthy();
    expect(rows[1]?.textContent).toContain('remove 1 dir, 9 files · to trash');
    expect(rows[4]?.textContent).toContain('~/notes/lab3-vfs.md → ~/notes/archive/');
    expect(rows[5]?.textContent).toContain('-R go-rwx');
  });

  it('DSN-16 the secure band names the requesting process', () => {
    renderSheet();
    expect(screen.getByText('Kernel confirmation · ai.agent pid 212')).toBeTruthy();
    expect(screen.getByText('secure layer · not drawn by the app')).toBeTruthy();
  });

  it('AGT-03 the "Why this needs confirmation" disclosure lists the kernel reasons', () => {
    renderSheet();
    const toggle = screen.getByRole('button', { name: 'Why this needs confirmation' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(region?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(region?.hidden).toBe(false);
    const items = within(region as HTMLElement).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Deletes files (3 directories, 16 files)DELETE',
      'Touches more than 20 inodes (23 > threshold 20)BLAST_RADIUS',
      'Changes permissions on ~/notes/archive/CHMOD',
    ]);
  });

  it('AGT-03 Run plan is disabled while loading and when over quota', () => {
    const onRun = vi.fn();
    const { unmount } = renderSheet({ status: 'loading', blast: undefined, onRun });
    const run = screen.getByRole('button', { name: 'Run plan' });
    expect(run.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(run, { key: 'Enter', ctrlKey: true });
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getAllByText('—')).toHaveLength(3);
    unmount();
    renderSheet({ quota: { ok: false, text: 'over quota by 38 MB' }, onRun });
    expect(screen.getByRole('button', { name: 'Run plan' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByText('over quota by 38 MB')).toBeTruthy();
  });

  it('UI-AgentConfirmSheet running shows determinate progress; rejection offers only Close', async () => {
    const onCancel = vi.fn();
    const { unmount } = renderSheet({ status: 'running', progress: { done: 3, total: 5 } });
    expect(screen.getByRole('button', { name: 'Running… 3 of 5' })).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Running plan' }).getAttribute('aria-valuenow'),
    ).toBe('3');
    unmount();
    renderSheet({
      status: 'rejected',
      rejection: 'Plan rejected: EACCES /system/bin — nothing ran',
      onCancel,
    });
    expect(screen.getByRole('alert').textContent).toContain('EACCES /system/bin');
    expect(screen.queryByRole('button', { name: 'Run plan' })).toBeNull();
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledWith('close');
  });

  it('UI-AgentConfirmSheet a scrim click asks for an answer instead of closing', () => {
    const onCancel = vi.fn();
    renderSheet({ onCancel });
    const scrim = screen.getByRole('alertdialog').parentElement?.previousElementSibling;
    fireEvent.click(scrim as Element);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Answer the confirmation first')).toBeTruthy();
  });

  it('UI-AgentConfirmSheet warns before the kernel timeout and flags ungrounded steps', () => {
    renderSheet({
      expiresInS: 20,
      steps: [{ ...(AGENT_STEPS[0] as AgentPlanStep), flag: 'ungrounded' }],
    });
    expect(
      screen.getByText('This request will be cancelled in 20 seconds — nothing will run'),
    ).toBeTruthy();
    expect(screen.getByText('not in your request')).toBeTruthy();
  });

  it('UI-AgentConfirmSheet derives badge tones from the operation', () => {
    expect(toneOfOp('DELETE')).toBe('danger');
    expect(toneOfOp('mv')).toBe('accent');
    expect(toneOfOp('CHMOD')).toBe('warning');
    expect(toneOfOp('MKDIR')).toBe('neutral');
  });
});
