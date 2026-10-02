import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { SEARCH_PREVIEWS, SEARCH_QUERY, SEARCH_RESULTS, SEARCH_STATS } from './fixtures.ts';
import {
  SearchPalette,
  spokenResult,
  type SearchPaletteProps,
  type SearchResult,
  type SemanticState,
} from './SearchPalette.tsx';

type Overrides = Partial<SearchPaletteProps>;

function Harness(props: { overrides?: Overrides; results?: readonly SearchResult[] }) {
  const [query, setQuery] = createSignal(SEARCH_QUERY);
  const [ai, setAi] = createSignal(false);
  const [active, setActive] = createSignal<string>();
  return (
    <SearchPalette
      open
      onClose={() => undefined}
      query={query()}
      onQueryChange={setQuery}
      results={props.results ?? SEARCH_RESULTS}
      preview={SEARCH_PREVIEWS[active() ?? '']}
      onActiveChange={(r) => setActive(r?.id)}
      onOpen={() => undefined}
      onReveal={() => undefined}
      onAskAgent={() => undefined}
      aiMode={ai()}
      onAiModeChange={setAi}
      stats={SEARCH_STATS}
      {...props.overrides}
    />
  );
}

const field = (): HTMLElement => screen.getByRole('combobox');
const activeOption = (): HTMLElement | null => {
  const id = field().getAttribute('aria-activedescendant');
  return id === null ? null : document.getElementById(id);
};

