import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  EVENT_PAYLOADS,
  KEvent,
  TOPIC_GROUPS,
  TopicPattern,
  TOPICS,
  topicMatches,
} from '../src/events.ts';
import type { Topic } from '../src/events.ts';
import {
  ErrDetail,
  ExecToKernel,
  fail,
  KernelToExec,
  KernelToView,
  ok,
  SysErr,
  SysOk,
  SysReqFrame,
  SysRes,
  ViewToKernel,
} from '../src/sys/envelope.ts';
import { codeSpans, readSpec, section, tables } from './spec-tables.ts';
import { INO, INO2, NETSTATUS, NOW, SHA } from './samples.ts';

const abi = readSpec('01-architecture/syscall-abi.md');
const valid = (schema: v.GenericSchema, input: unknown): boolean =>
  v.safeParse(schema, input).success;

const PAYLOAD_SAMPLES: Record<Topic, unknown> = {
  'vfs.create': {
    ino: INO,
    parent: INO2,
    name: 'a.md',
    type: 'f',
    uid: 1001,
    version: 1,
    origin: 'local',
    opId: INO,
  },
  'vfs.write': { ino: INO, parent: INO2, version: 2, size: 10, origin: 'remote' },
  'vfs.rename': {
    ino: INO,
    fromParent: INO2,
    fromName: 'a',
    toParent: INO2,
    toName: 'b',
    origin: 'local',
  },
  'vfs.unlink': {
    inos: [INO],
    truncated: false,
    parent: INO2,
    name: 'a',
    origin: 'local',
    opId: INO,
  },
  'vfs.chmod': { root: INO, inos: [INO], mode: 0o644, recursive: false, origin: 'local' },
  'vfs.chown': {
    root: INO,
    inos: [INO],
    uid: 1001,
    gid: 100,
    recursive: true,
    truncated: true,
    origin: 'remote',
  },
  'vfs.conflict': {
    ino: INO,
    keptAs: { ino: INO2, path: '/a (conflict from bob, 2026-09-24).md' },
    by: 'bob',
  },
  'vfs.rejected': { opId: INO, errno: 'EACCES', path: '/home/bob/x', restored: true },
  'proc.spawn': { pid: 12, ppid: 1, pgid: 12, uid: 1001, argv0: 'sh', priority: 20, class: 'user' },
  'proc.state': { pid: 12, from: 'READY', to: 'RUNNING', reason: 'dispatch' },
  'proc.exit': {
    pid: 12,
    status: { kind: 'signaled', signal: 'SIGKILL', code: 137 },
    reason: 'watchdog',
  },
  'wm.create': { wid: 7, pid: 12, app: 'editor' },
  'wm.focus': { wid: 7, pid: 12, app: 'editor' },
  'wm.minimise': { wid: 7, pid: 12, app: 'editor' },
  'wm.restore': { wid: 7, pid: 12, app: 'editor' },
  'wm.close': { wid: 7, pid: 12, app: 'editor' },
  'mem.fault': { pid: 12, pageId: 3, tier: 'remote', bytes: 65_536, ms: 12.5 },
  'mem.evict': { pid: 12, pageId: 3, bytes: 65_536, to: 'local' },
  'mem.pressure': { accounted: 900, budget: 1000, level: 'reclaim' },
  'net.state': NETSTATUS,
  'lock.granted': { ino: INO, mode: 'X', holder: 'alice@lab-pc-3', fence: 4, expiresAt: NOW },
  'lock.queued': { ino: INO, mode: 'S' },
  'lock.lost': { ino: INO, mode: 'X' },
  'lock.released': { ino: INO, mode: 'X' },
  'svc.started': { name: 'sync', critical: false },
  'svc.degraded': { name: 'sync', critical: false, error: 'offline', retryInMs: 500 },
  'svc.failed': { name: 'vfs', critical: true, error: 'storage' },
  'svc.stopped': { name: 'sync', critical: false },
  'update.available': { version: '0.3.0', build: 'a1f93c2' },
  'ai.index.progress': { pending: 3, indexedFiles: 10, chunks: 40, state: 'indexing' },
  'ai.model': { state: 'loading', loadedBytes: 1, totalBytes: 100 },
  'ai.predict': { uid: 1001, predictions: [{ app: 'terminal', confidence: 0.6 }] },
  notify: { nid: 1, title: 'Saved', body: 'x', level: 'warn', pid: 12 },
  'bus.overflow': { topic: 'vfs.write', dropped: 12 },
};

