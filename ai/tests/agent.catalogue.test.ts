import { CALLS, READ_ONLY_TOOL_CALLS, STEP_SYSCALL } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { isTerminalToolName, readOnlyCall, toolCatalogue } from '../src/agent/catalogue.ts';
import { decodeToolUse } from '../src/agent/decode.ts';
import {
  type JsonObject,
  buildToolDefinitions,
  serialiseTools,
  strictViolations,
  toStrictSubset,
} from '../src/agent/strict-schema.ts';

/** The shape `@valibot/to-json-schema` emits for `fs_find` (before post-processing). */
const FS_FIND_RAW: JsonObject = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 4096 },
    name: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    type: { anyOf: [{ enum: ['f', 'd', 'l'] }, { type: 'null' }] },
    mtime: { anyOf: [{ $ref: '#/$defs/RelTime' }, { type: 'null' }] },
    size: {
      anyOf: [
        {
          type: 'object',
          properties: {
            gt: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
            lt: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
          required: ['gt', 'lt'],
        },
        { type: 'null' },
      ],
    },
    maxdepth: { anyOf: [{ type: 'integer', minimum: 0, maximum: 64 }, { type: 'null' }] },
    pattern: { type: 'string', pattern: '^x$' },
  },
  required: ['path', 'name', 'type', 'mtime', 'size', 'maxdepth'],
  $defs: {
    RelTime: {
      type: 'object',
      properties: {
        within: { oneOf: [{ $ref: '#/$defs/RelSpan' }, { type: 'null' }] },
        olderThan: { oneOf: [{ $ref: '#/$defs/RelSpan' }, { type: 'null' }] },
      },
      required: ['within', 'olderThan'],
    },
    RelSpan: {
      type: 'object',
      properties: {
        unit: { enum: ['hour', 'day', 'week', 'month'] },
        count: { type: 'integer', minimum: 1, maximum: 365, multipleOf: 1 },
        mode: { enum: ['rolling', 'calendar'] },
      },
      required: ['unit', 'count', 'mode'],
      additionalProperties: true,
    },
  },
};

describe('tool catalogue (AGT-01)', () => {
  it('AGT-01 every tool maps to exactly one syscall schema in protocol', () => {
    const cat = toolCatalogue();
    expect(cat.map((c) => c.name)).toEqual([...cat.map((c) => c.name)].sort());
    for (const entry of cat) {
      expect(Object.hasOwn(CALLS, entry.syscall), entry.name).toBe(true);
    }
    const readOnly = cat.filter((c) => c.kind === 'read-only');
    expect(new Set(readOnly.map((c) => c.syscall))).toEqual(new Set(READ_ONLY_TOOL_CALLS));
    expect(cat.filter((c) => c.kind === 'step')).toHaveLength(Object.keys(STEP_SYSCALL).length);
    expect(
      cat
        .filter((c) => c.kind === 'terminal')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['ask_clarification', 'cannot_comply', 'submit_plan']);
    expect(isTerminalToolName('submit_plan')).toBe(true);
    expect(isTerminalToolName('eval')).toBe(false);
  });

  it('AGT-01 a read-only tool call becomes its syscall args and is re-parsed with the syscall schema', () => {
    const r = readOnlyCall('fs_find', {
      path: '/home/alice',
      name: '*.pdf',
      type: 'f',
      mtime: { within: { unit: 'week', count: 1, mode: 'calendar' }, olderThan: null },
      size: { gt: 10, lt: null },
      maxdepth: 3,
    });
    expect(r.ok && r.value).toEqual({
      call: 'find',
      args: {
        path: '/home/alice',
        name: '*.pdf',
        type: 'f',
        mtime: { within: { unit: 'week', count: 1, mode: 'calendar' } },
        size: { gt: 10 },
        maxDepth: 3,
        limit: 500,
      },
    });
    expect(
      readOnlyCall('fs_grep', { paths: ['/a'], text: 'x', ignoreCase: false, mode: 'l' }).ok,
    ).toBe(true);
    expect(readOnlyCall('fs_find', { path: '/a', extra: 1 }).ok).toBe(false);
    expect(readOnlyCall('rm', { path: '/' }).ok).toBe(false);
  });

  it('AGT-01 model tool input is parsed with Valibot and never reaches eval, Function or the shell parser', () => {
    const evilPath = '/home/alice/$(rm -rf ~); `reboot`';
    const d = decodeToolUse(
      {
        id: 'toolu_1',
        name: 'submit_plan',
        input: {
          summary: 'x',
          steps: [
            {
              id: 's1',
              span: 'remove it',
              op: { call: 'unlink', args: { path: evilPath, recursive: false } },
              sources: null,
            },
          ],
          assumptions: [],
          suspicious_content_seen: false,
        },
      },
      0o022,
    );
    // The string survives only as data: it is a path argument, never interpreted.
    expect(d.ok && d.value.kind === 'plan' && d.value.steps[0]?.args).toEqual({
      path: evilPath,
      recursive: false,
    });
    // Unknown tools, extra keys and bad chmod modes are EINVAL.
    expect(decodeToolUse({ id: 'toolu_2', name: 'eval', input: 'process.exit()' }, 0o022).ok).toBe(
      false,
    );
    expect(decodeToolUse({ id: 'bad id!', name: 'fs_stat', input: { path: '/' } }, 0o022).ok).toBe(
      false,
    );
    expect(
      decodeToolUse(
        {
          id: 'toolu_3',
          name: 'submit_plan',
          input: {
            summary: 'x',
            steps: [
              {
                id: 's1',
                span: 'x',
                op: {
                  call: 'chmod',
                  args: { path: '/a', mode: { symbolic: 'u+s' }, recursive: false },
                },
                sources: null,
              },
            ],
            assumptions: [],
            suspicious_content_seen: false,
          },
        },
        0o022,
      ).ok,
    ).toBe(false);
    expect(
      decodeToolUse(
        {
          id: 'toolu_4',
          name: 'submit_plan',
          input: { summary: 'x', steps: [], assumptions: [], suspicious_content_seen: false },
        },
        0o022,
      ).ok,
    ).toBe(false);
  });

  it('AGT-01 terminal tools decode into clarify and cannot turns', () => {
    const c = decodeToolUse(
      {
        id: 'toolu_5',
        name: 'ask_clarification',
        input: { question: 'Which?', options: ['a'], reason: 'ambiguous_target' },
      },
      0o022,
    );
    expect(c.ok && c.value.kind).toBe('clarify');
    const n = decodeToolUse(
      { id: 'toolu_6', name: 'cannot_comply', input: { reason: 'no tool' } },
      0o022,
    );
    expect(n.ok && n.value.kind).toBe('cannot');
    expect(decodeToolUse({ id: 'toolu_7', name: 'cannot_comply', input: {} }, 0o022).ok).toBe(
      false,
    );
    expect(
      decodeToolUse({ id: 'toolu_8', name: 'ask_clarification', input: { question: '' } }, 0o022)
        .ok,
    ).toBe(false);
    const t = decodeToolUse({ id: 'toolu_9', name: 'fs_stat', input: { path: '/' } }, 0o022);
    expect(t.ok && t.value).toEqual({
      kind: 'tool',
      callId: 'toolu_9',
      call: 'stat',
      args: { path: '/', follow: true },
    });
  });
});

