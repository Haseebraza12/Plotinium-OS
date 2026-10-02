import { AuditRecord, sha256, toHex } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import {
  planRecord,
  syscallRecords,
  argsDigest,
  argsSummary,
  abiOutcome,
  recordFingerprint,
} from '../src/agent/audit.ts';
import {
  CassetteMiss,
  MemoryCassetteStore,
  cassetteFetch,
  cassetteKey,
  containsCredential,
  scrub,
} from '../src/agent/cassette.ts';
import {
  LIMIT_MESSAGE,
  type LoopDeps,
  type LoopInput,
  runObservationLoop,
} from '../src/agent/loop.ts';
import {
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  REMINDER,
  Transcript,
} from '../src/agent/model.ts';
import { agentCredentials, elevationAllowed } from '../src/agent/root-drop.ts';
import { buildInverse, checkUndoPrecondition } from '../src/agent/undo.ts';
import { type Schema, parseWith } from '../src/util/schema.ts';
import { seededRandom } from '../src/util/rng.ts';
import { FROZEN_NOW, TZ } from '../eval/fixtures/fx-agt.ts';

const input: LoopInput = {
  request: 'move every PDF I changed last week into a new folder called reports',
  context: {
    uid: 1001,
    user: 'alice',
    groups: ['users'],
    cwd: '/home/alice',
    home: '/home/alice',
    now: '2026-10-05T10:00:00+05:00',
    tz: TZ,
    scope: ['/home/alice'],
  },
  listing: [{ name: 'thesis.pdf', type: 'f', size: 10, mtime: FROZEN_NOW }],
  listingTotal: 1,
};

const tool = (name: string, toolInput: unknown, id = `toolu_${name}`): ModelResponse => ({
  stopReason: 'tool_use',
  toolUses: [{ id, name, input: toolInput }],
  raw: [{ type: 'tool_use', name }],
});

/** A scripted model client that records every request it receives. */
function scripted(replies: ModelResponse[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete(req) {
      requests.push({ transcript: [...req.transcript], maxTokens: req.maxTokens });
      const r = replies.shift();
      return Promise.resolve(r ?? { stopReason: 'end_turn', toolUses: [], raw: [] });
    },
  };
}

const plan = {
  summary: 'reports',
  steps: [
    {
      id: 's1',
      span: 'a new folder called reports',
      op: { call: 'mkdir', args: { path: '~/reports', parents: false } },
      sources: null,
    },
  ],
  assumptions: [],
  suspicious_content_seen: false,
};

function deps(model: ModelClient, over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    model,
    runTool: () =>
      Promise.resolve({
        ok: true,
        value: { paths: ['/home/alice/thesis.pdf'], denied: 0, truncated: false },
      }),
    rng: seededRandom(5),
    umask: 0o022,
    now: () => FROZEN_NOW,
    ...over,
  };
}

