/**
 * The `complete` service's index (shell-and-terminal.md §3.10; SYS-03, SHL-10, SHL-11): the team's
 * `dsa/trie` in four namespaces, filled at start and updated incrementally from VFS events with one
 * O(L) insert or remove each.
 *
 *   cmd   command name                      builtins + `$PATH` manifests (`<name>.json`)
 *   path  dirKey + '/' + basename           directories indexed on first query ($HOME eagerly)
 *   flag  command + U+0000 + flag           `/usr/share/man/index.json`
 *   hist  uid + U+0000 + line               `complete.hist.load` / `add` from shells
 *
 * `dirKey` is a dense directory slot (2 UTF-16 code units, 12 bits each, in U+1000..U+1FFF so it
 * never contains a surrogate or a control character) assigned from the directory's inode, so a
 * directory rename changes one key in its old and new parent and nothing below it. The service
 * never sees credentials: the kernel checks `r` on the directory and `x` on its ancestors before it
 * calls `query` (SHL-10, I-SH6).
 */
import type { Completion } from '@plotinium/dsa/trie';
import { NamespacedRadixTrie } from '@plotinium/dsa/trie';
import type {
  CompleteItem,
  CompleteNamespace,
  CompleteResult,
  CompleteStatsRet,
} from '@plotinium/protocol';
import { COMPLETE_LIMIT_DEFAULT, COMPLETE_LIMIT_MAX } from '@plotinium/protocol';

export type EntryType = 'f' | 'd' | 'l';

export interface DirEntryLike {
  readonly name: string;
  readonly type: EntryType;
}

export interface CompletionQuery {
  readonly ns: CompleteNamespace;
  readonly prefix: string;
  readonly limit?: number;
  /** `path`: the directory inode the kernel resolved for the caller. */
  readonly dirIno?: string;
  /** `flag`: the command whose flags complete. */
  readonly cmd?: string;
  /** `hist`: the caller's uid, stamped by the kernel from the port (C3). */
  readonly uid?: number;
}

/** Bound of the `path` namespace (§3.10): past it the least recently queried directory goes. */
export const PATH_ENTRIES_MAX = 200_000;

const SLOT_BITS = 12;
const SLOT_MASK = (1 << SLOT_BITS) - 1;
const SLOT_BASE = 0x1000;
const SLOTS_MAX = 1 << (2 * SLOT_BITS);

const KIND_OF_TYPE: Readonly<Record<EntryType, 'file' | 'dir' | 'link'>> = {
  f: 'file',
  d: 'dir',
  l: 'link',
};

function itemOf(c: Completion): CompleteItem {
  switch (c.kind) {
    case 'builtin':
      return { text: c.text, kind: 'builtin' };
    case 'dir':
      return { text: c.text, kind: 'd' };
    case 'link':
      return { text: c.text, kind: 'l' };
    case 'file':
      return { text: c.text, kind: 'f' };
    case 'flag':
      return c.detail === undefined
        ? { text: c.text, kind: 'flag' }
        : { text: c.text, kind: 'flag', desc: c.detail.slice(0, 80) };
    case 'hist':
      return { text: c.text, kind: 'hist' };
    case 'cmd':
    case undefined:
      return { text: c.text, kind: 'program' };
  }
}

export class CompletionIndex {
  private readonly trie = new NamespacedRadixTrie();
  private readonly slotOf = new Map<string, number>();
  private readonly inoOf = new Map<number, string>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  /** Indexed directories, least recently queried first (Map insertion order as the recency list). */
  private readonly indexed = new Map<number, number>();
  private readonly builtins = new Set<string>();
  private readonly pathMax: number;

  constructor(opts: { pathMax?: number } = {}) {
    this.pathMax = opts.pathMax ?? PATH_ENTRIES_MAX;
  }

  // -- cmd -------------------------------------------------------------------------------------

  addBuiltin(name: string): void {
    this.builtins.add(name);
    this.trie.cmd.insert(name, { text: name, kind: 'builtin' });
  }

  addCommand(name: string): void {
    if (this.builtins.has(name) || name === '') return;
    this.trie.cmd.insert(name, { text: name, kind: 'cmd' });
  }

  removeCommand(name: string): void {
    if (this.builtins.has(name)) return;
    this.trie.cmd.remove(name);
  }

  // -- flag ------------------------------------------------------------------------------------

  addFlag(cmd: string, flag: string, desc?: string): void {
    this.trie.addFlag(cmd, flag, desc);
  }

  // -- hist ------------------------------------------------------------------------------------

  addHistory(uid: number, line: string): void {
    const text = line.trim();
    if (text === '') return;
    this.trie.addHistory(uid, text);
  }

  loadHistory(uid: number, lines: readonly string[]): void {
    for (const l of lines) this.addHistory(uid, l);
  }

  clearHistory(uid: number): number {
    return this.trie.clearHistory(uid);
  }

  // -- path ------------------------------------------------------------------------------------

