import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { Popover } from './Popover.tsx';

function Harness(props: { onClose?: (reason: string) => void }) {
  const [open, setOpen] = createSignal(true);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  return (
    <>
      <button ref={setAnchor} onClick={() => setOpen(true)}>
        AI
      </button>
      <button>Elsewhere</button>
      <Popover
        open={open()}
        anchor={anchor()}
        label="AI status"
        onClose={(reason) => {
          props.onClose?.(reason);
          setOpen(false);
        }}
      >
        <button data-autofocus>Open ai log</button>
      </Popover>
    </>
  );
}

describe('UI-Popover', () => {
  it('UI-Popover renders a labelled dialog in a portal and focuses its autofocus target', async () => {
    render(() => <Harness />);
    expect(screen.getByRole('dialog', { name: 'AI status' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Open ai log'));
  });

  it('UI-Popover closes on Escape and returns focus to the anchor', async () => {
    const onClose = vi.fn();
    render(() => <Harness onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(document.activeElement?.textContent).toBe('AI');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('UI-Popover closes on a pointer down outside, not inside', () => {
    const onClose = vi.fn();
    render(() => <Harness onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open ai log' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onClose).toHaveBeenCalledWith('outside');
  });
});
