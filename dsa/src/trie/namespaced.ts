/**
 * S2 NamespacedRadixTrie: the four completion namespaces of §3.5 S2 (DSA-TRIE-02), one RadixTrie
 * instance each. The helpers only build keys and strip them again; every operation is exactly one
 * call on the underlying trie, so each keeps that call's bound (insert/remove O(L),
 * complete O(P + k), removePrefix O(P + m)).
 *
 *   cmd   command name
 *   path  `${dirIno}/${basename}`  dirIno is the 36-char UUIDv7 of the containing directory, so a
 *                                  directory rename or move is one remove plus one insert: the
 *                                  keys of its own entries embed its ino, which does not change
 *   flag  `${cmd}\u0000${flag}`     U+0000 cannot occur in a command name, so `ls` never matches `lsof`
 *   hist  `${uid}\u0000${line}`     likewise uid 10 never matches uid 100
 */
import { RadixTrie } from './radix-trie.ts';
import type { Completion, NamespacedTrie, Trie } from './index.ts';

const pathKey = (dirIno: string, basename: string): string => `${dirIno}/${basename}`;
const flagKey = (cmd: string, flag: string): string => `${cmd}\u0000${flag}`;
const histKey = (uid: number, line: string): string => `${uid}\u0000${line}`;

/** Strip the first `n` code units (the namespace part of the key) from each completion. */
function stripKeys(completions: Completion[], n: number): Completion[] {
  // complete() returns fresh objects, so rewriting `text` in place is safe.
  for (const c of completions) c.text = c.text.slice(n);
  return completions;
}

export class NamespacedRadixTrie implements NamespacedTrie {
  private readonly cmdTrie = new RadixTrie();
  private readonly pathTrie = new RadixTrie();
  private readonly flagTrie = new RadixTrie();
  private readonly histTrie = new RadixTrie();

  get cmd(): Trie {
    return this.cmdTrie;
  }

  get path(): Trie {
    return this.pathTrie;
  }

  get flag(): Trie {
    return this.flagTrie;
  }

  get hist(): Trie {
    return this.histTrie;
  }

  /** Exactly one `path.insert` (the incremental VFS update of §5 S2). */
  addPath(dirIno: string, basename: string, kind: 'file' | 'dir' | 'link'): void {
    this.pathTrie.insert(pathKey(dirIno, basename), { text: basename, kind });
  }

  /** Exactly one `path.remove`. */
  removePath(dirIno: string, basename: string): boolean {
    return this.pathTrie.remove(pathKey(dirIno, basename));
  }

  /** Basenames in `dirIno` starting with `prefix`, in code-unit order. */
  completePath(dirIno: string, prefix: string, limit: number): Completion[] {
    return stripKeys(this.pathTrie.complete(pathKey(dirIno, prefix), limit), dirIno.length + 1);
  }

  addFlag(cmd: string, flag: string, detail?: string): void {
    const meta: Completion =
      detail === undefined ? { text: flag, kind: 'flag' } : { text: flag, kind: 'flag', detail };
    this.flagTrie.insert(flagKey(cmd, flag), meta);
  }

  /** Flags of `cmd` starting with `prefix`. */
  completeFlag(cmd: string, prefix: string, limit: number): Completion[] {
    return stripKeys(this.flagTrie.complete(flagKey(cmd, prefix), limit), cmd.length + 1);
  }

  addHistory(uid: number, line: string): void {
    this.histTrie.insert(histKey(uid, line), { text: line, kind: 'hist' });
  }

  /** History lines of `uid` starting with `prefix`. */
  completeHistory(uid: number, prefix: string, limit: number): Completion[] {
    const key = histKey(uid, prefix);
    return stripKeys(this.histTrie.complete(key, limit), key.length - prefix.length);
  }

  /** `history -c`: one removePrefix(`${uid}\u0000`), O(P + m); returns the keys removed. */
  clearHistory(uid: number): number {
    return this.histTrie.removePrefix(histKey(uid, ''));
  }
}
