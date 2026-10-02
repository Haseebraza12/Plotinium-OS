/**
 * Integration: subsystem B (the agentic shell) end to end — the `ai.agent` PROGRAM, the kernel's
 * `ai.agent.*` handlers, the gateway client against a fake `/api/llm/plan` that enforces the
 * server's strict request schema (server/src/llm/routes.ts `PlanReq`), the plan validator on the
 * live tree, the kernel-owned confirmation and the `batch` token gate (agentic-shell.md §3.2–§3.17).
 */
import type { AuditRecord, BatchOp } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import type { ConfirmTty, TtyRead } from '../src/agent/confirm.ts';
import type { HostFetch } from '../src/kernel/types.ts';
import agent, { EXIT, type AgentState } from '../src/programs/agent.ts';
import { AI_MANIFESTS, AI_PROGRAM_LOADERS } from '../src/programs/index.ts';
import { ProgramRunner, TestOs, type Proc, makeError, settle } from './harness/kernel.ts';

// ---------------------------------------------------------------------------------------------
// The fake gateway
// ---------------------------------------------------------------------------------------------

type Reply = {
  kind: 'observe' | 'plan' | 'clarify' | 'cannot';
  payload: unknown;
  toolUseId: string | null;
};
type Script = (
  turn: number,
  body: Record<string, unknown>,
) => Reply | { status: number; body: unknown };

interface Gateway {
  readonly fetch: HostFetch;
  readonly bodies: Array<Record<string, unknown>>;
  readonly signals: AbortSignal[];
  /** Resolve a held turn (for the kill-mid-plan test). */
  release?: () => void;
}

const PLAN_KEYS = new Set(['requestId', 'turn', 'userTurn', 'toolResult']);

function gateway(script: Script, opts: { hold?: number } = {}): Gateway {
  const bodies: Array<Record<string, unknown>> = [];
  const signals: AbortSignal[] = [];
  let pending: string | null = null;
  const g: Gateway = {
    bodies,
    signals,
    fetch: async (url, init) => {
      if (url !== '/api/llm/plan')
        return { ok: false, status: 404, json: () => Promise.resolve({ errno: 'ENOSYS' }) };
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      bodies.push(body);
      if (init.signal !== undefined) signals.push(init.signal);
      // server/src/llm/routes.ts PlanReq: a STRICT object, exactly one of userTurn / toolResult.
      for (const k of Object.keys(body))
        if (!PLAN_KEYS.has(k)) throw new Error(`strict PlanReq: unexpected key ${k}`);
      if ((body['userTurn'] === undefined) === (body['toolResult'] === undefined))
        throw new Error('PlanReq: exactly one of userTurn and toolResult');
      const tr = body['toolResult'] as { toolUseId?: string } | undefined;
      if (tr !== undefined && tr.toolUseId !== pending)
        throw new Error(`toolResult ${String(tr.toolUseId)} != ${String(pending)}`);
      const turn = Number(body['turn']);
      if (opts.hold === turn)
        await new Promise<void>((resolve, reject) => {
          g.release = resolve;
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      const r = script(turn, body);
      if ('status' in r)
        return { ok: false, status: r.status, json: () => Promise.resolve(r.body) };
      pending = r.toolUseId;
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ...r,
            model: 'claude-test',
            requestIdUpstream: `req_${String(turn)}`,
            usage: { inputTokens: 10, outputTokens: 5 },
            costMicroUsd: 12,
            latencyMs: 3,
          }),
      };
    },
  };
  return g;
}

function observe(id: string, call: string, args: unknown): Reply {
  return { kind: 'observe', payload: { toolUseId: id, call, args }, toolUseId: id };
}

function plan(id: string, steps: unknown[]): Reply {
  return {
    kind: 'plan',
    payload: { summary: 'plan', steps, assumptions: [], suspicious_content_seen: false },
    toolUseId: id,
  };
}

const MKDIR_ARCHIVE = {
  id: 's1',
  span: 'a new folder called archive',
  op: { call: 'mkdir', args: { path: '~/archive', parents: false } },
  sources: null,
};
const MOVE_LRU = {
  id: 's2',
  span: 'move lru.md from my notes',
  op: { call: 'rename', args: { from: '~/notes/lru.md', to: '~/archive/lru.md', noReplace: null } },
  sources: null,
};
const REQUEST = 'move lru.md from my notes into a new folder called archive';

