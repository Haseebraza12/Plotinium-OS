import { fireEvent, getAllByRole, getByRole } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPanicScreen, cycleSvg } from './panic.ts';
import { createRecoveryConsole } from './recovery.ts';
import { createUnsupportedScreen, DEGRADED_TITLE, UNSUPPORTED_TITLE } from './unsupported.ts';

const ID = { version: '0.3.0', build: 'a1f93c2' } as const;
const CYCLE = ['auth', 'sync', 'lockd', 'auth'] as const;

afterEach(() => {
  document.body.replaceChildren();
});

function panic(): {
  screen: ReturnType<typeof createPanicScreen>;
  onAction: ReturnType<typeof vi.fn>;
} {
  const onAction = vi.fn();
  const screen = createPanicScreen({
    ...ID,
    bootId: '7f3e·b12c',
    cycle: CYCLE,
    lines: [
      { t: 0.06, sub: 'svc', msg: '18 manifests (volume) · 31 edges' },
      {
        t: 0.06,
        sub: 'svc',
        msg: 'KERNEL PANIC: dependency cycle detected: auth → sync → lockd → auth',
      },
    ],
    onAction,
  });
  document.body.append(screen.el);
  screen.focus();
  return { screen, onAction };
}

describe('UI-PanicScreen', () => {
  it('BOOT-04 the panic screen names the cycle in the log and in the graph', () => {
    const { screen } = panic();
    const dialog = getByRole(screen.el, 'alertdialog', { name: 'Plotinium Kernel panic' });
    expect(dialog.textContent).toContain(
      'svc: KERNEL PANIC: dependency cycle detected: auth → sync → lockd → auth',
    );
    const graph = getByRole(screen.el, 'img', { name: /dependency cycle/iu });
    expect(graph.getAttribute('aria-label')).toBe(
      'Dependency cycle: sync requires auth, lockd requires sync, auth requires lockd.',
    );
    expect(graph.querySelectorAll('.plb-ge path')).toHaveLength(3);
    expect(graph.textContent).toContain('closes cycle');
    expect(cycleSvg(['a'], 'x')).toBeNull();
  });

  it('BOOT-13 focus starts on Recovery console; R, S and D work from anywhere', () => {
    const { screen, onAction } = panic();
    const recovery = getByRole(screen.el, 'button', { name: 'Recovery console' });
    expect(document.activeElement).toBe(recovery);
    expect(
      getAllByRole(screen.el, 'button').map((b) => b.getAttribute('aria-keyshortcuts')),
    ).toEqual(['R', 'S', 'D']);
    fireEvent.keyDown(document.body, { key: 's' });
    fireEvent.keyDown(document.body, { key: 'D' });
    fireEvent.keyDown(document.body, { key: 'r', ctrlKey: true });
    fireEvent.click(recovery);
    expect(onAction.mock.calls).toEqual([['safe'], ['diagnostics'], ['recovery']]);
  });

  it('UI-PanicScreen setBusy relabels the running action and disables the others', () => {
    const { screen, onAction } = panic();
    screen.setBusy('recovery', 'Rebooting into recovery…');
    expect(getByRole(screen.el, 'button', { name: 'Rebooting into recovery…' })).toBeTruthy();
    expect(
      getByRole(screen.el, 'button', { name: 'Safe mode' }).getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.keyDown(document.body, { key: 'S' });
    expect(onAction).not.toHaveBeenCalled();
    expect(getByRole(screen.el, 'status').textContent).toBe('Rebooting into recovery…');
    screen.destroy();
    fireEvent.keyDown(document.body, { key: 'R' });
    expect(onAction).not.toHaveBeenCalled();
  });
});

function recovery(): {
  rc: ReturnType<typeof createRecoveryConsole>;
  onAction: ReturnType<typeof vi.fn>;
  list: HTMLElement;
} {
  const onAction = vi.fn();
  const rc = createRecoveryConsole({
    ...ID,
    reason: 'Critical service "storage" failed: local database version is newer than this build.',
    status: 'Offline · storage 412 MB used',
    onAction,
  });
  document.body.append(rc.el);
  rc.focus();
  return { rc, onAction, list: getByRole(rc.el, 'listbox', { name: 'Actions' }) };
}

describe('UI-RecoveryConsole', () => {
  it('BOOT-06 recovery console runs fsck, clear local cache, reset session and restore default manifests', () => {
    const { rc, onAction } = recovery();
    fireEvent.keyDown(document.body, { key: 'f' });
    expect(onAction).toHaveBeenLastCalledWith('fsck');
    for (const [key, id, title] of [
      ['C', 'clear-cache', 'Clear local cache and re-sync'],
      ['S', 'reset-session', 'Reset session'],
      ['M', 'restore-manifests', 'Restore default service manifests'],
    ] as const) {
      fireEvent.keyDown(document.body, { key });
      expect(onAction).not.toHaveBeenLastCalledWith(id);
      expect(getByRole(rc.el, 'alertdialog').textContent).toContain(title);
      fireEvent.click(getByRole(rc.el, 'button', { name: /^Yes, /u }));
      expect(onAction).toHaveBeenLastCalledWith(id);
    }
    expect(onAction).toHaveBeenCalledTimes(4);
  });

  it('BOOT-13 the action list works from the keyboard: arrows choose, Enter runs, Esc cancels a confirmation', () => {
    const { rc, onAction, list } = recovery();
    expect(document.activeElement).toBe(list);
    expect(getByRole(rc.el, 'heading', { level: 1 }).textContent).toBe('Check file system');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(rc.selected).toBe('repair');
    fireEvent.keyDown(list, { key: 'Enter' });
    const confirm = getByRole(rc.el, 'alertdialog');
    expect(confirm.textContent).toContain('Repairs apply to this device only');
    expect(document.activeElement).toBe(getByRole(confirm, 'button', { name: 'Cancel' }));
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(confirm.hidden).toBe(true);
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onAction.mock.calls).toEqual([['safe']]);
  });

  it('UI-RecoveryConsole the fsck checklist states each pass in words and the bar carries real values', () => {
    const { rc } = recovery();
    rc.setChecklist([
      { label: 'Every inode reachable from /', state: 'passed', detail: '12,408 / 12,408' },
      { label: 'Quota totals consistent', state: 'running', detail: 'student ✓ alice ✓ bob' },
      { label: 'Blob refcounts & structure', state: 'pending' },
    ]);
    const list = getByRole(rc.el, 'list', { name: 'fsck passes' });
    const items = getAllByRole(list, 'listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Every inode reachable from /, passed12,408 / 12,408',
      'Quota totals consistent, runningstudent ✓ alice ✓ bob',
      'Blob refcounts & structure, pendingpending',
    ]);
    rc.setProgress(0.78, 'Stage 4 of 5 · quota totals · 78%');
    const bar = getByRole(rc.el, 'progressbar', { name: 'Recovery progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('78');
    expect(bar.getAttribute('aria-valuetext')).toBe('Stage 4 of 5 · quota totals · 78%');
    rc.output.append({ t: 0.004, sub: 'fsck', msg: 'mode check · target / · read-only' });
    rc.output.flush();
    expect(getByRole(rc.el, 'log', { name: 'Recovery output' }).getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  it('UI-RecoveryConsole while an action runs, destructive actions and reboots are disabled', () => {
    const { rc, onAction } = recovery();
    rc.setBusy('fsck');
    expect(rc.el.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    const clear = getByRole(rc.el, 'option', { name: 'Clear local cache and re-sync' });
    expect(clear.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'C' });
    fireEvent.keyDown(document.body, { key: 'N' });
    expect(rc.el.querySelector<HTMLElement>('.plb-confirm')?.hidden).toBe(true);
    fireEvent.keyDown(document.body, { key: 'D' });
    expect(onAction.mock.calls).toEqual([['diagnostics']]);
    rc.setBusy(null);
    expect(clear.hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('UI-UnsupportedScreen', () => {
  const caps = [
    { name: 'Secure context', probe: 'localhost:4717', status: 'pass', required: true },
    { name: 'IndexedDB', status: 'pass', required: true },
    {
      name: 'Origin Private File System',
      status: 'missing',
      fix: 'Swap falls back to IndexedDB (plotinium-swap)',
    },
    {
      name: 'Cross-origin isolation',
      status: 'degraded',
      fix: 'Pre-emption falls back to messages · AI search runs single-threaded',
    },
  ] as const;

  it('UI-UnsupportedScreen a missing required capability is fatal: the spec title and no Continue', () => {
    const onContinue = vi.fn();
    const screen = createUnsupportedScreen({
      ...ID,
      capabilities: [...caps, { name: 'Web Locks', status: 'missing', required: true }],
      onContinue,
      onCopyDiagnostics: vi.fn(),
    });
    document.body.append(screen.el);
    screen.focus();
    expect(screen.fatal).toBe(true);
    expect(getByRole(screen.el, 'heading', { level: 1 }).textContent).toBe(UNSUPPORTED_TITLE);
    expect(getAllByRole(screen.el, 'button').map((b) => b.textContent)).toEqual([
      'Copy diagnostics',
    ]);
    expect(getByRole(screen.el, 'alert').textContent).toContain('3 features unavailable');
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('UI-UnsupportedScreen degradable-only offers Continue (Enter) and Copy diagnostics (D); status is a word', () => {
    const onContinue = vi.fn();
    const onCopyDiagnostics = vi.fn();
    const screen = createUnsupportedScreen({
      ...ID,
      platform: 'Chrome 128 on Linux',
      capabilities: caps,
      onContinue,
      onCopyDiagnostics,
    });
    document.body.append(screen.el);
    screen.focus();
    expect(screen.fatal).toBe(false);
    expect(getByRole(screen.el, 'heading', { level: 1 }).textContent).toBe(DEGRADED_TITLE);
    expect(document.activeElement).toBe(
      getByRole(screen.el, 'button', { name: 'Continue in degraded mode' }),
    );
    const rows = getAllByRole(
      getByRole(screen.el, 'list', { name: 'Browser capabilities' }),
      'listitem',
    );
    expect(rows.map((r) => r.querySelector('.plb-tagx')?.textContent)).toEqual([
      'Pass',
      'Pass',
      'Missing',
      'Degraded',
    ]);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.keyDown(document.body, { key: 'd' });
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onCopyDiagnostics).toHaveBeenCalledTimes(1);
    screen.setCopyState('copied');
    expect(getByRole(screen.el, 'button', { name: 'Copied' })).toBeTruthy();
  });
});
