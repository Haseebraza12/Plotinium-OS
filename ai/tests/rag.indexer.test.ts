import { describe, expect, it } from 'vitest';

import { CHUNK_MAX, CHUNK_MIN, HEADER_MAX_TOKENS, chunkText } from '../src/indexer/chunker.ts';
import {
  INDEX_MAX_BYTES,
  extractText,
  pathEligibility,
  stripHtml,
} from '../src/indexer/extract.ts';
import { CHUNKER_VERSION, contentHash } from '../src/indexer/hash.ts';
import { MAX_MODEL_TOKENS, approxWordPiece } from '../src/indexer/tokens.ts';
import {
  Debouncer,
  actionFor,
  buildIndexPut,
  distinctHashes,
  hashChunks,
  planUpdate,
  reconcile,
} from '../src/indexer/bookkeeping.ts';
import { IndexQueue, queueKey, sleepAfterChunk } from '../src/indexer/queue.ts';
import { mapMinHeap, unitVector } from './doubles.ts';

const enc = new TextEncoder();
const MODEL = 'MongoDB/mdbr-leaf-ir@4262131b-q8-d384-chunker-v1';

function sentence(i: number): string {
  return `Sentence number ${i} explains how the pager keeps recently used pages in memory.`;
}

function longMarkdown(): string {
  const para = (n: number, base: number): string =>
    Array.from({ length: n }, (_, i) => sentence(base + i)).join(' ');
  return [
    '# LRU',
    '',
    '## Eviction',
    '',
    para(40, 0),
    '',
    para(40, 100),
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '## Admission',
    '',
    para(12, 200),
  ].join('\n');
}

describe('chunker-v1', () => {
  it('MEM-06 keeps [CLS] + header + chunk + [SEP] within 512 tokens on long prose, code and minified text', () => {
    const inputs: Array<[string, 'markdown' | 'code' | 'text']> = [
      [longMarkdown(), 'markdown'],
      [
        Array.from({ length: 400 }, (_, i) => `function f${i}(a, b) { return a + b + ${i}; }`).join(
          '\n',
        ),
        'code',
      ],
      ['x'.repeat(20_000), 'text'],
      [Array.from({ length: 300 }, (_, i) => sentence(i)).join(' '), 'text'],
    ];
    for (const [text, kind] of inputs) {
      const chunks = chunkText(text, kind);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.tokens).toBeLessThanOrEqual(CHUNK_MAX);
        expect(approxWordPiece.count(c.header)).toBeLessThanOrEqual(HEADER_MAX_TOKENS);
        expect(2 + approxWordPiece.count(c.header) + c.tokens).toBeLessThanOrEqual(
          MAX_MODEL_TOKENS,
        );
      }
    }
  });

  it('RAG-04 chunks respect headings: every chunk carries its heading trail and never the file name', () => {
    const chunks = chunkText(longMarkdown(), 'markdown');
    const headers = new Set(chunks.map((c) => c.header));
    expect(headers.has('LRU > Eviction')).toBe(true);
    expect(headers.has('LRU > Admission')).toBe(true);
    for (const c of chunks) expect(c.header).not.toContain('.md');
    // No chunk mixes two sections.
    for (const c of chunks.filter((x) => x.header === 'LRU > Admission'))
      expect(c.text).not.toContain('Sentence number 0 ');
  });

  it('RAG-04 consecutive chunks of one section overlap by whole sentences and map to exact byte and line ranges', () => {
    const text = longMarkdown();
    const bytes = enc.encode(text);
    const chunks = chunkText(text, 'markdown').filter((c) => c.header === 'LRU > Eviction');
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.byteStart).toBeLessThan(prev.byteEnd);
    }
    for (const c of chunks) {
      expect(new TextDecoder().decode(bytes.subarray(c.byteStart, c.byteEnd))).toBe(c.text);
      const firstLine = text.split('\n')[c.lineStart - 1] ?? '';
      expect(firstLine.length).toBeGreaterThan(0);
      expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart);
    }
  });

  it('RAG-04 a short tail merges into the previous chunk of its section', () => {
    const text = Array.from({ length: 50 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkText(text, 'text');
    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    if (chunks.length > 1 && last !== undefined)
      expect(last.tokens).toBeGreaterThanOrEqual(CHUNK_MIN);
  });

  it('RAG-04 code splits at declarations and plain text at paragraphs', () => {
    const code = [
      'function a() {',
      '  return 1;',
      '}',
      '',
      'export function b() {',
      '  return 2;',
      '}',
    ].join('\n');
    expect(chunkText(code, 'code').length).toBe(1);
    expect(chunkText('one\n\ntwo\n\nthree', 'text').map((c) => c.text)).toEqual([
      'one\n\ntwo\n\nthree',
    ]);
    expect(chunkText('', 'text')).toEqual([]);
  });

  it('RAG-04 setext headings, tables and lists are recognised as blocks', () => {
    const md = [
      'Title',
      '=====',
      '',
      '| a | b |',
      '| - | - |',
      '',
      '- item one',
      '- item two',
      '',
      'Sub',
      '---',
      '',
      'text',
    ].join('\n');
    const chunks = chunkText(md, 'markdown');
    expect(chunks.some((c) => c.header === 'Title > Sub')).toBe(true);
  });
});