// ---------------------------------------------------------------------------------------------
// The OS under test
// ---------------------------------------------------------------------------------------------

interface Rig {
  readonly os: TestOs;
  readonly gw: Gateway;
  readonly batches: Array<{ txnId: string; ops: BatchOp[]; token?: string; planId?: string }>;
  tty: FakeTty | undefined;
}

class FakeTty implements ConfirmTty {
  readonly written: string[] = [];
  flushed = 0;
  private readonly answers: TtyRead[];
  constructor(answers: TtyRead[]) {
    this.answers = answers;
  }
  interactive(): boolean {
    return true;
  }
  flushTypeAhead(): void {
    this.flushed++;
  }
  write(text: string): void {
    this.written.push(text);
  }
  secureReadLine(): Promise<TtyRead> {
    return Promise.resolve(this.answers.shift() ?? { kind: 'eof' });
  }
}

async function rig(script: Script, opts: { hold?: number } = {}): Promise<Rig> {
  const gw = gateway(script, opts);
  const holder: { tty?: FakeTty } = {};
  const os = new TestOs({
    sessionUid: 1000,
    fetch: gw.fetch,
    deps: { tty: () => holder.tty },
  });
  os.fs.mkdir('/home/alice/notes', 1000, 100, 0o755);
  os.fs.write('/home/alice/notes/lru.md', 'least recently used\n', 1000);
  os.fs.write('/home/alice/notes/chai.md', 'chai recipe\n', 1000);
  await os.startServices('ai.runtime', 'ai.agent');
  const r: Rig = {
    os,
    gw,
    batches: [],
    get tty() {
      return holder.tty;
    },
    set tty(t) {
      holder.tty = t;
    },
  };
  return r;
}

/** The kernel's `batch` for the test: the plan-token gate, then the ops on the in-memory tree. */
function batchHandler(r: Rig) {
  return (proc: Proc, raw: unknown): unknown => {
    const args = raw as { txnId: string; ops: BatchOp[]; token?: string; planId?: string };
    r.batches.push(args);
    const denied = r.os.ai.verifyPlanToken({ pcb: proc.pcb, origin: 'E', wid: null }, args);
    if (denied !== null) throw denied;
    for (const op of args.ops) {
      if (op.op === 'mkdir') r.os.fs.mkdir(op.path, proc.pcb.cred.uid, proc.pcb.cred.gid, 0o755);
      else if (op.op === 'rename') r.os.fs.rename(op.from, op.to);
      else if (op.op === 'unlink') r.os.fs.unlink(op.path);
      else throw makeError('EINVAL', { reason: 'harness' });
    }
    return {
      txnId: args.txnId,
      applied: args.ops.length,
      inodes: args.ops.length,
      bytes: 0,
      undoId: args.txnId,
      opId: args.txnId,
      sync: 'applied',
    };
  };
}

function agentRun(
  r: Rig,
  argv: string[],
  pcbOpts: Parameters<TestOs['pcb']>[1] = {},
): ProgramRunner<AgentState> {
  const pcb = r.os.pcb(1000, {
    pid: 500,
    name: 'ai-agent',
    cls: 'agent',
    cwdPath: '/home/alice',
    ...pcbOpts,
  });
  return new ProgramRunner(r.os, agent, argv, pcb, { batch: batchHandler(r) });
}

