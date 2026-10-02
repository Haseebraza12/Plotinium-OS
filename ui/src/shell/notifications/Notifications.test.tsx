import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShellNotification } from '../types.ts';
import { Wallpaper } from '../wallpaper/Wallpaper.tsx';
import { NotificationCard } from './NotificationCard.tsx';
import { groupNotifications, NotificationCenter } from './NotificationCenter.tsx';
import { NotificationToasts } from './NotificationToasts.tsx';

const NOW = Date.UTC(2026, 8, 24, 10, 42, 0);

const LOCK: ShellNotification = {
  id: 'n1',
  level: 'info',
  title: 'Lock granted — report.md',
  body: 'You hold the edit lock now · alice released it',
  app: 'editor',
  appName: 'Editor',
  at: NOW - 5_000,
  unread: true,
};
const UPDATE: ShellNotification = {
  id: 'n2',
  level: 'info',
  title: 'Restart to update',
  body: 'Plotinium 0.3.1 is ready. Your windows will be restored.',
  app: 'settings',
  appName: 'Settings',
  at: NOW - 120_000,
  actions: [
    { id: 'later', label: 'Later' },
    { id: 'restart', label: 'Restart', kind: 'primary' },
  ],
};
const CONFLICT: ShellNotification = {
  id: 'n3',
  level: 'warning',
  title: 'Conflict saved as copy',
  body: 'Your version was kept as',
  code: 'report (conflict from bob).md',
  app: 'files',
  appName: 'Files',
  at: NOW - 14 * 60_000,
  actions: [{ id: 'show', label: 'Show in Files', kind: 'link' }],
};
const COPY_DONE: ShellNotification = {
  id: 'n4',
  level: 'success',
  title: 'Copied 3 items',
  app: 'files',
  appName: 'Files',
  at: NOW - 20 * 60_000,
};
const ERROR: ShellNotification = {
  id: 'n5',
  level: 'error',
  title: 'Lock lost on report.md',
  body: 'The server revoked your lease.',
  app: 'editor',
  appName: 'Editor',
  at: NOW,
};

