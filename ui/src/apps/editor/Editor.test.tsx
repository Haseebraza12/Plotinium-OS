import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { DocumentTabs, tabAccessibleName, type DocumentTab } from './DocumentTabs.tsx';
import { EditorApp, type EditorDocument } from './EditorApp.tsx';
import { ConflictBanner, conflictTitle, type ConflictState } from './EditorBanner.tsx';
import { EditorSidebar } from './EditorSidebar.tsx';
import { EditorStatusBar, saveText, syncText } from './EditorStatusBar.tsx';
import {
  activeHeading,
  conflictedCopyName,
  languageOf,
  leaseSecondsLeft,
  markdownOutline,
} from './format.ts';
import { LockChip, lockChipLabel, lockChipText, type LockState } from './LockChip.tsx';

const REPORT = [
  '# OS Report',
  '',
  '## 1. Boot sequence',
  '```ts',
  '# not a heading',
  '```',
  '## 4. Sync and conflicts',
  '### 4.1 File locks',
  'A lock is a **lease**.',
].join('\n');

describe('UI-EditorFormat', () => {
  it('SYN-08 conflicted copies are named "name (conflict from user, YYYY-MM-DD).ext"', () => {
    expect(conflictedCopyName('os-report.md', 'student', '2026-09-24T10:00:00Z')).toBe(
      'os-report (conflict from student, 2026-09-24).md',
    );
    expect(conflictedCopyName('Makefile', 'bob', new Date(Date.UTC(2026, 10, 14)))).toBe(
      'Makefile (conflict from bob, 2026-11-14)',
    );
    expect(conflictedCopyName('.bashrc', 'alice', '2026-01-02')).toBe(
      '.bashrc (conflict from alice, 2026-01-02)',
    );
  });

  it('UI-EditorFormat builds the outline from ATX headings outside code fences', () => {
    const outline = markdownOutline(REPORT);
    expect(outline).toEqual([
      { level: 1, text: 'OS Report', line: 1 },
      { level: 2, text: '1. Boot sequence', line: 3 },
      { level: 2, text: '4. Sync and conflicts', line: 7 },
      { level: 3, text: '4.1 File locks', line: 8 },
    ]);
    expect(activeHeading(outline, 9)?.text).toBe('4.1 File locks');
    expect(activeHeading(outline, 5)?.text).toBe('1. Boot sequence');
    expect(languageOf('scheduler.ts')).toBe('typescript');
    expect(languageOf('README.md')).toBe('markdown');
    expect(leaseSecondsLeft(12_000, 0)).toBe(12);
    expect(leaseSecondsLeft(0, 5_000)).toBe(0);
  });
});

