import * as fc from 'fast-check';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  bitsToCaps,
  boundingSet,
  CAP_NAMES,
  capBit,
  capsToBits,
  NEVER_FROM_MANIFEST,
} from '../src/caps.ts';
import type { Cap } from '../src/caps.ts';
import {
  ERRNO,
  ERRNO_NAMES,
  errnoCode,
  errnoFromCode,
  isErrno,
  isRegisteredReason,
  Reason,
  REGISTERED_REASONS,
  SPEC_ERRNOS,
  strerror,
} from '../src/errno.ts';
import {
  SIGNAL_NAMES,
  SIGNALS,
  signalBit,
  signalExitStatus,
  signalFromNumber,
  signalNumber,
} from '../src/signals.ts';
import { CALL_NAMES } from '../src/sys/names.ts';
import { CALLS } from '../src/sys/registry.ts';
import { DEFAULT_SERVICE_MANIFESTS } from '../src/services.ts';
import { codeSpans, readSpec, section, tables } from './spec-tables.ts';

const abi = readSpec('01-architecture/syscall-abi.md');

describe('protocol/errno (syscall-abi.md §4.3)', () => {
  const table = tables(section(abi, '### 4.3 Errno master table')).find(
    (t) => t.header[0] === 'Errno',
  );

  it('ABI-05 the errno table equals the master table of syscall-abi.md section 4.3', () => {
    expect(table).toBeDefined();
    const rows = table?.rows ?? [];
    expect(rows.map((r) => r[0])).toEqual(ERRNO_NAMES);
    for (const r of rows) {
      const name = r[0] as keyof typeof ERRNO;
      expect(ERRNO[name].code, name).toBe(Number(r[1]));
      expect(ERRNO[name].source, name).toBe(r[2] === 'Spec' ? 'spec' : 'plotinium');
      expect(ERRNO[name].message, name).toBe(r[3]);
    }
  });

  it('ABI-05 every errno has one unique numeric code and one unique message', () => {
    const codes = ERRNO_NAMES.map(errnoCode);
    expect(new Set(codes).size).toBe(ERRNO_NAMES.length);
    expect(new Set(ERRNO_NAMES.map(strerror)).size).toBe(ERRNO_NAMES.length);
    for (const name of ERRNO_NAMES) {
      expect(errnoFromCode(errnoCode(name))).toBe(name);
      expect(isErrno(name)).toBe(true);
    }
    expect(errnoFromCode(12)).toBeUndefined();
    expect(isErrno('ENOMEM')).toBe(false);
    expect(isErrno('toString')).toBe(false);
  });

  it('ABI-05 the set is exactly the twelve spec errnos plus the thirteen allowed extras of C3', () => {
    expect([...SPEC_ERRNOS].sort()).toEqual(
      [
        'ENOENT',
        'EEXIST',
        'ENOTDIR',
        'EISDIR',
        'ENOTEMPTY',
        'EINVAL',
        'EACCES',
        'EPERM',
        'ELOOP',
        'EDQUOT',
        'EBUSY',
        'ENAMETOOLONG',
      ].sort(),
    );
    const extras = ERRNO_NAMES.filter((e) => !SPEC_ERRNOS.includes(e));
    expect(extras.sort()).toEqual(
      [
        'ESRCH',
        'ENOSYS',
        'EIO',
        'EAGAIN',
        'ECANCELED',
        'ETIMEDOUT',
        'EBADF',
        'EMFILE',
        'ENOTTY',
        'EPIPE',
        'EXDEV',
        'EAIUNAVAIL',
        'EAIREFUSED',
      ].sort(),
    );
    expect(ERRNO.EAIUNAVAIL.code).toBeGreaterThanOrEqual(1000);
    expect(ERRNO.EAIREFUSED.code).toBeLessThan(1100);
  });

  it('ABI-05 registered detail reasons equal syscall-abi.md section 4.3.1', () => {
    const rows =
      tables(section(abi, '#### 4.3.1 Registered')).find((t) => t.header[0] === 'Errno')?.rows ??
      [];
    expect(rows.length).toBe(Object.keys(REGISTERED_REASONS).length);
    for (const r of rows) {
      const errno = r[0] as keyof typeof REGISTERED_REASONS;
      const reasons = codeSpans(r[1] ?? '').filter((s) => !s.includes('.'));
      expect([...REGISTERED_REASONS[errno]], errno).toEqual(reasons);
      for (const reason of reasons) expect(isRegisteredReason(errno, reason)).toBe(true);
    }
    expect(isRegisteredReason('EIO', 'lease')).toBe(false);
    expect(isRegisteredReason('ENOTTY', 'anything')).toBe(false);
  });

  it('ABI-05 every registered reason matches the wire reason pattern', () => {
    for (const list of Object.values(REGISTERED_REASONS)) {
      for (const reason of list) expect(v.safeParse(Reason, reason).success, reason).toBe(true);
    }
    for (const bad of ['', 'Upper', '1digit', 'a'.repeat(41), 'has space'])
      expect(v.safeParse(Reason, bad).success, bad).toBe(false);
  });

  it('INV-ABI-8 every call-specific errno in the registry is in the master table', () => {
    for (const name of CALL_NAMES)
      for (const e of CALLS[name].errnos) expect(ERRNO_NAMES, `${name} ${e}`).toContain(e);
  });
});

