/**
 * The op pipeline end to end over a fake transaction layer: vfsTxn (L0 dedup, retries, rejection
 * recording), the capturing feed statement, the content-write handler and op.result
 * (offline-and-sync.md §3.10-§3.12, §3.14.4; database.md §3.9, §3.13, §3.15).
 * Every op.result is parsed with the protocol's OpResult schema (SYN-03).
 */
import fc from 'fast-check';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { deriveIno, OpResult, type OpSubmit } from '@plotinium/protocol';

import { CancelRegistry } from '../../vfs/cancel.ts';
import { ContentWriteHandler } from './content-write.ts';
import {
  ProtocolViolation,
  SyncEngine,
  callOf,
  type CommittedOp,
  type OpOrigin,
} from './engine.ts';
import {
  FakeDb,
  HOME,
  ROOT_DIR,
  pgError,
  sha,
  uid7,
  writeOp,
  type FakeTx,
} from './tests/fake-db.ts';

const ALICE = 1001;
const BOB = 1002;
const ALICE_HOME = uid7(1, 1);
const BOB_HOME = uid7(1, 2);
const SHARED = uid7(1, 3);
const LOCKED_DIR = uid7(1, 4);
const REPORT = uid7(2, 1);
const NOTES = uid7(2, 2);
const PRIVATE = uid7(2, 3);
const OS_A = uid7(3, 1);
const OS_B = uid7(3, 2);
const DEV_A = uid7(4, 1);

let opCounter = 0;
const nextOpId = (): string => uid7(0x9000, ++opCounter);

function check(r: OpResult): OpResult {
  return v.parse(OpResult, r);
}

