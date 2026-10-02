import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { EditorStatusBar, saveText, syncText } from './EditorStatusBar.tsx';

describe('EditorStatusBar for a document in no file yet (verify-b)', () => {
  it('UI-117 says "not saved" and shows no sync part for an untitled document', () => {
    expect(saveText({ kind: 'new' })).toBe('not saved');
    expect(syncText({ kind: 'none' })).toBe('');
    const { container } = render(() => (
      <EditorStatusBar
        line={1}
        col={1}
        language="Plain Text"
        save={{ kind: 'new' }}
        sync={{ kind: 'none' }}
      />
    ));
    const bar = container.querySelector('footer');
    expect(bar?.textContent).toContain('not saved');
    expect(bar?.textContent).not.toContain('synced');
    expect(bar?.querySelector('[data-sync]')).toBeNull();
  });

  it('UI-117 keeps the sync part for a saved file', () => {
    const { container } = render(() => (
      <EditorStatusBar
        line={1}
        col={1}
        language="Markdown"
        save={{ kind: 'saved', version: 4 }}
        sync={{ kind: 'synced' }}
      />
    ));
    expect(container.querySelector('[data-sync="synced"]')?.textContent).toContain('synced');
    expect(container.querySelector('footer')?.textContent).toContain('saved v4');
  });
});