describe('extraction', () => {
  it('RAG-01 eligibility follows the path, dot-directory, type and extension rules', () => {
    expect(pathEligibility('/home/alice/notes.md', 'f')).toEqual({
      ok: true,
      kind: 'markdown',
      html: false,
    });
    expect(pathEligibility('/home/alice/src/a.ts', 'f')).toEqual({
      ok: true,
      kind: 'code',
      html: false,
    });
    expect(pathEligibility('/home/alice/README', 'f')).toEqual({
      ok: true,
      kind: 'text',
      html: false,
    });
    expect(pathEligibility('/home/alice/a.txt', 'f')).toEqual({
      ok: true,
      kind: 'text',
      html: false,
    });
    expect(pathEligibility('/home/alice/page.html', 'f')).toEqual({
      ok: true,
      kind: 'text',
      html: true,
    });
    expect(pathEligibility('/system/x.md', 'f')).toEqual({ ok: false, reason: 'location' });
    expect(pathEligibility('/home/alice/.cache/x.md', 'f')).toEqual({
      ok: false,
      reason: 'dot-dir',
    });
    expect(pathEligibility('/home/alice/x.png', 'f')).toEqual({ ok: false, reason: 'extension' });
    expect(pathEligibility('/home/alice/d', 'd')).toEqual({ ok: false, reason: 'type' });
  });

  it('RAG-01 text, markdown and code are extracted; binary, invalid UTF-8 and large files are refused', () => {
    expect(extractText('/home/a/x.md', 'f', enc.encode('# Hi'))).toEqual({
      ok: true,
      kind: 'markdown',
      text: '# Hi',
    });
    expect(extractText('/home/a/x.ts', 'f', enc.encode('let a;'))).toEqual({
      ok: true,
      kind: 'code',
      text: 'let a;',
    });
    expect(extractText('/home/a/x.txt', 'f', new Uint8Array([104, 0, 105]))).toEqual({
      ok: false,
      reason: 'binary',
    });
    expect(extractText('/home/a/x.txt', 'f', new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({
      ok: false,
      reason: 'encoding',
    });
    expect(extractText('/home/a/x.txt', 'f', new Uint8Array(INDEX_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'size',
    });
    expect(extractText('/etc/x.txt', 'f', enc.encode('a'))).toEqual({
      ok: false,
      reason: 'location',
    });
  });

  it('RAG-01 HTML stripping keeps every newline so line numbers point at the source', () => {
    const html = '<p>a</p>\n<script>\nevil()\n</script>\n<!-- c\n-->\n<b\n>b</b>';
    const out = stripHtml(html);
    expect(out.split('\n').length).toBe(html.split('\n').length);
    expect(out).not.toContain('evil');
    expect(out).toContain('a');
  });
});

describe('content hashing and incremental bookkeeping', () => {
  it('RAG-02 the content hash covers model key, header and text but never the file name', async () => {
    const h1 = await contentHash(MODEL, 'LRU', 'body');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentHash(MODEL, 'LRU', 'body')).toBe(h1);
    expect(await contentHash(MODEL, 'LRU2', 'body')).not.toBe(h1);
    expect(await contentHash(`${MODEL}x`, 'LRU', 'body')).not.toBe(h1);
    expect(await contentHash(MODEL, 'LRUb', 'ody')).not.toBe(h1);
    expect(CHUNKER_VERSION).toBe('chunker-v1');
  });

  it('RAG-02 a content change re-embeds only chunks whose hash is new and reuses the rest', async () => {
    const before = await hashChunks(longMarkdown(), 'markdown', MODEL);
    const edited = longMarkdown().replace('Sentence number 205 ', 'Sentence number 205 changed ');
    const after = await hashChunks(edited, 'markdown', MODEL);
    const plan = planUpdate({
      ino: 'i',
      inodeVersion: 2,
      modelKey: MODEL,
      own: true,
      chunks: after,
      known: new Set(distinctHashes(before)),
    });
    expect(plan.toEmbed.length).toBeGreaterThan(0);
    expect(plan.toEmbed.length).toBeLessThan(after.length);
    expect(plan.reused).toBe(after.length - plan.toEmbed.length);
    const vectors = new Map(
      plan.toEmbed.map((c, i) => [c.contentHash, unitVector(i + 1)] as const),
    );
    const put = buildIndexPut(plan, vectors);
    expect(put?.chunks.filter((c) => c.reuseOf !== undefined).length).toBe(plan.reused);
    expect(put?.chunks.every((c) => c.preview !== undefined && c.terms !== undefined)).toBe(true);
    expect(buildIndexPut(plan, new Map())).toBeUndefined();
  });

  it('RAG-03 foreign-owned files never carry preview text or BM25 terms in ai.index.put', async () => {
    const chunks = await hashChunks('hello world', 'text', MODEL);
    const plan = planUpdate({
      ino: 'i',
      inodeVersion: 1,
      modelKey: MODEL,
      own: false,
      chunks,
      known: new Set(),
    });
    const put = buildIndexPut(
      plan,
      new Map(plan.toEmbed.map((c) => [c.contentHash, unitVector(3)] as const)),
    );
    expect(put?.chunks.every((c) => c.preview === undefined && c.terms === undefined)).toBe(true);
  });

  it('RAG-02 a rename re-embeds nothing, an unlink drops and chmod needs nothing', async () => {
    const chunks = await hashChunks(longMarkdown(), 'markdown', MODEL);
    const again = await hashChunks(longMarkdown(), 'markdown', MODEL);
    const plan = planUpdate({
      ino: 'i',
      inodeVersion: 3,
      modelKey: MODEL,
      own: true,
      chunks: again,
      known: new Set(distinctHashes(chunks)),
    });
    expect(plan.toEmbed).toEqual([]);
    expect(actionFor('vfs.rename')).toBe('none');
    expect(actionFor('vfs.chmod')).toBe('none');
    expect(actionFor('vfs.unlink')).toBe('drop');
    expect(actionFor('vfs.unlink', false)).toBe('none');
    expect(actionFor('vfs.write')).toBe('reindex');
    expect(actionFor('vfs.create')).toBe('reindex');
    expect(actionFor('vfs.chown')).toBe('drop-old-owner-text');
  });

  it('RAG-02 the 1.5 s debounce coalesces bursts per ino', () => {
    const d = new Debouncer();
    d.touch('a', 0);
    d.touch('a', 1_000);
    d.touch('b', 200);
    expect(d.take(1_600)).toEqual([]);
    expect(d.take(1_700)).toEqual(['b']);
    expect(d.take(2_400)).toEqual([]);
    expect(d.take(2_500)).toEqual(['a']);
    d.touch('c', 0);
    d.cancel('c');
    expect(d.pending).toBe(0);
  });

  it('RAG-02 reconciliation enqueues stale and missing files and drops vanished ones', () => {
    const r = reconcile(
      [
        { ino: 'a', inodeVersion: 1 },
        { ino: 'b', inodeVersion: 2 },
        { ino: 'gone', inodeVersion: 1 },
      ],
      [
        { ino: 'a', version: 1, eligible: true },
        { ino: 'b', version: 3, eligible: true },
        { ino: 'new', version: 1, eligible: true },
        { ino: 'bin', version: 1, eligible: false },
      ],
      MODEL,
      MODEL,
    );
    expect(r).toEqual({ enqueue: ['b', 'new'], drop: ['gone'], backfill: false });
    const all = reconcile(
      [{ ino: 'a', inodeVersion: 1 }],
      [{ ino: 'a', version: 1, eligible: true }],
      'old',
      MODEL,
    );
    expect(all).toEqual({ enqueue: ['a'], drop: [], backfill: true });
  });
});

describe('indexer queue and throttle', () => {
  it('RAG-01 the work queue orders deadline, hot, hit, normal, backfill, oldest first within a class', () => {
    const q = new IndexQueue(mapMinHeap());
    q.enqueue('backfill', 'backfill', 1);
    q.enqueue('n1', 'normal', 5);
    q.enqueue('n0', 'normal', 2);
    q.enqueue('hot', 'hot', 9);
    q.enqueue('hit', 'hit', 3);
    expect([q.pop()?.ino, q.pop()?.ino, q.pop()?.ino, q.pop()?.ino, q.pop()?.ino]).toEqual([
      'hot',
      'hit',
      'n0',
      'n1',
      'backfill',
    ]);
    expect(q.pop()).toBeUndefined();
    expect(queueKey('hot', 7)).toBeLessThan(queueKey('hit', 0));
  });

  it('RAG-02 a file pending more than 15 s moves to the deadline class and bypasses the duty-cycle sleep', () => {
    const q = new IndexQueue(mapMinHeap());
    q.enqueue('old', 'backfill', 0);
    q.enqueue('hot', 'hot', 14_000);
    expect(q.age(15_001)).toBe(1);
    expect(q.classOf('old')).toBe('deadline');
    expect(q.pop()?.ino).toBe('old');
    expect(
      sleepAfterChunk({ lastEmbedMs: 120, lastInputAt: 15_000, now: 15_100, cls: 'deadline' }),
    ).toBe(0);
  });

  it('RAG-01 the indexer sleeps as long as the last embedding while the user was active in the last second', () => {
    expect(
      sleepAfterChunk({ lastEmbedMs: 120, lastInputAt: 1_000, now: 1_500, cls: 'normal' }),
    ).toBe(120);
    expect(sleepAfterChunk({ lastEmbedMs: 120, lastInputAt: 0, now: 1_500, cls: 'normal' })).toBe(
      0,
    );
  });

  it('RAG-01 enqueue promotes but never demotes, and remove forgets a job', () => {
    const q = new IndexQueue(mapMinHeap());
    q.enqueue('a', 'normal', 1);
    q.enqueue('a', 'backfill', 2);
    expect(q.classOf('a')).toBe('normal');
    q.enqueue('a', 'hot', 3);
    expect(q.classOf('a')).toBe('hot');
    expect(q.remove('a')).toBe(true);
    expect(q.remove('a')).toBe(false);
    expect(q.size).toBe(0);
  });
});
