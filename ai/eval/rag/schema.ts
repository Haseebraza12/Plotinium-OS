/**
 * Data formats of the RAG evaluation set (ai-safety-and-evaluation.md §3.6; RAG-04, RAG-03, AIS-04)
 * and their run-time validation. The files are data written by people, so every field is checked
 * before use and a malformed file fails with the file, line and field in the message.
 *
 * - `corpus/MANIFEST.jsonl`: one row per document (VFS path, stored file, owner, group, mode,
 *   format, category, size, SHA-256, source, licence, author, near-duplicate and distractor notes).
 * - `queries.json`: the RAG-04 queries, graded: `relevant` (grade 2, used by Recall@5 and MRR) and
 *   `partial` (grade 1, used by nDCG@10 only). The spec's record `{id, query, relevant, author,
 *   kind}` is a subset of ours.
 * - `permissions.json`: users, groups, directory modes and the RAG-03 leak probes.
 */

/** Corpus files are stored with this suffix so tsc, ESLint, Vitest and Prettier never treat evaluation data as source. */
export const CORPUS_SUFFIX = '.corpus';

export const QUERY_KINDS = ['paraphrase', 'keyword', 'code', 'question'] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export interface ManifestRow {
  /** Absolute VFS path, e.g. `/home/alice/notes/os/deadlock.md`. */
  path: string;
  /** Stored file relative to `corpus/`: the VFS path without its leading `/`, plus `.corpus`. */
  file: string;
  owner: string;
  group: string;
  /** Octal mode as written by `ls -l` digits, e.g. `644`. */
  mode: string;
  format: string;
  category: string;
  bytes: number;
  sha256: string;
  source: string;
  licence: string;
  author: string;
  nearDuplicateOf?: string;
  distractorFor?: string[];
}

export interface EvalQuery {
  id: string;
  query: string;
  kind: QueryKind;
  author: string;
  /** Grade 2: the files the query is about (1–3). */
  relevant: string[];
  /** Grade 1: related files that answer part of the query. */
  partial: string[];
}

export interface QuerySet {
  set: string;
  corpus: string;
  /** The user whose session runs the RAG-04 queries. */
  user: string;
  queries: EvalQuery[];
}

export interface PermUser {
  uid: number;
  gid: number;
  groups: number[];
}

export interface DirSpec {
  path: string;
  owner: string;
  group: string;
  mode: string;
}

export interface LeakProbe {
  id: string;
  query: string;
  target: string;
  /** Users expected to be able to read `target` (checked against the tree, then used as ground truth). */
  readableBy: string[];
  why: string;
}

export interface PermFixture {
  set: string;
  groups: Record<string, number>;
  users: Record<string, PermUser>;
  directories: DirSpec[];
  defaultDirectory: { group: string; mode: string };
  probes: LeakProbe[];
}

export class EvalDataError extends Error {
  override readonly name = 'EvalDataError';
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obj(v: unknown, where: string): Obj {
  if (!isObj(v)) throw new EvalDataError(`${where}: expected an object`);
  return v;
}

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '')
    throw new EvalDataError(`${where}: "${key}" must be a non-empty string`);
  return v;
}

function int(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new EvalDataError(`${where}: "${key}" must be a non-negative integer`);
  return v;
}

function strList(o: Obj, key: string, where: string, optional = false): string[] {
  const v = o[key];
  if (v === undefined && optional) return [];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === 'string' && x !== ''))
    throw new EvalDataError(`${where}: "${key}" must be an array of non-empty strings`);
  return v;
}

function intList(o: Obj, key: string, where: string): number[] {
  const v = o[key];
  if (
    !Array.isArray(v) ||
    !v.every((x): x is number => typeof x === 'number' && Number.isSafeInteger(x))
  )
    throw new EvalDataError(`${where}: "${key}" must be an array of integers`);
  return v;
}

function mode(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  if (!/^[0-7]{3}$/.test(v))
    throw new EvalDataError(`${where}: "${key}" must be three octal digits`);
  return v;
}

function absPath(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  if (!v.startsWith('/') || v.endsWith('/') || v.includes('//'))
    throw new EvalDataError(`${where}: "${key}" must be a normalised absolute path`);
  return v;
}

export function parseOctal(mode: string): number {
  return Number.parseInt(mode, 8);
}