describe('strict schema post-processor (AGT-01)', () => {
  it('AGT-01 strict tool schemas contain no unsupported keyword', () => {
    expect(strictViolations(FS_FIND_RAW).length).toBeGreaterThan(0);
    const strict = toStrictSubset(FS_FIND_RAW);
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    expect(strictViolations(strict.value)).toEqual([]);
    const s = strict.value;
    expect(s['required']).toEqual(['maxdepth', 'mtime', 'name', 'path', 'pattern', 'size', 'type']);
    expect(s['additionalProperties']).toBe(false);
    // The optional `pattern` PROPERTY keeps its name and becomes nullable; the keyword is stripped.
    expect((s['properties'] as JsonObject)['pattern']).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(JSON.stringify(s)).not.toContain('oneOf');
    expect(JSON.stringify(s)).not.toContain('$ref');
  });

  it('AGT-01 recursive and unknown references fail the build step', () => {
    const rec: JsonObject = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/N' } },
      $defs: { N: { type: 'object', properties: { next: { $ref: '#/$defs/N' } } } },
    };
    const r = toStrictSubset(rec);
    expect(!r.ok && r.error.reason).toBe('recursive-schema');
    const u = toStrictSubset({ type: 'object', properties: { a: { $ref: '#/$defs/Missing' } } });
    expect(!u.ok && u.error.reason).toBe('unknown-ref');
  });

  it('AGT-01 tool definitions are sorted by name, strict and byte-stable', () => {
    const tools = [
      {
        name: 'fs_stat',
        description: 'b',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', format: 'uri-reference' } },
          required: ['path'],
        } as JsonObject,
      },
      { name: 'fs_find', description: 'a', inputSchema: FS_FIND_RAW },
    ];
    const built = buildToolDefinitions(tools);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.map((t) => t.name)).toEqual(['fs_find', 'fs_stat']);
    expect(built.value.every((t) => t.strict)).toBe(true);
    const again = buildToolDefinitions([...tools].reverse());
    expect(again.ok && serialiseTools(again.value)).toBe(serialiseTools(built.value));
    expect(
      strictViolations({
        type: 'object',
        properties: { a: { type: 'array', minItems: 2 } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toEqual(['$.properties.a: minItems 2']);
    const bad = buildToolDefinitions([
      { name: 'x', description: '', inputSchema: { $ref: '#/$defs/Nope' } },
    ]);
    expect(!bad.ok && bad.error.step).toBe('x');
  });
});