describe('UI-SearchPalette', () => {
  it('UI-SearchPalette is a labelled modal dialog with a focused combobox over one listbox', async () => {
    render(() => <Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Search' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const input = field();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(within(listbox).getByRole('group', { name: 'Top hit' })).toBeTruthy();
    expect(within(listbox).getByRole('group', { name: 'Semantic matches' })).toBeTruthy();
    expect(within(listbox).getByRole('group', { name: 'Apps' })).toBeTruthy();
    expect(within(listbox).getByRole('group', { name: 'Commands' })).toBeTruthy();
    expect(within(listbox).getAllByRole('option')).toHaveLength(8);
  });

  it('RAG-06 options carry path:line citations and a printed relevance, not colour alone', () => {
    render(() => <Harness />);
    const match = screen.getByRole('option', {
      name: 'budget-2026-w38.csv, line 14, relevance 92 percent',
    });
    expect(match.textContent).toContain('~/finance/budget-2026-w38.csv:14');
    expect(match.textContent).toContain('92%');
    const top = screen.getByRole('option', {
      name: 'os-report.md, /home/student/notes/os-report.md:14, top hit',
    });
    const marks = top.querySelectorAll('mark');
    expect([...marks].map((m) => m.textContent)).toEqual(['budget report', 'last week']);
    expect(
      screen.getByRole('option', {
        name: 'lab4-costs.md, line 7, relevance 67 percent, owner alice',
      }),
    ).toBeTruthy();
  });

  it('UI-SearchPalette arrows, Home and End move the active option and the preview follows', async () => {
    render(() => <Harness />);
    expect(activeOption()?.textContent).toContain('os-report.md');
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Preview of os-report.md' })).toBeTruthy(),
    );
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(activeOption()?.getAttribute('aria-selected')).toBe('true');
    expect(activeOption()?.textContent).toContain('budget-2026-w38.csv');
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Preview of budget-2026-w38.csv' })).toBeTruthy(),
    );
    fireEvent.keyDown(field(), { key: 'End' });
    expect(activeOption()?.textContent).toContain('semsearch budget');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(activeOption()?.textContent).toContain('os-report.md');
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(activeOption()?.textContent).toContain('semsearch budget');
    fireEvent.keyDown(field(), { key: 'Home' });
    expect(activeOption()?.textContent).toContain('os-report.md');
  });

  it('UI-SearchPalette Enter opens, Ctrl+Enter reveals in Files, double-click opens', () => {
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    render(() => <Harness overrides={{ onOpen, onReveal }} />);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'budget-csv' }));
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ id: 'budget-csv' }));
    fireEvent.dblClick(screen.getByRole('option', { name: /^Editor, application/u }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'app-editor' }));
  });

  it('UI-SearchPalette a click selects without opening; the preview actions call back', async () => {
    const onOpen = vi.fn();
    const onAskAgent = vi.fn();
    render(() => <Harness overrides={{ onOpen, onAskAgent }} />);
    fireEvent.click(screen.getByRole('option', { name: /^meeting-notes-17-sep\.md/u }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(activeOption()?.textContent).toContain('meeting-notes-17-sep.md');
    const preview = await screen.findByRole('region', {
      name: 'Preview of meeting-notes-17-sep.md',
    });
    fireEvent.click(within(preview).getByRole('button', { name: 'Ask AI about this' }));
    expect(onAskAgent).toHaveBeenCalledWith(
      SEARCH_QUERY,
      expect.objectContaining({ id: 'meeting-notes' }),
    );
    fireEvent.click(within(preview).getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'meeting-notes' }));
  });

  it('UI-SearchPalette Tab switches to AI mode, Enter asks the agent, Escape leaves AI mode first', () => {
    const onAskAgent = vi.fn();
    const onClose = vi.fn();
    render(() => <Harness overrides={{ onAskAgent, onClose }} />);
    fireEvent.keyDown(field(), { key: 'Tab' });
    expect(field().getAttribute('aria-label')).toBe('Ask the agent');
    expect(field().getAttribute('placeholder')).toBe('Ask the agent…');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onAskAgent).toHaveBeenCalledWith(SEARCH_QUERY, undefined);
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(field().getAttribute('aria-label')).toBe('Search files, apps and commands');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
  });

  it('UI-SearchPalette a scrim click closes with reason "scrim"', () => {
    const onClose = vi.fn();
    render(() => <Harness overrides={{ onClose }} />);
    const dialog = screen.getByRole('dialog', { name: 'Search' });
    const scrim = dialog.previousElementSibling;
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as Element);
    expect(onClose).toHaveBeenCalledWith('scrim');
  });

  it('RAG-06 while the model loads the palette labels keyword matches and says so', () => {
    const semantic: SemanticState = 'loading';
    render(() => <Harness overrides={{ semantic }} />);
    expect(screen.getByRole('group', { name: 'Keyword matches' })).toBeTruthy();
    expect(screen.getAllByText('Semantic model loading — showing keyword matches').length).toBe(1);
    expect(screen.getByText('Keyword')).toBeTruthy();
  });

  it('UI-SearchPalette the empty state offers the agent and Enter hands the query over', () => {
    const onAskAgent = vi.fn();
    render(() => (
      <Harness
        results={[]}
        overrides={{ query: 'xyz', onQueryChange: () => undefined, onAskAgent }}
      />
    ));
    expect(screen.getByText('No results for “xyz”')).toBeTruthy();
    const suggestion = screen.getByRole('option', { name: /Ask the agent:/u });
    expect(activeOption()).toBe(suggestion);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onAskAgent).toHaveBeenCalledWith('xyz', undefined);
  });

  it('UI-SearchPalette the loading state shows static skeleton rows and the error is an alert', () => {
    render(() => (
      <Harness
        results={[]}
        overrides={{
          loading: true,
          progress: 0.5,
          error: 'Search failed — EIO. Showing keyword matches.',
        }}
      />
    ));
    expect(screen.getByRole('alert').textContent).toContain('Search failed — EIO');
    expect(screen.queryByText(/No results/u)).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('RAG-05 a query slower than 500 ms shows its timing in the warning state', () => {
    render(() => <Harness overrides={{ stats: { count: 8, ms: 640, source: 'local index' } }} />);
    const stats = screen.getByText(/8 results · 640 ms · local index/u);
    expect(stats.getAttribute('data-slow')).toBe('true');
  });

  it('UI-SearchPalette disabled results are skipped by the keyboard and state why', () => {
    const results: SearchResult[] = [
      { id: 'a', group: 'semantic', kind: 'file', title: 'a.md', relevance: 0.9, line: 1 },
      {
        id: 'b',
        group: 'semantic',
        kind: 'file',
        title: 'b.md',
        line: 2,
        relevance: 0.8,
        disabled: true,
        disabledReason: 'No permission',
      },
      { id: 'c', group: 'semantic', kind: 'file', title: 'c.md', relevance: 0.7, line: 3 },
    ];
    render(() => <Harness results={results} />);
    expect(screen.getByRole('option', { name: /b\.md.*No permission/u })).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(activeOption()?.textContent).toContain('c.md');
  });

  it('UI-SearchPalette spoken names cover apps and commands', () => {
    expect(spokenResult(SEARCH_RESULTS[4] as SearchResult)).toBe('Files, application, running');
    expect(spokenResult(SEARCH_RESULTS[6] as SearchResult)).toBe(
      'ai "summarise budget report", Ask the AI agent · Terminal',
    );
  });
});