describe('protocol/events (syscall-abi.md §4.6)', () => {
  it('ABI-07 the event topics equal the table of syscall-abi.md section 4.6', () => {
    const rows =
      tables(section(abi, '### 4.6 Event topics and payloads')).find((t) => t.header[0] === 'Topic')
        ?.rows ?? [];
    expect(rows.flatMap((r) => codeSpans(r[0] ?? ''))).toEqual(TOPICS);
  });

  it('ABI-07 every topic payload accepts its sample and KEvent checks the payload against the topic', () => {
    for (const topic of TOPICS) {
      expect(valid(EVENT_PAYLOADS[topic], PAYLOAD_SAMPLES[topic]), topic).toBe(true);
      expect(valid(KEvent, { topic, seq: 1, t: NOW, data: PAYLOAD_SAMPLES[topic] }), topic).toBe(
        true,
      );
    }
    expect(
      valid(KEvent, { topic: 'notify', seq: 1, t: NOW, data: PAYLOAD_SAMPLES['vfs.write'] }),
    ).toBe(false);
    expect(valid(KEvent, { topic: 'vfs.explode', seq: 1, t: NOW, data: {} })).toBe(false);
    expect(
      valid(EVENT_PAYLOADS['vfs.unlink'], {
        ...(PAYLOAD_SAMPLES['vfs.unlink'] as object),
        inos: Array(1001).fill(INO),
      }),
    ).toBe(false);
  });

  it('ABI-07 topicMatches selects exact topics and whole groups only', () => {
    expect(topicMatches('vfs.*', 'vfs.write')).toBe(true);
    expect(topicMatches('vfs.*', 'proc.exit')).toBe(false);
    expect(topicMatches('notify.*', 'notify')).toBe(true);
    expect(topicMatches('ai.*', 'ai.index.progress')).toBe(true);
    expect(topicMatches('vfs.write', 'vfs.write')).toBe(true);
    expect(topicMatches('vfs.writ', 'vfs.write')).toBe(false);
    expect(topicMatches('vf.*', 'vfs.write')).toBe(false);
  });

  it('ABI-07 a topic pattern is an exact topic or a known group wildcard', () => {
    for (const group of TOPIC_GROUPS) expect(valid(TopicPattern, `${group}.*`), group).toBe(true);
    for (const topic of TOPICS) expect(valid(TopicPattern, topic), topic).toBe(true);
    for (const bad of ['*', 'vfs', 'nope.*', 'vfs.**', 'vfs.write.*'])
      expect(valid(TopicPattern, bad), bad).toBe(false);
  });
});

