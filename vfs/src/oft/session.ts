/**
 * A write session (virtual-file-system.md §3.9.3, PVFS-11): a copy-on-write overlay of 1 MiB chunks
 * over the snapshot read at open. Reads through the same description see the session
 * (read-your-writes); holes written past the end are zero-filled; nothing is visible to anyone else
 * until the commit at `close`/`fsync`, which is what makes a failed session leave no partial data.
 *
 * Staging of dirty chunks beyond SESSION_MEM_MAX (8 MiB) is the kernel's job: `dirtyBytes` tells it
 * when to seal chunks; this module keeps the bytes and their order.
 */
import { CHUNK_SIZE } from '../limits.ts';

/** The bytes of snapshot chunk `index` (at most CHUNK_SIZE), or EAGAIN when not cached offline. */
export type ChunkSource = (index: number) => Uint8Array | 'EAGAIN';

export class WriteSession {
  private readonly base: ChunkSource;
  private readonly dirty = new Map<number, Uint8Array>();
  /** Snapshot bytes at or beyond this offset were cut by a truncate: they read as zeros. */
  private baseLimit: number;
  size: number;

  constructor(baseSize: number, base: ChunkSource, trunc = false) {
    this.base = base;
    this.size = trunc ? 0 : baseSize;
    this.baseLimit = this.size;
  }

  get dirtyBytes(): number {
    let n = 0;
    for (const c of this.dirty.values()) n += c.length;
    return n;
  }

  /** The current bytes of chunk `i` as stored (may be shorter than its logical length). */
  private chunk(i: number): Uint8Array | 'EAGAIN' {
    const d = this.dirty.get(i);
    if (d !== undefined) return d;
    const start = i * CHUNK_SIZE;
    if (start >= this.baseLimit) return new Uint8Array(0);
    const b = this.base(i);
    if (b === 'EAGAIN') return b;
    return b.subarray(0, Math.max(0, Math.min(b.length, this.baseLimit - start)));
  }

  read(pos: number, len: number): Uint8Array | 'EAGAIN' {
    const end = Math.min(this.size, pos + len);
    if (end <= pos) return new Uint8Array(0);
    const out = new Uint8Array(end - pos);
    for (let off = pos; off < end;) {
      const i = Math.floor(off / CHUNK_SIZE);
      const inChunk = off - i * CHUNK_SIZE;
      const n = Math.min(CHUNK_SIZE - inChunk, end - off);
      const c = this.chunk(i);
      if (c === 'EAGAIN') return c;
      if (inChunk < c.length)
        out.set(c.subarray(inChunk, Math.min(c.length, inChunk + n)), off - pos);
      off += n;
    }
    return out;
  }

  write(pos: number, data: Uint8Array): void | 'EAGAIN' {
    for (let off = 0; off < data.length;) {
      const at = pos + off;
      const i = Math.floor(at / CHUNK_SIZE);
      const inChunk = at - i * CHUNK_SIZE;
      const n = Math.min(CHUNK_SIZE - inChunk, data.length - off);
      const cur = this.chunk(i);
      if (cur === 'EAGAIN') return cur;
      const next = new Uint8Array(Math.max(cur.length, inChunk + n));
      next.set(cur);
      next.set(data.subarray(off, off + n), inChunk);
      this.dirty.set(i, next);
      off += n;
    }
    this.size = Math.max(this.size, pos + data.length);
  }

  truncate(size: number): void {
    if (size < this.size) {
      this.baseLimit = Math.min(this.baseLimit, size);
      for (const [i, c] of this.dirty) {
        const start = i * CHUNK_SIZE;
        if (start >= size) this.dirty.delete(i);
        else if (start + c.length > size) this.dirty.set(i, c.slice(0, size - start));
      }
    }
    this.size = size;
  }

  /** The whole content, for hashing at commit (phase 1). */
  bytes(): Uint8Array | 'EAGAIN' {
    return this.read(0, this.size);
  }
}