  private keyOf(slot: number): string {
    return String.fromCharCode(
      SLOT_BASE + ((slot >>> SLOT_BITS) & SLOT_MASK),
      SLOT_BASE + (slot & SLOT_MASK),
    );
  }

  private slotFor(ino: string): number {
    const known = this.slotOf.get(ino);
    if (known !== undefined) return known;
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    if (slot >= SLOTS_MAX) throw new RangeError('completion: directory slots exhausted');
    this.slotOf.set(ino, slot);
    this.inoOf.set(slot, ino);
    return slot;
  }

  isIndexed(dirIno: string): boolean {
    const slot = this.slotOf.get(dirIno);
    return slot !== undefined && this.indexed.has(slot);
  }

  /** Replace a directory's listing (first query, or a re-index after it was dropped). */
  indexDir(dirIno: string, entries: readonly DirEntryLike[]): void {
    this.forgetDir(dirIno);
    const slot = this.slotFor(dirIno);
    const key = this.keyOf(slot);
    for (const e of entries) this.trie.addPath(key, e.name, KIND_OF_TYPE[e.type]);
    this.indexed.set(slot, entries.length);
    this.bound(slot);
  }

  /** An entry appeared in an indexed directory (`vfs.create`, a rename's new name). */
  addEntry(dirIno: string, name: string, type: EntryType): void {
    const slot = this.slotOf.get(dirIno);
    if (slot === undefined || !this.indexed.has(slot)) return;
    const key = this.keyOf(slot);
    if (!this.trie.path.has(`${key}/${name}`))
      this.indexed.set(slot, (this.indexed.get(slot) ?? 0) + 1);
    this.trie.addPath(key, name, KIND_OF_TYPE[type]);
    this.bound(slot);
  }

  /** An entry left an indexed directory (`vfs.unlink`, a rename's old name). */
  removeEntry(dirIno: string, name: string): void {
    const slot = this.slotOf.get(dirIno);
    if (slot === undefined || !this.indexed.has(slot)) return;
    if (this.trie.removePath(this.keyOf(slot), name))
      this.indexed.set(slot, Math.max(0, (this.indexed.get(slot) ?? 1) - 1));
  }

  /** Drop a directory's listing (the directory itself was removed, or the bound was reached). */
  forgetDir(dirIno: string): void {
    const slot = this.slotOf.get(dirIno);
    if (slot === undefined) return;
    if (this.indexed.has(slot)) {
      this.trie.path.removePrefix(`${this.keyOf(slot)}/`);
      this.indexed.delete(slot);
    }
    this.slotOf.delete(dirIno);
    this.inoOf.delete(slot);
    this.freeSlots.push(slot);
  }

  private bound(keep: number): void {
    while (this.trie.path.size > this.pathMax && this.indexed.size > 1) {
      const oldest = this.indexed.keys().next().value;
      if (oldest === undefined || oldest === keep) break;
      const ino = this.inoOf.get(oldest);
      if (ino === undefined) break;
      this.forgetDir(ino);
    }
  }

  private touch(slot: number): void {
    const n = this.indexed.get(slot);
    if (n === undefined) return;
    this.indexed.delete(slot);
    this.indexed.set(slot, n);
  }

  // -- query -----------------------------------------------------------------------------------

  query(q: CompletionQuery): CompleteResult {
    const limit = Math.max(1, Math.min(COMPLETE_LIMIT_MAX, q.limit ?? COMPLETE_LIMIT_DEFAULT));
    let found: Completion[];
    let indexed = true;
    switch (q.ns) {
      case 'cmd':
        found = this.trie.cmd.complete(q.prefix, limit + 1);
        break;
      case 'flag':
        found = q.cmd === undefined ? [] : this.trie.completeFlag(q.cmd, q.prefix, limit + 1);
        break;
      case 'hist':
        found = q.uid === undefined ? [] : this.trie.completeHistory(q.uid, q.prefix, limit + 1);
        break;
      case 'path': {
        const slot = q.dirIno === undefined ? undefined : this.slotOf.get(q.dirIno);
        if (slot === undefined || !this.indexed.has(slot)) {
          found = [];
          indexed = false;
          break;
        }
        this.touch(slot);
        found = this.trie.completePath(this.keyOf(slot), q.prefix, limit + 1);
        break;
      }
    }
    return {
      items: found.slice(0, limit).map(itemOf),
      truncated: found.length > limit,
      indexed,
    };
  }

  stats(): CompleteStatsRet {
    const ns = (name: CompleteNamespace): { entries: number; bytes: number } => ({
      entries: this.trie[name].size,
      bytes: Math.max(0, Math.round(this.trie[name].stats().bytesUsed)),
    });
    return { ns: { cmd: ns('cmd'), path: ns('path'), flag: ns('flag'), hist: ns('hist') } };
  }

  /** Entries per namespace, for the service start log line. */
  sizes(): Record<CompleteNamespace, number> {
    return {
      cmd: this.trie.cmd.size,
      path: this.trie.path.size,
      flag: this.trie.flag.size,
      hist: this.trie.hist.size,
    };
  }
}
