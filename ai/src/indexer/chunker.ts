/**
 * chunker-v1 (rag-semantic-search.md §3.2.4): heading- and paragraph-aware chunks of about 400
 * tokens with 40–80 tokens of overlap inside a section.
 *
 * Every chunk is one contiguous range of the ORIGINAL text, so byte and line offsets are exact
 * and citations point to real lines. The overlap is counted inside the 480-token maximum, which
 * keeps `[CLS] + header(<=24) + chunk + [SEP] <= 512` (I-A7).
 */
import { utf8Length } from '../util/bytes.ts';
import type { TextKind } from './extract.ts';
import { type TokenCounter, approxWordPiece } from './tokens.ts';

export const CHUNK_TARGET = 400;
export const CHUNK_MIN = 120;
export const CHUNK_MAX = 480;
export const OVERLAP_MIN = 40;
export const OVERLAP_MAX = 80;
export const HEADER_MAX_TOKENS = 24;
/** A word longer than this (minified code, base64) is cut into character windows. */
const HARD_SPLIT_CHARS = 300;

export interface ChunkDraft {
  seq: number;
  byteStart: number;
  byteEnd: number;
  /** 1-based, inclusive. */
  lineStart: number;
  lineEnd: number;
  /** Heading trail only (`LRU > Eviction`); never a file name. */
  header: string;
  text: string;
  tokens: number;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

type SplitMode = 'sentence' | 'line';

interface Block {
  section: number;
  start: number;
  end: number;
  mode: SplitMode;
}

interface Unit {
  start: number;
  end: number;
  tokens: number;
}

class TextMap {
  readonly lines: Line[] = [];
  private readonly byteStarts: number[] = [];
  readonly text: string;

  constructor(text: string) {
    this.text = text;
    let start = 0;
    let bytes = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      const end = nl === -1 ? text.length : nl;
      const lineEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
      this.lines.push({ start, end: lineEnd, text: text.slice(start, lineEnd) });
      this.byteStarts.push(bytes);
      if (nl === -1) break;
      bytes += utf8Length(text.slice(start, nl + 1));
      start = nl + 1;
    }
  }

