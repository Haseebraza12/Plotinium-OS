import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERRNOS } from '../errno.ts';
import { LockSetChanged, VfsError } from '../vfs/types.ts';
import { CONSTRAINT_RULES, isDeterministic, sqlstate, toErrno } from './errors.ts';

const NOT_CANCELLED = { cancelled: false };
const pgError = (code: string, constraint?: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('pg error'), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
    ...extra,
  });

describe('DB-04 SQLSTATE to errno mapping (database.md §4.9, §6.1)', () => {
  const cases: [string, string | undefined, Record<string, unknown>, string, string | undefined][] =
    [
      ['23505', 'dentries_pkey', {}, 'EEXIST', undefined],
      ['23505', 'users_username_key', {}, 'EEXIST', undefined],
      ['23505', 'dentries_dir_one_parent', {}, 'EPERM', 'directory'],
      ['23505', 'locks_one_writer', {}, 'EBUSY', 'lease'],
      ['23505', 'op_log_session_cseq_key', {}, 'EINVAL', undefined],
      ['23505', 'feed_pkey', {}, 'EIO', 'server'],
      ['23505', 'some_future_key', {}, 'EEXIST', undefined],
      [
        '23503',
        'dentries_parent_fk',
        {
          message:
            'insert or update on table "dentries" violates foreign key constraint "dentries_parent_fk"',
        },
        'ENOENT',
        undefined,
      ],
      [
        '23503',
        'dentries_parent_fk',
        {
          message:
            'update or delete on table "inodes" violates foreign key constraint "dentries_parent_fk" on table "dentries"',
        },
        'ENOTEMPTY',
        undefined,
      ],
      [
        '23503',
        'dentries_child_fk',
        {
          message:
            'insert or update on table "dentries" violates foreign key constraint "dentries_child_fk"',
        },
        'ENOENT',
        undefined,
      ],
      [
        '23503',
        'dentries_child_fk',
        {
          message:
            'update or delete on table "inodes" violates foreign key constraint "dentries_child_fk" on table "dentries"',
        },
        'EIO',
        undefined,
      ],
      ['23503', 'inodes_uid_fk', {}, 'EINVAL', undefined],
      ['23503', 'swap_pages_session_fk', {}, 'EACCES', undefined],
      ['23503', 'inodes_blob_fk', {}, 'EIO', 'server'],
      ['23503', 'locks_ino_fk', {}, 'ENOENT', undefined],
      ['23514', 'users_quota_bytes_ok', {}, 'EDQUOT', undefined],
      ['23514', 'users_quota_inodes_ok', {}, 'EDQUOT', undefined],
      ['23514', 'dentries_name_len', {}, 'ENAMETOOLONG', undefined],
      ['23514', 'inodes_symlink_target_len', {}, 'ENAMETOOLONG', undefined],
      ['23514', 'blobs_refcount_nonneg', {}, 'EIO', 'server'],
      ['23514', 'inodes_mode_range', {}, 'EINVAL', undefined],
      ['23514', 'dentries_name_nfc', {}, 'EINVAL', undefined],
      ['23514', 'a_future_check', {}, 'EINVAL', undefined],
      ['23P01', 'locks_sx_excl', {}, 'EBUSY', 'lease'],
      ['PTC01', 'dentries_acyclic', {}, 'EINVAL', undefined],
      ['P0001', undefined, { hint: 'plotinium.fault' }, 'EIO', 'injected'],
      ['P0001', undefined, {}, 'EIO', 'server'],
      ['55P03', undefined, {}, 'EBUSY', 'lock-timeout'],
      ['40001', undefined, {}, 'EAGAIN', 'retry-exhausted'],
      ['40P01', undefined, {}, 'EAGAIN', 'retry-exhausted'],
      ['23502', undefined, {}, 'EINVAL', undefined],
      ['22P02', undefined, {}, 'EINVAL', undefined],
      ['22021', undefined, {}, 'EINVAL', undefined],
      ['08006', undefined, {}, 'EIO', 'server'],
      ['57P01', undefined, {}, 'EIO', 'server'],
      ['42501', undefined, {}, 'EIO', 'server'],
      ['XX000', undefined, {}, 'EIO', 'server'],
    ];

  it.each(cases)(
    'DB-04 SQLSTATE %s on %s maps to the documented errno',
    (code, constraint, extra, errno, reason) => {
      const err = toErrno(pgError(code, constraint, extra), NOT_CANCELLED);
      expect(err).toBeInstanceOf(VfsError);
      expect(err.errno).toBe(errno);
      expect(err.reason).toBe(reason);
    },
  );

  it('AGT-09 57014 maps to ECANCELED killed only when the cancel flag is set, otherwise ETIMEDOUT', () => {
    expect(toErrno(pgError('57014'), { cancelled: true }).errno).toBe('ECANCELED');
    expect(toErrno(pgError('57014'), { cancelled: true }).reason).toBe('killed');
    expect(toErrno(pgError('57014'), NOT_CANCELLED).errno).toBe('ETIMEDOUT');
  });

  it('DB-03 LockSetChanged after the last attempt and an aborted op map to EAGAIN and ECANCELED', () => {
    expect(toErrno(new LockSetChanged([1, 2]), NOT_CANCELLED).errno).toBe('EAGAIN');
    const abort = new DOMException('The operation was aborted', 'AbortError');
    expect(toErrno(abort, NOT_CANCELLED).errno).toBe('ECANCELED');
    const own = new VfsError('ENOTDIR');
    expect(toErrno(own, NOT_CANCELLED)).toBe(own);
    expect(toErrno('not an error', NOT_CANCELLED).errno).toBe('EIO');
  });

  it('DB-04 every rule maps to a C3 errno', () => {
    for (const r of Object.values(CONSTRAINT_RULES)) {
      expect(ERRNOS).toContain(r.errno);
      if (r.referencedErrno !== undefined) expect(ERRNOS).toContain(r.referencedErrno);
    }
  });

  it('DB-04 every constraint name in db/schema.sql is covered by the errno mapper or its documented default', () => {
    const schema = readFileSync(
      fileURLToPath(new URL('../../../db/schema.sql', import.meta.url)),
      'utf8',
    );
    const names = new Set<string>();
    for (const m of schema.matchAll(/CONSTRAINT ([a-z_0-9]+)/g)) names.add(m[1] ?? '');
    for (const m of schema.matchAll(/CREATE UNIQUE INDEX ([a-z_0-9]+)/g)) names.add(m[1] ?? '');
    names.add('dentries_acyclic'); // raised by the trigger with SQLSTATE PTC01
    expect(names.size).toBeGreaterThan(150);
    const missing = [...names].filter((n) => !(n in CONSTRAINT_RULES));
    expect(missing).toEqual([]);
  });

  it('DB-04 sqlstate() reads only well-formed codes', () => {
    expect(sqlstate(pgError('40P01'))).toBe('40P01');
    expect(sqlstate({ code: 'ECONNREFUSED' })).toBeUndefined();
    expect(sqlstate(null)).toBeUndefined();
  });
});

