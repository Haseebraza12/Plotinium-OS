/**
 * Man-page rendering (shell-and-terminal.md §3.12): headings in bold, paragraphs wrapped to
 * `COLUMNS − 4` with a 4-space indent, code blocks indented and not wrapped, `•` bullets, inline
 * code in bold, links as their text only. Bold is emitted only on a terminal.
 */

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** Removes the `---json … ---` front matter. */
export function stripFrontMatter(text: string): string {
  const m = /^---json\n[\s\S]*?\n---\n/.exec(text);
  return m === null ? text : text.slice(m[0].length);
}

/** Inline markup: `code` and **bold** become bold (or plain), [text](url) becomes text. */
export function inline(text: string, tty: boolean): string {
  const b = (s: string): string => (tty ? `${BOLD}${s}${RESET}` : s);
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, (_m, s: string) => b(s))
    .replace(/\*\*([^*]+)\*\*/g, (_m, s: string) => b(s));
}

/** Visible length, ignoring SGR escapes. */
function visible(text: string): number {
  // eslint-disable-next-line no-control-regex -- stripping our own SGR sequences
  return [...text.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

/** Greedy word wrap; `first` prefixes the first line and `rest` the others. */
export function wrap(text: string, width: number, first: string, rest: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = first;
  let len = visible(first);
  let empty = true;
  for (const word of words) {
    const w = visible(word);
    if (!empty && len + 1 + w > width) {
      lines.push(line);
      line = rest;
      len = visible(rest);
      empty = true;
    }
    line += empty ? word : ` ${word}`;
    len += empty ? w : w + 1;
    empty = false;
  }
  if (!empty || lines.length === 0) lines.push(line);
  return lines;
}

export function renderMarkdown(source: string, columns: number, tty: boolean): string[] {
  const width = Math.max(20, columns - 4);
  const out: string[] = [];
  const lines = stripFrontMatter(source).split('\n');
  let para: string[] = [];
  let fenced = false;
  let afterHeading = false;
  const flush = (): void => {
    if (para.length > 0) out.push(...wrap(inline(para.join(' '), tty), width, '    ', '    '));
    para = [];
  };
  for (const raw of lines) {
    if (raw.startsWith('```')) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(`        ${raw}`);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading !== null) {
      flush();
      if (out.length > 0 && out.at(-1) !== '') out.push('');
      out.push(tty ? `${BOLD}${heading[1] ?? ''}${RESET}` : (heading[1] ?? ''));
      afterHeading = true;
      continue;
    }
    if (raw.trim() === '' && afterHeading) continue;
    afterHeading = false;
    if (raw.startsWith('    ')) {
      flush();
      out.push(`    ${raw}`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet !== null) {
      flush();
      out.push(...wrap(inline(bullet[1] ?? '', tty), width, '    • ', '      '));
      continue;
    }
    if (raw.trim() === '') {
      flush();
      if (out.length > 0 && out.at(-1) !== '') out.push('');
      continue;
    }
    para.push(raw.trim());
    // Two trailing spaces are a hard line break (multi-form synopses).
    if (raw.endsWith('  ')) flush();
  }
  flush();
  while (out.at(-1) === '') out.pop();
  return out;
}