function setup(opts: { quotaAlice?: number } = {}) {
  const db = new FakeDb();
  db.addUser(0, 'root');
  db.addUser(ALICE, 'alice', { quotaBytes: opts.quotaAlice ?? 1_000_000 });
  db.addUser(BOB, 'bob');
  db.addDir(ROOT_DIR, null, '', 0);
  db.addDir(HOME, ROOT_DIR, 'home', 0);
  db.addDir(ALICE_HOME, HOME, 'alice', ALICE, 0o755);
  db.addDir(BOB_HOME, HOME, 'bob', BOB, 0o755);
  db.addDir(SHARED, HOME, 'shared', BOB, 0o777);
  db.addDir(LOCKED_DIR, BOB_HOME, 'drop', BOB, 0o755); // alice may not create entries here
  db.addFile(REPORT, SHARED, 'report.md', BOB, { mode: 0o666, sha: sha(1), size: 10 });
  db.addFile(NOTES, ALICE_HOME, 'notes.txt', ALICE, { mode: 0o644, sha: sha(1), size: 10 });
  db.addFile(PRIVATE, LOCKED_DIR, 'plan.md', BOB, { mode: 0o666, sha: sha(1), size: 10 });
  for (let i = 2; i < 200; i++) db.addBlob(sha(i), i);
  db.addSession(OS_A, ALICE, DEV_A);
  db.addSession(OS_B, BOB, null);
  const committed: CommittedOp[] = [];
  const errors: string[] = [];
  const cancel = new CancelRegistry();
  const engine = new SyncEngine<FakeTx>({
    steps: db.steps,
    cancel,
    lockTimeoutMs: 2_000,
    statementTimeoutMs: 15_000,
    feed: db.feedSql,
    handlerFor: (s) =>
      s.op.kind === 'write'
        ? new ContentWriteHandler(db.content, s, { timeZone: 'Asia/Karachi' })
        : undefined,
    sessions: { ownsOsSession: (o, u, d) => db.sessions.owns(o, u, d) },
    onCommitted: (c) => committed.push(c),
    onError: (_e, ctx) => errors.push(ctx),
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const origin = (uid: number, grants: number[] = [], connId = `c-${uid}`): OpOrigin => ({
    connId,
    uid,
    deviceId: uid === ALICE ? DEV_A : null,
    mayActAs: (p) => p === uid || grants.includes(p),
    gidsOf: (p) => [p],
  });
  return { db, engine, committed, errors, cancel, alice: origin(ALICE), bob: origin(BOB), origin };
}

describe('OFF-02 exactly once (offline-and-sync.md §3.10, §3.11)', () => {
  it('OFF-02 exactly-once property: dropped replies, duplicated frames, transient failures and a server kill after COMMIT apply every op once', async () => {
    const fault = fc.constantFrom(
      'ok',
      'drop-reply',
      'duplicate',
      'kill-after-commit',
      'transient',
      'serialization',
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fault, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 25 }),
        fc.array(fc.integer({ min: 2, max: 150 }), { minLength: 25, maxLength: 25 }),
        async (plans, sizes) => {
          const { db, engine, alice } = setup();
          let version = 1;
          let bytes = 10;
          const opIds: string[] = [];
          for (const [k, attempts] of plans.entries()) {
            const size = sizes[k] ?? 2;
            const submit = writeOp({
              opId: nextOpId(),
              osSessionId: OS_A,
              cseq: k + 1,
              principal: ALICE,
              ino: NOTES,
              sha: sha(size),
              size,
              baseVersion: version,
            });
            opIds.push(submit.opId);
            let final: OpResult | null = null;
            // The client resends until it has processed a final result (C1: the op stays in the outbox).
            for (let attempt = 0; final === null && attempt < 50; attempt++) {
              const f = attempts[attempt] ?? 'ok';
              db.failBegin =
                f === 'transient'
                  ? () => pgError('08006')
                  : f === 'serialization'
                    ? (n) => (n % 2 === 1 ? pgError('40001') : null)
                    : null;
              db.failAfterCommit = f === 'kill-after-commit' ? () => pgError('57P01') : null;
              const r = check(await engine.applyOp(alice, submit));
              db.failBegin = null;
              db.failAfterCommit = null;
              if (f === 'duplicate') {
                const again = check(await engine.applyOp(alice, submit)); // the same frame twice on the socket
                expect(again.status).toBe(r.status === 'retry' ? again.status : r.status);
              }
              if (f === 'drop-reply' || r.status === 'retry') continue; // the reply is lost or asks for a resend
              final = r;
            }
            if (final === null) throw new Error('op never finished');
            expect(final.status).toBe('applied');
            version = final.versions?.[0]?.version ?? -1;
            bytes = size;
          }
          const file = db.inode(NOTES);
          expect(file?.version).toBe(1 + plans.length); // one version per op: never twice, never lost
          expect(file?.size).toBe(bytes);
          expect([...db.state.opLog.keys()].sort()).toEqual([...opIds].sort()); // one op_log row per opId
          expect([...db.state.opLog.values()].every((r) => r.status === 'applied')).toBe(true);
          expect(db.feedIsGapFree()).toBe(true);
          expect(db.state.users.get(ALICE)?.feedSeq).toBe(plans.length);
          const live = [...db.state.blobs.values()].filter((b) => b.refcount > 0).map((b) => b.sha);
          expect(live).toContain(sha(bytes));
        },
      ),
      { seed: 20261114, numRuns: 40 },
    );
  });

  it('OFF-02 a duplicate returns the stored outcome with duplicate: true and the same versions, ownerSeqs and lamport', async () => {
    const { engine, alice, committed } = setup();
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: NOTES,
      sha: sha(5),
      size: 5,
      baseVersion: 1,
    });
    const first = check(await engine.applyOp(alice, submit));
    const second = check(await engine.applyOp(alice, submit));
    expect(first).toMatchObject({ status: 'applied', duplicate: false });
    expect(second).toMatchObject({ status: 'applied', duplicate: true });
    expect(second.versions).toEqual(first.versions);
    expect(second.ownerSeqs).toEqual(first.ownerSeqs);
    expect(second.lamport).toBe(first.lamport);
    expect(second.commitTime).toBe(first.commitTime);
    expect(committed).toHaveLength(1); // a duplicate is never broadcast again
    expect(committed[0]?.ownerSeqs).toEqual([{ ownerUid: ALICE, seq: 1 }]);
  });

  it('OFF-02 a resent op whose first attempt was rejected returns the same errno and is never applied', async () => {
    const { db, engine, bob } = setup();
    // bob may not write alice's 0644 notes: EACCES is deterministic and persisted before the reply.
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_B,
      cseq: 1,
      principal: BOB,
      ino: NOTES,
      sha: sha(7),
      size: 7,
      baseVersion: 1,
    });
    const first = check(await engine.applyOp(bob, submit));
    expect(first).toMatchObject({ status: 'rejected', errno: 'EACCES', duplicate: false });
    expect(db.state.opLog.get(submit.opId)?.status).toBe('rejected');
    const again = check(await engine.applyOp(bob, submit));
    expect(again).toMatchObject({ status: 'rejected', errno: 'EACCES', duplicate: true });
    expect(db.inode(NOTES)?.version).toBe(1);
  });

  it('OFF-02 a transient 40001 exhaustion returns retry, persists nothing, and the resent op applies once', async () => {
    const { db, engine, alice } = setup();
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: NOTES,
      sha: sha(9),
      size: 9,
      baseVersion: 1,
    });
    db.failBegin = () => pgError('40001');
    const r = check(await engine.applyOp(alice, submit));
    expect(r).toMatchObject({ status: 'retry', errno: 'EAGAIN', reason: 'retry-exhausted' });
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(db.state.opLog.has(submit.opId)).toBe(false);
    db.failBegin = null;
    expect(check(await engine.applyOp(alice, submit)).status).toBe('applied');
    expect(db.inode(NOTES)?.version).toBe(2);
  });

  it('OFF-02 a missing blob answers retry EAGAIN blob-missing without persisting; after the upload the op applies', async () => {
    const { db, engine, alice } = setup();
    const missing = 'f'.repeat(64);
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: NOTES,
      sha: missing,
      size: 4,
      baseVersion: 1,
    });
    expect(check(await engine.applyOp(alice, submit))).toMatchObject({
      status: 'retry',
      errno: 'EAGAIN',
      reason: 'blob-missing',
      retryAfterMs: 0,
    });
    expect(db.state.opLog.size).toBe(0);
    db.addBlob(missing, 4);
    expect(check(await engine.applyOp(alice, submit)).status).toBe('applied');
  });

  it('OFF-02 a rejection that could not be recorded is sent as retry, never as rejected (INV-S11)', async () => {
    const { db, engine, bob, errors } = setup();
    db.failRecord = true;
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_B,
      cseq: 1,
      principal: BOB,
      ino: NOTES,
      sha: sha(7),
      size: 7,
      baseVersion: 1,
    });
    expect(check(await engine.applyOp(bob, submit))).toMatchObject({
      status: 'retry',
      errno: 'EIO',
      reason: 'server',
    });
    expect(errors).toContain('record-rejection');
  });

  it('OFF-02 a queued op killed by proc.signal is recorded rejected ECANCELED killed and a resend returns it', async () => {
    const { db, engine, alice } = setup();
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: NOTES,
      sha: sha(9),
      size: 9,
      baseVersion: 1,
    });
    expect(check(await engine.rejectKilled(alice, submit))).toMatchObject({
      status: 'rejected',
      errno: 'ECANCELED',
      reason: 'killed',
    });
    expect(check(await engine.applyOp(alice, submit))).toMatchObject({
      status: 'rejected',
      errno: 'ECANCELED',
      duplicate: true,
    });
    expect(check(await engine.rejectKilled(alice, submit))).toMatchObject({
      status: 'rejected',
      duplicate: true,
    });
    expect(db.inode(NOTES)?.version).toBe(1);
  });

  it('OFF-02 a running op whose signal is aborted rolls back and is recorded ECANCELED killed (AGT-09)', async () => {
    const { engine, alice } = setup();
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: NOTES,
      sha: sha(9),
      size: 9,
      baseVersion: 1,
    });
    const r = check(await engine.applyOp(alice, submit, AbortSignal.abort()));
    expect(r).toMatchObject({ status: 'rejected', errno: 'ECANCELED' });
  });

  it('OFF-02 an op with a valid identity and an invalid body is rejected EINVAL and persisted (step 0)', async () => {
    const { db, engine, alice } = setup();
    const opId = nextOpId();
    const r = check(
      await engine.rejectInvalid(alice, {
        opId,
        osSessionId: OS_A,
        cseq: 9,
        lamport: 9,
        principal: ALICE,
        clientTime: undefined,
        kind: 'write',
        issue: 'op.size: invalid',
      }),
    );
    expect(r).toMatchObject({ status: 'rejected', errno: 'EINVAL', reason: 'schema' });
    expect(db.state.opLog.get(opId)?.call).toBe('write');
  });

  it('OFF-02 an op id already used by another uid is refused EINVAL and never reveals the stored result', async () => {
    const { engine, alice, bob } = setup();
    const opId = nextOpId();
    await engine.applyOp(
      alice,
      writeOp({
        opId,
        osSessionId: OS_A,
        cseq: 1,
        principal: ALICE,
        ino: NOTES,
        sha: sha(9),
        size: 9,
        baseVersion: 1,
      }),
    );
    const r = check(
      await engine.applyOp(
        bob,
        writeOp({
          opId,
          osSessionId: OS_B,
          cseq: 1,
          principal: BOB,
          ino: REPORT,
          sha: sha(9),
          size: 9,
          baseVersion: 1,
        }),
      ),
    );
    expect(r).toMatchObject({ status: 'rejected', errno: 'EINVAL' });
    expect(r.versions).toBeUndefined();
    const k = check(
      await engine.rejectKilled(
        bob,
        writeOp({
          opId,
          osSessionId: OS_B,
          cseq: 2,
          principal: BOB,
          ino: REPORT,
          sha: sha(9),
          size: 9,
          baseVersion: 1,
        }),
      ),
    );
    expect(k).toMatchObject({ status: 'rejected', errno: 'EINVAL' });
  });
});

