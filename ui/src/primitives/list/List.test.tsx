import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { ListGroup, ListRow } from './List.tsx';

describe('UI-ListRow', () => {
  it('UI-ListRow groups rows under a labelled section list', () => {
    render(() => (
      <ListGroup title="Semantic search">
        <ListRow title="Embedding model" value="mdbr-leaf-ir" />
        <ListRow title="Index status" subtitle="412 chunks pending" />
      </ListGroup>
    ));
    expect(screen.getByRole('region', { name: 'Semantic search' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('mdbr-leaf-ir')).toBeTruthy();
  });

  it('UI-ListRow with onClick is a button; disabled rows do not fire', () => {
    const onClick = vi.fn();
    render(() => (
      <ListGroup>
        <ListRow title="Open ai log" chevron onClick={onClick} />
        <ListRow title="Rebuild index" onClick={onClick} disabled />
      </ListGroup>
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Open ai log' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild index' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
