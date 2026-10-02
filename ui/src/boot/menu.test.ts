import { fireEvent, getAllByRole, getByRole } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootMenu, type BootMenuOptions } from './menu.ts';

afterEach(() => {
  document.body.replaceChildren();
});

function mount(extra: Partial<BootMenuOptions> = {}): {
  menu: ReturnType<typeof createBootMenu>;
  onChoose: ReturnType<typeof vi.fn>;
  list: HTMLElement;
} {
  const onChoose = vi.fn();
  const menu = createBootMenu({ version: '0.3.0', build: 'a1f93c2', onChoose, ...extra });
  document.body.append(menu.el);
  menu.focus();
  return { menu, onChoose, list: getByRole(menu.el, 'listbox') };
}

const selectedName = (list: HTMLElement): string =>
  getAllByRole(list, 'option').find((o) => o.getAttribute('aria-selected') === 'true')
    ?.textContent ?? '';

describe('UI-BootMenu', () => {
  it('BOOT-06 the Plotinium Boot Manager offers Normal, Safe mode, Recovery and Verbose boot', () => {
    const { menu, list } = mount();
    const dialog = getByRole(menu.el, 'dialog', { name: 'Plotinium Boot Manager' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(getAllByRole(list, 'option').map((o) => o.getAttribute('aria-labelledby'))).toHaveLength(
      4,
    );
    expect(
      getAllByRole(list, 'option', { name: /./u }).map(
        (o) => o.querySelector('.plb-ot')?.textContent,
      ),
    ).toEqual(['Normal boot', 'Safe mode', 'Recovery', 'Verbose boot']);
    expect(getByRole(list, 'option', { name: 'Safe mode' }).textContent).toContain(
      'No AI services · no autostart apps · default theme',
    );
    expect(menu.selected).toBe('normal');
  });

  it('BOOT-13 focus lands on the listbox; ↑/↓ wrap and Enter boots the selection', () => {
    const { menu, onChoose, list } = mount();
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(selectedName(list)).toContain('Safe mode');
    expect(list.getAttribute('aria-activedescendant')).toBe(
      getByRole(list, 'option', { name: 'Safe mode' }).id,
    );
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(menu.selected).toBe('verbose');
    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledWith('recovery');
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(menu.el.querySelector('.plb-keys')?.textContent).toBe('Starting recovery…');
  });

  it('BOOT-06 Esc closes the menu and a number key boots its entry directly', () => {
    const onClose = vi.fn();
    const first = mount({ onClose });
    fireEvent.keyDown(first.list, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(first.onChoose).not.toHaveBeenCalled();
    first.menu.destroy();
    const second = mount();
    fireEvent.keyDown(second.list, { key: '4' });
    expect(second.onChoose).toHaveBeenCalledWith('verbose');
  });

  it('BOOT-06 two failed boots in a row preselect Safe mode and show the warning line', () => {
    const { menu, list } = mount({ failedBoots: 2 });
    expect(menu.selected).toBe('safe');
    expect(selectedName(list)).toContain('Safe mode');
    expect(getByRole(menu.el, 'status').textContent).toBe(
      'The last 2 boots failed. Safe mode is selected.',
    );
  });

  it('BOOT-06 the countdown ring shows only while the menu is open and stops at the first key press', () => {
    const onInteract = vi.fn();
    const announce = vi.fn();
    const { menu, list } = mount({ onInteract, announce });
    const cd = menu.el.querySelector<HTMLElement>('.plb-cd');
    expect(cd?.hidden).toBe(true);
    menu.setCountdown(5, 5);
    expect(cd?.hidden).toBe(false);
    expect(cd?.textContent).toBe('auto-boot in 5 s');
    expect(cd?.querySelectorAll('path')).toHaveLength(5);
    menu.setCountdown(3, 5);
    expect(cd?.querySelectorAll('path[data-off]')).toHaveLength(2);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('auto-boot in 5 seconds');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(cd?.hidden).toBe(true);
    expect(onInteract).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith('auto-boot stopped');
    menu.setCountdown(2, 5);
    expect(cd?.hidden).toBe(true);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(onInteract).toHaveBeenCalledTimes(1);
  });

  it('UI-BootMenu a click selects without booting; a double click boots', () => {
    const { menu, onChoose, list } = mount();
    const recovery = getByRole(list, 'option', { name: 'Recovery' });
    fireEvent.click(recovery);
    expect(menu.selected).toBe('recovery');
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.dblClick(recovery);
    expect(onChoose).toHaveBeenCalledWith('recovery');
  });
});
