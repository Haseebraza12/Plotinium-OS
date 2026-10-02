/**
 * Polish-wave fixes in the window chrome (docs/design/bug-hunt/BUGS.md, owner fix-windows):
 * UI-033 drag-region double-click under pointer capture, UI-041 the double-click action hook,
 * UI-094 the right-click window menu and the live region, UI-154 square corners when snapped.
 */
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import type { WindowState } from '../types.ts';
import { WindowFrame } from './WindowFrame.tsx';
import css from './WindowFrame.module.css?raw';

function handlers() {
  return {
    onClose: vi.fn<() => void>(),
    onMinimise: vi.fn<() => void>(),
    onMaximize: vi.fn<() => void>(),
    onTitlePointerDown: vi.fn<(event: PointerEvent) => void>(),
    onWindowMenu: vi.fn<(anchor: HTMLElement, at?: { x: number; y: number }) => void>(),
  };
}

const section = (): HTMLElement => screen.getByRole('dialog');
const parts = (): { titlebar: HTMLElement; content: HTMLElement } => {
  const frame = section().firstElementChild as HTMLElement;
  return {
    titlebar: frame.children[0] as HTMLElement,
    content: frame.children[1] as HTMLElement,
  };
};

function unified(h: ReturnType<typeof handlers>, extra: { onTitleDoubleClick?: () => void } = {}) {
  render(() => (
    <WindowFrame title="Files" titlebar="overlay" focused {...h} {...extra}>
      <header data-pl-drag-region>
        <span>Files</span>
        <button type="button">Back</button>
      </header>
      <p>rows</p>
    </WindowFrame>
  ));
}

describe('UI-033 drag-region double-click', () => {
  it('UI-033 a double-click that pointer capture retargets to the content element still zooms', () => {
    const h = handlers();
    unified(h);
    const { content } = parts();
    // The press lands on the drag region; the drag takes pointer capture on the content element,
    // so the browser's dblclick targets the content element itself.
    fireEvent.pointerDown(screen.getByText('Files', { selector: 'span' }), { button: 0 });
    fireEvent.dblClick(content);
    expect(h.onMaximize).toHaveBeenCalledOnce();
  });

  it('UI-033 a press on a control or on app content is not a drag-region double-click', () => {
    const h = handlers();
    unified(h);
    const { content } = parts();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Back' }), { button: 0 });
    fireEvent.dblClick(content);
    fireEvent.pointerDown(screen.getByText('rows'), { button: 0 });
    fireEvent.dblClick(content);
    fireEvent.dblClick(screen.getByText('rows'));
    expect(h.onMaximize).not.toHaveBeenCalled();
  });
});

describe('UI-041 double-click action', () => {
  it('UI-041 onTitleDoubleClick replaces the zoom on the title bar and drag regions, never on controls', () => {
    const h = handlers();
    const action = vi.fn<() => void>();
    render(() => (
      <WindowFrame title="notes" focused canMaximise={false} {...h} onTitleDoubleClick={action} />
    ));
    fireEvent.dblClick(parts().titlebar);
    expect(action).toHaveBeenCalledOnce();
    fireEvent.dblClick(screen.getByRole('button', { name: 'Close notes' }));
    expect(action).toHaveBeenCalledOnce();
    expect(h.onMaximize).not.toHaveBeenCalled();
  });

  it('UI-041 without the hook a non-maximisable window ignores the double-click', () => {
    const h = handlers();
    render(() => <WindowFrame title="notes" focused canMaximise={false} {...h} />);
    fireEvent.dblClick(parts().titlebar);
    expect(h.onMaximize).not.toHaveBeenCalled();
  });

  it('UI-041 the hook also serves a unified window drag region', () => {
    const h = handlers();
    const action = vi.fn<() => void>();
    unified(h, { onTitleDoubleClick: action });
    fireEvent.pointerDown(screen.getByText('Files', { selector: 'span' }), { button: 0 });
    fireEvent.dblClick(parts().content);
    expect(action).toHaveBeenCalledOnce();
    expect(h.onMaximize).not.toHaveBeenCalled();
  });
});

describe('UI-094 right-click window menu and live region', () => {
  it('UI-094 a right-click on the title bar opens the window menu at the pointer instead of the page menu', () => {
    const h = handlers();
    render(() => <WindowFrame title="notes" focused {...h} />);
    const shown = fireEvent.contextMenu(parts().titlebar, { clientX: 120, clientY: 40 });
    expect(shown).toBe(false);
    expect(h.onWindowMenu).toHaveBeenCalledWith(parts().titlebar, { x: 120, y: 40 });
    // The traffic lights never show the page menu, and do not open the window menu either.
    const onLight = fireEvent.contextMenu(screen.getByRole('button', { name: 'Close notes' }));
    expect(onLight).toBe(false);
    expect(h.onWindowMenu).toHaveBeenCalledOnce();
  });

  it('UI-094 a right-click on a drag region opens it too; app content and handled menus are left alone', () => {
    const h = handlers();
    unified(h);
    fireEvent.contextMenu(screen.getByText('Files', { selector: 'span' }), {
      clientX: 300,
      clientY: 20,
    });
    expect(h.onWindowMenu).toHaveBeenCalledWith(parts().content, { x: 300, y: 20 });
    expect(fireEvent.contextMenu(screen.getByText('rows'))).toBe(true);
    const span = screen.getByText('Files', { selector: 'span' });
    span.addEventListener('contextmenu', (e) => e.preventDefault());
    fireEvent.contextMenu(span);
    expect(h.onWindowMenu).toHaveBeenCalledOnce();
  });

  it('UI-094 the window has a polite live region for keyboard move and size results', () => {
    const h = handlers();
    const [status, setStatus] = createSignal('');
    render(() => <WindowFrame title="notes" focused status={status()} {...h} />);
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    setStatus('Moved to 120, 80');
    expect(live.textContent).toBe('Moved to 120, 80');
  });
});

describe('UI-154 snapped corners', () => {
  it('UI-154 a snapped window is marked with its edge, only while normal', () => {
    const h = handlers();
    const [state, setState] = createSignal<WindowState>('normal');
    const [snap, setSnap] = createSignal<'left' | 'right' | null>('left');
    render(() => <WindowFrame title="notes" focused state={state()} snap={snap()} {...h} />);
    expect(section().dataset.snap).toBe('left');
    setSnap('right');
    expect(section().dataset.snap).toBe('right');
    setState('maximised');
    expect(section().dataset.snap).toBeUndefined();
    setState('normal');
    setSnap(null);
    expect(section().dataset.snap).toBeUndefined();
  });

  it('UI-154 the snapped edge has square corners (D-24)', () => {
    const flat = css.replace(/\s+/g, ' ');
    expect(flat).toContain(
      ".window[data-snap='left'] { border-radius: 0 var(--pl-radius-win) var(--pl-radius-win) 0; }",
    );
    expect(flat).toContain(
      ".window[data-snap='right'] { border-radius: var(--pl-radius-win) 0 0 var(--pl-radius-win); }",
    );
  });
});
