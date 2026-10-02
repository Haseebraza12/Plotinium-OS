import { beforeAll, describe, expect, it } from 'vitest';

import { USERS } from '../fixtures/fx-agt.ts';
import { type EvalCorpus, type EvalTree, buildEvalTree, loadCorpus } from './corpus.ts';
import { memoryHost, nodeHost, ragDir } from './host.ts';
import { lexicalOverlap, mean } from './metrics.ts';
import {
  CORPUS_SUFFIX,
  EvalDataError,
  QUERY_KINDS,
  parseManifest,
  parseQueries,
} from './schema.ts';

let corpus: EvalCorpus;
let tree: EvalTree;

beforeAll(async () => {
  corpus = await loadCorpus(nodeHost(), ragDir());
  tree = buildEvalTree(corpus);
});

const byPath = (): Map<string, EvalCorpus['docs'][number]> =>
  new Map(corpus.docs.map((d) => [d.path, d]));

describe('AIS-04 corpus composition', () => {
  it('AIS-04 the RAG corpus has at least 200 documents and 30 queries, each document with a source and licence entry', () => {
    expect(corpus.docs.length).toBeGreaterThanOrEqual(200);
    expect(corpus.queries.queries.length).toBeGreaterThanOrEqual(30);
    for (const d of corpus.docs) {
      expect(d.meta.source, d.path).toBe('original');
      expect(d.meta.licence, d.path).toBe('LicenseRef-Plotinium-Team');
      expect(d.meta.author, d.path).not.toBe('');
    }
  });

  it('AIS-04 every stored corpus file has exactly one manifest row and matches its recorded size and SHA-256', async () => {
    const host = nodeHost();
    const onDisk = host
      .listFiles(host.join(ragDir(), 'corpus'))
      .filter((f) => f !== 'MANIFEST.jsonl')
      .sort();
    expect(onDisk.every((f) => f.endsWith(CORPUS_SUFFIX))).toBe(true);
    expect(onDisk).toEqual(corpus.docs.map((d) => d.meta.file).sort());
    // loadCorpus already verified size and SHA-256 of every file; a changed byte must fail loudly
    const row = corpus.docs[0]?.meta;
    if (row === undefined) throw new Error('empty corpus');
    const files = new Map([
      ['/r/corpus/MANIFEST.jsonl', JSON.stringify(row)],
      [`/r/corpus/${row.file}`, 'edited'],
      ['/r/queries.json', '{"set":"s","corpus":"c","user":"alice","queries":[]}'],
      ['/r/permissions.json', '{}'],
    ]);
    await expect(loadCorpus(memoryHost(files), '/r')).rejects.toThrow(EvalDataError);
  });

  it('AIS-04 the corpus mixes notes, reports, meeting notes, everyday text and code in TypeScript, Python and C', () => {
    const formats = new Set(corpus.docs.map((d) => d.meta.format));
    for (const f of ['md', 'txt', 'ts', 'py', 'c']) expect(formats, f).toContain(f);
    const categories = new Set(corpus.docs.map((d) => d.meta.category));
    for (const c of ['course-notes', 'meeting-notes', 'report', 'code', 'everyday', 'private'])
      expect(categories, c).toContain(c);
    const code = corpus.docs.filter((d) => d.meta.category === 'code');
    expect(code.length).toBeGreaterThanOrEqual(25);
  });

  it('AIS-04 near-duplicate and distractor annotations point at real documents and distractors are never graded for their query', () => {
    const docs = byPath();
    const queries = new Map(corpus.queries.queries.map((q) => [q.id, q]));
    const near = corpus.docs.filter((d) => d.meta.nearDuplicateOf !== undefined);
    const distractors = corpus.docs.filter((d) => d.meta.distractorFor !== undefined);
    expect(near.length).toBeGreaterThanOrEqual(10);
    expect(distractors.length).toBeGreaterThanOrEqual(20);
    for (const d of near) expect(docs.has(d.meta.nearDuplicateOf ?? ''), d.path).toBe(true);
    for (const d of distractors) {
      for (const id of d.meta.distractorFor ?? []) {
        const q = queries.get(id);
        expect(q, `${d.path} → ${id}`).toBeDefined();
        expect([...(q?.relevant ?? []), ...(q?.partial ?? [])]).not.toContain(d.path);
      }
    }
  });

  it.todo(
    'AIS-04 each query is written by a member who did not write its target documents (needs the human query pass before the Week-11 claim)',
  );
});

