/**
 * From ranked candidates to `SemsearchResult.results` (rag-semantic-search.md §3.5 steps 6–8).
 *
 * 6. Per-file collapse (unless `chunks`) and freshness: drop a row whose stored `inodeVersion`
 *    differs from the current inode (I-A4) or whose inode left the live tree (I-A9).
 * 7. Foreign results: online they are shown only if the server reports them readable at the
 *    current version, with the server's snippet; on verify failure or offline they are hidden
 *    with a notice. Nothing foreign is ever shown unverified (RAG-03).
 * 8. Citations: the current path (first readable link) and a snippet from the caller's own text.
 */
import type { SemsearchResult } from '@plotinium/protocol';

import { SNIPPET_MAX, makeSnippet } from './citations.ts';
import { NOTICE_VERIFY_FAILED, noticeHiddenOffline } from './hybrid.ts';
import { type Cred, type FileSlot, type LiveNode, type LiveTree, isForeign } from './readable.ts';

export type ResultRow = SemsearchResult['results'][number];

/** At most 50 items per `POST /api/index/verify` (§3.6). */
export const VERIFY_MAX_ITEMS = 50;

export interface Candidate {
  fileIdx: number;
  /** Absent for a BM25 name-only match. */
  seq?: number;
  score: number;
}

export interface ChunkMeta {
  lineStart: number;
  lineEnd: number;
  inodeVersion: number;
}

export interface ResolvedPath {
  path: string;
  /** Directories on the path, root first. */
  ancestors: readonly LiveNode[];
}

export interface VerifyItem {
  ino: string;
  seq: number;
  readable: boolean;
  path?: string;
  inodeVersion?: number;
  snippet?: string;
}

export interface AssembleInput {
  cred: Cred;
  candidates: readonly Candidate[];
  k: number;
  chunks: boolean;
  fileTable: readonly (FileSlot | undefined)[];
  tree: LiveTree;
  /** The first readable link of a file, resolved as the caller. */
  resolvePath(ino: string): ResolvedPath | undefined;
  chunkMeta(ino: string, seq: number): ChunkMeta | undefined;
  /** Own-file text: the `ai_text` preview, else a local `read` of the byte range. */
  ownSnippet(ino: string, seq: number | undefined): string | undefined;
  online: boolean;
  /** `POST /api/index/verify`; undefined means timeout or server error. */
  verify?(
    items: ReadonlyArray<{ ino: string; seq: number; inodeVersion: number }>,
  ): Promise<VerifyItem[] | undefined>;
}

export interface Assembled {
  results: ResultRow[];
  notices: string[];
}

interface Pending {
  ino: string;
  node: LiveNode;
  path: ResolvedPath;
  meta: ChunkMeta | undefined;
  seq: number | undefined;
  score: number;
  foreign: boolean;
}

function fresh(input: AssembleInput, c: Candidate): Pending | undefined {
  const slot = input.fileTable[c.fileIdx];
  if (slot === undefined) return undefined;
  const node = input.tree.node(slot.ino);
  if (node === undefined) return undefined;
  const meta = c.seq === undefined ? undefined : input.chunkMeta(slot.ino, c.seq);
  if (c.seq !== undefined && (meta === undefined || meta.inodeVersion !== node.version))
    return undefined;
  const path = input.resolvePath(slot.ino);
  if (path === undefined) return undefined;
  return {
    ino: slot.ino,
    node,
    path,
    meta,
    seq: c.seq,
    score: c.score,
    foreign: isForeign(input.cred, node, path.ancestors),
  };
}

function row(
  p: Pending,
  snippet: string,
  verified: 'own' | 'server',
  path = p.path.path,
): ResultRow {
  return {
    path,
    ino: p.ino,
    lineStart: p.meta?.lineStart ?? 0,
    lineEnd: p.meta?.lineEnd ?? 0,
    score: p.score,
    snippet: makeSnippet(snippet, SNIPPET_MAX),
    verified,
  };
}

/** Steps 6–8 of the query path. */
export async function assembleResults(input: AssembleInput): Promise<Assembled> {
  const picked: Pending[] = [];
  const seenFiles = new Set<number>();
  for (const c of input.candidates) {
    if (picked.length >= input.k) break;
    if (!input.chunks && seenFiles.has(c.fileIdx)) continue;
    const p = fresh(input, c);
    if (p === undefined) continue;
    seenFiles.add(c.fileIdx);
    picked.push(p);
  }
  const notices: string[] = [];
  // Name-only matches have no chunk; they are verified as chunk 0 of the file.
  const foreign = picked.filter((p) => p.foreign);
  const verified = new Map<Pending, VerifyItem>();
  if (foreign.length > 0 && !input.online) {
    notices.push(noticeHiddenOffline(foreign.length));
  } else if (foreign.length > 0) {
    const items = foreign
      .slice(0, VERIFY_MAX_ITEMS)
      .map((p) => ({ ino: p.ino, seq: p.seq ?? 0, inodeVersion: p.node.version }));
    const answer = input.verify === undefined ? undefined : await input.verify(items);
    if (answer === undefined) {
      notices.push(NOTICE_VERIFY_FAILED);
    } else {
      for (const p of foreign) {
        const v = answer.find((a) => a.ino === p.ino && a.seq === (p.seq ?? 0));
        if (v?.readable === true && v.inodeVersion === p.node.version) verified.set(p, v);
      }
    }
  }
  const results: ResultRow[] = [];
  for (const p of picked) {
    if (!p.foreign) {
      results.push(row(p, input.ownSnippet(p.ino, p.seq) ?? '', 'own'));
      continue;
    }
    const v = verified.get(p);
    if (v !== undefined) results.push(row(p, v.snippet ?? '', 'server', v.path ?? p.path.path));
  }
  return { results, notices };
}
