import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { SHUTDOWN_STEPS, UPDATE_CURRENT, UPDATE_NEXT, UPDATE_NOTES } from './fixtures.ts';
import {
  codeRuns,
  RestartToUpdateDialog,
  type RestartToUpdateDialogProps,
} from './RestartToUpdateDialog.tsx';
import { ShutdownProgress } from './ShutdownProgress.tsx';

function renderDialog(overrides: Partial<RestartToUpdateDialogProps> = {}) {
  const props: RestartToUpdateDialogProps = {
    open: true,
    current: UPDATE_CURRENT,
    next: UPDATE_NEXT,
    notes: UPDATE_NOTES,
    onReleaseNotes: () => undefined,
    autoInstall: true,
    onAutoInstallChange: () => undefined,
    onLater: () => undefined,
    onRestart: () => undefined,
    ...overrides,
  };
  return render(() => <RestartToUpdateDialog {...props} />);
}

describe('UI-RestartToUpdateDialog', () => {
  it('OFF-05 the dialog names the version change and focuses Later, the safe action', async () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Plotinium 0.3.1 is ready' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const body = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(body?.textContent).toContain('activates on your next restart');
    expect(dialog.textContent).toContain('a1f93c2');
    expect(dialog.textContent).toContain('c47e0b9');
    expect(dialog.textContent).toContain('18.4 MB');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Later' })),
    );
  });

  it("OFF-05 What's new lists the notes with inline code", () => {
    renderDialog();
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[2]?.querySelector('code')?.textContent).toBe('ai explain');
    expect(items[0]?.textContent).toBe('Faster boot: independent services start in parallel');
  });

  it('OFF-05 Escape means Later; Ctrl+Enter and the button restart', async () => {
    const onLater = vi.fn();
    const onRestart = vi.fn();
    renderDialog({ onLater, onRestart });
    const later = screen.getByRole('button', { name: 'Later' });
    await waitFor(() => expect(document.activeElement).toBe(later));
    fireEvent.keyDown(later, { key: 'Enter', ctrlKey: true });
    expect(onRestart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Restart Now' }));
    expect(onRestart).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(later, { key: 'Escape' });
    expect(onLater).toHaveBeenCalledWith('escape');
    fireEvent.click(later);
    expect(onLater).toHaveBeenCalledWith('button');
  });

  it('UI-RestartToUpdateDialog the auto-install checkbox reports changes', () => {
    const onAutoInstallChange = vi.fn();
    renderDialog({ onAutoInstallChange });
    const box = screen.getByRole('checkbox', { name: 'Install updates automatically' });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(onAutoInstallChange).toHaveBeenCalledWith(false);
  });

  it('UI-RestartToUpdateDialog restarting blocks a second restart and an error is an alert', () => {
    const onRestart = vi.fn();
    renderDialog({ restarting: true, onRestart, error: 'A restart is already in progress' });
    const button = screen.getByRole('button', { name: 'Restarting…' });
    fireEvent.click(button);
    expect(onRestart).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A restart is already in progress');
  });

  it('UI-RestartToUpdateDialog a scrim click nudges instead of closing', () => {
    const onLater = vi.fn();
    renderDialog({ onLater });
    const scrim = screen.getByRole('alertdialog').parentElement?.previousElementSibling;
    fireEvent.click(scrim as Element);
    expect(onLater).not.toHaveBeenCalled();
    expect(screen.getByText('Choose Later or Restart Now')).toBeTruthy();
  });

  it('UI-RestartToUpdateDialog splits backticked code runs', () => {
    expect(codeRuns('`ai explain` for failed commands')).toEqual([
      { text: 'ai explain', code: true },
      { text: ' for failed commands', code: false },
    ]);
  });
});

describe('UI-ShutdownProgress', () => {
  it('BOOT-12 shows a determinate ring and the steps in their real order with state in text', () => {
    render(() => (
      <ShutdownProgress
        title="Restarting Plotinium…"
        percent={62}
        phase="stopping services"
        stopped={11}
        total={18}
        verbose="Stopping services (reverse order) · flushing 3 dirty pages · saving session…"
        steps={SHUTDOWN_STEPS}
        footer="Session saved for student (uid 1001) · 4 windows"
        bound="≤ 8 s"
      />
    ));
    const ring = screen.getByRole('progressbar', { name: 'Restarting Plotinium…' });
    expect(ring.getAttribute('aria-valuenow')).toBe('62');
    expect(ring.getAttribute('aria-valuetext')).toBe('62 percent, stopping services, 11 of 18');
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'active',
      'pending',
    ]);
    expect(items[3]?.textContent).toContain('in progress');
    expect(items[4]?.textContent).toContain('waiting');
    expect(items[3]?.querySelectorAll('[data-state="done"]')).toHaveLength(10);
    expect(screen.getByText('62% · stopping services · 11 of 18')).toBeTruthy();
  });
});
