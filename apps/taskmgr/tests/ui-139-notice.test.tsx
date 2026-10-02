// @vitest-environment happy-dom
/**
 * UI-139: the in-app outcome notice of Task Manager and Settings covered the content and the
 * controls under it (it was an absolutely positioned toast). It now takes its own grid row under
 * the app, so the app's last row stays visible and clickable while a notice is shown.
 */
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NOTICE_HOST_STYLE, NoticeToast, type AppNotice } from '../../src/notice.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mountHost(initial: AppNotice | undefined, onDismiss = vi.fn()) {
  const root = document.createElement('div');
  document.body.append(root);
  const [notice, setNotice] = createSignal<AppNotice | undefined>(initial);
  dispose = render(
    () => (
      <div data-testid="host" style={NOTICE_HOST_STYLE}>
        <div data-testid="app">
          <button type="button">Last control</button>
        </div>
        <NoticeToast notice={notice()} onDismiss={onDismiss} />
      </div>
    ),
    root,
  );
  const host = root.querySelector<HTMLElement>('[data-testid="host"]');
  if (host === null) throw new Error('host not rendered');
  return { host, setNotice, onDismiss };
}

describe('UI-139 the app notice takes its own row', () => {
  it('UI-139 the host is a two-row grid: the app fills the first row, the notice the second', () => {
    const { host } = mountHost({ level: 'info', text: 'Sent SIGTERM to burn (pid 301)' });
    expect(host.style.display).toBe('grid');
    expect(host.style.getPropertyValue('grid-template-rows')).toBe('minmax(0, 1fr) auto');
    const notice = host.querySelector<HTMLElement>('[data-testid="app-notice"]');
    expect(notice).not.toBeNull();
    // A sibling row after the app, not an overlay on top of it.
    expect(host.children[0]?.getAttribute('data-testid')).toBe('app');
    expect(host.children[1]).toBe(notice);
    expect(notice?.style.position ?? '').not.toMatch(/absolute|fixed/u);
    expect(notice?.style.bottom ?? '').toBe('');
  });

  it('UI-139 an error is an alert, an info a status, and no notice leaves no row', () => {
    const { host, setNotice } = mountHost(undefined);
    expect(host.querySelector('[data-testid="app-notice"]')).toBeNull();
    expect(host.children).toHaveLength(1);
    setNotice({ level: 'error', text: 'Could not change the memory budget (EINVAL)' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('EINVAL');
    setNotice({ level: 'info', text: 'Saved' });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Saved');
  });

  it('UI-139 the dismiss button has a name and calls back', () => {
    const { host, onDismiss } = mountHost({ level: 'info', text: 'Saved' });
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect(button).not.toBeNull();
    button?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
