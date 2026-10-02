/**
 * VFS core types (virtual-file-system.md §4.1) and the requested completion-service shapes
 * (shell-and-terminal.md §4.5): valid and invalid samples per schema.
 */
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  COMPLETE_CALLS,
  COMPLETE_LIMIT_MAX,
  COMPLETE_NAMESPACES,
  CompleteBenchArgs,
  CompleteBenchRet,
  CompleteHistAddArgs,
  CompleteHistClearArgs,
  CompleteHistLoadArgs,
  CompleteItem,
  CompleteQuery,
  CompleteResult,
  CompleteStatsRet,
} from '../src/complete.ts';
import { Reason } from '../src/errno.ts';
import { CALL_NAMES } from '../src/sys/names.ts';
import { FS_IDS, FsId, PermSubject, VFS_DETAILS, VfsDetail } from '../src/vfs.ts';
import { readSpec, section } from './spec-tables.ts';

const ok = (schema: v.GenericSchema, value: unknown): boolean => v.safeParse(schema, value).success;

describe('protocol/vfs (virtual-file-system.md §4.1)', () => {
  it('PVFS-10 FsId is root or tmp', () => {
    expect(FS_IDS).toEqual(['root', 'tmp']);
    expect(ok(FsId, 'tmp')).toBe(true);
    expect(ok(FsId, 'home')).toBe(false);
  });

  it('VFS-04 PermSubject carries type, mode, uid and gid only', () => {
    expect(ok(PermSubject, { type: 'd', mode: 0o755, uid: 0, gid: 0 })).toBe(true);
    expect(ok(PermSubject, { type: 'l', mode: 0o777, uid: 1000, gid: 100 })).toBe(true);
    expect(ok(PermSubject, { type: 'x', mode: 0o755, uid: 0, gid: 0 })).toBe(false);
    expect(ok(PermSubject, { type: 'f', mode: -1, uid: 0, gid: 0 })).toBe(false);
    expect(ok(PermSubject, { type: 'f', mode: 0o644, uid: 0, gid: 0, size: 1 })).toBe(false);
  });

  it('PVFS-16 the VFS detail reasons equal the VfsDetail union of section 4.1 and are well-formed error reasons', () => {
    const block = section(readSpec('04-vfs/virtual-file-system.md'), '### 4.1 Core types');
    const union = /export type VfsDetail =([^;]+);/.exec(block)?.[1] ?? '';
    const fromSpec = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...VFS_DETAILS]).toEqual(fromSpec);
    for (const d of VFS_DETAILS) expect(ok(Reason, d), d).toBe(true);
    expect(ok(VfsDetail, 'stale-base')).toBe(true);
    expect(ok(VfsDetail, 'Stale-Base')).toBe(false);
  });
});

