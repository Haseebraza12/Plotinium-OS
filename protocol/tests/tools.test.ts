import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { PlanStep, PlanTurn } from '../src/ai/agent.ts';
import type { STEP_ARG_SCHEMAS } from '../src/ai/tools.ts';
import {
  AGENT_TOOL_NAMES,
  AskClarificationInput,
  CannotComplyInput,
  planStepArgsSchema,
  READ_ONLY_TOOLS,
  STEP_SYSCALL,
  SubmitPlanInput,
  TERMINAL_TOOLS,
  toPlanStep,
  ToolStep,
} from '../src/ai/tools.ts';
import { READ_ONLY_TOOL_CALLS } from '../src/audit.ts';
import { CALLS } from '../src/sys/registry.ts';

const parse = (schema: v.GenericSchema, input: unknown) =>
  v.safeParse(schema, input, { abortEarly: true });

const TOOL_INPUTS: Record<keyof typeof READ_ONLY_TOOLS, unknown[]> = {
  fs_readdir: [{ path: '/home/alice' }],
  fs_stat: [{ path: 'notes.md' }],
  fs_find: [
    { path: '.', name: null, type: null, mtime: null, size: null, maxdepth: null },
    {
      path: '/home/alice/docs',
      name: '*.pdf',
      type: 'f',
      mtime: { within: { unit: 'week', count: 1, mode: 'rolling' }, olderThan: null },
      size: { gt: 1024, lt: null },
      maxdepth: 2,
    },
    {
      path: '.',
      name: null,
      type: 'd',
      mtime: { within: null, olderThan: { unit: 'month', count: 3, mode: 'calendar' } },
      size: null,
      maxdepth: 0,
    },
  ],
  fs_grep: [{ paths: ['/home/alice'], text: 'invoice', ignoreCase: true, mode: 'l' }],
  fs_du: [
    { path: '.', depth: null },
    { path: '.', depth: 1 },
  ],
  fs_wc: [{ paths: ['a.txt', 'b.txt'] }],
};

const STEP_SAMPLES: Record<keyof typeof STEP_ARG_SCHEMAS, unknown> = {
  mkdir: { path: 'archive/2025', parents: true },
  write: { path: 'todo.txt', text: 'buy milk' },
  rename: { from: 'a.md', to: 'b.md', noReplace: null },
  copy: { from: 'a.md', to: 'backup/a.md', recursive: false },
  unlink: { path: 'drafts', recursive: true },
  symlink: { target: '../shared/report.pdf', path: 'report.pdf' },
  chmod: { path: 'secret.txt', mode: { symbolic: 'go-rwx' }, recursive: false },
  chown: { path: 'shared', uid: null, gid: 200, recursive: true },
  utimes: { path: 'notes.md' },
  find: { path: '.', name: '*.log', type: 'f', mtime: null, size: null, maxdepth: null },
  glob: { path: 'downloads', name: '*.zip' },
};

type Node = Record<string, unknown>;
function* nodes(root: unknown): Generator<Node> {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || typeof n !== 'object') continue;
    const node = n as Node;
    yield node;
    stack.push(
      ...Object.values((node['entries'] as Node | undefined) ?? {}),
      ...((node['options'] as unknown[] | undefined) ?? []).filter((o) => typeof o === 'object'),
      ...((node['items'] as unknown[] | undefined) ?? []),
      ...['item', 'wrapped', 'key', 'value'].map((k) => node[k]),
    );
  }
}

