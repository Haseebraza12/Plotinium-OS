/**
 * The Editor's find and replace bar (UI-101): a `@codemirror/search` panel drawn with Plotinium
 * parts instead of CodeMirror's default form. Ctrl/Cmd+F opens it at the top of the document, like
 * the find bar of a macOS text view: the field with a match count ("3 of 12"), Match Case, Whole
 * Word and Regular Expression toggles, Previous and Next, a disclosure for the Replace row, and
 * Done.
 *
 * Keyboard (all while the bar has focus): Enter and Shift+Enter go to the next and previous match,
 * Ctrl/Cmd+G and Shift+Ctrl/Cmd+G too, Enter in the Replace field replaces the current match and
 * Ctrl/Cmd+Enter replaces all, Escape closes the bar and puts the caret back in the text. Tab moves
 * through the controls in reading order; nothing traps focus (WCAG 2.1.2).
 *
 * Screen readers: the bar is a `search` landmark; every control has a name; the toggles are
 * toggle buttons (aria-pressed) and the disclosure says whether the Replace row is shown
 * (aria-expanded); the count is a polite status; CodeMirror announces each match it moves to
 * ("current match … on line 12").
 *
 * CSP: the bar's styles are a CSS module (a bundled stylesheet); CodeMirror's own search theme is
 * a style-mod rule set in the `<style>` element `CodeEditor` already routes through the
 * adopted-sheet mirror (primitives/internal/csp-styles.ts). No inline style is set here.
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { type Panel, runScopeHandlers, type EditorView, type ViewUpdate } from '@codemirror/view';
import CaseSensitive from 'lucide-solid/icons/case-sensitive';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import ChevronUp from 'lucide-solid/icons/chevron-up';
import Regex from 'lucide-solid/icons/regex';
import Search from 'lucide-solid/icons/search';
import WholeWord from 'lucide-solid/icons/whole-word';
import {
  type Accessor,
  createSignal,
  createUniqueId,
  type JSX,
  type Setter,
  Show,
} from 'solid-js';
import { render } from 'solid-js/web';

import { Button } from '../../primitives/button/Button.tsx';
import { IconButton } from '../../primitives/icon-button/IconButton.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { countMatches, type MatchCount, matchStatus } from './search.ts';
import styles from './SearchPanel.module.css';

/** The query fields the bar edits (SearchQuery's constructor options, without `test`). */
export interface QueryFields {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

function fieldsOf(q: SearchQuery): QueryFields {
  return {
    search: q.search,
    replace: q.replace,
    caseSensitive: q.caseSensitive,
    wholeWord: q.wholeWord,
    regexp: q.regexp,
  };
}

/** The Replace row's visibility, kept per editor across closing and reopening the bar. */
export interface ReplaceRowState {
  shown: Accessor<boolean>;
  setShown: Setter<boolean>;
}

export interface SearchBarProps {
  query: QueryFields;
  count: MatchCount;
  readOnly: boolean;
  replaceShown: boolean;
  onQuery: (patch: Partial<QueryFields>) => void;
  onNext: () => void;
  onPrevious: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onToggleReplace: () => void;
  onDone: () => void;
  /** Keys CodeMirror's `search-panel` scope handles (Escape, Ctrl/Cmd+G, Ctrl/Cmd+F). */
  onScopeKey?: (event: KeyboardEvent) => boolean;
  searchRef?: (el: HTMLInputElement) => void;
  replaceRef?: (el: HTMLInputElement) => void;
}

/** The bar itself, presentational (tests and the gallery render it without CodeMirror). */
export function SearchBar(props: SearchBarProps): JSX.Element {
  const uid = createUniqueId();
  const replaceRowId = `pl-find-replace-${uid}`;
  let searchInput: HTMLInputElement | undefined;
  let replaceInput: HTMLInputElement | undefined;
  const status = (): string => matchStatus(props.count);
  const noMatch = (): boolean => props.count.total === 0;
  const canReplace = (): boolean => !props.readOnly && !noMatch();

  const onKeyDown = (event: KeyboardEvent): void => {
    if (props.onScopeKey?.(event) === true) {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Enter' || event.altKey) return;
    if (event.target === searchInput) {
      event.preventDefault();
      if (event.shiftKey) props.onPrevious();
      else props.onNext();
    } else if (event.target === replaceInput) {
      event.preventDefault();
      if (!canReplace()) return;
      if (event.ctrlKey || event.metaKey) props.onReplaceAll();
      else props.onReplace();
    }
  };

  return (
    <div role="search" aria-label="Find in document" class={styles.bar} onKeyDown={onKeyDown}>
      <div class={styles.row}>
        <Show when={!props.readOnly} fallback={<span class={styles.disclosureSpace} />}>
          <IconButton
            class={cx(styles.disclosure, props.replaceShown && styles.open)}
            label="Find and Replace"
            aria-expanded={props.replaceShown}
            aria-controls={replaceRowId}
            title={props.replaceShown ? 'Hide Replace' : 'Show Replace'}
            icon={<ChevronRight size={14} />}
            onClick={() => props.onToggleReplace()}
          />
        </Show>
        <div class={styles.field} data-invalid={props.count.invalid ? '' : undefined}>
          <span class={styles.fieldIcon} aria-hidden="true">
            <Search size={13} />
          </span>
          <input
            ref={(el) => {
              searchInput = el;
              props.searchRef?.(el);
            }}
            class={styles.input}
            type="text"
            name="search"
            aria-label="Find"
            placeholder="Find"
            autocomplete="off"
            spellcheck={false}
            main-field="true"
            aria-invalid={props.count.invalid ? 'true' : undefined}
            value={props.query.search}
            onInput={(event) => props.onQuery({ search: event.currentTarget.value })}
          />
          <span
            class={cx(styles.count, props.count.invalid && styles.countError)}
            role="status"
            data-testid="editor-find-count"
          >
            {status()}
          </span>
        </div>
        <div class={styles.group} role="group" aria-label="Search options">
          <IconButton
            class={styles.toggle}
            label="Match Case"
            title="Match Case"
            pressed={props.query.caseSensitive}
            icon={<CaseSensitive size={16} />}
            onClick={() => props.onQuery({ caseSensitive: !props.query.caseSensitive })}
          />
          <IconButton
            class={styles.toggle}
            label="Whole Words"
            title="Whole Words"
            pressed={props.query.wholeWord}
            icon={<WholeWord size={16} />}
            onClick={() => props.onQuery({ wholeWord: !props.query.wholeWord })}
          />
          <IconButton
            class={styles.toggle}
            label="Regular Expression"
            title="Regular Expression"
            pressed={props.query.regexp}
            icon={<Regex size={16} />}
            onClick={() => props.onQuery({ regexp: !props.query.regexp })}
          />
        </div>
        <div class={styles.group} role="group" aria-label="Go to match">
          <IconButton
            label="Previous Match"
            title="Previous Match (Shift+Enter)"
            disabled={noMatch()}
            icon={<ChevronUp size={16} />}
            onClick={() => props.onPrevious()}
          />
          <IconButton
            label="Next Match"
            title="Next Match (Enter)"
            disabled={noMatch()}
            icon={<ChevronDown size={16} />}
            onClick={() => props.onNext()}
          />
        </div>
        <Button size="sm" class={styles.done} onClick={() => props.onDone()}>
          Done
        </Button>
      </div>
      <Show when={!props.readOnly && props.replaceShown}>
        <div id={replaceRowId} class={cx(styles.row, styles.replaceRow)}>
          <span class={styles.disclosureSpace} />
          <div class={styles.field}>
            <input
              ref={(el) => {
                replaceInput = el;
                props.replaceRef?.(el);
              }}
              class={styles.input}
              type="text"
              name="replace"
              aria-label="Replace with"
              placeholder="Replace"
              autocomplete="off"
              spellcheck={false}
              value={props.query.replace}
              onInput={(event) => props.onQuery({ replace: event.currentTarget.value })}
            />
          </div>
          <div class={styles.group}>
            <Button size="sm" disabled={!canReplace()} onClick={() => props.onReplace()}>
              Replace
            </Button>
            <Button size="sm" disabled={!canReplace()} onClick={() => props.onReplaceAll()}>
              Replace All
            </Button>
          </div>
        </div>
      </Show>
    </div>
  );
}

/**
 * The `createPanel` of `search()` for CodeEditor: the bar above the text, bound to the editor's
 * search state. `replace` is the editor's Replace-row state, shared by every bar it opens.
 */
export function createSearchPanel(view: EditorView, replace: ReplaceRowState): Panel {
  const dom = view.dom.ownerDocument.createElement('div');
  dom.className = styles.panel ?? '';
  const [query, setQuery] = createSignal<SearchQuery>(getSearchQuery(view.state), {
    equals: (a, b) => a.eq(b),
  });
  const [count, setCount] = createSignal<MatchCount>(countMatches(view.state, query()));
  const [readOnly, setReadOnly] = createSignal(view.state.readOnly);
  let searchInput: HTMLInputElement | undefined;
  let replaceInput: HTMLInputElement | undefined;

  const commit = (patch: Partial<QueryFields>): void => {
    const next = new SearchQuery({ ...fieldsOf(query()), ...patch });
    if (!next.eq(query())) view.dispatch({ effects: setSearchQuery.of(next) });
  };

  const dispose = render(
    () => (
      <SearchBar
        query={fieldsOf(query())}
        count={count()}
        readOnly={readOnly()}
        replaceShown={replace.shown()}
        onQuery={commit}
        onNext={() => findNext(view)}
        onPrevious={() => findPrevious(view)}
        onReplace={() => replaceNext(view)}
        onReplaceAll={() => replaceAll(view)}
        onToggleReplace={() => {
          const show = !replace.shown();
          replace.setShown(show);
          if (show) queueMicrotask(() => replaceInput?.focus());
        }}
        onDone={() => closeSearchPanel(view)}
        onScopeKey={(event) => runScopeHandlers(view, event, 'search-panel')}
        searchRef={(el) => (searchInput = el)}
        replaceRef={(el) => (replaceInput = el)}
      />
    ),
    dom,
  );

  return {
    dom,
    top: true,
    mount() {
      searchInput?.focus();
      searchInput?.select();
    },
    update(update: ViewUpdate) {
      let next = query();
      let changed = false;
      for (const tr of update.transactions)
        for (const effect of tr.effects)
          if (effect.is(setSearchQuery)) {
            next = effect.value;
            changed = true;
          }
      if (changed) setQuery(next);
      if (changed || update.docChanged || update.selectionSet)
        setCount(countMatches(update.state, next));
      if (update.state.readOnly !== update.startState.readOnly) setReadOnly(update.state.readOnly);
    },
    destroy() {
      dispose();
    },
  };
}

/** Focuses the Replace field of `view`'s open bar (Find and Replace). */
export function focusReplaceField(view: EditorView): boolean {
  const field = view.dom.querySelector<HTMLInputElement>(`.${styles.panel ?? ''} input[name=replace]`);
  if (field === null) return false;
  field.focus();
  field.select();
  return true;
}
