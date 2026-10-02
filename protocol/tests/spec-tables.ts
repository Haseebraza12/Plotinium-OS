/**
 * Test helper: read Markdown pipe tables out of the specs, so conformance tests compare the code
 * with the normative tables instead of with a second hand-typed copy.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readSpec(relativeToSpecs: string): string {
  return readFileSync(path.join(REPO_ROOT, 'specs', relativeToSpecs), 'utf8');
}

/**
 * The text of the section that starts at the first line beginning with `heading` and ends before
 * the next heading of the same or a higher level.
 */
export function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) throw new Error(`heading not found: ${heading}`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i] ?? '');
    if (m?.[1] !== undefined && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export interface Table {
  readonly header: string[];
  readonly rows: string[][];
}

/** Split one table row on unescaped pipes and unescape `\|` inside cells. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll('\\|', '|'));
}

/** Every pipe table in `markdown`, with its header row and data rows. */
export function tables(markdown: string): Table[] {
  const out: Table[] = [];
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (line.trim().startsWith('|') && /^\s*\|\s*:?-{3,}/.test(next)) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(cells(lines[i] ?? ''));
        i++;
      }
      out.push({ header, rows });
    } else {
      i++;
    }
  }
  return out;
}

/** The backticked tokens of a cell, in order. */
export function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}