describe('observation loop (AIN-B1, AGT-07)', () => {
  it('AIN-B1 every observation the model receives is the datamarked result of exactly one read-only syscall', async () => {
    const calls: Array<[string, unknown]> = [];
    const model = scripted([
      tool('fs_find', {
        path: '/home/alice',
        name: '*.pdf',
        type: 'f',
        mtime: null,
        size: null,
        maxdepth: null,
      }),
      tool('submit_plan', plan),
    ]);
    const out = await runObservationLoop(
      input,
      deps(model, {
        runTool: (call, args) => (
          calls.push([call, args]),
          Promise.resolve({
            ok: true,
            value: { paths: ['/home/alice/thesis.pdf'], denied: 0, truncated: false },
          })
        ),
      }),
    );
    expect(out.kind).toBe('plan');
    expect(calls).toEqual([
      ['find', { path: '/home/alice', name: '*.pdf', type: 'f', limit: 500 }],
    ]);
    const second = model.requests[1]?.transcript ?? [];
    const result = second[second.length - 1];
    expect(result?.role).toBe('tool_result');
    expect(result?.role === 'tool_result' && result.content).toMatch(/^<untrusted source="find /);
    expect(out.kind === 'plan' && [...out.observed]).toEqual(['/home/alice/thesis.pdf']);
    expect(out.observations).toEqual([
      {
        turn: 1,
        call: 'find',
        args: { path: '/home/alice', name: '*.pdf', type: 'f', limit: 500 },
        ok: true,
      },
    ]);
  });

  it('AGT-07 ambiguous requests produce ask_clarification and the answer becomes a new user turn', async () => {
    const model = scripted([
      tool('ask_clarification', {
        question: 'Which report?',
        options: ['a', 'b'],
        reason: 'ambiguous_target',
      }),
      tool('submit_plan', plan),
    ]);
    const out = await runObservationLoop(
      input,
      deps(model, { clarify: () => Promise.resolve('the reports one') }),
    );
    expect(out.kind).toBe('plan');
    expect(out.clarifications).toEqual(['the reports one']);
    const last = model.requests[1]?.transcript.at(-1);
    expect(last?.role === 'tool_result' && last.content).toBe(
      '<clarification>the reports one</clarification>',
    );
    const nonInteractive = await runObservationLoop(
      input,
      deps(
        scripted([
          tool('ask_clarification', { question: 'Which?', options: [], reason: 'ambiguous_scope' }),
        ]),
      ),
    );
    expect(nonInteractive).toMatchObject({ kind: 'needs-clarification', question: 'Which?' });
    const eof = await runObservationLoop(
      input,
      deps(
        scripted([
          tool('ask_clarification', { question: 'Which?', options: [], reason: 'ambiguous_scope' }),
        ]),
        { clarify: () => Promise.resolve(undefined) },
      ),
    );
    expect(eof.kind).toBe('needs-clarification');
  });

  it('AGT-07 at most 2 clarification rounds and 6 model turns; hitting a cap runs nothing and reports ETIMEDOUT', async () => {
    const ask = () =>
      tool('ask_clarification', { question: 'Which?', options: [], reason: 'ambiguous_scope' });
    const clar = await runObservationLoop(
      input,
      deps(scripted([ask(), ask(), ask()]), { clarify: () => Promise.resolve('x') }),
    );
    expect(clar).toMatchObject({ kind: 'error', errno: 'ETIMEDOUT', reason: 'clarify-limit' });
    const find = () => tool('fs_stat', { path: '/home/alice' });
    const turns = await runObservationLoop(
      input,
      deps(scripted([find(), find(), find(), find(), find(), find(), find()])),
    );
    expect(turns).toMatchObject({
      kind: 'error',
      errno: 'ETIMEDOUT',
      message: LIMIT_MESSAGE,
      turns: 6,
    });
    let t = FROZEN_NOW;
    const slow = await runObservationLoop(
      input,
      deps(scripted([find(), find()]), { now: () => (t += 70_000) }),
    );
    expect(slow).toMatchObject({ kind: 'error', errno: 'ETIMEDOUT', reason: 'deadline' });
  });

  it('AGT-07 end_turn gets one kernel reminder, max_tokens one retry at 16,000, and refusal is EAIREFUSED', async () => {
    const empty: ModelResponse = { stopReason: 'end_turn', toolUses: [], raw: [{ type: 'text' }] };
    const model = scripted([empty, tool('submit_plan', plan)]);
    const out = await runObservationLoop(input, deps(model));
    expect(out.kind).toBe('plan');
    const t = model.requests[1]?.transcript.at(-1);
    expect(t?.role === 'user' && t.text).toBe(REMINDER);
    const twice = await runObservationLoop(input, deps(scripted([empty, empty])));
    expect(twice).toMatchObject({ kind: 'error', errno: 'ETIMEDOUT' });
    const long: ModelResponse = { stopReason: 'max_tokens', toolUses: [], raw: [] };
    const retry = scripted([long, tool('submit_plan', plan)]);
    expect((await runObservationLoop(input, deps(retry))).kind).toBe('plan');
    expect(retry.requests.map((r) => r.maxTokens)).toEqual([8_000, 16_000]);
    expect(retry.requests[1]?.transcript.length).toBe(1);
    expect(await runObservationLoop(input, deps(scripted([long, long])))).toMatchObject({
      errno: 'ETIMEDOUT',
    });
    const refused = await runObservationLoop(
      input,
      deps(scripted([{ stopReason: 'refusal', toolUses: [], raw: [], category: 'cyber' }])),
    );
    expect(refused).toMatchObject({ kind: 'error', errno: 'EAIREFUSED', reason: 'cyber' });
    const two: ModelResponse = {
      stopReason: 'tool_use',
      toolUses: [
        { id: 'a', name: 'fs_stat', input: { path: '/' } },
        { id: 'b', name: 'fs_stat', input: { path: '/' } },
      ],
      raw: [],
    };
    expect(await runObservationLoop(input, deps(scripted([two])))).toMatchObject({
      errno: 'EINVAL',
    });
    const endWithTool: ModelResponse = {
      ...tool('cannot_comply', { reason: 'no' }),
      stopReason: 'end_turn',
    };
    expect(await runObservationLoop(input, deps(scripted([endWithTool])))).toMatchObject({
      kind: 'cannot',
      reason: 'no',
    });
  });

  it('AGT-06 tool errors go back as is_error results with the errno only, and bad input is EINVAL', async () => {
    const model = scripted([
      tool('fs_stat', { path: '/home/bob' }),
      tool('cannot_comply', { reason: 'cannot read' }),
    ]);
    const out = await runObservationLoop(
      input,
      deps(model, { runTool: () => Promise.resolve({ ok: false, errno: 'EACCES' }) }),
    );
    expect(out.kind).toBe('cannot');
    const res = model.requests[1]?.transcript.at(-1);
    expect(res).toEqual({
      role: 'tool_result',
      toolUseId: 'toolu_fs_stat',
      content: 'errno EACCES',
      isError: true,
    });
    expect(out.observations[0]).toMatchObject({ ok: false, errno: 'EACCES' });
    const bad = await runObservationLoop(
      input,
      deps(scripted([tool('fs_stat', { path: '/', smuggled: 0 })])),
    );
    expect(bad).toMatchObject({ kind: 'error', errno: 'EINVAL' });
  });

  it('AGT-09 a kill (abort) between turns stops the loop with ECANCELED and runs nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await runObservationLoop(
      input,
      deps(scripted([tool('submit_plan', plan)]), { signal: ac.signal }),
    );
    expect(out).toMatchObject({ kind: 'error', errno: 'ECANCELED' });
  });

  it('AGT-06 the transcript is append-only: entries are frozen and views are copies', () => {
    const t = new Transcript();
    t.append({ role: 'user', text: 'a' });
    const v = t.view() as unknown[];
    v.pop();
    expect(t.length).toBe(1);
    expect(Object.isFrozen(t.view()[0])).toBe(true);
  });
});

