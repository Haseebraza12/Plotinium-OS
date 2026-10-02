import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { Sheet } from '../sheet/Sheet.tsx';
import { Dialog } from './Dialog.tsx';

function DialogHarness(props: { onClose?: (r: string) => void; role?: 'dialog' | 'alertdialog' }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Empty Trash…</button>
      <Dialog
        open={open()}
        role={props.role}
        title="Empty the Trash?"
        description="12 items will be deleted permanently."
        onClose={(r) => {
          props.onClose?.(r);
          setOpen(false);
        }}
        actions={
          <>
            <button data-autofocus onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button>Empty Trash</button>
          </>
        }
      />
    </>
  );
}

describe('UI-Dialog', () => {
  it('DSN-15 UI-Dialog is a labelled modal that focuses the safe action', async () => {
    render(() => <DialogHarness role="alertdialog" />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Empty the Trash?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
  });

  it('UI-Dialog traps Tab inside the panel', async () => {
    render(() => <DialogHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    const last = screen.getByRole('button', { name: 'Empty Trash' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.textContent).toBe('Empty Trash');
  });

  it('UI-Dialog Escape closes and returns focus to the invoker', async () => {
    const onClose = vi.fn();
    render(() => <DialogHarness onClose={onClose} />);
    const invoker = screen.getByRole('button', { name: 'Empty Trash…' });
    invoker.focus();
    fireEvent.click(invoker);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(document.activeElement).toBe(invoker);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('UI-Sheet', () => {
  it('UI-Sheet renders inside its window, labelled and modal, and closes on Escape', async () => {
    const onClose = vi.fn();
    const [open, setOpen] = createSignal(true);
    render(() => (
      <div style={{ position: 'relative' }} data-testid="window">
        <Sheet
          open={open()}
          title="Confirm destructive plan"
          role="alertdialog"
          onClose={(r) => {
            onClose(r);
            setOpen(false);
          }}
          actions={<button data-autofocus>Cancel</button>}
        />
      </div>
    ));
    const sheet = screen.getByRole('alertdialog', { name: 'Confirm destructive plan' });
    expect(screen.getByTestId('window').contains(sheet)).toBe(true);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
  });
});
