import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { DEGRADED_SERVICES, QUEUED_OPS } from './fixtures.ts';
import { LockBanner } from './LockBanner.tsx';
import { OfflinePopover, type OfflinePopoverProps } from './OfflinePopover.tsx';

function PopoverHarness(props: { overrides?: Partial<OfflinePopoverProps> }) {
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const [open, setOpen] = createSignal(true);
  return (
    <>
      <button ref={setAnchor} onClick={() => setOpen((v) => !v)}>
        Offline · 3 queued
      </button>
      <OfflinePopover
        open={open()}
        onClose={() => setOpen(false)}
        anchor={anchor()}
        queued={QUEUED_OPS}
        degraded={DEGRADED_SERVICES}
        retry="idle"
        nextCheckS={42}
        onRetry={() => undefined}
        onOpenTaskManager={() => undefined}
        {...props.overrides}
      />
    </>
  );
}

describe('UI-OfflinePopover', () => {
  it('OFF-04 the popover lists queued operations and degraded services as labelled lists', async () => {
    render(() => <PopoverHarness />);
    const dialog = await screen.findByRole('dialog', {
      name: 'Connectivity and degraded services',
    });
    const queue = within(dialog).getByRole('list', { name: 'Queued operations' });
    const ops = within(queue).getAllByRole('listitem');
    expect(ops).toHaveLength(3);
    expect(ops[0]?.textContent).toBe('write~/notes.md, queued 14:29');
    expect(ops[2]?.textContent).toBe('mv~/a.txt →  to ~/archive/a.txt, queued 14:31');
    expect(within(dialog).getByText('Will replay automatically · exactly once')).toBeTruthy();
    const services = within(dialog).getByRole('list', { name: 'Degraded services' });
    expect(
      within(services)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['sync — offline14:28:51', 'lockd — local advisory locks only14:28:51']);
    expect(within(dialog).getByText('Degraded services · 2')).toBeTruthy();
  });

  it('OFF-02 focus starts on Retry now; a press retries once and a check cannot be doubled', async () => {
    const onRetry = vi.fn();
    const [retry, setRetry] = createSignal<'idle' | 'checking'>('idle');
    render(() => (
      <PopoverHarness
        overrides={{
          onRetry,
          get retry() {
            return retry();
          },
        }}
      />
    ));
    const button = await screen.findByRole('button', { name: 'Retry now' });
    await waitFor(() => expect(document.activeElement).toBe(button));
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    setRetry('checking');
    const checking = screen.getByRole('button', { name: 'Checking…' });
    expect(checking.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(checking);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('OFF-02 Escape closes and returns focus to the chip', async () => {
    render(() => <PopoverHarness />);
    const button = await screen.findByRole('button', { name: 'Retry now' });
    await waitFor(() => expect(document.activeElement).toBe(button));
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Offline · 3 queued' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('OFF-01 the empty queue and a replay are stated in words', async () => {
    const { unmount } = render(() => <PopoverHarness overrides={{ queued: [] }} />);
    expect(await screen.findByText('Nothing queued · all changes are on the server')).toBeTruthy();
    unmount();
    render(() => <PopoverHarness overrides={{ replay: { done: 1, total: 3 } }} />);
    expect(await screen.findByText('Replaying 1 of 3 · exactly once')).toBeTruthy();
  });

  it('UI-OfflinePopover rows open their target when the caller allows it', async () => {
    const onOpenOp = vi.fn();
    const onOpenService = vi.fn();
    render(() => <PopoverHarness overrides={{ onOpenOp, onOpenService }} />);
    fireEvent.click(await screen.findByRole('button', { name: /~\/drafts/u }));
    expect(onOpenOp).toHaveBeenCalledWith('op-2');
    fireEvent.click(screen.getByRole('button', { name: /lockd/u }));
    expect(onOpenService).toHaveBeenCalledWith('lockd');
  });
});

describe('UI-LockBanner', () => {
  it('VFS-09 the banner says who holds the lease and counts down in text and a progressbar', () => {
    render(() => (
      <LockBanner
        holder={{ name: 'bob', uid: 1002 }}
        file="report.md"
        remainingS={11}
        ttlS={15}
        lease={{ mode: 'X', fence: 41, lastSeen: '14:31:02' }}
        onNotify={() => undefined}
      />
    ));
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('bob is editing report.md — you have read-only access.');
    expect(banner.textContent).toContain(
      'Lease expires in 11 s · X lease · fence 41 · last seen 14:31:02',
    );
    const bar = screen.getByRole('progressbar', { name: 'Lease time left' });
    expect(bar.getAttribute('aria-valuetext')).toBe('11 seconds left');
    expect(bar.getAttribute('aria-valuemax')).toBe('15');
  });

  it('VFS-09 Notify me toggles to a pressed "Notifying you"', () => {
    const [notifying, setNotifying] = createSignal(false);
    render(() => (
      <LockBanner
        holder={{ name: 'bob', uid: 1002 }}
        file="report.md"
        remainingS={11}
        ttlS={15}
        notifying={notifying()}
        onNotify={() => setNotifying(true)}
      />
    ));
    const button = screen.getByRole('button', { name: 'Notify me' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    const pressed = screen.getByRole('button', { name: 'Notifying you' });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
  });

  it('VFS-09 the released state offers Open for writing', () => {
    const onOpenForWriting = vi.fn();
    render(() => (
      <LockBanner
        holder={{ name: 'bob', uid: 1002 }}
        file="report.md"
        remainingS={0}
        ttlS={15}
        state="released"
        onOpenForWriting={onOpenForWriting}
      />
    ));
    expect(screen.getByRole('status').textContent).toContain('report.md is available');
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open for writing' }));
    expect(onOpenForWriting).toHaveBeenCalled();
  });
});