describe('audit records (AGT-08)', () => {
  const base = {
    auditId: '0192f0c1-0000-7000-8000-000000000011',
    t: FROZEN_NOW,
    osSessionId: '0192f0c1-0000-7000-8000-000000000022',
    pid: 311,
    uid: 1001,
    requestId: '0192f0c1-0000-7000-8000-0000000000aa',
    request: 'delete the old build logs',
    call: 'ai.agent.submit' as const,
    args: {
      steps: [{ op: 'write', args: { path: '/home/alice/a', text: 'SECRET CONTENT' } }],
      token: 'TOKVALUE',
    },
    durationUs: 1200,
  };

  it('AGT-08 the plan record carries prompt, plan hash, confirmation and outcome and matches the protocol schema', () => {
    const rec = planRecord({
      ...base,
      outcome: 'committed',
      planHash: 'a'.repeat(64),
      dryRunHash: 'b'.repeat(64),
      confirmation: 'confirmed',
      txnId: base.auditId,
      undoId: base.auditId,
      inodes: 13,
      ruid: 1001,
      observations: [
        { call: 'find', args: { path: '/' }, ok: true },
        { call: 'stat', args: {}, ok: false, errno: 'EACCES' },
      ],
    });
    expect(parseWith(AuditRecord as unknown as Schema<unknown>, rec).ok).toBe(true);
    expect(rec).toMatchObject({
      level: 'agent',
      actor: 'agent',
      promptId: base.requestId,
      request: base.request,
      outcome: 'ok',
      confirmation: 'confirmed',
      inodes: 13,
    });
    expect(rec.argsSummary).not.toContain('SECRET');
    expect(rec.argsSummary).not.toContain('TOKVALUE');
    expect(rec.argsSummary).toContain('committed');
    expect(recordFingerprint(rec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AGT-08 rejected, declined and killed plans are audited with their outcome and errno', () => {
    const rejected = planRecord({ ...base, outcome: 'rejected_invalid', errno: 'EPERM' });
    expect(rejected).toMatchObject({ outcome: 'rejected', errno: 'EPERM', errnoCode: 1 });
    expect(planRecord({ ...base, outcome: 'declined' }).outcome).toBe('declined');
    expect(planRecord({ ...base, outcome: 'killed_rolled_back', errno: 'ECANCELED' }).outcome).toBe(
      'killed_rolled_back',
    );
    expect(abiOutcome('confirm_timeout')).toBe('declined');
    expect(abiOutcome('undone')).toBe('ok');
  });

  it('AGT-08 every executed agent op gets its own syscall record with a digest and no write data', () => {
    const recs = syscallRecords({
      auditIds: [base.auditId],
      t: 1,
      osSessionId: base.osSessionId,
      pid: 1,
      uid: 1001,
      requestId: base.requestId,
      txnId: base.auditId,
      ops: [
        { op: 'write', path: '/a', text: 'SECRET' },
        { op: 'mkdir', path: '/b' },
      ],
    });
    expect(recs).toHaveLength(2);
    for (const r of recs)
      expect(parseWith(AuditRecord as unknown as Schema<unknown>, r).ok).toBe(true);
    expect(recs[0]?.argsSummary).not.toContain('SECRET');
    const bytes = new Uint8Array([1, 2]);
    expect(argsDigest({ data: bytes.buffer })).toBe(
      argsDigest({ data: { len: 2, sha256: toHex(sha256(bytes)) } }),
    );
    expect(argsDigest(new Uint8Array([1]))).toMatch(/^[0-9a-f]{64}$/);
    expect(
      argsSummary(
        {
          a: [1, 2, 3, 4, 5, 6],
          b: { c: { d: { e: 1 } } },
          bin: new Uint8Array(2),
          n: null,
          s: 'x'.repeat(100),
        },
        60,
      ).length,
    ).toBeLessThanOrEqual(60);
  });
});

describe('undo and root drop (AGT-10, AGT-04)', () => {
  it('AGT-10 the inverse plan reverses renames, trashes created entries and restores modes, owners and times', () => {
    const ops = buildInverse(
      [
        { kind: 'trash', path: '/home/alice/reports' },
        { kind: 'rename', from: '/home/alice/reports/a.pdf', to: '/home/alice/a.pdf' },
        { kind: 'chmod', path: '/home/alice/reports', mode: 0o755 },
        { kind: 'chown', path: '/home/alice/x', uid: 1001, gid: 100 },
        { kind: 'utimes', path: '/home/alice/y', mtime: 5 },
      ],
      { home: '/home/alice', undoTxnId: 'u1', trashExists: false },
    );
    expect(ops).toEqual([
      { op: 'utimes', path: '/home/alice/y', mtime: 5 },
      { op: 'chown', path: '/home/alice/x', uid: 1001, gid: 100 },
      { op: 'chmod', path: '/home/alice/reports', mode: { op: 'set', bits: 0o755 } },
      { op: 'rename', from: '/home/alice/reports/a.pdf', to: '/home/alice/a.pdf' },
      { op: 'mkdir', path: '/home/alice/.trash', mode: 0o700, parents: true },
      { op: 'mkdir', path: '/home/alice/.trash/u1', mode: 0o700 },
      { op: 'rename', from: '/home/alice/reports', to: '/home/alice/.trash/u1/1-reports' },
    ]);
    expect(
      buildInverse([{ kind: 'trash', path: '/h/a' }], {
        home: '/h',
        undoTxnId: 'u',
        trashExists: true,
      })[0],
    ).toEqual({ op: 'mkdir', path: '/h/.trash/u', mode: 0o700 });
  });

  it('AGT-10 ai undo after a later change returns EAGAIN changed-since', () => {
    const post = [{ ino: 'a', version: 2 }];
    expect(checkUndoPrecondition(post, () => 2).ok).toBe(true);
    const r = checkUndoPrecondition(post, () => 3);
    expect(!r.ok && r.error).toMatchObject({ errno: 'EAGAIN', reason: 'changed-since' });
  });

  it('AGT-04 an agent started from a su root shell runs as the real login uid, and ai refuses a root login', () => {
    const r = agentCredentials({
      effective: { uid: 0, gid: 0, groups: [] },
      login: { uid: 1001, gid: 100, groups: [100] },
    });
    expect(r.ok && r.value).toEqual({ uid: 1001, gid: 100, groups: [100] });
    const root = agentCredentials({
      effective: { uid: 0, gid: 0, groups: [] },
      login: { uid: 0, gid: 0, groups: [] },
    });
    expect(!root.ok && root.error.errno).toBe('EPERM');
    expect(elevationAllowed({ liveSuGrant: true, securePromptOk: true }).ok).toBe(true);
    expect(elevationAllowed({ liveSuGrant: false, securePromptOk: true }).ok).toBe(false);
  });
});

describe('cassettes (AIS-07, AIS-08)', () => {
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    system: 's',
    metadata: { user_id: 'x' },
  };
  const req = (b: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    body: JSON.stringify(b),
    headers: {
      'x-api-key': 'sk-ant-api03-SECRETSECRET',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      ...headers,
    },
  });

  it('AIS-08 cassettes contain no credential or auth header', async () => {
    const store = new MemoryCassetteStore();
    const inner = () =>
      Promise.resolve(
        new Response(
          'event: message_start\ndata: {"message":{"model":"claude-opus-5-5","usage":{"input_tokens":12,"cache_read_input_tokens":3}},"echo":"sk-ant-api03-LEAKED","authorization":"Bearer abcdefghijkl"}\n\nevent: message_delta\ndata: {"usage":{"output_tokens":7}}\n',
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'request-id': 'req_1',
              'set-cookie': 'session=abc',
            },
          },
        ),
      );
    const f = cassetteFetch({
      mode: 'record',
      store,
      inner,
      provider: 'anthropic',
      now: () => FROZEN_NOW,
    });
    const res = await f(
      'https://api.anthropic.com/v1/messages',
      req({ ...body, messages: [{ role: 'user', content: 'x-api-key: "sk-ant-api03-INBODY"' }] }),
    );
    expect(res.status).toBe(200);
    const [c] = [...store.cassettes.values()];
    expect(c).toBeDefined();
    const text = JSON.stringify(c);
    expect(containsCredential(text)).toBe(false);
    expect(text).not.toContain('SECRETSECRET');
    expect(text).not.toContain('LEAKED');
    expect(text).not.toContain('set-cookie');
    expect(c?.usage).toEqual({ input: 12, output: 7, cacheRead: 3, cacheWrite: 0 });
    expect(c?.model).toEqual({ requested: 'claude-opus-5-5', served: 'claude-opus-5-5' });
    expect(containsCredential('{"x-api-key":"abc"}')).toBe(true);
    expect(containsCredential('sk-ant-api03-zzz')).toBe(true);
    expect(scrub('Authorization: Bearer abcdefghij')).not.toContain('abcdefghij');
  });

  it('AIS-07 replay needs no key, keys ignore auth headers, and a miss fails instead of calling the provider', async () => {
    const store = new MemoryCassetteStore();
    let live = 0;
    const inner = () => {
      live++;
      return Promise.resolve(
        new Response('{"model":"m"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    await cassetteFetch({ mode: 'record', store, inner, provider: 'anthropic', now: () => 0 })(
      'u',
      req(body),
    );
    const replay = cassetteFetch({
      mode: 'replay',
      store,
      inner,
      provider: 'anthropic',
      now: () => 0,
    });
    const r = await replay('u', req(body, { 'x-api-key': 'different' }));
    expect(await r.text()).toBe('{"model":"m"}');
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(live).toBe(1);
    await expect(replay('u', req({ ...body, max_tokens: 1 }))).rejects.toBeInstanceOf(CassetteMiss);
    expect(cassetteKey(body, 'b')).toBe(
      cassetteKey({ ...body, metadata: { user_id: 'other' } }, 'b'),
    );
    expect(cassetteKey(body, 'b')).not.toBe(cassetteKey(body, 'c'));
    expect(cassetteKey('not an object')).toMatch(/^[0-9a-f]{64}$/);
    const request = new Request('https://x/v1', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'anthropic-beta': 'b' },
    });
    await cassetteFetch({ mode: 'record', store, inner, provider: 'anthropic', now: () => 0 })(
      request,
    );
    expect(store.cassettes.has(cassetteKey(body, 'b'))).toBe(true);
    await cassetteFetch({ mode: 'live', store, inner, provider: 'anthropic', now: () => 0 })('u', {
      body: 'not json',
    });
    expect(live).toBe(3);
  });
});