describe('protocol/signals (syscall-abi.md §4.8)', () => {
  it('ABI-09 the signal table equals syscall-abi.md section 4.8', () => {
    const rows =
      tables(section(abi, '### 4.8 Signals')).find((t) => t.header[0] === 'Signal')?.rows ?? [];
    expect(rows.map((r) => r[0])).toEqual(SIGNAL_NAMES);
    for (const r of rows) {
      const s = SIGNALS[r[0] as keyof typeof SIGNALS];
      expect(s.number, r[0]).toBe(Number(r[1]));
      expect(s.defaultAction, r[0]).toBe(r[2]);
      expect(s.catchable, r[0]).toBe(r[3] === 'yes');
    }
  });

  it('ABI-09 SIGKILL exits with 137, and only SIGKILL and SIGSTOP cannot be caught', () => {
    expect(signalExitStatus('SIGKILL')).toBe(137);
    expect(signalExitStatus('SIGTERM')).toBe(143);
    expect(SIGNAL_NAMES.filter((n) => !SIGNALS[n].catchable)).toEqual(['SIGKILL', 'SIGSTOP']);
    for (const name of SIGNAL_NAMES) {
      expect(signalFromNumber(signalNumber(name))).toBe(name);
      expect(signalBit(name)).toBe(2 ** signalNumber(name));
    }
    expect(signalFromNumber(4)).toBeUndefined();
  });
});

describe('protocol/caps (syscall-abi.md §3.5 and §4.5)', () => {
  const capTable = tables(section(abi, '### 4.5 Capability table')).find(
    (t) => t.header[0] === 'Capability',
  );

  it('ABI-06 the capability list equals the table of syscall-abi.md section 4.5, in order', () => {
    expect(capTable?.rows.map((r) => codeSpans(r[0] ?? '')[0])).toEqual([...CAP_NAMES]);
    expect(CAP_NAMES.length).toBeLessThanOrEqual(64); // fits the PCB's Uint32Array(2)
  });

  it('ABI-06 bounding sets equal the table of syscall-abi.md section 3.5', () => {
    const rows =
      tables(section(abi, '### 3.5 Capability model')).find((t) => t.header[0] === 'Class')?.rows ??
      [];
    const capsIn = (cell: string): string[] =>
      codeSpans(cell)
        .flatMap((s) => s.split(/\s+/))
        .filter((c) => (CAP_NAMES as readonly string[]).includes(c));
    const row = (prefix: string): string =>
      rows.find((r) => (r[0] ?? '').includes(prefix))?.[1] ?? '';
    const user = capsIn(row('uid ≥ 1000'));
    expect([...boundingSet(1001, 'user', false)].sort()).toEqual(user.sort());
    expect([...boundingSet(65_534, 'user', true)].sort()).toEqual(user.sort());
    const rootExtra = capsIn(row('uid 0'));
    expect(rootExtra).toEqual(['kill.other', 'sys.admin', 'debug.fault']);
    expect([...boundingSet(0, 'user', false)].sort()).toEqual(
      [...user, 'kill.other', 'sys.admin'].sort(),
    );
    expect([...boundingSet(0, 'user', true)].sort()).toEqual([...user, ...rootExtra].sort());
    const agent = capsIn(row('`agent`')).filter((c) => c !== 'batch.grant');
    expect([...boundingSet(0, 'agent', true)].sort()).toEqual(agent.sort());
    expect([...boundingSet(1001, 'system', false)].sort()).toEqual(capsIn(row('`system`')).sort());
  });

  it('ABI-06 the agent bounding set never holds fs.write, proc, window, lock or kill.other, even at uid 0', () => {
    for (const uid of [0, 1001]) {
      for (const cap of ['fs.write', 'proc', 'window', 'lock', 'kill.other'] as Cap[]) {
        expect(boundingSet(uid, 'agent', true)).not.toContain(cap);
      }
    }
  });

  it('ABI-06 no bounding set contains net.sync or batch.grant', () => {
    for (const cls of ['user', 'agent', 'system'] as const) {
      for (const uid of [0, 1001]) {
        for (const cap of NEVER_FROM_MANIFEST)
          expect(boundingSet(uid, cls, true)).not.toContain(cap);
      }
    }
  });

  it('ABI-06 every capability a call requires is grantable by some bounding set, except the kernel-issued batch.grant', () => {
    const grantable = new Set<Cap>([
      ...boundingSet(0, 'user', true),
      ...boundingSet(0, 'agent', true),
      ...boundingSet(0, 'system', true),
    ]);
    for (const name of CALL_NAMES) {
      const s = CALLS[name] as {
        caps: readonly Cap[];
        capsDynamic?: readonly Cap[];
        capsCrossUid?: readonly Cap[];
      };
      for (const cap of [...s.caps, ...(s.capsDynamic ?? []), ...(s.capsCrossUid ?? [])])
        expect(grantable.has(cap), `${name} ${cap}`).toBe(true);
    }
  });

  it('ABI-06 every service manifest capability is inside the system bounding set', () => {
    const system = boundingSet(0, 'system', false);
    for (const m of DEFAULT_SERVICE_MANIFESTS)
      for (const cap of m.caps) expect(system, `${m.name} ${cap}`).toContain(cap);
  });

  it('ABI-06 capsToBits and bitsToCaps round-trip every capability subset', () => {
    fc.assert(
      fc.property(fc.subarray([...CAP_NAMES]), (subset) => {
        const bits = capsToBits(subset);
        expect(bits).toHaveLength(2);
        expect(bitsToCaps(bits)).toEqual(CAP_NAMES.filter((c) => subset.includes(c)));
      }),
      { numRuns: 500 },
    );
    expect(capBit('fs.read')).toBe(0);
    expect(capBit('net.sync')).toBe(CAP_NAMES.length - 1);
  });
});
