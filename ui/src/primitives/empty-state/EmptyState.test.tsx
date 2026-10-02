import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState.tsx';

describe('UI-EmptyState', () => {
  it('UI-EmptyState renders a heading at the requested level, description and actions', () => {
    render(() => (
      <EmptyState
        title="No results for “paging”"
        description="Try fewer words."
        level={2}
        actions={<button>Clear</button>}
      />
    ));
    expect(screen.getByRole('heading', { level: 2, name: 'No results for “paging”' })).toBeTruthy();
    expect(screen.getByText('Try fewer words.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('UI-EmptyState can announce itself as a status', () => {
    render(() => <EmptyState title="Folder is empty" live />);
    expect(screen.getByRole('status').textContent).toContain('Folder is empty');
  });
});
