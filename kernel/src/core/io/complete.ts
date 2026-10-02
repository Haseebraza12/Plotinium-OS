/**
 * The `complete` service's port and the `complete.*` calls (shell-and-terminal.md §3.10, §4.5;
 * SYS-03, SHL-10, SHL-11): the team's `dsa/trie` (services/src/system/completion.ts) filled at start
 * and updated INCREMENTALLY from the kernel's VFS events, one O(L) insert or remove per change.
 *
 *   cmd   shell builtins + the program catalog + `/bin/*.json`
 *   flag  `- \`-x\` — text` option lines of the section-1 man pages listed in
 *         `/usr/share/man/index.json`
 *   hist  per uid, from `complete.hist.load` / `add` (the shell's history file)
 *   path  the console user's home eagerly; any other directory on its first query
 *
 * The service never sees credentials: `call` resolves `dir` with the CALLER's credentials (x on
 * every ancestor through resolution, r on the directory here) and stamps `hist` with the caller's
 * uid from the port (C3). `complete.*` is not in the syscall-abi catalogue yet (protocol/src/
 * complete.ts: requested, so the dispatcher answers ENOSYS at stage 2); `call` is the handler the
 * dispatcher reaches once protocol registers them.
 */
import type { CompletePort, CompleteStarted } from '@plotinium/services';
import { CompletionIndex } from '@plotinium/services';
import type { COMPLETE_CALLS, CompleteResult, CompleteStatsRet } from '@plotinium/protocol';
import {
  CompleteBenchArgs,
  CompleteHistAddArgs,
  CompleteHistClearArgs,
  CompleteHistLoadArgs,
  CompleteQuery,
  INO,
} from '@plotinium/protocol';
import type { VfsEvent } from '@plotinium/vfs';
import { R, may } from '@plotinium/vfs';
import * as v from 'valibot';

import { KernelError } from '../errors.ts';
import { actorOf } from '../fs/kfs.ts';
import type { KernelFs } from '../fs/kfs.ts';
import type { Caller } from '../ipc/ports.ts';
import type { ProgramCatalog } from '../programs/catalog.ts';
import { listDir, readTextAsRoot } from './fsutil.ts';

/** The shell's builtins (apps/shell/builtins/names.ts, shell-and-terminal.md §3.7.1). */
export const SHELL_BUILTINS = [
  'cd',
  'export',
  'unset',
  'exit',
  'history',
  'jobs',
  'fg',
  'bg',
  'wait',
  'pwd',
  'echo',
  'kill',
  'help',
  'type',
  'true',
  'false',
] as const;

export type CompleteCallName = (typeof COMPLETE_CALLS)[number];

