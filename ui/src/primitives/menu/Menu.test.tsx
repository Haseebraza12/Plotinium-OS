import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { ContextMenu, Menu, type MenuEntry } from './Menu.tsx';

const items: readonly MenuEntry[] = [
  { id: 'open', label: 'Open', shortcut: ['Ctrl', 'O'] },
  { id: 'rename', label: 'Rename…' },
  { kind: 'separator' },
  { id: 'copy', label: 'Copy', disabled: true },
  { id: 'compress', label: 'Compress' },
  { id: 'trash', label: 'Move to Trash', danger: true },
];

function Harness(props: { onSelect?: (id: string) => void; onClose?: (r: string) => void }) {
  const [open, setOpen] = createSignal(true);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  return (
    <>
      <button ref={setAnchor}>File</button>
      <Menu
        open={open()}
        anchor={anchor()}
        label="File"
        items={items}
        onSelect={(id) => props.onSelect?.(id)}
        onClose={(r) => {
          props.onClose?.(r);
          setOpen(false);
        }}
      />
    </>
  );
}

describe('UI-Menu', () => {
  it('UI-Menu renders menu roles, a separator and focuses the first item', () => {
    render(() => <Harness />);
    expect(screen.getByRole('menu', { name: 'File' })).toBeTruthy();
    expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open' }).getAttribute('aria-keyshortcuts')).toBe(
      'Control+O',
    );
    expect(document.activeElement?.textContent).toContain('Open');
  });

  it('UI-Menu focuses the first item when it opens after mount, and again on re-open', async () => {
    const [open, setOpen] = createSignal(false);
    render(() => (
      <>
        <button>Edit</button>
        <Menu
          open={open()}
          label="Edit"
          items={items}
          onSelect={() => undefined}
          onClose={() => setOpen(false)}
        />
      </>
    ));
    expect(screen.queryByRole('menu')).toBeNull();
    setOpen(true);
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Open'));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    screen.getByRole('button', { name: 'Edit' }).focus();
    setOpen(true);
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Open'));
    expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true);
  });

  it('UI-Menu arrow keys skip disabled items and wrap', () => {
    render(() => <Harness />);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Compress');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Open');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement?.textContent).toContain('Move to Trash');
  });

  it('UI-Menu type-ahead jumps to the matching item', () => {
    render(() => <Harness />);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'm' });
    expect(document.activeElement?.textContent).toContain('Move to Trash');
  });

  it('UI-Menu Enter selects, closes and returns focus to the anchor', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(() => <Harness onSelect={onSelect} onClose={onClose} />);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('rename');
    expect(onClose).toHaveBeenCalledWith('select');
    expect(document.activeElement?.textContent).toBe('File');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('UI-Menu Escape closes; disabled items ignore clicks', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(() => <Harness onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
  });

  it('UI-Menu checkable items are menuitemcheckbox with aria-checked', () => {
    render(() => (
      <Menu
        open
        label="View"
        items={[
          { id: 'list', label: 'as List', checked: true },
          { id: 'icons', label: 'as Icons', checked: false },
        ]}
        onSelect={() => undefined}
        onClose={() => undefined}
      />
    ));
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'as List' }).getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('UI-ContextMenu', () => {
  it('UI-ContextMenu opens at the pointer on right-click and from Shift+F10', async () => {
    const onSelect = vi.fn();
    render(() => (
      <ContextMenu label="Actions" items={items} onSelect={onSelect}>
        <button>os-report.md</button>
      </ContextMenu>
    ));
    const target = screen.getByRole('button', { name: 'os-report.md' });
    fireEvent.contextMenu(target, { clientX: 40, clientY: 50 });
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compress' }));
    expect(onSelect).toHaveBeenCalledWith('compress');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.keyDown(target, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy();
  });
});