describe('UI-DocumentTabs', () => {
  const TABS: DocumentTab[] = [
    { id: 'a', label: 'os-report.md', badge: 'MD', state: 'conflict' },
    { id: 'b', label: 'scheduler.ts', badge: 'TS', state: 'dirty' },
    { id: 'c', label: 'README.md', badge: 'MD' },
  ];

  it('DSN-08 tab state carried by a dot is also in the accessible name', () => {
    expect(tabAccessibleName(TABS[0] ?? { id: '', label: '' })).toBe('os-report.md, has conflict');
    expect(tabAccessibleName(TABS[1] ?? { id: '', label: '' })).toBe(
      'scheduler.ts, unsaved changes',
    );
  });

  it('UI-DocumentTabs is an APG tablist with roving focus and close buttons', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(() => (
      <DocumentTabs
        label="Open files"
        tabs={TABS}
        selected="a"
        onSelect={onSelect}
        onClose={onClose}
        panelId="panel"
      />
    ));
    const list = screen.getByRole('tablist', { name: 'Open files' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(tabs[0]?.getAttribute('aria-controls')).toBe('panel');
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('c');
    // Close is a pointer affordance outside the accessibility tree; keyboards use Delete.
    expect(tabs[1]?.getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(screen.queryByRole('button', { name: 'Close scheduler.ts' })).toBeNull();
    fireEvent.click(document.querySelector('[data-close="b"]') as HTMLElement);
    expect(onClose).toHaveBeenCalledWith('b');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('UI-ConflictBanner', () => {
  const CONFLICT: ConflictState = {
    kind: 'conflict',
    copyName: 'os-report (conflict from student, 2026-09-24).md',
    offline: true,
  };

  it('VFS-10 names the kept copy and offers Compare and Open conflicted copy', () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(() => <ConflictBanner state={CONFLICT} onAction={onAction} onDismiss={onDismiss} />);
    const region = screen.getByRole('region', { name: 'Sync conflict' });
    expect(within(region).getByRole('alert').textContent).toBe(
      'This file changed on the server while you were offline.',
    );
    expect(region.textContent).toContain(
      'Your version was saved as “os-report (conflict from student, 2026-09-24).md”.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open conflicted copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onAction.mock.calls).toEqual([['compare'], ['open-copy']]);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('VFS-10 a deleted copy disables both actions with a reason', () => {
    const onAction = vi.fn();
    render(() => <ConflictBanner state={{ ...CONFLICT, copyMissing: true }} onAction={onAction} />);
    const compare = screen.getByRole('button', { name: 'Compare' });
    expect(compare.getAttribute('aria-disabled')).toBe('true');
    expect(compare.getAttribute('title')).toBe('The conflicted copy was deleted');
    fireEvent.click(compare);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('UI-ConflictBanner resolved, checking and error states use exact strings', () => {
    expect(conflictTitle({ kind: 'resolved', version: 8 })).toBe('Conflict resolved · kept v8');
    expect(conflictTitle({ kind: 'checking' })).toBe('Checking server version…');
    expect(conflictTitle({ kind: 'error', retryInSeconds: 4 })).toBe(
      'Could not reach server · retry in 4 s',
    );
    expect(conflictTitle({ ...CONFLICT, offline: false })).toBe('This file changed on the server.');
    const onAction = vi.fn();
    render(() => (
      <ConflictBanner state={{ kind: 'error', retryInSeconds: 4 }} onAction={onAction} />
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledWith('retry');
  });

  it('DSN-05 the banner leaves at once under reduced motion', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    const [state, setState] = createSignal<ConflictState | undefined>(CONFLICT);
    render(() => <ConflictBanner state={state()} onAction={() => undefined} />);
    expect(screen.queryByRole('region', { name: 'Sync conflict' })).not.toBeNull();
    setState(undefined);
    expect(screen.queryByRole('region', { name: 'Sync conflict' })).toBeNull();
  });
});

describe('UI-LockChip', () => {
  const other = (expiresAt: number): LockState => ({
    kind: 'other',
    holder: 'alice',
    expiresAt,
    leaseMs: 30_000,
    fence: 42,
  });

  it('VFS-09 shows who holds the lease and the seconds left, in text and in words', () => {
    render(() => <LockChip state={other(12_000)} now={() => 0} />);
    const chip = screen.getByRole('button', {
      name: 'Read-only, locked by alice, lease 12 seconds',
    });
    expect(chip.textContent).toContain('Read-only — locked by alice (lease 12 s)');
    expect(chip.getAttribute('title')).toBe('alice holds the write lease · 12 s left · fence 42');
    expect(screen.getByRole('timer').textContent).toBe('12 seconds left on the lease');
    expect(lockChipText({ kind: 'mine' }, 0)).toBe('Editing — you hold the lock');
    expect(lockChipLabel({ kind: 'released', holder: 'alice' }, 0)).toBe(
      'Editable, alice released the lock',
    );
  });

  it('VFS-09 the countdown steps once per second and announces expiry and release', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const [state, setState] = createSignal<LockState>(other(6_000));
      render(() => <LockChip state={state()} now={() => now} />);
      now = 2_000;
      vi.advanceTimersByTime(1000);
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
        'Read-only, locked by alice, lease 4 seconds',
      );
      expect(screen.getByRole('status').textContent).toBe('Lease expiring');
      setState({ kind: 'released', holder: 'alice' });
      expect(screen.getByRole('status').textContent).toBe('alice released the lock');
    } finally {
      vi.useRealTimers();
    }
  });

  it('UI-LockChip click opens the lock popover through a callback', () => {
    const onActivate = vi.fn();
    render(() => <LockChip state={{ kind: 'mine' }} onActivate={onActivate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editing, you hold the lock' }));
    expect(onActivate).toHaveBeenCalledOnce();
  });
});

describe('UI-EditorStatusBar', () => {
  it('UI-EditorStatusBar reads "Ln 42, Col 7 · UTF-8 · Markdown · saved v8 · synced"', () => {
    const onAskAi = vi.fn();
    render(() => (
      <EditorStatusBar
        line={42}
        col={7}
        language="Markdown"
        save={{ kind: 'saved', version: 8 }}
        sync={{ kind: 'synced' }}
        readOnly
        onAskAi={onAskAi}
      />
    ));
    const bar = screen.getByRole('contentinfo');
    expect(bar.textContent?.replace(/\s+/gu, ' ')).toContain(
      'Ln 42, Col 7 · UTF-8 · Markdown · saved v8 · synced',
    );
    expect(bar.textContent).toContain('Read-only');
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(onAskAi).toHaveBeenCalledOnce();
    // Only save and sync are in the live region, never the caret.
    expect(screen.getByRole('status').textContent).not.toContain('Ln 42');
  });

  it('UI-EditorStatusBar hides Ask AI in the AI-off build and names every sync state', () => {
    render(() => (
      <EditorStatusBar
        line={1}
        col={1}
        language="Markdown"
        save={{ kind: 'queued', queued: 1 }}
        sync={{ kind: 'offline', queued: 3 }}
      />
    ));
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    expect(saveText({ kind: 'queued', queued: 1 })).toBe('saved · offline, 1 queued');
    expect(syncText({ kind: 'offline', queued: 3 })).toBe('offline · 3 queued');
    expect(syncText({ kind: 'conflict', count: 1 })).toBe('1 conflict');
    expect(saveText({ kind: 'failed' })).toBe('save failed · retry');
  });
});

describe('UI-EditorSidebar', () => {
  it('UI-EditorSidebar outline is a tree that jumps to headings; files is a listbox', () => {
    const onJump = vi.fn();
    const onFile = vi.fn();
    render(() => (
      <EditorSidebar
        outline={markdownOutline(REPORT)}
        activeLine={7}
        onOutlineSelect={onJump}
        folder="/home/student/notes"
        files={[
          { id: 'r', name: 'os-report.md' },
          { id: 'c', name: 'os-report (conflict from student, 2026-09-24).md', conflict: true },
        ]}
        selectedFile="r"
        onFileSelect={onFile}
      />
    ));
    const items = within(screen.getByRole('tree')).getAllByRole('treeitem');
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2', '3']);
    expect(items[2]?.getAttribute('aria-selected')).toBe('true');
    expect(items[2]?.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(items[2] as HTMLElement, { key: 'Enter' });
    expect(onJump).toHaveBeenCalledWith(7);
    const option = screen.getByRole('option', {
      name: 'os-report (conflict from student, 2026-09-24).md, conflicted copy',
    });
    expect(option.textContent).toContain('Conflict');
    fireEvent.click(option);
    expect(onFile).toHaveBeenCalledWith('c');
  });
});

describe('UI-EditorApp', () => {
  const DOCS: EditorDocument[] = [
    { id: 'r', name: 'os-report.md', path: '/home/student/notes/os-report.md', state: 'conflict' },
    { id: 's', name: 'scheduler.ts' },
  ];

  it('VFS-09 a locked document is read-only and a keystroke shows who holds it', () => {
    const onAttempt = vi.fn();
    render(() => (
      <EditorApp
        documents={DOCS}
        selected="r"
        onSelect={() => undefined}
        doc={REPORT}
        lockHolder="alice"
        folder="/home/student/notes"
        files={[]}
        save={{ kind: 'saved', version: 8 }}
        sync={{ kind: 'synced' }}
        onReadOnlyAttempt={onAttempt}
      />
    ));
    const box = screen.getByRole('textbox', { name: 'os-report.md (read-only)' });
    expect(box.getAttribute('aria-readonly')).toBe('true');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(screen.getByText('Locked by alice · you can read, not edit')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'os-report.md, has conflict' })).toBeTruthy();
    expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(4);
  });
});
