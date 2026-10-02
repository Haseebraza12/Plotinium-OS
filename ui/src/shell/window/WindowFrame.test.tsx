import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import type {
  ResizeEdge,
  WindowOverlay,
  WindowOverlayAction,
  WindowPhase,
  WindowState,
} from '../types.ts';
import { WindowFrame } from './WindowFrame.tsx';
import css from './WindowFrame.module.css?raw';

function handlers() {
  return {
    onClose: vi.fn<() => void>(),
    onMinimise: vi.fn<() => void>(),
    onMaximize: vi.fn<() => void>(),
    onFocusRequest: vi.fn<() => void>(),
    onTitlePointerDown: vi.fn<(event: PointerEvent) => void>(),
    onResizeStart: vi.fn<(edge: ResizeEdge, event: PointerEvent) => void>(),
    onPhaseEnd: vi.fn<(phase: WindowPhase) => void>(),
    onOverlayAction: vi.fn<(action: WindowOverlayAction) => void>(),
  };
}

function frame(): HTMLElement {
  return screen.getByRole('dialog');
}
function titleBar(): HTMLElement {
  return screen.getByRole('heading', { level: 2 }).parentElement as HTMLElement;
}

describe('UI-WindowFrame', () => {
  it('WM-07 is a non-modal dialog labelled by its title, with traffic lights named for the app', () => {
    const h = handlers();
    render(() => (
      <WindowFrame title="notes" appName="Files" focused {...h}>
        <p>content</p>
      </WindowFrame>
    ));
    const win = screen.getByRole('dialog', { name: 'notes' });
    expect(win.getAttribute('aria-modal')).toBe('false');
    expect(screen.getByRole('group', { name: 'Window controls' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Minimise Files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Files' }));
    expect(h.onClose).toHaveBeenCalledOnce();
    expect(h.onMinimise).toHaveBeenCalledOnce();
    expect(h.onMaximize).toHaveBeenCalledOnce();
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('WM-04 double-clicking the title bar maximises, but not on its controls', () => {
    const h = handlers();
    render(() => <WindowFrame title="notes" focused {...h} />);
    fireEvent.dblClick(titleBar());
    expect(h.onMaximize).toHaveBeenCalledOnce();
    fireEvent.dblClick(screen.getByRole('button', { name: 'Close notes' }));
    expect(h.onMaximize).toHaveBeenCalledOnce();
  });

  it('WM-03 a title-bar pointer-down starts a drag, never from a control, and focuses the window', () => {
    const h = handlers();
    render(() => (
      <WindowFrame
        title="notes"
        focused={false}
        toolbar={<button type="button">Back</button>}
        {...h}
      />
    ));
    fireEvent.pointerDown(titleBar(), { button: 0 });
    expect(h.onTitlePointerDown).toHaveBeenCalledOnce();
    expect(h.onFocusRequest).toHaveBeenCalledOnce();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Back' }), { button: 0 });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Zoom notes' }), { button: 0 });
    expect(h.onTitlePointerDown).toHaveBeenCalledOnce();
  });

  it('UI-WindowFrame overlay title bar keeps the lights and name; app drag regions move and zoom', () => {
    const h = handlers();
    render(() => (
      <WindowFrame title="Task Manager" titlebar="overlay" focused toolbar={<b>ignored</b>} {...h}>
        <header data-pl-drag-region>
          <span>Task Manager</span>
          <button type="button">End Process</button>
        </header>
        <p>rows</p>
      </WindowFrame>
    ));
    expect(screen.getByRole('dialog', { name: 'Task Manager' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close Task Manager' })).toBeTruthy();
    expect(screen.queryByText('ignored')).toBeNull();
    const frameEl = frame().firstElementChild as HTMLElement;
    expect(frameEl.dataset.titlebar).toBe('overlay');

    fireEvent.pointerDown(screen.getByText('Task Manager', { selector: 'span' }), { button: 0 });
    expect(h.onTitlePointerDown).toHaveBeenCalledOnce();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'End Process' }), { button: 0 });
    fireEvent.pointerDown(screen.getByText('rows'), { button: 0 });
    expect(h.onTitlePointerDown).toHaveBeenCalledOnce();

    fireEvent.dblClick(screen.getByText('Task Manager', { selector: 'span' }));
    expect(h.onMaximize).toHaveBeenCalledOnce();
    fireEvent.dblClick(screen.getByText('rows'));
    expect(h.onMaximize).toHaveBeenCalledOnce();
  });

  it('UI-WindowFrame standard title bars ignore app drag regions', () => {
    const h = handlers();
    render(() => (
      <WindowFrame title="notes" focused {...h}>
        <div data-pl-drag-region>strip</div>
      </WindowFrame>
    ));
    fireEvent.pointerDown(screen.getByText('strip'), { button: 0 });
    expect(h.onTitlePointerDown).not.toHaveBeenCalled();
  });

  it('WM-04 eight resize handles report their edge and hide while maximised', () => {
    const h = handlers();
    const [state, setState] = createSignal<WindowState>('normal');
    render(() => <WindowFrame title="notes" focused state={state()} {...h} />);
    const handles = frame().querySelectorAll<HTMLElement>('[data-edge]');
    expect(Array.from(handles, (el) => el.dataset.edge).sort()).toEqual(
      ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'].sort(),
    );
    const se = frame().querySelector('[data-edge="se"]') as HTMLElement;
    fireEvent.pointerDown(se, { button: 0 });
    expect(h.onResizeStart).toHaveBeenCalledWith('se', expect.any(Event));
    expect(h.onTitlePointerDown).not.toHaveBeenCalled();
    setState('maximised');
    expect(frame().querySelectorAll('[data-edge]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Restore notes' })).toBeTruthy();
    expect(frame().dataset.state).toBe('maximised');
  });

  it('DSN-31 focus and dragging are data attributes on a pl-focus-shadow frame', () => {
    const [focused, setFocused] = createSignal(true);
    const [dragging, setDragging] = createSignal(false);
    render(() => (
      <WindowFrame title="notes" focused={focused()} dragging={dragging()} {...handlers()} />
    ));
    expect(frame().classList.contains('pl-focus-shadow')).toBe(true);
    expect(frame().dataset.focused).toBe('true');
    setFocused(false);
    setDragging(true);
    expect(frame().dataset.focused).toBe('false');
    expect(frame().dataset.dragging).toBe('true');
  });

  it('DSN-24 window chrome is static glass: contained, no live blur, drag tier when dragging', () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(clean).not.toMatch(/backdrop-filter/u);
    expect(clean).toMatch(/contain:\s*layout paint/u);
    expect(clean).toMatch(
      /\[data-dragging='true'\]\s*\{\s*box-shadow:\s*var\(--pl-shadow-win-drag\)/u,
    );
  });

  it('WM-04 a phase adds its motion class and genie inputs, and onPhaseEnd fires once', () => {
    const h = handlers();
    const [phase, setPhase] = createSignal<WindowPhase | undefined>('minimising');
    render(() => (
      <WindowFrame
        title="notes"
        focused
        phase={phase()}
        genie={{ x: 120, y: 480 }}
        style={{ transform: 'translate3d(40px, 60px, 0)', width: '600px', height: '400px' }}
        {...h}
      />
    ));
    expect(frame().classList.contains('pl-anim-window-minimise')).toBe(true);
    expect(frame().style.getPropertyValue('--pl-genie-x')).toBe('120px');
    expect(frame().style.getPropertyValue('--pl-genie-y')).toBe('480px');
    expect(frame().style.width).toBe('600px');
    fireEvent.animationEnd(frame());
    fireEvent.animationEnd(frame());
    expect(h.onPhaseEnd).toHaveBeenCalledOnce();
    expect(h.onPhaseEnd).toHaveBeenCalledWith('minimising');
    setPhase('restoring');
    expect(frame().classList.contains('pl-anim-window-restore')).toBe(true);
    expect(frame().classList.contains('pl-anim-window-minimise')).toBe(false);
  });

  it('DSN-30 under reduced motion a phase ends at once with no animation class', async () => {
    document.documentElement.dataset.motion = 'reduce';
    const h = handlers();
    render(() => <WindowFrame title="notes" focused phase="opening" {...h} />);
    expect(frame().classList.contains('pl-anim-window-open')).toBe(false);
    await waitFor(() => expect(h.onPhaseEnd).toHaveBeenCalledWith('opening'));
  });

  it('WM-05 a minimised window leaves the accessibility tree (inert)', () => {
    render(() => <WindowFrame title="notes" focused={false} state="minimised" {...handlers()} />);
    expect(frame().hasAttribute('inert')).toBe(true);
  });

  it('WM-05 the restoring overlay shows real byte counts; the not-responding overlay offers actions', () => {
    const h = handlers();
    const [overlay, setOverlay] = createSignal<WindowOverlay>({
      kind: 'restoring',
      doneBytes: 3.1 * 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
    });
    render(() => <WindowFrame title="notes" focused overlay={overlay()} {...h} />);
    const bar = screen.getByRole('progressbar', { name: 'Restoring…' });
    expect(bar.getAttribute('aria-valuetext')).toBe('3.1 / 5.0 MB');
    setOverlay({ kind: 'not-responding' });
    expect(screen.getByRole('alert').textContent).toContain('Not responding');
    fireEvent.click(screen.getByRole('button', { name: 'Force quit' }));
    expect(h.onOverlayAction).toHaveBeenCalledWith('force-quit');
    setOverlay({ kind: 'suspended' });
    fireEvent.click(screen.getByRole('button', { name: 'Suspended — click to restore' }));
    expect(h.onOverlayAction).toHaveBeenLastCalledWith('restore');
  });

  it('WM-07 disabled controls stay focusable but do nothing, and Shift+F10 opens the window menu', () => {
    const h = handlers();
    const onWindowMenu = vi.fn<(anchor: HTMLElement) => void>();
    render(() => (
      <WindowFrame title="About" focused canMaximise={false} onWindowMenu={onWindowMenu} {...h} />
    ));
    const zoom = screen.getByRole('button', { name: 'Zoom About' });
    expect(zoom.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(zoom);
    fireEvent.dblClick(titleBar());
    expect(h.onMaximize).not.toHaveBeenCalled();
    fireEvent.keyDown(titleBar(), { key: 'F10', shiftKey: true });
    expect(onWindowMenu).toHaveBeenCalledWith(titleBar());
  });
});