describe('protocol/tools: model-facing agent tools (agentic-shell.md §3.6)', () => {
  it('AGT-01 every tool maps to exactly one syscall schema in protocol', () => {
    for (const [name, tool] of Object.entries(READ_ONLY_TOOLS)) {
      expect(tool.name).toBe(name);
      expect(Object.hasOwn(CALLS, tool.call), name).toBe(true);
      expect(READ_ONLY_TOOL_CALLS, name).toContain(tool.call);
    }
    expect(
      Object.values(READ_ONLY_TOOLS)
        .map((t) => t.call)
        .sort(),
    ).toEqual([...READ_ONLY_TOOL_CALLS].sort());
    for (const [op, call] of Object.entries(STEP_SYSCALL))
      expect(Object.hasOwn(CALLS, call), op).toBe(true);
  });

  it('AGT-01 read-only tool inputs convert to arguments the target syscall accepts', () => {
    for (const [name, tool] of Object.entries(READ_ONLY_TOOLS)) {
      for (const input of TOOL_INPUTS[name as keyof typeof READ_ONLY_TOOLS]) {
        const parsed = parse(tool.input, input);
        expect(parsed.success, `${name} input`).toBe(true);
        if (!parsed.success) continue;
        const args = (tool.toArgs as (i: unknown) => unknown)(parsed.output);
        const r = parse(CALLS[tool.call].args, args);
        expect(r.success, `${name} → ${tool.call} ${r.issues?.[0]?.message ?? ''}`).toBe(true);
      }
    }
    const find = READ_ONLY_TOOLS.fs_find.toArgs(
      v.parse(READ_ONLY_TOOLS.fs_find.input, TOOL_INPUTS.fs_find[1]),
    );
    expect(find).toEqual({
      path: '/home/alice/docs',
      name: '*.pdf',
      type: 'f',
      mtime: { within: { unit: 'week', count: 1, mode: 'rolling' } },
      size: { gt: 1024 },
      maxDepth: 2,
      limit: 500,
    });
    const grep = READ_ONLY_TOOLS.fs_grep.toArgs(
      v.parse(READ_ONLY_TOOLS.fs_grep.input, TOOL_INPUTS.fs_grep[0]),
    );
    expect(grep).toEqual({
      paths: ['/home/alice'],
      pattern: 'invoice',
      recursive: true,
      ignoreCase: true,
      mode: 'l',
      limit: 500,
    });
  });

  it('AGT-01 a malformed model tool call is rejected by the protocol schema', () => {
    const find = READ_ONLY_TOOLS.fs_find.input;
    expect(parse(find, { path: '.' }).success).toBe(false); // every key is required
    expect(
      parse(find, {
        path: '.',
        name: null,
        type: null,
        mtime: null,
        size: null,
        maxdepth: null,
        regex: '.*',
      }).success,
    ).toBe(false);
    expect(
      parse(find, { path: '.', name: null, type: 'x', mtime: null, size: null, maxdepth: null })
        .success,
    ).toBe(false);
    const both = {
      within: { unit: 'day', count: 1, mode: 'rolling' },
      olderThan: { unit: 'day', count: 2, mode: 'rolling' },
    };
    expect(
      parse(find, { path: '.', name: null, type: null, mtime: both, size: null, maxdepth: null })
        .success,
    ).toBe(false);
    expect(
      parse(find, {
        path: '.',
        name: null,
        type: null,
        mtime: { within: null, olderThan: null },
        size: null,
        maxdepth: null,
      }).success,
    ).toBe(false);
    expect(
      parse(READ_ONLY_TOOLS.fs_grep.input, { paths: [], text: 'x', ignoreCase: false, mode: 'l' })
        .success,
    ).toBe(false);
  });

  it("ABI-14 tool input schemas use only Claude's strict subset: strict objects, every key required, no binary, records or recursion", () => {
    const inputs = [
      ...Object.values(READ_ONLY_TOOLS).map((t) => t.input),
      ...Object.values(TERMINAL_TOOLS).map((t) => t.input),
    ];
    for (const input of inputs) {
      for (const node of nodes(input)) {
        expect([
          'object',
          'loose_object',
          'object_with_rest',
          'optional',
          'exact_optional',
          'undefinedable',
          'nullish',
          'instance',
          'lazy',
          'record',
          'unknown',
          'any',
          'map',
          'set',
          'blob',
          'promise',
          'function',
        ]).not.toContain(node['type']);
      }
    }
  });

  it('ABI-14 agent tool names are unique, sorted and snake_case', () => {
    expect(AGENT_TOOL_NAMES).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOL_NAMES.length);
    for (const name of AGENT_TOOL_NAMES) expect(name).toMatch(/^[a-z][a-z_]*$/);
    expect(AGENT_TOOL_NAMES).toContain('submit_plan');
  });

  it('AGT-02 plan steps convert to ABI plan steps whose args re-parse with the schema of their op', () => {
    for (const [op, args] of Object.entries(STEP_SAMPLES)) {
      const tool = { id: 's1', span: 'tidy my files', op: { call: op, args }, sources: null };
      const parsed = v.safeParse(ToolStep, tool);
      expect(parsed.success, `${op} ${parsed.issues?.[0]?.message ?? ''}`).toBe(true);
      if (!parsed.success) continue;
      const step = toPlanStep(parsed.output, 0o022);
      expect(step, op).toBeDefined();
      if (step === undefined) continue;
      expect(parse(PlanStep, step).success, op).toBe(true);
      const r = parse(planStepArgsSchema(step.op), step.args);
      expect(r.success, `${op} args ${r.issues?.[0]?.message ?? ''}`).toBe(true);
    }
    const chmod = toPlanStep(
      v.parse(ToolStep, {
        id: 's2',
        span: 'hide it',
        op: { call: 'chmod', args: STEP_SAMPLES.chmod },
        sources: null,
      }),
      0o022,
    );
    expect(chmod?.args).toEqual({
      path: 'secret.txt',
      mode: { op: 'delta', add: 0, clear: 0o077 },
      recursive: false,
    });
    const utimes = toPlanStep(
      v.parse(ToolStep, {
        id: 's3',
        span: 'touch',
        op: { call: 'utimes', args: STEP_SAMPLES.utimes },
        sources: { ref: 's1' },
      }),
      0o022,
    );
    expect(utimes).toEqual({
      id: 's3',
      op: 'utimes',
      args: { path: 'notes.md', mtime: 'now' },
      span: 'touch',
      sources: { ref: 's1' },
    });
  });

  it('AGT-02 an unsupported chmod mode yields no plan step, so validation rejects it', () => {
    const bad = v.parse(ToolStep, {
      id: 's1',
      span: 'x',
      op: { call: 'chmod', args: { path: 'a', mode: { symbolic: 'a+X' }, recursive: true } },
      sources: null,
    });
    expect(toPlanStep(bad, 0o022)).toBeUndefined();
    const setuid = v.parse(ToolStep, {
      id: 's1',
      span: 'x',
      op: { call: 'chmod', args: { path: 'a', mode: { set: '4755' }, recursive: false } },
      sources: null,
    });
    expect(toPlanStep(setuid, 0o022)).toBeUndefined();
    expect(
      parse(ToolStep, {
        id: 's1',
        span: 'x',
        op: { call: 'rmdir', args: { path: 'a' } },
        sources: null,
      }).success,
    ).toBe(false);
    expect(
      parse(ToolStep, {
        id: 's26',
        span: 'x',
        op: { call: 'utimes', args: { path: 'a' } },
        sources: null,
      }).success,
    ).toBe(true);
  });

  it('AGT-01 the terminal tools accept well-formed calls and reject extra keys', () => {
    const plan = {
      summary: 'tidy',
      steps: [
        { id: 's1', span: 'tidy', op: { call: 'mkdir', args: STEP_SAMPLES.mkdir }, sources: null },
      ],
      assumptions: [],
      suspicious_content_seen: false,
    };
    expect(parse(SubmitPlanInput, plan).success).toBe(true);
    expect(
      parse(SubmitPlanInput, { ...plan, steps: Array.from({ length: 26 }, () => plan.steps[0]) })
        .success,
    ).toBe(false);
    expect(
      parse(AskClarificationInput, {
        question: 'Which folder?',
        options: ['docs'],
        reason: 'ambiguous_target',
      }).success,
    ).toBe(true);
    expect(
      parse(AskClarificationInput, {
        question: 'x',
        options: ['1', '2', '3', '4', '5', '6'],
        reason: 'ambiguous_target',
      }).success,
    ).toBe(false);
    expect(parse(CannotComplyInput, { reason: 'outside your home', extra: 1 }).success).toBe(false);
    expect(
      parse(PlanTurn, {
        kind: 'plan',
        steps: [{ id: 's1', op: 'mkdir', args: { path: 'a' }, span: 'x' }],
      }).success,
    ).toBe(true);
  });
});