describe('SYN-11 principals and OS sessions (§3.8.6, §3.10 steps 1-2)', () => {
  it('SYN-11 a forged principal returns retry EACCES principal and never applies; a live su grant applies it', async () => {
    const { db, engine, origin } = setup();
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_B,
      cseq: 1,
      principal: ALICE,
      ino: NOTES,
      sha: sha(3),
      size: 3,
      baseVersion: 1,
    });
    expect(check(await engine.applyOp(origin(BOB), submit))).toMatchObject({
      status: 'retry',
      errno: 'EACCES',
      reason: 'principal',
    });
    expect(db.state.opLog.size).toBe(0);
    expect(check(await engine.applyOp(origin(BOB, [ALICE]), submit)).status).toBe('applied');
  });

  it('SYN-11 an op filed under another uid OS session is a protocol violation (close 1008)', async () => {
    const { engine, bob } = setup();
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: BOB,
      ino: REPORT,
      sha: sha(3),
      size: 3,
      baseVersion: 1,
    });
    await expect(engine.applyOp(bob, submit)).rejects.toBeInstanceOf(ProtocolViolation);
    await expect(
      engine.rejectInvalid(bob, {
        opId: nextOpId(),
        osSessionId: OS_A,
        cseq: 1,
        lamport: 1,
        principal: BOB,
        clientTime: undefined,
        kind: undefined,
        issue: 'x',
      }),
    ).rejects.toBeInstanceOf(ProtocolViolation);
  });

  it('SYN-11 a database failure in the session check answers retry EIO', async () => {
    const { engine, alice, errors } = setup();
    const broken = new SyncEngine<FakeTx>({
      steps: setup().db.steps,
      cancel: new CancelRegistry(),
      lockTimeoutMs: 1,
      statementTimeoutMs: 1,
      feed: setup().db.feedSql,
      handlerFor: () => undefined,
      sessions: { ownsOsSession: () => Promise.reject(new Error('down')) },
      onError: (_e, c) => errors.push(c),
    });
    const submit = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: NOTES,
      sha: sha(3),
      size: 3,
      baseVersion: 1,
    });
    expect(check(await broken.applyOp(alice, submit))).toMatchObject({
      status: 'retry',
      errno: 'EIO',
    });
    expect(errors).toContain('os-session-check');
    expect(engine.lamport.value).toBe(0);
  });

  it('SYN-04 an op kind without a server handler is kept by the client: retry ENOSYS not-implemented', async () => {
    const { engine, alice } = setup();
    const utimes: OpSubmit = {
      ...writeOp({
        opId: nextOpId(),
        osSessionId: OS_A,
        cseq: 1,
        principal: ALICE,
        ino: NOTES,
        sha: sha(3),
        size: 3,
        baseVersion: 1,
      }),
      op: { kind: 'utimes', ino: NOTES, mtime: 1 },
    };
    expect(check(await engine.applyOp(alice, utimes))).toMatchObject({
      status: 'retry',
      errno: 'ENOSYS',
      retryAfterMs: 60_000,
    });
    const unlink: OpSubmit = {
      ...utimes,
      opId: nextOpId(),
      op: {
        kind: 'unlink',
        parentIno: ALICE_HOME,
        name: 'notes.txt',
        ino: NOTES,
        recursive: false,
      },
    };
    expect(check(await engine.applyOp(alice, unlink)).errno).toBe('ENOSYS');
    expect(
      callOf({
        kind: 'create',
        parentIno: ALICE_HOME,
        name: 'd',
        ino: NOTES,
        type: 'd',
        mode: 0o755,
        mtime: 0,
      }),
    ).toBe('mkdir');
    expect(
      callOf({
        kind: 'create',
        parentIno: ALICE_HOME,
        name: 'l',
        ino: NOTES,
        type: 'l',
        mode: 0o777,
        mtime: 0,
        symlinkTarget: 'x',
      }),
    ).toBe('symlink');
    // Every wire op kind has an op_log call name (utimes, audit.append and session.layout too).
    expect(callOf({ kind: 'session.layout', layout: {}, rev: 1 })).toBe('session.layout');
    expect(callOf({ kind: 'utimes', ino: NOTES, mtime: 1 })).toBe('utimes');
  });
});