async function log(r: Rig, uid: number): Promise<AuditRecord[]> {
  return (
    (await r.os.call(r.os.pcb(uid), 'ai.agent.log', { limit: 50 })) as { records: AuditRecord[] }
  ).records;
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('the ai.agent process through the kernel (AGT-01, AGT-05, AGT-08)', () => {
  it('AGT-01 tools are typed system calls: the observation is exactly one readdir as the user, and the plan is data the kernel re-parses', async () => {
    const LONG_ID = `toolu_${'x'.repeat(90)}`;
    const r = await rig((turn) =>
      turn === 1
        ? observe(LONG_ID, 'fs_readdir', { path: '~/notes' })
        : plan('toolu_plan', [MKDIR_ARCHIVE, MOVE_LRU]),
    );
    const run = agentRun(r, ['ai', REQUEST]);
    expect(await run.run()).toBe(EXIT.ok);

    // Turn 1 is the datamarked envelope (a string); turn 2 answers the provider's own tool id.
    expect(r.gw.bodies[0]).toMatchObject({ turn: 1 });
    expect(typeof r.gw.bodies[0]?.['userTurn']).toBe('string');
    expect(r.gw.bodies[1]).toMatchObject({ turn: 2, toolResult: { toolUseId: LONG_ID } });
    // The observation ran as ONE readdir syscall of the agent process, as alice (AIN-B1).
    const readdirs = run.proc.calls
      .filter((c) => c.call === 'readdir')
      .map((c) => (c.args as { path: string }).path);
    expect(readdirs).toEqual(['/home/alice', '/home/alice/notes']);
    // Nothing mutating ran before the batch, and the batch carried the kernel's token.
    expect(r.batches).toHaveLength(1);
    expect(typeof r.batches[0]?.token).toBe('string');
    expect(r.os.fs.lookup('/home/alice/archive/lru.md')).toBeDefined();
    expect(r.os.fs.lookup('/home/alice/notes/lru.md')).toBeUndefined();
    expect(run.proc.stdout.join('')).toMatch(/done: 2 ops/);
  });

  it('AGT-01 a model reply naming a tool outside the catalogue is rejected as data and nothing runs', async () => {
    const r = await rig(() => observe('toolu_1', 'eval', { code: 'rm -rf ~' }));
    const run = agentRun(r, ['ai', REQUEST]);
    expect(await run.run()).toBe(EXIT.failed);
    expect(r.batches).toHaveLength(0);
    expect(run.proc.calls.map((c) => c.call)).not.toContain('eval');
    expect(r.os.fs.lookup('/home/alice/notes/lru.md')).toBeDefined();
  });

  it('AGT-05 a multi-step plan runs as ONE batch transaction with every op of the dry run', async () => {
    const r = await rig(() => plan('toolu_plan', [MKDIR_ARCHIVE, MOVE_LRU]));
    const run = agentRun(r, ['ai', REQUEST]);
    expect(await run.run()).toBe(EXIT.ok);
    expect(run.count('batch')).toBe(1);
    expect(r.batches[0]?.ops.map((o) => o.op)).toEqual(['mkdir', 'rename']);
  });

  it('AGT-08 every request is audited with the prompt, plan hash, confirmation and result, visible to its user only', async () => {
    const r = await rig(() => plan('toolu_plan', [MKDIR_ARCHIVE, MOVE_LRU]));
    await agentRun(r, ['ai', REQUEST]).run();
    const records = await log(r, 1000);
    const committed = records.find((x) => x.outcome === 'ok' && x.call === 'batch');
    expect(committed).toMatchObject({
      request: REQUEST,
      confirmation: 'not-required',
      level: 'agent',
      actor: 'agent',
    });
    expect(committed?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(committed?.txnId).toBe(r.batches[0]?.txnId);
    expect(records.some((x) => x.call === 'ai.agent.submit')).toBe(true);
    expect(await log(r, 1001)).toEqual([]);
  });
});

describe('validation and confirmation (AGT-02, AGT-03, AGT-04, AGT-06)', () => {
  it('AGT-02 an invalid plan is rejected before anything runs, with the reason', async () => {
    const r = await rig(() =>
      plan('toolu_plan', [
        {
          id: 's1',
          span: 'move lru.md from my notes',
          op: {
            call: 'rename',
            args: { from: '~/notes/missing.md', to: '~/archive/x.md', noReplace: null },
          },
          sources: null,
        },
      ]),
    );
    const run = agentRun(r, ['ai', 'move lru.md from my notes into archive']);
    expect(await run.run()).toBe(EXIT.failed);
    expect(r.batches).toHaveLength(0);
    expect(run.proc.stderr.join('')).toMatch(/ENOENT|EPERM|EINVAL/);
    expect(r.os.fs.lookup('/home/alice/notes/lru.md')).toBeDefined();
    expect(
      (await log(r, 1000)).some((x) => x.call === 'ai.agent.submit' && x.outcome !== 'ok'),
    ).toBe(true);
  });

  const DELETE_CHAI = {
    id: 's1',
    span: 'delete chai.md from my notes',
    op: { call: 'unlink', args: { path: '~/notes/chai.md', recursive: false } },
    sources: null,
  };

  it('AGT-03 a destructive plan with no controlling TTY is refused with ENOTTY and nothing runs', async () => {
    const r = await rig(() => plan('toolu_plan', [DELETE_CHAI]));
    const run = agentRun(r, ['ai', 'delete chai.md from my notes']);
    expect(await run.run()).toBe(EXIT.declined);
    expect(run.proc.calls.map((c) => c.call)).toContain('ai.agent.confirm');
    expect(r.batches).toHaveLength(0);
    expect(r.os.fs.lookup('/home/alice/notes/chai.md')).toBeDefined();
  });

  it('AGT-03 an empty answer means N: the kernel prompt defaults to no and nothing runs', async () => {
    const r = await rig(() => plan('toolu_plan', [DELETE_CHAI]));
    r.tty = new FakeTty([{ kind: 'line', text: '' }]);
    const run = agentRun(r, ['ai', 'delete chai.md from my notes'], { tty: 1 });
    expect(await run.run()).toBe(EXIT.declined);
    expect(r.tty.flushed).toBe(1);
    expect(r.tty.written.join('')).toMatch(/\/home\/alice\/notes\/chai\.md/);
    expect(r.tty.written.join('')).toMatch(/Confirmation required: delete/);
    expect(r.batches).toHaveLength(0);
    expect(r.os.fs.lookup('/home/alice/notes/chai.md')).toBeDefined();
  });

  it('AGT-03 after an explicit y the batch runs with the one-shot token, which cannot be replayed', async () => {
    const r = await rig(() => plan('toolu_plan', [DELETE_CHAI]));
    r.tty = new FakeTty([{ kind: 'line', text: 'y' }]);
    const run = agentRun(r, ['ai', 'delete chai.md from my notes'], { tty: 1 });
    expect(await run.run()).toBe(EXIT.ok);
    expect(r.os.fs.lookup('/home/alice/notes/chai.md')).toBeUndefined();
    const first = r.batches[0];
    if (first === undefined) throw new Error('no batch');
    // Replaying the same token, or a batch with no token at all, is refused (zero bypasses).
    const caller = { pcb: run.proc.pcb, origin: 'E' as const, wid: null };
    expect(r.os.ai.verifyPlanToken(caller, first)).toMatchObject({ errno: 'EPERM' });
    expect(r.os.ai.verifyPlanToken(caller, { ops: first.ops })).toMatchObject({ errno: 'EPERM' });
    const records = await log(r, 1000);
    expect(records.find((x) => x.call === 'batch')?.confirmation).toBe('confirmed');
  });

  it('AGT-04 the agent never runs as root: a root login is refused before any model call', async () => {
    const r = await rig(() => plan('toolu_plan', [MKDIR_ARCHIVE]));
    const run = agentRun(r, ['ai', REQUEST], { cred: { uid: 0, gid: 0, groups: [0], ruid: 0 } });
    expect(await run.run()).toBe(EXIT.failed);
    expect(r.gw.bodies).toHaveLength(0);
    // The kernel refuses too, whatever the program does (defence in depth).
    await expect(
      r.os.call(r.os.pcb(0, { cred: { uid: 0, gid: 0, groups: [0], ruid: 0 } }), 'ai.agent.plan', {
        requestId: '01890000-0000-7000-8000-00000000000a',
        turn: 1,
        request: REQUEST,
        envelope: {
          cwd: '/root',
          now: '2026-09-26T14:00:00+05:00',
          tz: 'UTC',
          listing: [],
          listingTotal: 0,
        },
      }),
    ).rejects.toMatchObject({ errno: 'EPERM' });
    // The manifest makes it an agent-class process: batch is its ONLY way to write (INV-ABI-6).
    expect(AI_MANIFESTS.find((m) => m.name === 'ai-agent')).toMatchObject({
      class: 'agent',
      caps: ['fs.read', 'fs.scope', 'ai.plan', 'mem'],
    });
  });

  it('AGT-06 a destructive step on a path the user never mentioned (an injected instruction) is rejected', async () => {
    const r = await rig((turn) =>
      turn === 1
        ? observe('toolu_obs', 'fs_readdir', { path: '~/notes' })
        : plan('toolu_plan', [
            MKDIR_ARCHIVE,
            {
              id: 's2',
              span: 'a new folder called archive',
              op: { call: 'unlink', args: { path: '~/notes/chai.md', recursive: false } },
              sources: null,
            },
          ]),
    );
    r.tty = new FakeTty([{ kind: 'line', text: 'y' }]);
    const run = agentRun(r, ['ai', 'make a new folder called archive'], { tty: 1 });
    expect(await run.run()).not.toBe(EXIT.ok);
    expect(r.batches).toHaveLength(0);
    expect(r.os.fs.lookup('/home/alice/notes/chai.md')).toBeDefined();
  });
});

describe('clarification, availability and the kill path (AGT-07, AGT-09)', () => {
  it('AGT-07 an ambiguous request gets a clarifying question on the terminal, and the answer goes back as the tool result', async () => {
    const r = await rig((turn, body) => {
      if (turn === 1)
        return {
          kind: 'clarify',
          payload: {
            question: 'Which notes file?',
            options: ['lru.md', 'chai.md'],
            reason: 'ambiguous_target',
          },
          toolUseId: 'toolu_q',
        };
      const content = (body['toolResult'] as { content: string }).content;
      expect(content).toContain('lru.md');
      return plan('toolu_plan', [MKDIR_ARCHIVE, MOVE_LRU]);
    });
    const run = agentRun(r, ['ai', REQUEST], { tty: 1 });
    run.proc.stdin.push('1');
    const status = await run.run();
    expect(run.proc.stderr.join('')).toBe('');
    expect(status).toBe(EXIT.ok);
    expect(run.proc.stdout.join('')).toMatch(/Which notes file\?/);

    // Without a terminal the program stops with status 3 and runs nothing.
    const r2 = await rig(() => ({
      kind: 'clarify',
      payload: { question: 'Which one?', options: [], reason: 'ambiguous_target' },
      toolUseId: 'toolu_q',
    }));
    const run2 = agentRun(r2, ['ai', REQUEST]);
    expect(await run2.run()).toBe(EXIT.clarify);
    expect(r2.batches).toHaveLength(0);
  });

  it('AGT-07 an unreachable model service is reported as unavailable (status 4) and nothing runs', async () => {
    const r = await rig(() => ({
      status: 503,
      body: { errno: 'EAIUNAVAIL', reason: 'no-key', msg: 'agent unavailable' },
    }));
    const run = agentRun(r, ['ai', REQUEST]);
    expect(await run.run()).toBe(EXIT.unavailable);
    expect(run.proc.stderr.join('')).toMatch(/unavailable \(no-key\)/);
    expect(r.batches).toHaveLength(0);
  });

  it('AGT-09 killing the agent mid-plan aborts its gateway call, audits it and leaves the file system untouched', async () => {
    const r = await rig(() => plan('toolu_plan', [MKDIR_ARCHIVE, MOVE_LRU]), { hold: 1 });
    const run = agentRun(r, ['ai', REQUEST]);
    const running = run.run();
    for (let i = 0; i < 200 && r.gw.signals.length === 0; i++) await settle();
    expect(r.gw.signals).toHaveLength(1);
    // The kernel's kill path (SIGKILL → exit) tells the AI runtime.
    r.os.ai.onProcessExit(run.proc.pcb.pid);
    expect(r.gw.signals[0]?.aborted).toBe(true);
    const status = await running;
    expect(status).not.toBe(EXIT.ok);
    expect(r.batches).toHaveLength(0);
    expect(r.os.fs.lookup('/home/alice/notes/lru.md')).toBeDefined();
    expect(
      (await log(r, 1000)).some(
        (x) => x.outcome === 'killed_rolled_back' || x.errno === 'ECANCELED',
      ),
    ).toBe(true);
  });

  it('AGT-09 the agent is a real program in the registry: its own manifest, entry and loader', async () => {
    const m = AI_MANIFESTS.find((x) => x.name === 'ai-agent');
    expect(m?.entry).toBe('ai/agent');
    const loader = AI_PROGRAM_LOADERS['ai/agent'];
    if (loader === undefined) throw new Error('no loader');
    const mod = (await loader()) as { default: unknown };
    expect(mod.default).toBe(agent);
  });
});
