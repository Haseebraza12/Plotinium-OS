/**
 * `cat [-n] [-v] [FILE | -]...` (shell-and-terminal.md §3.14.7): 64 KiB reads, content passed
 * through byte for byte; `-v` shows control bytes as `^X` and bytes from 0x80 as `M-x`.
 */
import { defineCommand, parseFor } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import type { Io } from '../lib/io.ts';
import type { SysGen } from '../lib/sys.ts';

export interface CatOpts {
  readonly number: boolean;
  readonly visible: boolean;
  readonly files: readonly string[];
}

const CHUNK = 65_536;
const encoder = new TextEncoder();

/** The `-v` spelling of one byte (newline and tab are kept). */
export function visibleByte(b: number): string {
  if (b >= 0x80) return `M-${visibleByte(b - 0x80)}`;
  if (b === 0x7f) return '^?';
  if (b < 0x20 && b !== 0x0a && b !== 0x09) return `^${String.fromCharCode(b + 0x40)}`;
  return String.fromCharCode(b);
}

/** Line numbering state that carries across reads and files. */
export interface Numbering {
  line: number;
  atStart: boolean;
}

/** Applies -v and -n to one chunk. */
export function transform(chunk: Uint8Array, opts: CatOpts, num: Numbering): Uint8Array {
  if (!opts.number && !opts.visible) return chunk;
  const parts: Uint8Array[] = [];
  let start = 0;
  const emit = (end: number): void => {
    const slice = chunk.subarray(start, end);
    parts.push(opts.visible ? encoder.encode(Array.from(slice, visibleByte).join('')) : slice);
  };
  for (let i = 0; i < chunk.length; i++) {
    if (opts.number && num.atStart) {
      emit(i);
      start = i;
      num.line += 1;
      parts.push(encoder.encode(`${String(num.line).padStart(6)}\t`));
      num.atStart = false;
    }
    if (chunk[i] === 0x0a) num.atStart = true;
  }
  emit(chunk.length);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function* copyFd(io: Io, fd: number, opts: CatOpts, num: Numbering): SysGen<void> {
  for (;;) {
    const buf = yield* io.sys.call('read', { fd, len: CHUNK });
    if (buf.byteLength === 0) return;
    yield* io.outBytes(transform(new Uint8Array(buf), opts, num));
  }
}

export default defineCommand<CatOpts>({
  name: 'cat',
  parse(args) {
    const p = parseFor('cat', args);
    return {
      number: p.has('n'),
      visible: p.has('v'),
      files: p.operands.length === 0 ? ['-'] : p.operands,
    };
  },
  *run(io, opts) {
    const num: Numbering = { line: 0, atStart: true };
    let status = 0;
    for (const file of opts.files) {
      if (file === '-') {
        yield* copyFd(io, 0, opts, num);
        continue;
      }
      let fd: number | null = null;
      try {
        fd = (yield* io.sys.call('open', { path: file, flags: 'r' })).fd;
        yield* copyFd(io, fd, opts, num);
      } catch (e) {
        yield* io.error(`${file}: ${describe(e)}`);
        status = 1;
      } finally {
        if (fd !== null) yield* io.sys.call('close', { fd });
      }
    }
    return status;
  },
});