describe('VFS-10 content writes: version CAS and conflicted copies (§3.12.2)', () => {
  it('VFS-10 an offline write against a newer version becomes report (conflict from alice, date).md and bob keeps his version', async () => {
    const { db, engine, alice, bob, committed } = setup();
    // bob saved version 2 while alice was offline with base 1.
    check(
      await engine.applyOp(
        bob,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_B,
          cseq: 1,
          principal: BOB,
          ino: REPORT,
          sha: sha(20),
          size: 20,
          baseVersion: 1,
        }),
      ),
    );
    const offline = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: REPORT,
      sha: sha(30),
      size: 30,
      baseVersion: 1,
    });
    const r = check(await engine.applyOp(alice, offline));
    expect(r.status).toBe('conflict');
    expect(r.errno).toBeUndefined();
    expect(r.keptAs).toEqual({
      ino: deriveIno(offline.opId, REPORT),
      parentIno: SHARED,
      name: 'report (conflict from alice, 2026-11-14).md',
    });
    const original = db.inode(REPORT);
    expect(original?.version).toBe(2); // bob's version stays: nothing silently overwritten
    expect(original?.size).toBe(20);
    const copy = db.inode(deriveIno(offline.opId, REPORT));
    expect(copy).toMatchObject({ uid: ALICE, size: 30, mode: 0o666, type: 'f' });
    expect(db.state.users.get(ALICE)?.usedBytes).toBe(10 + 30); // charged to the principal
    // Feed: alice (new inode) and bob (his directory's listing changed).
    expect(r.ownerSeqs).toEqual([
      { ownerUid: ALICE, seq: 1 },
      { ownerUid: BOB, seq: 2 },
    ]);
    const last = committed.at(-1);
    expect(last?.effects.dirs).toEqual([SHARED]);
    expect(last?.effects.changes.map((c) => c.ino)).toEqual([
      deriveIno(offline.opId, REPORT),
      SHARED,
    ]);
  });

  it('VFS-10 a second conflicted copy of the same file on the same day gets the suffix 2', async () => {
    const { engine, alice, bob } = setup();
    check(
      await engine.applyOp(
        bob,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_B,
          cseq: 1,
          principal: BOB,
          ino: REPORT,
          sha: sha(20),
          size: 20,
          baseVersion: 1,
        }),
      ),
    );
    const a = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 1,
          principal: ALICE,
          ino: REPORT,
          sha: sha(30),
          size: 30,
          baseVersion: 1,
        }),
      ),
    );
    const b = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 2,
          principal: ALICE,
          ino: REPORT,
          sha: sha(31),
          size: 31,
          baseVersion: 1,
        }),
      ),
    );
    expect(a.keptAs?.name).toBe('report (conflict from alice, 2026-11-14).md');
    expect(b.keptAs?.name).toBe('report (conflict from alice, 2026-11-14) 2.md');
  });

  it('VFS-10 without w on the parent the conflicted copy goes to ~/lost+found, created 0700 on demand', async () => {
    const { db, engine, alice, bob } = setup();
    check(
      await engine.applyOp(
        bob,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_B,
          cseq: 1,
          principal: BOB,
          ino: PRIVATE,
          sha: sha(20),
          size: 20,
          baseVersion: 1,
        }),
      ),
    );
    const op = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 1,
      principal: ALICE,
      ino: PRIVATE,
      sha: sha(40),
      size: 40,
      baseVersion: 1,
    });
    const r = check(await engine.applyOp(alice, op));
    const lf = deriveIno(op.opId, ALICE_HOME);
    expect(r).toMatchObject({
      status: 'conflict',
      keptAs: { parentIno: lf, name: 'plan (conflict from alice, 2026-11-14).md' },
    });
    expect(db.inode(lf)).toMatchObject({ type: 'd', mode: 0o700, uid: ALICE });
    expect(
      db
        .childrenOf(ALICE_HOME)
        .map((d) => d.name)
        .sort(),
    ).toEqual(['lost+found', 'notes.txt']);
    // A second one reuses the existing lost+found.
    const again = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 2,
      principal: ALICE,
      ino: PRIVATE,
      sha: sha(41),
      size: 41,
      baseVersion: 1,
    });
    expect(check(await engine.applyOp(alice, again)).keptAs?.parentIno).toBe(lf);
  });

  it('VFS-10 a conflicted copy that does not fit the quota rejects the op EDQUOT with nothing changed', async () => {
    const { db, engine, alice, bob } = setup({ quotaAlice: 25 });
    check(
      await engine.applyOp(
        bob,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_B,
          cseq: 1,
          principal: BOB,
          ino: REPORT,
          sha: sha(20),
          size: 20,
          baseVersion: 1,
        }),
      ),
    );
    const r = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 1,
          principal: ALICE,
          ino: REPORT,
          sha: sha(30),
          size: 30,
          baseVersion: 1,
        }),
      ),
    );
    expect(r).toMatchObject({ status: 'rejected', errno: 'EDQUOT' });
    expect(db.childrenOf(SHARED)).toHaveLength(1);
  });

  it('VFS-10 the mtime of an offline edit is clamped to the commit time + 60 s', async () => {
    const { db, engine, alice } = setup();
    const future = db.now + 3_600_000;
    const r = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 1,
          principal: ALICE,
          ino: NOTES,
          sha: sha(8),
          size: 8,
          baseVersion: 1,
          mtime: future,
        }),
      ),
    );
    expect(r.versions?.[0]?.mtime).toBe(db.now + 60_000);
  });

  it('VFS-10 a write to a missing file or a directory is rejected ENOENT / EISDIR; a missing base entry is EINVAL', async () => {
    const { engine, alice } = setup();
    const gone = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 1,
          principal: ALICE,
          ino: uid7(2, 99),
          sha: sha(8),
          size: 8,
          baseVersion: 1,
        }),
      ),
    );
    expect(gone).toMatchObject({ status: 'rejected', errno: 'ENOENT' });
    const dir = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 2,
          principal: ALICE,
          ino: ALICE_HOME,
          sha: sha(8),
          size: 8,
          baseVersion: 1,
        }),
      ),
    );
    expect(dir).toMatchObject({ status: 'rejected', errno: 'EISDIR' });
    const noBase: OpSubmit = {
      ...writeOp({
        opId: nextOpId(),
        osSessionId: OS_A,
        cseq: 3,
        principal: ALICE,
        ino: NOTES,
        sha: sha(8),
        size: 8,
        baseVersion: 1,
      }),
      base: { kind: 'versions', entries: [] },
    };
    expect(check(await engine.applyOp(alice, noBase))).toMatchObject({
      status: 'rejected',
      errno: 'EINVAL',
    });
    const wrongSize = writeOp({
      opId: nextOpId(),
      osSessionId: OS_A,
      cseq: 4,
      principal: ALICE,
      ino: NOTES,
      sha: sha(8),
      size: 9,
      baseVersion: 1,
    });
    expect(check(await engine.applyOp(alice, wrongSize))).toMatchObject({
      status: 'rejected',
      errno: 'EINVAL',
    });
  });
});