const MAN_INDEX = '/usr/share/man/index.json';
const MAN_PAGES_MAX = 256;
const FLAG_LINE = /^\s*[-*]\s+`(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*)[^`]*`\s*(?:—|-|:)?\s*(.*)$/;

const ManIndex = v.array(
  v.object({
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    section: v.optional(v.number()),
  }),
);

export interface CompleteIoDeps {
  readonly fs: () => KernelFs | null;
  readonly catalog: ProgramCatalog;
  /** The console user's home (indexed eagerly at start). */
  readonly home: () => string | null;
  readonly log: (level: 'info' | 'warn', msg: string) => void;
  readonly now: () => number;
}

/** Parse the OPTIONS section of a man page into flags. */
export function flagsOf(page: string): { flag: string; desc: string }[] {
  const out: { flag: string; desc: string }[] = [];
  let inOptions = false;
  for (const line of page.split('\n')) {
    if (/^#{1,3}\s/.test(line)) {
      inOptions = /^#{1,3}\s+OPTIONS\b/i.test(line);
      continue;
    }
    if (!inOptions) continue;
    const m = FLAG_LINE.exec(line);
    if (m?.[1] !== undefined) out.push({ flag: m[1], desc: (m[2] ?? '').trim() });
  }
  return out;
}

export class CompleteIo implements CompletePort {
  private readonly deps: CompleteIoDeps;
  private idx = new CompletionIndex();
  private unlisten: (() => void) | null = null;
  private started = false;

  constructor(deps: CompleteIoDeps) {
    this.deps = deps;
  }

  get index(): CompletionIndex {
    return this.idx;
  }

  get running(): boolean {
    return this.started;
  }

  async start(): Promise<CompleteStarted> {
    this.idx = new CompletionIndex();
    for (const b of SHELL_BUILTINS) this.idx.addBuiltin(b);
    for (const n of this.deps.catalog.names()) this.idx.addCommand(n);
    const fs = this.deps.fs();
    if (fs !== null) {
      const bin = await listDir(fs, INO.BIN);
      for (const e of bin ?? [])
        if (e.type !== 'd') this.idx.addCommand(e.name.replace(/\.json$/, ''));
      await this.loadFlags(fs);
      const home = this.deps.home();
      if (home !== null) {
        try {
          const r = await fs.resolvePath(
            {
              pid: 1,
              cred: { uid: 0, gid: 0, groups: [0] },
              cls: 'system',
              cwdIno: INO.ROOT,
              cwdPath: '/',
              umask: 0o022,
            },
            home,
            { follow: true },
          );
          if (r.node?.type === 'd') await this.ensureIndexed(fs, r.node.ino);
        } catch {
          // No home yet (a local guest before its first file): indexed on first query.
        }
      }
      this.unlisten?.();
      this.unlisten = fs.events.listen((ev) => {
        this.apply(ev);
      });
    }
    this.started = true;
    const s = this.idx.sizes();
    return { cmd: s.cmd, flag: s.flag, hist: s.hist, path: s.path };
  }

  private async loadFlags(fs: KernelFs): Promise<void> {
    const text = await readTextAsRoot(fs, MAN_INDEX);
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.deps.log('warn', `${MAN_INDEX}: not JSON, no flag completion`);
      return;
    }
    const parsed = v.safeParse(ManIndex, raw);
    if (!parsed.success) return;
    for (const e of parsed.output.filter((x) => (x.section ?? 1) === 1).slice(0, MAN_PAGES_MAX)) {
      const page = await readTextAsRoot(fs, `/usr/share/man/1/${e.name}.md`);
      if (page === null) continue;
      for (const f of flagsOf(page))
        this.idx.addFlag(e.name, f.flag, f.desc === '' ? undefined : f.desc);
    }
  }

  private async ensureIndexed(fs: KernelFs, dirIno: string): Promise<boolean> {
    if (this.idx.isIndexed(dirIno)) return true;
    const entries = await listDir(fs, dirIno);
    if (entries === null) return false;
    this.idx.indexDir(dirIno, entries);
    return true;
  }

  /** One VFS event: at most one trie insert or remove per affected entry. */
  apply(ev: VfsEvent): void {
    switch (ev.topic) {
      case 'vfs.create':
        for (const i of ev.data.items) {
          this.idx.addEntry(i.parent, i.name, i.type);
          if (i.parent === INO.BIN && i.type !== 'd')
            this.idx.addCommand(i.name.replace(/\.json$/, ''));
        }
        return;
      case 'vfs.unlink':
        for (const i of ev.data.items) {
          this.idx.removeEntry(i.parent, i.name);
          if (i.type === 'd') for (const ino of [i.ino, ...i.inos]) this.idx.forgetDir(ino);
          if (i.parent === INO.BIN && i.type !== 'd') {
            const name = i.name.replace(/\.json$/, '');
            if (this.deps.catalog.manifest(name) === undefined) this.idx.removeCommand(name);
          }
        }
        return;
      case 'vfs.rename':
        for (const i of ev.data.items) {
          if (i.from !== null) this.idx.removeEntry(i.from.parent, i.from.name);
          if (i.to !== null) this.idx.addEntry(i.to.parent, i.to.name, i.type);
        }
        return;
      case 'vfs.load':
      case 'vfs.write':
      case 'vfs.link':
      case 'vfs.chmod':
      case 'vfs.chown':
      case 'vfs.utimes':
      case 'vfs.conflict':
      case 'vfs.revert':
        return;
    }
  }

  // -- the calls ------------------------------------------------------------------------------

  private async query(c: Caller, raw: unknown): Promise<CompleteResult> {
    const q = parse(CompleteQuery, raw);
    if (q.ns !== 'path') {
      return this.idx.query({
        ns: q.ns,
        prefix: q.prefix,
        limit: q.limit,
        ...(q.cmd === undefined ? {} : { cmd: q.cmd }),
        ...(q.ns === 'hist' ? { uid: c.pcb.cred.uid } : {}),
      });
    }
    const fs = this.deps.fs();
    if (fs === null) return { items: [], truncated: false, indexed: false };
    const actor = actorOf(c.pcb);
    const r = await fs.resolvePath(actor, q.dir ?? '.', { follow: true });
    const node = r.node;
    if (node?.type !== 'd')
      throw new KernelError('ENOTDIR', { path: q.dir ?? '.' }, 'not a directory');
    if (!may(actor.cred, node, R))
      throw new KernelError('EACCES', { path: q.dir ?? '.' }, 'permission denied');
    const indexed = await this.ensureIndexed(fs, node.ino);
    if (!indexed) return { items: [], truncated: false, indexed: false };
    return this.idx.query({ ns: 'path', prefix: q.prefix, limit: q.limit, dirIno: node.ino });
  }

  /** `complete --bench`: p50/p95/p99 of `queries` random prefixes over synthetic names. */
  private bench(raw: unknown): {
    p50: number;
    p95: number;
    p99: number;
    max: number;
    bytesPerEntry: number;
    entries: number;
  } {
    const a = parse(CompleteBenchArgs, raw);
    const n = a.synthetic ?? 10_000;
    const idx = new CompletionIndex();
    let seed = a.seed >>> 0;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_.';
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      let s = '';
      const len = 4 + Math.floor(rnd() * 12);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)] ?? 'a';
      names.push(`${s}${String(i)}`);
    }
    idx.indexDir(
      'bench',
      names.map((name) => ({ name, type: 'f' as const })),
    );
    const times: number[] = [];
    for (let i = 0; i < a.queries; i++) {
      const name = names[Math.floor(rnd() * names.length)] ?? 'a';
      const prefix = name.slice(0, 1 + Math.floor(rnd() * 3));
      const t = this.deps.now();
      idx.query({ ns: 'path', prefix, limit: a.k, dirIno: 'bench' });
      times.push(this.deps.now() - t);
    }
    times.sort((x, y) => x - y);
    const at = (p: number): number =>
      times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0;
    const st = idx.stats().ns.path;
    return {
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: times[times.length - 1] ?? 0,
      bytesPerEntry: st.entries === 0 ? 0 : st.bytes / st.entries,
      entries: st.entries,
    };
  }

  /** The `complete.*` handlers (reached once protocol registers the calls, see the module note). */
  async call(c: Caller, name: CompleteCallName, raw: unknown): Promise<unknown> {
    if (!this.started)
      throw new KernelError(
        'EAGAIN',
        { reason: 'starting' },
        'the complete service is not running',
      );
    switch (name) {
      case 'complete.query':
        return this.query(c, raw);
      case 'complete.hist.load':
        this.idx.loadHistory(c.pcb.cred.uid, parse(CompleteHistLoadArgs, raw).lines);
        return {};
      case 'complete.hist.add':
        this.idx.addHistory(c.pcb.cred.uid, parse(CompleteHistAddArgs, raw).line);
        return {};
      case 'complete.hist.clear':
        parse(CompleteHistClearArgs, raw);
        this.idx.clearHistory(c.pcb.cred.uid);
        return {};
      case 'complete.stats':
        return this.stats();
      case 'complete.bench':
        return this.bench(raw);
    }
  }

  stats(): CompleteStatsRet {
    return this.idx.stats();
  }

  stop(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    this.started = false;
    return Promise.resolve();
  }
}

function parse<S extends v.GenericSchema>(schema: S, raw: unknown): v.InferOutput<S> {
  const r = v.safeParse(schema, raw, { abortEarly: true });
  if (r.success) return r.output;
  const key = r.issues[0]?.path?.map((p) => String(p.key)).join('.');
  throw new KernelError('EINVAL', key === undefined ? {} : { field: key }, 'invalid arguments');
}