describe('protocol/complete (shell-and-terminal.md §4.5, requested calls)', () => {
  it('SYS-03 the requested complete.* calls are not registered until syscall-abi.md accepts them', () => {
    for (const call of COMPLETE_CALLS)
      expect((CALL_NAMES as readonly string[]).includes(call)).toBe(false);
    expect(COMPLETE_NAMESPACES).toEqual(['cmd', 'path', 'flag', 'hist']);
  });

  it('SYS-03 CompleteQuery accepts each namespace and applies the default limit', () => {
    expect(v.parse(CompleteQuery, { ns: 'cmd', prefix: 'ls' })).toEqual({
      ns: 'cmd',
      prefix: 'ls',
      limit: 100,
    });
    expect(ok(CompleteQuery, { ns: 'path', prefix: 're', dir: '/home/alice', limit: 20 })).toBe(
      true,
    );
    expect(ok(CompleteQuery, { ns: 'path', prefix: '' })).toBe(true); // cwd
    expect(ok(CompleteQuery, { ns: 'flag', prefix: '--', cmd: 'ls' })).toBe(true);
    expect(ok(CompleteQuery, { ns: 'hist', prefix: 'git ' })).toBe(true);
  });

  it('SYS-03 CompleteQuery rejects a bad namespace, limit, missing cmd and misplaced dir', () => {
    expect(ok(CompleteQuery, { ns: 'env', prefix: '' })).toBe(false);
    expect(ok(CompleteQuery, { ns: 'cmd', prefix: '', limit: 0 })).toBe(false);
    expect(ok(CompleteQuery, { ns: 'cmd', prefix: '', limit: COMPLETE_LIMIT_MAX + 1 })).toBe(false);
    expect(ok(CompleteQuery, { ns: 'cmd', prefix: '', limit: 1.5 })).toBe(false);
    expect(ok(CompleteQuery, { ns: 'flag', prefix: '-' })).toBe(false);
    expect(ok(CompleteQuery, { ns: 'cmd', prefix: 'l', dir: '/bin' })).toBe(false);
    expect(ok(CompleteQuery, { ns: 'cmd', prefix: 'l', uid: 0 })).toBe(false); // identity comes from the port
    expect(ok(CompleteQuery, { ns: 'cmd', prefix: 'x'.repeat(4_097) })).toBe(false);
  });

  it('SYS-03 CompleteResult and CompleteItem accept service replies and reject malformed ones', () => {
    const reply = {
      items: [
        { text: 'ls', kind: 'program' },
        { text: '-l', kind: 'flag', desc: 'use a long listing format' },
        { text: 'git status', kind: 'hist', seq: 42 },
      ],
      truncated: false,
      indexed: true,
    };
    expect(ok(CompleteResult, reply)).toBe(true);
    expect(ok(CompleteItem, { text: 'x', kind: 'dir' })).toBe(false);
    expect(ok(CompleteItem, { text: 'x', kind: 'f', desc: 'd'.repeat(81) })).toBe(false);
    expect(ok(CompleteResult, { items: [], truncated: false })).toBe(false);
    expect(
      ok(CompleteResult, {
        items: Array.from({ length: 101 }, () => ({ text: 'a', kind: 'f' })),
        truncated: true,
        indexed: true,
      }),
    ).toBe(false);
  });

  it('SHL-10 history calls carry lines only, never a uid', () => {
    expect(ok(CompleteHistLoadArgs, { lines: ['ls', 'cd /tmp'] })).toBe(true);
    expect(ok(CompleteHistLoadArgs, { lines: Array.from({ length: 1_201 }, () => 'ls') })).toBe(
      false,
    );
    expect(ok(CompleteHistAddArgs, { line: 'echo hi' })).toBe(true);
    expect(ok(CompleteHistAddArgs, { line: 'echo hi', uid: 0 })).toBe(false);
    expect(ok(CompleteHistClearArgs, {})).toBe(true);
    expect(ok(CompleteHistClearArgs, { uid: 1000 })).toBe(false);
  });

  it('SYS-03 complete.stats reports entries and bytes for every namespace', () => {
    const one = { entries: 10_000, bytes: 1_048_576 };
    expect(ok(CompleteStatsRet, { ns: { cmd: one, path: one, flag: one, hist: one } })).toBe(true);
    expect(ok(CompleteStatsRet, { ns: { cmd: one, path: one, flag: one } })).toBe(false);
    expect(
      ok(CompleteStatsRet, {
        ns: { cmd: one, path: { entries: -1, bytes: 0 }, flag: one, hist: one },
      }),
    ).toBe(false);
  });

  it('SYS-03 complete.bench takes a directory or a synthetic size with seeded defaults and returns latencies in ms', () => {
    expect(v.parse(CompleteBenchArgs, {})).toEqual({
      ns: 'path',
      queries: 10_000,
      k: 20,
      seed: 42,
    });
    expect(ok(CompleteBenchArgs, { dir: '/home/alice/big' })).toBe(true);
    expect(ok(CompleteBenchArgs, { synthetic: 100_000, queries: 1_000, k: 20, seed: 7 })).toBe(
      true,
    );
    expect(ok(CompleteBenchArgs, { dir: '/home/alice/big', synthetic: 10_000 })).toBe(false);
    expect(ok(CompleteBenchArgs, { k: 0 })).toBe(false);
    expect(ok(CompleteBenchArgs, { seed: -1 })).toBe(false);
    expect(
      ok(CompleteBenchRet, {
        p50: 0.02,
        p95: 0.04,
        p99: 0.07,
        max: 0.4,
        bytesPerEntry: 96.5,
        entries: 10_000,
      }),
    ).toBe(true);
    expect(
      ok(CompleteBenchRet, {
        p50: -1,
        p95: 0.04,
        p99: 0.07,
        max: 0.4,
        bytesPerEntry: 96.5,
        entries: 10_000,
      }),
    ).toBe(false);
    expect(
      ok(CompleteBenchRet, {
        p50: 0.02,
        p95: Number.NaN,
        p99: 0.07,
        max: 0.4,
        bytesPerEntry: 96.5,
        entries: 10_000,
      }),
    ).toBe(false);
  });
});