  lineOf(index: number): number {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lines[mid]?.start ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  byteOf(index: number): number {
    const i = this.lineOf(index);
    const line = this.lines[i];
    return (
      (this.byteStarts[i] ?? 0) +
      (line === undefined ? 0 : utf8Length(this.text.slice(line.start, index)))
    );
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
const TABLE = /^\s*\|/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const DECL =
  /^(?:export\s|async\s+function\b|function\b|class\b|def\b|fn\b|pub\s|interface\b|struct\b|type\s+\w+\s*=|const\s+\w+\s*=\s*(?:async\s*)?\()/;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || ATX.test(line) || TABLE.test(line) || LIST_ITEM.test(line);
}

interface Sections {
  headers: string[][];
}

function markdownBlocks(map: TextMap, sections: Sections): Block[] {
  const lines = map.lines;
  const blocks: Block[] = [];
  const trail: string[] = [];
  let section = 0;
  const openSection = (level: number, title: string): void => {
    trail.length = Math.min(trail.length, level - 1);
    while (trail.length < level - 1) trail.push('');
    trail.push(title.trim());
    sections.headers.push(trail.filter((t) => t !== ''));
    section = sections.headers.length - 1;
  };
  const push = (from: number, to: number, mode: SplitMode): void => {
    const a = lines[from];
    const b = lines[to];
    if (a !== undefined && b !== undefined)
      blocks.push({ section, start: a.start, end: b.end, mode });
  };
  let i = 0;
  while (i < lines.length) {
    const text = lines[i]?.text ?? '';
    if (isBlank(text)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(text);
    if (fence?.[1] !== undefined) {
      const marker = fence[1];
      let j = i + 1;
      while (j < lines.length && !(lines[j]?.text ?? '').trimStart().startsWith(marker)) j++;
      const end = Math.min(j, lines.length - 1);
      push(i, end, 'line');
      i = end + 1;
      continue;
    }
    const atx = ATX.exec(text);
    if (atx?.[1] !== undefined) {
      openSection(atx[1].length, atx[2] ?? '');
      push(i, i, 'sentence');
      i++;
      continue;
    }
    const next = lines[i + 1]?.text;
    if (next !== undefined && SETEXT.exec(next) !== null && !startsBlock(text)) {
      openSection(next.trim().startsWith('=') ? 1 : 2, text);
      push(i, i + 1, 'sentence');
      i += 2;
      continue;
    }
    if (TABLE.test(text)) {
      let j = i;
      while (j + 1 < lines.length && TABLE.test(lines[j + 1]?.text ?? '')) j++;
      push(i, j, 'line');
      i = j + 1;
      continue;
    }
    // A list item or a paragraph: runs until a blank line or the start of another block.
    const isItem = LIST_ITEM.test(text);
    let j = i;
    while (j + 1 < lines.length) {
      const t = lines[j + 1]?.text ?? '';
      if (isBlank(t) || startsBlock(t)) break;
      if (!isItem && SETEXT.test(t)) break;
      j++;
    }
    push(i, j, isItem ? 'line' : 'sentence');
    i = j + 1;
  }
  return blocks;
}

function braceDelta(line: string): number {
  let d = 0;
  for (const ch of line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')) {
    if (ch === '{') d++;
    else if (ch === '}') d--;
  }
  return d;
}

function codeBlocks(map: TextMap): Block[] {
  const lines = map.lines;
  const blocks: Block[] = [];
  let depth = 0;
  let open = -1;
  let last = -1;
  const close = (): void => {
    const a = lines[open];
    const b = lines[last];
    if (open >= 0 && a !== undefined && b !== undefined)
      blocks.push({ section: 0, start: a.start, end: b.end, mode: 'line' });
    open = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]?.text ?? '';
    if (isBlank(text)) {
      if (depth <= 0 && open >= 0) {
        let k = i + 1;
        while (k < lines.length && isBlank(lines[k]?.text ?? '')) k++;
        const nextLine = lines[k]?.text;
        if (nextLine === undefined || !/^\s/.test(nextLine)) close();
      }
      continue;
    }
    if (depth <= 0 && open >= 0 && DECL.test(text)) close();
    if (open < 0) open = i;
    last = i;
    depth = Math.max(0, depth + braceDelta(text));
  }
  close();
  return blocks;
}

function paragraphBlocks(map: TextMap): Block[] {
  const blocks: Block[] = [];
  let open = -1;
  let last = -1;
  map.lines.forEach((line, i) => {
    if (isBlank(line.text)) {
      if (open >= 0)
        blocks.push({
          section: 0,
          start: map.lines[open]?.start ?? 0,
          end: map.lines[last]?.end ?? 0,
          mode: 'sentence',
        });
      open = -1;
      return;
    }
    if (open < 0) open = i;
    last = i;
  });
  if (open >= 0)
    blocks.push({
      section: 0,
      start: map.lines[open]?.start ?? 0,
      end: map.lines[last]?.end ?? 0,
      mode: 'sentence',
    });
  return blocks;
}

/** Fine units of a range: whole lines, or whole sentences (which also end at a newline). */
function fineRanges(
  text: string,
  start: number,
  end: number,
  mode: SplitMode,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const slice = text.slice(start, end);
  const boundary = mode === 'line' ? /\n/g : /[.!?]["')\]]*\s+|\n/g;
  let from = 0;
  const pushRange = (a: number, b: number): void => {
    let s = a;
    while (s < b && /\s/.test(slice.charAt(s))) s++;
    let e = b;
    while (e > s && /\s/.test(slice.charAt(e - 1))) e--;
    if (e > s) out.push([start + s, start + e]);
  };
  for (const m of slice.matchAll(boundary)) {
    const cut = m.index + m[0].length;
    pushRange(from, cut);
    from = cut;
  }
  pushRange(from, slice.length);
  return out;
}

function hardSplit(text: string, start: number, end: number, counter: TokenCounter): Unit[] {
  const units: Unit[] = [];
  let curStart = -1;
  let curEnd = -1;
  let curTokens = 0;
  const flush = (): void => {
    if (curStart >= 0) units.push({ start: curStart, end: curEnd, tokens: curTokens });
    curStart = -1;
    curTokens = 0;
  };
  for (const m of text.slice(start, end).matchAll(/\S+/g)) {
    const pieces: Array<[number, number]> = [];
    const ws = start + m.index;
    for (let p = 0; p < m[0].length; p += HARD_SPLIT_CHARS) {
      pieces.push([ws + p, ws + Math.min(m[0].length, p + HARD_SPLIT_CHARS)]);
    }
    for (const [a, b] of pieces) {
      const t = counter.count(text.slice(a, b));
      if (curStart >= 0 && curTokens + t > CHUNK_TARGET) flush();
      if (curStart < 0) curStart = a;
      curEnd = b;
      curTokens += t;
    }
  }
  flush();
  return units;
}

function unitsOf(text: string, block: Block, counter: TokenCounter): Unit[] {
  const tokens = counter.count(text.slice(block.start, block.end));
  if (tokens <= CHUNK_MAX) return [{ start: block.start, end: block.end, tokens }];
  const units: Unit[] = [];
  for (const [a, b] of fineRanges(text, block.start, block.end, block.mode)) {
    const t = counter.count(text.slice(a, b));
    if (t <= CHUNK_MAX) units.push({ start: a, end: b, tokens: t });
    else units.push(...hardSplit(text, a, b, counter));
  }
  return units;
}

function headerOf(trail: string[] | undefined, counter: TokenCounter): string {
  const parts = [...(trail ?? [])];
  while (parts.length > 1 && counter.count(parts.join(' > ')) > HEADER_MAX_TOKENS) parts.shift();
  let header = parts.join(' > ');
  if (counter.count(header) > HEADER_MAX_TOKENS) {
    const words = header.split(/\s+/);
    while (words.length > 0 && counter.count(words.join(' ')) > HEADER_MAX_TOKENS) words.pop();
    header = words.join(' ');
  }
  return header;
}

interface Pending {
  units: Unit[];
  ownTokens: number;
  overlapStart: number | undefined;
  overlapTokens: number;
}

function overlapFrom(
  text: string,
  prev: Pending,
  mode: SplitMode,
  counter: TokenCounter,
): { start: number; tokens: number } | undefined {
  const first = prev.units[0];
  const lastUnit = prev.units[prev.units.length - 1];
  if (first === undefined || lastUnit === undefined) return undefined;
  const ranges = fineRanges(text, first.start, lastUnit.end, mode);
  let tokens = 0;
  let start: number | undefined;
  for (let i = ranges.length - 1; i > 0; i--) {
    const r = ranges[i];
    if (r === undefined) break;
    const t = counter.count(text.slice(r[0], r[1]));
    if (tokens + t > OVERLAP_MAX) break;
    tokens += t;
    start = r[0];
    if (tokens >= OVERLAP_MIN) break;
  }
  return start === undefined ? undefined : { start, tokens };
}

/** Split `text` into chunker-v1 chunks. */
export function chunkText(
  text: string,
  kind: TextKind,
  counter: TokenCounter = approxWordPiece,
): ChunkDraft[] {
  const map = new TextMap(text);
  const sections: Sections = { headers: [[]] };
  const blocks =
    kind === 'markdown'
      ? markdownBlocks(map, sections)
      : kind === 'code'
        ? codeBlocks(map)
        : paragraphBlocks(map);
  const mode: SplitMode = kind === 'code' ? 'line' : 'sentence';

  const out: ChunkDraft[] = [];
  let b = 0;
  while (b < blocks.length) {
    const section = blocks[b]?.section ?? 0;
    const units: Unit[] = [];
    while (b < blocks.length && blocks[b]?.section === section) {
      const block = blocks[b];
      if (block !== undefined) units.push(...unitsOf(text, block, counter));
      b++;
    }
    const chunks: Pending[] = [];
    let cur: Pending | undefined;
    const start = (u: Unit): Pending => {
      const prev = chunks[chunks.length - 1];
      const ov = prev === undefined ? undefined : overlapFrom(text, prev, mode, counter);
      const useOv = ov !== undefined && ov.tokens + u.tokens <= CHUNK_MAX;
      return {
        units: [u],
        ownTokens: u.tokens,
        overlapStart: useOv ? ov.start : undefined,
        overlapTokens: useOv ? ov.tokens : 0,
      };
    };
    for (const u of units) {
      if (cur === undefined) {
        cur = start(u);
        continue;
      }
      const total = cur.overlapTokens + cur.ownTokens;
      if (total + u.tokens > CHUNK_MAX || (total >= CHUNK_MIN && total + u.tokens > CHUNK_TARGET)) {
        chunks.push(cur);
        cur = start(u);
      } else {
        cur.units.push(u);
        cur.ownTokens += u.tokens;
      }
    }
    if (cur !== undefined) chunks.push(cur);
    // A tail under the minimum merges into the previous chunk of the same section.
    const tail = chunks[chunks.length - 1];
    const before = chunks[chunks.length - 2];
    if (
      tail !== undefined &&
      before !== undefined &&
      tail.ownTokens < CHUNK_MIN &&
      before.overlapTokens + before.ownTokens + tail.ownTokens <= CHUNK_MAX
    ) {
      before.units.push(...tail.units);
      before.ownTokens += tail.ownTokens;
      chunks.pop();
    }
    const header = headerOf(sections.headers[section], counter);
    for (const c of chunks) {
      const firstUnit = c.units[0];
      const lastUnit = c.units[c.units.length - 1];
      if (firstUnit === undefined || lastUnit === undefined) continue;
      const charStart = c.overlapStart ?? firstUnit.start;
      const charEnd = lastUnit.end;
      const chunkText = text.slice(charStart, charEnd);
      out.push({
        seq: out.length,
        byteStart: map.byteOf(charStart),
        byteEnd: map.byteOf(charEnd),
        lineStart: map.lineOf(charStart) + 1,
        lineEnd: map.lineOf(Math.max(charStart, charEnd - 1)) + 1,
        header,
        text: chunkText,
        tokens: counter.count(chunkText),
      });
    }
  }
  return out;
}