describe('RAG-04 query set', () => {
  it('RAG-04 every graded file exists and is readable by the query user, with 1 to 3 relevant files per query', () => {
    const docs = byPath();
    const cred = tree.cred(corpus.queries.user);
    for (const q of corpus.queries.queries) {
      expect(q.relevant.length, q.id).toBeGreaterThanOrEqual(1);
      expect(q.relevant.length, q.id).toBeLessThanOrEqual(3);
      for (const p of [...q.relevant, ...q.partial]) {
        expect(docs.has(p), `${q.id} ${p}`).toBe(true);
        expect(tree.canRead(cred, p), `${q.id} ${p}`).toBe(true);
      }
      // grade-2 targets are the query user's own files, so the keyword path can see their bodies
      for (const p of q.relevant)
        expect(docs.get(p)?.meta.owner, `${q.id} ${p}`).toBe(corpus.queries.user);
    }
  });

  it('RAG-04 the query mix has every kind and the paraphrases share few content words with their targets', () => {
    const docs = byPath();
    const kinds = new Set(corpus.queries.queries.map((q) => q.kind));
    for (const k of QUERY_KINDS) expect(kinds, k).toContain(k);
    const overlapOf = (kind: string): number =>
      mean(
        corpus.queries.queries
          .filter((q) => q.kind === kind)
          .map((q) =>
            mean(
              q.relevant.map((p) => {
                const d = docs.get(p);
                return lexicalOverlap(
                  q.query,
                  `${p.slice(p.lastIndexOf('/') + 1)}\n${d?.text ?? ''}`,
                );
              }),
            ),
          ),
      );
    expect(
      corpus.queries.queries.filter((q) => q.kind === 'paraphrase').length,
    ).toBeGreaterThanOrEqual(10);
    expect(overlapOf('paraphrase')).toBeLessThan(0.3);
    expect(overlapOf('question')).toBeLessThan(0.45);
    expect(overlapOf('keyword')).toBeGreaterThan(overlapOf('paraphrase'));
  });

  it('RAG-04 the data parsers reject malformed rows with the file and line', () => {
    expect(() => parseManifest('{"path":"relative"}', 'M')).toThrow(/M:1/);
    expect(() => parseManifest('not json')).toThrow(EvalDataError);
    expect(() =>
      parseQueries({
        set: 's',
        corpus: 'c',
        user: 'alice',
        queries: [{ id: 'Q', query: 'q', kind: 'guess', author: 'a', relevant: ['/x'] }],
      }),
    ).toThrow(/unknown kind/);
    expect(() =>
      parseQueries({
        set: 's',
        corpus: 'c',
        user: 'alice',
        queries: [
          { id: 'Q', query: 'q', kind: 'code', author: 'a', relevant: ['/x'], partial: ['/x'] },
        ],
      }),
    ).toThrow(/both relevant and partial/);
  });
});

describe('RAG-03 permission fixture', () => {
  it('RAG-03 the fixture users are the fx-agt users', () => {
    for (const [name, u] of Object.entries(USERS)) {
      expect(corpus.perms.users[name], name).toEqual({
        uid: u.uid,
        gid: u.gid,
        groups: [...u.groups],
      });
    }
  });

  it('RAG-03 the tree encodes the intended readability of every leak-probe target for every user', () => {
    for (const probe of corpus.perms.probes) {
      for (const user of tree.userNames) {
        expect(tree.canRead(tree.cred(user), probe.target), `${probe.id} ${user}`).toBe(
          probe.readableBy.includes(user),
        );
      }
    }
  });

  it('RAG-03 alice owns private files with mode 600, including some in a traversable directory', () => {
    const private600 = corpus.docs.filter((d) => d.meta.owner === 'alice' && d.meta.mode === '600');
    expect(private600.length).toBeGreaterThanOrEqual(5);
    const bob = tree.cred('bob');
    const parentMode = (p: string): number | undefined =>
      tree.tree.nodeAt(p.slice(0, p.lastIndexOf('/')))?.mode;
    // the file mode alone must hide these: their directory is open to everyone
    expect(private600.filter((d) => parentMode(d.path) === 0o755).length).toBeGreaterThanOrEqual(2);
    for (const d of private600) {
      expect(tree.canRead(tree.cred('alice'), d.path), d.path).toBe(true);
      expect(tree.canRead(bob, d.path), d.path).toBe(false);
      expect(tree.canRead(tree.cred('carol'), d.path), d.path).toBe(false);
    }
  });
});