/** Parse `corpus/MANIFEST.jsonl`. Blank lines are allowed; paths must be unique. */
export function parseManifest(text: string, source = 'MANIFEST.jsonl'): ManifestRow[] {
  const rows: ManifestRow[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const where = `${source}:${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new EvalDataError(`${where}: not valid JSON`);
    }
    const o = obj(parsed, where);
    const path = absPath(o, 'path', where);
    const file = str(o, 'file', where);
    if (file !== `${path.slice(1)}${CORPUS_SUFFIX}`)
      throw new EvalDataError(
        `${where}: "file" must be the path without "/" plus "${CORPUS_SUFFIX}"`,
      );
    if (seen.has(path)) throw new EvalDataError(`${where}: duplicate path ${path}`);
    seen.add(path);
    const sha256 = str(o, 'sha256', where);
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new EvalDataError(`${where}: "sha256" must be 64 hex digits`);
    const row: ManifestRow = {
      path,
      file,
      owner: str(o, 'owner', where),
      group: str(o, 'group', where),
      mode: mode(o, 'mode', where),
      format: str(o, 'format', where),
      category: str(o, 'category', where),
      bytes: int(o, 'bytes', where),
      sha256,
      source: str(o, 'source', where),
      licence: str(o, 'licence', where),
      author: str(o, 'author', where),
    };
    if (o['nearDuplicateOf'] !== undefined)
      row.nearDuplicateOf = absPath(o, 'nearDuplicateOf', where);
    if (o['distractorFor'] !== undefined) row.distractorFor = strList(o, 'distractorFor', where);
    rows.push(row);
  });
  return rows;
}

function isKind(v: string): v is QueryKind {
  return (QUERY_KINDS as readonly string[]).includes(v);
}

/** Parse `queries.json`. Ids are unique; a file is never both relevant and partial. */
export function parseQueries(json: unknown, source = 'queries.json'): QuerySet {
  const top = obj(json, source);
  const list = top['queries'];
  if (!Array.isArray(list)) throw new EvalDataError(`${source}: "queries" must be an array`);
  const ids = new Set<string>();
  const queries = list.map((raw, i): EvalQuery => {
    const where = `${source} queries[${i}]`;
    const o = obj(raw, where);
    const id = str(o, 'id', where);
    if (ids.has(id)) throw new EvalDataError(`${where}: duplicate id ${id}`);
    ids.add(id);
    const kind = str(o, 'kind', where);
    if (!isKind(kind)) throw new EvalDataError(`${where}: unknown kind "${kind}"`);
    const relevant = strList(o, 'relevant', where);
    const partial = strList(o, 'partial', where, true);
    if (relevant.length === 0) throw new EvalDataError(`${where}: at least one relevant file`);
    if (new Set(relevant).size !== relevant.length || new Set(partial).size !== partial.length)
      throw new EvalDataError(`${where}: duplicate file in a grade list`);
    if (relevant.some((p) => partial.includes(p)))
      throw new EvalDataError(`${where}: a file is both relevant and partial`);
    return {
      id,
      query: str(o, 'query', where),
      kind,
      author: str(o, 'author', where),
      relevant,
      partial,
    };
  });
  return {
    set: str(top, 'set', source),
    corpus: str(top, 'corpus', source),
    user: str(top, 'user', source),
    queries,
  };
}

/** Parse `permissions.json`. */
export function parsePermissions(json: unknown, source = 'permissions.json'): PermFixture {
  const top = obj(json, source);
  const groupsObj = obj(top['groups'], `${source} groups`);
  const groups: Record<string, number> = {};
  for (const name of Object.keys(groupsObj))
    groups[name] = int(groupsObj, name, `${source} groups`);
  const usersObj = obj(top['users'], `${source} users`);
  const users: Record<string, PermUser> = {};
  for (const name of Object.keys(usersObj)) {
    const where = `${source} users.${name}`;
    const u = obj(usersObj[name], where);
    users[name] = {
      uid: int(u, 'uid', where),
      gid: int(u, 'gid', where),
      groups: intList(u, 'groups', where),
    };
  }
  const dirs = top['directories'];
  if (!Array.isArray(dirs)) throw new EvalDataError(`${source}: "directories" must be an array`);
  const directories = dirs.map((raw, i): DirSpec => {
    const where = `${source} directories[${i}]`;
    const o = obj(raw, where);
    return {
      path: absPath(o, 'path', where),
      owner: str(o, 'owner', where),
      group: str(o, 'group', where),
      mode: mode(o, 'mode', where),
    };
  });
  const defWhere = `${source} defaultDirectory`;
  const def = obj(top['defaultDirectory'], defWhere);
  const probesRaw = top['probes'];
  if (!Array.isArray(probesRaw)) throw new EvalDataError(`${source}: "probes" must be an array`);
  const probes = probesRaw.map((raw, i): LeakProbe => {
    const where = `${source} probes[${i}]`;
    const o = obj(raw, where);
    return {
      id: str(o, 'id', where),
      query: str(o, 'query', where),
      target: absPath(o, 'target', where),
      readableBy: strList(o, 'readableBy', where),
      why: str(o, 'why', where),
    };
  });
  return {
    set: str(top, 'set', source),
    groups,
    users,
    directories,
    defaultDirectory: { group: str(def, 'group', defWhere), mode: mode(def, 'mode', defWhere) },
    probes,
  };
}
