import { For, Show, splitProps, type JSX } from 'solid-js';

export interface TextPart {
  text: string;
  match: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Splits `text` into runs, marking every case-insensitive occurrence of any term. Longer terms
 * win over their prefixes ("budget report" before "budget"). Empty terms are ignored.
 */
export function splitMatches(text: string, terms: readonly string[] | undefined): TextPart[] {
  const usable = (terms ?? []).map((t) => t.trim()).filter((t) => t !== '');
  if (usable.length === 0 || text === '') return [{ text, match: false }];
  const pattern = new RegExp(
    `(${[...usable]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|')})`,
    'giu',
  );
  const parts: TextPart[] = [];
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    const index = found.index ?? last;
    if (index > last) parts.push({ text: text.slice(last, index), match: false });
    parts.push({ text: found[0], match: true });
    last = index + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

export interface MatchTextProps {
  text: string;
  terms?: readonly string[];
  /** Class for the <mark> runs. Matches are also bold, so colour is never the only signal. */
  markClass?: string;
}

/** Text with its matched terms wrapped in <mark> (search snippets, previews). */
export function MatchText(props: MatchTextProps): JSX.Element {
  const [local] = splitProps(props, ['text', 'terms', 'markClass']);
  return (
    <For each={splitMatches(local.text, local.terms)}>
      {(part) => (
        <Show when={part.match} fallback={part.text}>
          <mark class={local.markClass}>{part.text}</mark>
        </Show>
      )}
    </For>
  );
}

/** "92 percent" style spoken value for a 0..1 ratio. */
export function percentOf(ratio: number): number {
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/** Pluralises a count with its noun: plural(1, 'result') -> "1 result". */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}
