/**
 * Where memhog keeps its pages (memory-and-paging.md §3.4, §3.13, §4.2).
 *
 * - `ctx.mem` (the design): the executor's page API. `alloc({kind: 'chunk', size, label})`
 *   reserves budget first (BLOCKED on `mem` until reclaim frees space, MEM-06) and returns page ids;
 *   `get(id, 'r' | 'rw')` returns the resident body or faults it in (`mem.fault`), and `'rw'` marks
 *   the page dirty. These pages are paged out and in individually, so a read after a fault proves
 *   the round trip byte-identical (MEM-03).
 * - `mem.alloc` (the fallback while the executor has no `ctx.mem`): one `mem.alloc` segment per
 *   page reserves and accounts the bytes exactly like a page (every byte is charged before it
 *   exists), and the body lives in the program's resident generator frame. The body is not state:
 *   after a page-out, a migration or a restore the program re-creates it from its seed and
 *   generation, and the checksum recorded in `st` proves the re-creation exact.
 *
 * TODO(R1): take `CtxMem` from @plotinium/kernel/sys when `ProgramContext.mem` lands (it is a TODO
 * there today); `hasCtxMem` then becomes a plain property read.
 */
import type { ProgramContext, SysGen } from '@plotinium/kernel/sys';

/** The fixed chunk size of large buffers (PAGE_CHUNK, memory-and-paging.md §3.1). */
export const PAGE_CHUNK = 262_144;

export type PageMode = 'r' | 'rw';

/** The page API of memory-and-paging.md §4.2 as the executor runtime is expected to provide it. */
export interface CtxMem {
  alloc(req: {
    kind: 'chunk' | 'logical';
    size: number;
    label?: string;
  }): SysGen<{ pageIds: readonly number[] }>;
  get(pageId: number, mode: PageMode): SysGen<Uint8Array | ArrayBuffer>;
  free(pageIds: readonly number[]): SysGen<unknown>;
}

export interface PageBody {
  readonly body: Uint8Array;
  /** True when the body had to be re-created empty: its bytes must be filled again. */
  readonly fresh: boolean;
}

export interface PageBackend {
  readonly name: 'ctx.mem' | 'mem.alloc';
  /** One page of `len` ≤ PAGE_CHUNK bytes; may block while the budget is full. Returns its handle. */
  alloc(len: number, label: string): SysGen<number>;
  get(handle: number, len: number, mode: PageMode): SysGen<PageBody>;
  free(handle: number): SysGen<void>;
}

function isFn(o: object, key: string): boolean {
  return typeof (o as Record<string, unknown>)[key] === 'function';
}

/** The executor's page API when the runtime provides one (`ctx.mem`), else null. */
export function ctxMemOf(ctx: ProgramContext): CtxMem | null {
  const mem: unknown = (ctx as ProgramContext & { readonly mem?: unknown }).mem;
  if (typeof mem !== 'object' || mem === null) return null;
  if (!isFn(mem, 'alloc') || !isFn(mem, 'get') || !isFn(mem, 'free')) return null;
  return mem as CtxMem;
}

export function ctxMemBackend(mem: CtxMem): PageBackend {
  return {
    name: 'ctx.mem',
    *alloc(len: number, label: string): SysGen<number> {
      const { pageIds } = yield* mem.alloc({ kind: 'chunk', size: len, label });
      const id = pageIds[0];
      if (id === undefined) throw new RangeError('ctx.mem.alloc returned no page');
      return id;
    },
    *get(handle: number, _len: number, mode: PageMode): SysGen<PageBody> {
      const raw = yield* mem.get(handle, mode);
      return { body: raw instanceof Uint8Array ? raw : new Uint8Array(raw), fresh: false };
    },
    *free(handle: number): SysGen<void> {
      yield* mem.free([handle]);
    },
  };
}

/**
 * The `mem.alloc` fallback. The map lives as long as this generator frame: it is lost (on
 * purpose) at a page-out or a migration, and `get` then hands out an empty body marked `fresh`.
 */
export function segmentBackend(ctx: ProgramContext): PageBackend {
  const bodies = new Map<number, Uint8Array>();
  return {
    name: 'mem.alloc',
    *alloc(len: number, label: string): SysGen<number> {
      const { segId } = yield* ctx.sys.call('mem.alloc', {
        bytes: len,
        key: label,
        kind: 'buffer',
      });
      bodies.set(segId, new Uint8Array(len));
      return segId;
    },
    *get(handle: number, len: number, _mode: PageMode): SysGen<PageBody> {
      const known = bodies.get(handle);
      if (known !== undefined && known.byteLength === len) return { body: known, fresh: false };
      // A lost body: a yield point before the caller spends a step re-creating it.
      yield ctx.tick;
      const body = new Uint8Array(len);
      bodies.set(handle, body);
      return { body, fresh: true };
    },
    *free(handle: number): SysGen<void> {
      bodies.delete(handle);
      yield* ctx.sys.call('mem.free', { segId: handle });
    },
  };
}

/** `ctx.mem` when present, else the `mem.alloc` fallback. */
export function backendFor(ctx: ProgramContext): PageBackend {
  const mem = ctxMemOf(ctx);
  return mem === null ? segmentBackend(ctx) : ctxMemBackend(mem);
}
