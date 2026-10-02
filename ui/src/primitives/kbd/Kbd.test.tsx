import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { ariaKeyShortcuts, Kbd, spokenKeys } from './Kbd.tsx';

describe('UI-Kbd', () => {
  it('UI-Kbd renders one hidden keycap per key and a spoken text for assistive technology', () => {
    const { container } = render(() => <Kbd keys={['Ctrl', '↵']} />);
    const outer = container.firstElementChild;
    expect(outer?.tagName).toBe('KBD');
    expect(outer?.hasAttribute('aria-label')).toBe(false);
    const caps = outer?.querySelectorAll('kbd[aria-hidden="true"]');
    expect(caps).toHaveLength(2);
    expect(outer?.querySelector('span:not([aria-hidden])')?.textContent).toBe('Ctrl Enter');
  });

  it('UI-Kbd decorative keycaps are hidden entirely', () => {
    const { container } = render(() => <Kbd keys={['Esc']} decorative />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('UI-Kbd plain variant joins words with + and runs symbol modifiers together', () => {
    const word = render(() => <Kbd keys={['Ctrl', '⇧', 'N']} variant="plain" decorative />);
    expect(word.container.textContent).toBe('Ctrl+⇧N');
    word.unmount();
    const mac = render(() => <Kbd keys={['⇧', '⌘', 'N']} variant="plain" decorative />);
    expect(mac.container.textContent).toBe('⇧⌘N');
    mac.unmount();
    const caps = render(() => <Kbd keys={['Ctrl', 'O']} decorative />);
    expect(caps.container.textContent).toBe('Ctrl+O');
  });

  it('UI-Kbd maps chords to spoken text and aria-keyshortcuts', () => {
    expect(spokenKeys(['Ctrl', '⇧', '⌫'])).toBe('Ctrl Shift Backspace');
    expect(ariaKeyShortcuts(['Ctrl', '⇧', 'N'])).toBe('Control+Shift+N');
  });
});
