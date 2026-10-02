/**
 * The Node host of the RAG evaluation: reading the corpus and writing reports.
 *
 * ai/ is type-checked for browsers and workers with `types: []` (ai/tsconfig.json), so this module
 * does not import `node:` modules statically. It asks Node for its built-ins at run time with
 * `process.getBuiltinModule` (Node >= 22.3; the repository requires Node 24) and describes the few
 * members it uses with narrow structural types. Everything else in ai/eval/rag is pure and takes
 * a `Host`, so the tests can pass an in-memory one.
 */

/** File access the harness needs, with POSIX-style paths. */
export interface Host {
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  /** Writes a UTF-8 file, creating missing parent directories. */
  writeText(path: string, text: string): void;
  exists(path: string): boolean;
  /** Regular files below `dir`, recursively, as paths relative to `dir` with `/` separators. */
  listFiles(dir: string): string[];
  join(...parts: string[]): string;
}

interface NodeFs {
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  existsSync(path: string): boolean;
  readdirSync(path: string, options: { recursive: true }): string[];
  statSync(path: string): { isFile(): boolean };
}

interface NodePath {
  readonly sep: string;
  join(...parts: string[]): string;
  dirname(path: string): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
}

export interface NodeProcess {
  argv: string[];
  exitCode?: number | undefined;
  getBuiltinModule(id: string): unknown;
}

/** The Node `process` object, or an error that says why the harness cannot run here. */
export function nodeProcess(): NodeProcess {
  const proc = (globalThis as { process?: Partial<NodeProcess> }).process;
  if (
    proc === undefined ||
    typeof proc.getBuiltinModule !== 'function' ||
    !Array.isArray(proc.argv)
  )
    throw new Error('the RAG evaluation harness runs on Node >= 22.3 (process.getBuiltinModule)');
  return proc as NodeProcess;
}

function builtin<T>(id: string): T {
  const mod = nodeProcess().getBuiltinModule(id);
  if (mod === undefined || mod === null) throw new Error(`Node built-in ${id} is unavailable`);
  return mod as T;
}

/** The real file system. */
export function nodeHost(): Host {
  const fs = builtin<NodeFs>('node:fs');
  const path = builtin<NodePath>('node:path');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    readBytes: (p) => fs.readFileSync(p),
    readText: (p) => decoder.decode(fs.readFileSync(p)),
    writeText: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    },
    exists: (p) => fs.existsSync(p),
    listFiles: (dir) =>
      fs
        .readdirSync(dir, { recursive: true })
        .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
        .map((rel) => rel.split(path.sep).join('/'))
        .sort(),
    join: (...parts) => path.join(...parts),
  };
}

/** Absolute path of ai/eval/rag (this module's directory). */
export function ragDir(): string {
  const url = builtin<NodeUrl>('node:url');
  const path = builtin<NodePath>('node:path');
  return path.dirname(url.fileURLToPath(import.meta.url));
}

/** An in-memory host over `files` (path → text), for tests. Writes are kept in the map. */
export function memoryHost(files: Map<string, string>): Host {
  const encoder = new TextEncoder();
  const get = (p: string): string => {
    const text = files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    return text;
  };
  return {
    readText: get,
    readBytes: (p) => encoder.encode(get(p)),
    writeText: (p, text) => {
      files.set(p, text);
    },
    exists: (p) => files.has(p),
    listFiles: (dir) => {
      const prefix = `${dir.replace(/\/+$/, '')}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .sort();
    },
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
  };
}
