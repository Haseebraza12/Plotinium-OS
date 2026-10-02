/**
 * Find and replace for the Editor (UI-101): the pure half. The panel (SearchPanel.tsx) shows
 * "3 of 12" beside the field; this module counts the matches of a `@codemirror/search` query and
 * says which one the selection is on. Counting stops at MATCH_COUNT_CAP matches, so a query that
 * matches every character of a large file costs a bounded amount of work per keystroke.
 */
import type { SearchQuery } from '@codemirror/search';
import type { EditorState } from '@codemirror/state';

/** The most matches counted; more reads "1,000+ matches". */
export const MATCH_COUNT_CAP = 1000;

export interface MatchCount {
  /** Matches found, at most MATCH_COUNT_CAP. */
  total: number;
  /** 1-based index of the match the main selection covers exactly, or 0. */
  current: number;
  /** More than MATCH_COUNT_CAP matches exist. */
  capped: boolean;
  /** The query is empty or not a valid regular expression. */
  invalid: boolean;
  /** The query is empty. */
  empty: boolean;
}

export const NO_MATCHES: MatchCount = {
  total: 0,
  current: 0,
  capped: false,
  invalid: false,
  empty: true,
};

/** Counts `query`'s matches in `state` (up to the cap) and finds the selected one. */
export function countMatches(
  state: EditorState,
  query: SearchQuery,
  cap = MATCH_COUNT_CAP,
): MatchCount {
  if (query.search === '') return NO_MATCHES;
  if (!query.valid) return { ...NO_MATCHES, empty: false, invalid: true };
  const sel = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); next.done !== true; next = cursor.next()) {
    if (total === cap) return { total, current, capped: true, invalid: false, empty: false };
    total += 1;
    if (current === 0 && next.value.from === sel.from && next.value.to === sel.to) current = total;
  }
  return { total, current, capped: false, invalid: false, empty: false };
}

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/** The status beside the field ("3 of 12", "12 matches", "No matches", "Invalid pattern"). */
export function matchStatus(count: MatchCount): string {
  if (count.empty) return '';
  if (count.invalid) return 'Invalid pattern';
  if (count.total === 0) return 'No matches';
  if (count.capped) return `${MATCH_COUNT_CAP.toLocaleString('en-GB')}+ matches`;
  if (count.current > 0)
    return `${count.current.toLocaleString('en-GB')} of ${count.total.toLocaleString('en-GB')}`;
  return plural(count.total, 'match', 'matches');
}
