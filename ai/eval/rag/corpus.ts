/**
 * Loading the RAG evaluation set and building its file-system tree.
 *
 * The corpus is kept verbatim: every document's size and SHA-256 are in the manifest and are
 * checked on load, because recorded embeddings are keyed by content and line numbers in citations
 * must not drift. The tree gives every document the owner, group and mode from the manifest and
 * every directory the mode from permissions.json, so the same tree serves the RAG-04 run (as the
 * query user) and the RAG-03 leak checks (as every user).
 *
 * `canRead` is an independent readability oracle for the leak checks: it walks the path from the
 * root (x on every directory, r on the file) instead of reusing `readableSet`, so a bug in the
 * readable set cannot hide itself.
 */
import { toHexBytes } from '../../src/util/bytes.ts';
import type { Cred, PermOracle } from '../../src/util/cred.ts';
import { posixOracle } from '../fixtures/perm.ts';
import { type FixtureEntry, type FixtureTree, buildTree } from '../fixtures/tree.ts';
import type { Host } from './host.ts';
import {
  EvalDataError,
  type ManifestRow,
  type PermFixture,
  type QuerySet,
  parseManifest,
  parseOctal,
  parsePermissions,
  parseQueries,
} from './schema.ts';

export interface CorpusDoc {
  path: string;
  text: string;
  bytes: Uint8Array;
  meta: ManifestRow;
}

export interface EvalCorpus {
  docs: CorpusDoc[];
  queries: QuerySet;
  perms: PermFixture;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return toHexBytes(new Uint8Array(digest));
}

/** Load and verify `corpus/MANIFEST.jsonl`, every document, `queries.json` and `permissions.json`. */
export async function loadCorpus(host: Host, dir: string): Promise<EvalCorpus> {
  const corpusDir = host.join(dir, 'corpus');
  const manifest = parseManifest(host.readText(host.join(corpusDir, 'MANIFEST.jsonl')));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const docs: CorpusDoc[] = [];
  for (const meta of manifest) {
    const bytes = host.readBytes(host.join(corpusDir, meta.file));
    if (bytes.length !== meta.bytes)
      throw new EvalDataError(
        `${meta.file}: ${bytes.length} bytes, the manifest says ${meta.bytes}`,
      );
    const sha = await sha256Hex(bytes);
    if (sha !== meta.sha256)
      throw new EvalDataError(
        `${meta.file}: content differs from the manifest (sha256 ${sha}); corpus files are kept verbatim`,
      );
    docs.push({ path: meta.path, text: decoder.decode(bytes), bytes, meta });
  }
  const queries = parseQueries(
    JSON.parse(host.readText(host.join(dir, 'queries.json'))) as unknown,
  );
  const perms = parsePermissions(
    JSON.parse(host.readText(host.join(dir, 'permissions.json'))) as unknown,
  );
  return { docs, queries, perms };
}

/** `rag-corpus@<documents>-<queries>`, the `fixtures` label of the evaluation report. */
export function corpusLabel(corpus: EvalCorpus): string {
  return `rag-corpus@${corpus.docs.length}-${corpus.queries.queries.length}`;
}

export interface EvalTree {
  readonly tree: FixtureTree;
  readonly userNames: readonly string[];
  cred(user: string): Cred;
  /** Independent oracle: x on every directory from the root, then r on the file. */
  canRead(cred: Cred, path: string): boolean;
}

function parentsOf(path: string): string[] {
  const parts = path.split('/').slice(1, -1);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
}

export function buildEvalTree(corpus: EvalCorpus, oracle: PermOracle = posixOracle): EvalTree {
  const { perms } = corpus;
  const uidOf = (name: string): number => {
    if (name === 'root') return 0;
    const u = perms.users[name];
    if (u === undefined) throw new EvalDataError(`unknown user "${name}"`);
    return u.uid;
  };
  const gidOf = (name: string): number => {
    if (name === 'root') return 0;
    const g = perms.groups[name];
    if (g === undefined) throw new EvalDataError(`unknown group "${name}"`);
    return g;
  };
  const entries = new Map<string, FixtureEntry>();
  for (const d of perms.directories) {
    entries.set(d.path, {
      path: d.path,
      type: 'd',
      uid: uidOf(d.owner),
      gid: gidOf(d.group),
      mode: parseOctal(d.mode),
    });
  }
  for (const doc of corpus.docs) {
    for (const dir of parentsOf(doc.path)) {
      if (entries.has(dir)) continue;
      // A directory below /home/<user> that permissions.json does not list belongs to that user.
      const home = dir.split('/')[2];
      const owner = home !== undefined && perms.users[home] !== undefined ? home : 'root';
      entries.set(dir, {
        path: dir,
        type: 'd',
        uid: uidOf(owner),
        gid: gidOf(perms.defaultDirectory.group),
        mode: parseOctal(perms.defaultDirectory.mode),
      });
    }
    if (entries.has(doc.path)) throw new EvalDataError(`${doc.path}: listed twice`);
    entries.set(doc.path, {
      path: doc.path,
      type: 'f',
      uid: uidOf(doc.meta.owner),
      gid: gidOf(doc.meta.group),
      mode: parseOctal(doc.meta.mode),
      size: doc.meta.bytes,
    });
  }
  const tree = buildTree([...entries.values()]);
  const cred = (user: string): Cred => {
    const u = perms.users[user];
    if (u === undefined) throw new EvalDataError(`unknown user "${user}"`);
    return { uid: u.uid, gid: u.gid, groups: [...u.groups] };
  };
  const canRead = (c: Cred, path: string): boolean => {
    for (const dir of ['/', ...parentsOf(path)]) {
      const node = tree.nodeAt(dir);
      if (node?.type !== 'd' || !oracle.may(c, node, 'x')) return false;
    }
    const file = tree.nodeAt(path);
    return file?.type === 'f' && oracle.may(c, file, 'r');
  };
  return { tree, userNames: Object.keys(perms.users), cred, canRead };
}