describe('UI-Notification', () => {
  beforeEach(() => {
    // Exit animations end at once, so dismissals are synchronous in these tests.
    document.documentElement.dataset.motion = 'reduce';
  });

  it('WMD-18 a card is an article named by level, source and title, with a spoken time', () => {
    render(() => (
      <NotificationCard notification={CONFLICT} now={NOW} onDismiss={() => undefined} />
    ));
    const card = screen.getByRole('article', {
      name: 'Warning from Files: Conflict saved as copy',
    });
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.textContent).toContain('14m ago');
    expect(card.textContent).toContain('14 minutes ago');
    expect(card.querySelector('code')?.textContent).toBe('report (conflict from bob).md');
    expect(card.dataset.level).toBe('warning');
  });

  it('WMD-18 actions call onAction; Delete on the focused card and the close button dismiss', () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    render(() => (
      <NotificationCard
        notification={UPDATE}
        now={NOW}
        onAction={onAction}
        onDismiss={onDismiss}
        onOpen={onOpen}
      />
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onAction).toHaveBeenCalledWith('restart');
    expect(onOpen).not.toHaveBeenCalled();
    const card = screen.getByRole('article');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.keyDown(card, { key: 'Delete' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Restart to update' }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('WMD-18 same-app notifications group, newest first', () => {
    const groups = groupNotifications([LOCK, CONFLICT, UPDATE, COPY_DONE]);
    expect(groups.map((g) => [g.key, g.items.map((n) => n.id)])).toEqual([
      ['editor', ['n1']],
      ['files', ['n3', 'n4']],
      ['settings', ['n2']],
    ]);
  });

  it('WMD-18 the centre stacks a group behind "+1 from Files" and expands it', () => {
    render(() => (
      <NotificationCenter
        notifications={[LOCK, UPDATE, CONFLICT, COPY_DONE]}
        now={NOW}
        onDismiss={() => undefined}
        onClearAll={() => undefined}
        onAction={() => undefined}
      />
    ));
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    const more = screen.getByRole('button', { name: '+1 from Files' });
    expect(document.querySelector('.pl-notification-stack')).not.toBeNull();
    fireEvent.click(more);
    expect(screen.getAllByRole('article')).toHaveLength(4);
    const toggle = screen.getByRole('button', { name: /Show (more|less)/u });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('Show less');
  });

  it('WMD-18 dismissing and Clear all reach the host; an empty centre says so', () => {
    const onDismiss = vi.fn();
    const onClearAll = vi.fn();
    const [list, setList] = createSignal<ShellNotification[]>([LOCK, UPDATE]);
    render(() => (
      <NotificationCenter
        notifications={list()}
        now={NOW}
        onDismiss={(id) => {
          onDismiss(id);
          setList((l) => l.filter((n) => n.id !== id));
        }}
        onClearAll={() => {
          onClearAll();
          setList([]);
        }}
        onAction={() => undefined}
      />
    ));
    fireEvent.keyDown(screen.getByRole('article', { name: /Lock granted/u }), { key: 'Backspace' });
    expect(onDismiss).toHaveBeenCalledWith('n1');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledOnce();
    expect(screen.getByText('No notifications')).toBeTruthy();
    expect(screen.getByText("You're all caught up.")).toBeTruthy();
  });
});

describe('UI-NotificationToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.dataset.motion = 'reduce';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('WMD-18 banners dismiss themselves by level; errors stay; hover pauses the timer', () => {
    const onDismiss = vi.fn();
    render(() => (
      <NotificationToasts
        inline
        notifications={[LOCK, CONFLICT, ERROR]}
        now={NOW}
        onDismiss={onDismiss}
        onAction={() => undefined}
      />
    ));
    const warning = screen.getByRole('article', { name: /Conflict saved as copy/u });
    fireEvent.pointerEnter(warning.parentElement as HTMLElement);
    vi.advanceTimersByTime(6_100);
    expect(onDismiss).toHaveBeenCalledWith('n1', 'timeout');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    // The hovered warning is paused.
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(warning.parentElement as HTMLElement);
    vi.advanceTimersByTime(10_100);
    expect(onDismiss).toHaveBeenCalledWith('n3', 'timeout');
    vi.advanceTimersByTime(60_000);
    expect(onDismiss).not.toHaveBeenCalledWith('n5', 'timeout');
  });

  it('WMD-18 at most three banners show, and Focus holds back info and success', () => {
    const [focus, setFocus] = createSignal(false);
    render(() => (
      <NotificationToasts
        inline
        notifications={[ERROR, LOCK, UPDATE, CONFLICT, COPY_DONE]}
        now={NOW}
        focusMode={focus()}
        autoDismiss={false}
        onDismiss={() => undefined}
        onAction={() => undefined}
      />
    ));
    expect(screen.getAllByRole('article')).toHaveLength(3);
    setFocus(true);
    const names = screen.getAllByRole('article').map((a) => a.getAttribute('aria-labelledby'));
    expect(names).toHaveLength(2);
    expect(screen.getByRole('article', { name: /Lock lost/u })).toBeTruthy();
    expect(screen.getByRole('article', { name: /Conflict saved/u })).toBeTruthy();
  });

  it('WMD-18 new banners are announced: politely, and errors assertively; Escape never dismisses (UI-082), Delete does', () => {
    const onDismiss = vi.fn();
    const [list, setList] = createSignal<ShellNotification[]>([]);
    render(() => (
      <NotificationToasts
        inline
        notifications={list()}
        now={NOW}
        onDismiss={onDismiss}
        onAction={() => undefined}
      />
    ));
    setList([LOCK]);
    expect(screen.getByRole('status').textContent).toBe(
      'Lock granted — report.md. You hold the edit lock now · alice released it',
    );
    setList([ERROR, LOCK]);
    expect(screen.getByRole('alert').textContent).toBe(
      'Lock lost on report.md. The server revoked your lease.',
    );
    fireEvent.keyDown(screen.getByRole('article', { name: /Lock lost/u }), { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('article', { name: /Lock lost/u }), { key: 'Delete' });
    expect(onDismiss).toHaveBeenCalledWith('n5', 'user');
  });
});

describe('UI-Wallpaper', () => {
  it('DSN-30 is decorative and drifts only when asked', () => {
    const [animate, setAnimate] = createSignal(false);
    const { container } = render(() => <Wallpaper animate={animate()} />);
    const wallpaper = container.firstElementChild as HTMLElement;
    expect(wallpaper.getAttribute('aria-hidden')).toBe('true');
    expect(wallpaper.dataset.animated).toBe('false');
    setAnimate(true);
    expect(wallpaper.dataset.animated).toBe('true');
  });
});