describe('VFS-09 content writes under leases (§3.14.4)', () => {
  it('VFS-09 a write with a stale fence returns conflict EBUSY stale-fence and its bytes are kept as a conflicted copy', async () => {
    const { db, engine, alice } = setup();
    // alice held X with fence 41; it expired and bob now holds X with fence 42.
    db.addLock({
      ino: REPORT,
      osSessionId: OS_B,
      mode: 'X',
      fence: 42,
      expiresAt: db.now + 10_000,
    });
    const r = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 1,
          principal: ALICE,
          ino: REPORT,
          sha: sha(12),
          size: 12,
          baseVersion: 1,
          fences: [{ ino: REPORT, fence: 41 }],
        }),
      ),
    );
    expect(r).toMatchObject({ status: 'conflict', errno: 'EBUSY', reason: 'stale-fence' });
    expect(r.keptAs?.name).toBe('report (conflict from alice, 2026-11-14).md');
    expect(db.inode(REPORT)?.version).toBe(1);
  });

  it('VFS-09 a second writer without a lease gets conflict EBUSY lease and both versions are kept', async () => {
    const { db, engine, alice } = setup();
    db.addLock({
      ino: REPORT,
      osSessionId: OS_B,
      mode: 'X',
      fence: 42,
      expiresAt: db.now + 10_000,
    });
    const r = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 1,
          principal: ALICE,
          ino: REPORT,
          sha: sha(12),
          size: 12,
          baseVersion: 1,
        }),
      ),
    );
    expect(r).toMatchObject({ status: 'conflict', errno: 'EBUSY', reason: 'lease' });
    expect(db.inode(REPORT)?.size).toBe(10);
  });

  it('VFS-09 the holder of the X lease writing with its fence applies normally; an expired foreign lease no longer blocks', async () => {
    const { db, engine, alice } = setup();
    db.addLock({
      ino: REPORT,
      osSessionId: OS_A,
      mode: 'X',
      fence: 43,
      expiresAt: db.now + 10_000,
    });
    const r = check(
      await engine.applyOp(
        alice,
        writeOp({
          opId: nextOpId(),
          osSessionId: OS_A,
          cseq: 1,
          principal: ALICE,
          ino: REPORT,
          sha: sha(12),
          size: 12,
          baseVersion: 1,
          fences: [{ ino: REPORT, fence: 43 }],
        }),
      ),
    );
    expect(r.status).toBe('applied');
    db.state.locks = [
      { ino: NOTES, osSessionId: OS_B, mode: 'X', fence: 50, expiresAt: db.now - 1 },
    ];
    expect(
      check(
        await engine.applyOp(
          alice,
          writeOp({
            opId: nextOpId(),
            osSessionId: OS_A,
            cseq: 2,
            principal: ALICE,
            ino: NOTES,
            sha: sha(13),
            size: 13,
            baseVersion: 1,
          }),
        ),
      ).status,
    ).toBe('applied');
  });
});