describe('OFF-02 persisted outcomes (offline-and-sync.md §3.10, database.md §3.9.3)', () => {
  const det = (errno: ConstructorParameters<typeof VfsError>[0], reason?: string) =>
    isDeterministic(new VfsError(errno, reason === undefined ? {} : { reason }));

  it('OFF-02 final rejections are recorded so a resend reproduces them', () => {
    for (const e of [
      'ENOENT',
      'EEXIST',
      'ENOTDIR',
      'EISDIR',
      'ENOTEMPTY',
      'EINVAL',
      'EPERM',
      'ELOOP',
      'EDQUOT',
      'ENAMETOOLONG',
      'EXDEV',
      'EACCES',
    ] as const) {
      expect(det(e)).toBe(true);
    }
    expect(det('EIO', 'injected')).toBe(true);
    expect(det('ECANCELED', 'killed')).toBe(true);
    expect(det('EBUSY', 'lease')).toBe(true);
    expect(det('EBUSY', 'subtree-busy')).toBe(true);
    expect(det('EAGAIN', 'stale-version')).toBe(true);
    expect(det('EAGAIN', 'stale-plan')).toBe(true);
  });

  it('OFF-02 transient outcomes are not recorded, so a resend executes again', () => {
    expect(det('EIO', 'server')).toBe(false);
    expect(det('EIO')).toBe(false);
    expect(det('EBUSY', 'lock-timeout')).toBe(false);
    expect(det('EAGAIN', 'retry-exhausted')).toBe(false);
    expect(det('EAGAIN', 'blob-missing')).toBe(false);
    expect(det('EACCES', 'principal')).toBe(false);
    expect(det('ETIMEDOUT')).toBe(false);
    expect(det('ECANCELED', 'signal')).toBe(false);
  });
});
