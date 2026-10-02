import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { SidebarList, type SidebarSection } from './SidebarList.tsx';

const sections: readonly SidebarSection[] = [
  {
    id: 'fav',
    title: 'Favourites',
    items: [
      { id: 'home', label: 'Home' },
      { id: 'documents', label: 'Documents' },
      { id: 'downloads', label: 'Downloads', disabled: true },
      { id: 'recent', label: 'Recent' },
    ],
  },
  {
    id: 'tags',
    title: 'Tags',
    items: [{ id: 'report', label: 'Report', dot: true, tint: 'indigo' }],
  },
];

describe('UI-SidebarList', () => {
  it('UI-SidebarList is a named navigation with titled sections and aria-current', () => {
    render(() => (
      <SidebarList
        label="Places"
        sections={sections}
        selected="documents"
        onSelect={() => undefined}
      />
    ));
    expect(screen.getByRole('navigation', { name: 'Places' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Favourites' })).toBeTruthy();
    const current = screen.getByRole('button', { name: 'Documents' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('button', { name: 'Home' }).getAttribute('tabindex')).toBe('-1');
  });

  it('UI-SidebarList arrows move focus across sections, skipping disabled rows', () => {
    render(() => (
      <SidebarList
        label="Places"
        sections={sections}
        selected="documents"
        onSelect={() => undefined}
      />
    ));
    const docs = screen.getByRole('button', { name: 'Documents' });
    docs.focus();
    fireEvent.keyDown(docs, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Recent');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Report');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'h' });
    expect(document.activeElement?.textContent).toContain('Home');
  });

  it('UI-SidebarList click selects enabled rows only', () => {
    const onSelect = vi.fn();
    render(() => (
      <SidebarList label="Places" sections={sections} selected="home" onSelect={onSelect} />
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Downloads' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('recent');
  });
});
