/**
 * Accessibility fixes in the primitives (polish wave, fix-apps-settings-a11y): UI-140 (Tab out of
 * a portalled popover), the Select's aria-controls (axe aria-valid-attr-value), UI-147.
 */
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { IconButton } from './icon-button/IconButton.tsx';
import { Popover } from './popover/Popover.tsx';
import { Select } from './select/Select.tsx';

function PopoverHarness(props: { onClose: (reason: string) => void }) {
  const [open, setOpen] = createSignal(true);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  return (
    <>
      <button>Before</button>
      <button ref={setAnchor}>Renice…</button>
      <input aria-label="Search processes" />
      <Popover
        open={open()}
        anchor={anchor()}
        label="Renice burn"
        onClose={(reason) => {
          props.onClose(reason);
          setOpen(false);
        }}
      >
        <button data-autofocus>Cancel</button>
        <button>Apply</button>
      </Popover>
    </>
  );
}

describe('UI-140 Tab leaves a portalled popover where it would leave an inline one', () => {
  it('UI-140 Tab from the last control goes to the control after the anchor and closes', async () => {
    const onClose = vi.fn();
    render(() => <PopoverHarness onClose={onClose} />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    const apply = screen.getByRole('button', { name: 'Apply' });
    apply.focus();
    fireEvent.keyDown(apply, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search processes' }));
    expect(document.activeElement).not.toBe(document.body);
    expect(onClose).toHaveBeenCalledWith('outside');
  });

  it('UI-140 Shift+Tab from the first control goes back to the anchor', async () => {
    const onClose = vi.fn();
    render(() => <PopoverHarness onClose={onClose} />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.textContent).toBe('Renice…');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('UI-140 Tab between controls inside the popover is left to the browser', async () => {
    const onClose = vi.fn();
    render(() => <PopoverHarness onClose={onClose} />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    cancel.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('UI-Select aria-controls names an element that exists', () => {
  it('UI-Select the combobox controls the listbox only while it is open', async () => {
    render(() => (
      <Select
        label="Channel"
        value="stable"
        options={[
          { value: 'stable', label: 'Stable' },
          { value: 'beta', label: 'Beta' },
        ]}
        onChange={() => undefined}
      />
    ));
    const combo = screen.getByRole('combobox');
    expect(combo.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(combo);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    const id = combo.getAttribute('aria-controls') ?? '';
    expect(document.getElementById(id)?.getAttribute('role')).toBe('listbox');
  });

  it('UI-042 a Select can be described (why it is disabled)', () => {
    render(() => (
      <>
        <p id="why">Not available in this build.</p>
        <Select
          label="Language"
          value="en-GB"
          disabled
          describedBy="why"
          options={[{ value: 'en-GB', label: 'English (UK)' }]}
          onChange={() => undefined}
        />
      </>
    ));
    const combo = screen.getByRole('combobox');
    expect(combo.getAttribute('aria-describedby')).toBe('why');
    expect(combo.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('UI-147 primitives set no inline style attribute of their own', () => {
  it('UI-147 IconButton wraps its icon with a class, not style="display: contents"', () => {
    render(() => <IconButton label="Back" icon={<svg />} />);
    const wrapper = screen.getByRole('button', { name: 'Back' }).firstElementChild;
    expect(wrapper?.getAttribute('style')).toBeNull();
    expect(wrapper?.getAttribute('class')).not.toBe('');
  });
});