describe('protocol/envelope (syscall-abi.md §4.1)', () => {
  it('ABI-01 a request frame needs a uint32 id, a string call and an args field', () => {
    expect(valid(SysReqFrame, { id: 0, call: 'stat', args: { path: '/' } })).toBe(true);
    expect(valid(SysReqFrame, { id: 0xffff_ffff, call: 'ai.agent.plan', args: null })).toBe(true);
    expect(valid(SysReqFrame, { id: 1, call: 'stat' })).toBe(false);
    expect(valid(SysReqFrame, { id: -1, call: 'stat', args: {} })).toBe(false);
    expect(valid(SysReqFrame, { id: 2 ** 32, call: 'stat', args: {} })).toBe(false);
    expect(valid(SysReqFrame, { id: 1.5, call: 'stat', args: {} })).toBe(false);
    expect(valid(SysReqFrame, { id: 1, call: 42, args: {} })).toBe(false);
    expect(valid(SysReqFrame, { id: 1, call: 'stat', args: {}, uid: 0 })).toBe(false);
  });

  it('ABI-01 an unknown but well-formed call name decodes, so the dispatcher can answer ENOSYS', () => {
    expect(valid(SysReqFrame, { id: 1, call: 'no.such.call', args: {} })).toBe(true);
    expect(valid(SysReqFrame, { id: 1, call: 'Bad Name', args: {} })).toBe(false);
    expect(valid(SysReqFrame, { id: 1, call: `a${'b'.repeat(64)}`, args: {} })).toBe(false);
  });

  it('ABI-01 every reply carries the request id and exactly one of value or errno', () => {
    expect(valid(SysRes, ok(7, { size: 1 }))).toBe(true);
    expect(valid(SysRes, fail(7, 'EACCES', 'permission denied', { path: '/home/bob' }))).toBe(true);
    expect(valid(SysRes, { id: 7, ok: true, value: 1, errno: 'EIO' })).toBe(false);
    expect(valid(SysRes, { id: 7, ok: false, value: 1 })).toBe(false);
    expect(valid(SysRes, { id: 7, ok: false })).toBe(false);
    expect(valid(SysRes, { ok: true, value: 1 })).toBe(false);
    expect(valid(SysOk, { id: 7, ok: true })).toBe(false);
  });

  it('INV-ABI-8 an error reply with an errno outside the master table is rejected', () => {
    expect(valid(SysErr, { id: 1, ok: false, errno: 'ENOMEM' })).toBe(false);
    expect(valid(SysErr, { id: 1, ok: false, errno: 'EINTR' })).toBe(false);
    expect(
      valid(SysErr, { id: 1, ok: false, errno: 'ECANCELED', detail: { reason: 'signal' } }),
    ).toBe(true);
  });

  it('ABI-01 fail omits an empty detail and keeps the fields of ErrDetail', () => {
    expect(fail(3, 'EBUSY')).toEqual({ id: 3, ok: false, errno: 'EBUSY' });
    expect(fail(3, 'EBUSY', undefined, {})).toEqual({ id: 3, ok: false, errno: 'EBUSY' });
    const detail = {
      reason: 'lease',
      holder: 'alice@lab-pc-3',
      retryAfterMs: 500,
      cycle: ['lib:a', 'lib:b', 'lib:a'],
      step: 3,
      check: 'scope',
    };
    expect(valid(ErrDetail, detail)).toBe(true);
    expect(valid(ErrDetail, { ...detail, value: 'secret' })).toBe(false);
  });

  it('ABI-10 hello frames carry the ABI version and a SHA-256 digest', () => {
    expect(valid(ExecToKernel, { t: 'hello', abi: 1, digest: SHA })).toBe(true);
    expect(valid(ViewToKernel, { t: 'hello', abi: 1, digest: SHA })).toBe(true);
    expect(valid(ExecToKernel, { t: 'hello', abi: 0, digest: SHA })).toBe(false);
    expect(valid(ExecToKernel, { t: 'hello', abi: 1, digest: 'md5' })).toBe(false);
  });

  it('ABI-02 an executor syscall frame is also the slice-end report and may carry watchdog telemetry', () => {
    const req = {
      id: 41,
      call: 'unlink',
      args: { path: '/home/alice/old-drafts', recursive: true },
    };
    expect(valid(ExecToKernel, { t: 'syscall', pid: 412, sliceSeq: 9031, cpuMs: 0.4, req })).toBe(
      true,
    );
    expect(
      valid(ExecToKernel, {
        t: 'syscall',
        pid: 412,
        sliceSeq: 9031,
        cpuMs: 0.4,
        req,
        steps: 10,
        maxStepUs: 80,
        touched: new Uint32Array(2),
      }),
    ).toBe(true);
    expect(valid(ExecToKernel, { t: 'yield', pid: 412, sliceSeq: 9031, cpuMs: 10 })).toBe(true);
    expect(valid(ExecToKernel, { t: 'exit', pid: 412, sliceSeq: 9031, cpuMs: 1, code: 0 })).toBe(
      true,
    );
    expect(
      valid(ExecToKernel, { t: 'syscall', pid: 412, sliceSeq: 9031, cpuMs: 0.4, req, uid: 0 }),
    ).toBe(false);
  });

  it('ABI-01 kernel-to-executor and view frames follow the walk-through of section 4.1', () => {
    const res = {
      id: 41,
      ok: true,
      value: { removed: 1000, bytes: 7_340_032, opId: INO, sync: 'applied' },
    };
    expect(
      valid(KernelToExec, {
        t: 'dispatch',
        pid: 412,
        sliceSeq: 9032,
        quantumMs: 10,
        pendingSigs: 0,
        res,
      }),
    ).toBe(true);
    expect(
      valid(KernelToExec, {
        t: 'dispatch',
        pid: 412,
        sliceSeq: 9032,
        quantumMs: 10,
        pendingSigs: 4,
      }),
    ).toBe(true);
    expect(
      valid(KernelToExec, { t: 'resume', pid: 412, sliceSeq: 9032, quantumMs: 6, pendingSigs: 0 }),
    ).toBe(false);
    expect(
      valid(KernelToExec, {
        t: 'resume',
        pid: 412,
        sliceSeq: 9032,
        quantumMs: 6,
        pendingSigs: 0,
        res,
      }),
    ).toBe(true);
    expect(
      valid(ViewToKernel, { t: 'req', req: { id: 1, call: 'stat', args: { path: '/' } } }),
    ).toBe(true);
    expect(valid(KernelToView, { t: 'res', res })).toBe(true);
    expect(
      valid(KernelToView, {
        t: 'events',
        batch: [{ topic: 'notify', seq: 1, t: NOW, data: PAYLOAD_SAMPLES.notify }],
      }),
    ).toBe(true);
    expect(valid(KernelToView, { t: 'tty.out', data: new ArrayBuffer(3) })).toBe(true);
    expect(valid(KernelToView, { t: 'tty.out', data: 'text' })).toBe(false);
    expect(valid(KernelToView, { t: 'close', reason: 'abi-mismatch' })).toBe(true);
  });
});
