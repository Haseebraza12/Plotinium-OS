import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
} from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { ErrnoError } from '../../errno.ts';
import { HttpError } from '../../http/errors.ts';
import {
  AnthropicProvider,
  buildMessageParams,
  classifyProviderError,
  createAnthropicClient,
  parseEffort,
  textOf,
  toolCallOf,
  usageOf,
  type BetaTool,
} from './anthropic.ts';
import { CassetteMiss } from './cassette.ts';
import { assertStrictTools, nullsToAbsent, strictSchemaProblems } from './strict-tools.ts';
import { FakeSdk, fakeMessage } from './tests/fixtures.ts';

/** agentic-shell.md §3.7 example (trimmed), a strict-compatible schema. */
const FS_FIND: BetaTool = {
  name: 'fs_find',
  description: 'Read-only. Find entries under a directory as the user.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['maxdepth', 'name', 'path', 'size', 'type'],
    properties: {
      maxdepth: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      path: { type: 'string' },
      size: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['gt', 'lt'],
            properties: {
              gt: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
              lt: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            },
          },
          { type: 'null' },
        ],
      },
      type: { anyOf: [{ type: 'string', enum: ['d', 'f', 'l'] }, { type: 'null' }] },
    },
  },
};
const SUBMIT: BetaTool = {
  name: 'submit_plan',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['steps'],
    properties: { steps: { type: 'array', items: { type: 'string' } } },
  },
};

describe('The Anthropic adapter (backend-api.md §3.13.4; agentic-shell.md §3.7, §4.3)', () => {
  it('AGT-01 strict tool schemas contain no unsupported keyword', () => {
    expect(strictSchemaProblems(FS_FIND.input_schema)).toEqual([]);
    const bad = {
      type: 'object',
      properties: {
        a: { type: 'string', minLength: 1, pattern: 'x' },
        b: { oneOf: [{ type: 'string' }] },
        c: {
          type: 'array',
          items: { type: 'object', properties: { d: { type: 'string', format: 'color' } } },
          minItems: 2,
        },
        e: { $ref: '#/$defs/x' },
      },
      required: ['a', 'b', 'zz'],
    };
    expect(strictSchemaProblems(bad)).toEqual(
      expect.arrayContaining([
        '$: additionalProperties must be false',
        '$.c: not in required',
        '$: required names unknown property zz',
        '$.a: unsupported keyword minLength',
        '$.a: unsupported keyword pattern',
        '$.b: unsupported keyword oneOf',
        '$.c: minItems other than 0 or 1',
        '$.c[]: additionalProperties must be false',
        '$.c[].d: unsupported format color',
        '$.e: unsupported keyword $ref',
      ]),
    );
    expect(strictSchemaProblems('x')).toEqual(['$: not a schema object']);
    expect(strictSchemaProblems(true)).toEqual([]);
    expect(() => assertStrictTools([FS_FIND, SUBMIT])).not.toThrow();
    expect(() => assertStrictTools([FS_FIND, FS_FIND])).toThrow(/duplicate tool name/);
    expect(() =>
      assertStrictTools([{ name: 'bad name', input_schema: { type: 'string' } }]),
    ).toThrow(ErrnoError);
  });

  it('AGT-01 the request is byte-stable: tools sorted by name, schema keys sorted, strict on every tool, cache breakpoints on the last tool and the system block', () => {
    const shuffled: BetaTool = {
      ...FS_FIND,
      input_schema: {
        properties: FS_FIND.input_schema.properties,
        required: FS_FIND.input_schema.required,
        additionalProperties: false,
        type: 'object',
      },
    };
    const a = buildMessageParams({
      model: 'claude-opus-5-5',
      maxTokens: 8000,
      effort: 'medium',
      system: 'S',
      tools: [SUBMIT, FS_FIND],
      messages: [],
      fallbacks: true,
    });
    const b = buildMessageParams({
      model: 'claude-opus-5-5',
      maxTokens: 8000,
      effort: 'medium',
      system: 'S',
      tools: [shuffled, SUBMIT],
      messages: [],
      fallbacks: true,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tools?.map((t) => ('name' in t ? t.name : ''))).toEqual(['fs_find', 'submit_plan']);
    expect(a.tools?.every((t) => 'strict' in t && t.strict === true)).toBe(true);
    expect(
      a.tools?.[0] && 'cache_control' in a.tools[0] ? a.tools[0].cache_control : 'absent',
    ).toBe('absent');
    expect(a.tools?.[1] && 'cache_control' in a.tools[1] ? a.tools[1].cache_control : null).toEqual(
      { type: 'ephemeral' },
    );
    expect(a.system).toEqual([{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }]);
    expect(a.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(a).toMatchObject({
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const noTools = buildMessageParams({
      model: 'claude-sonnet-4-6',
      maxTokens: 10,
      effort: 'low',
      system: 'S',
      tools: [],
      messages: [],
      fallbacks: false,
      temperature: 0,
    });
    expect(noTools.tools).toBeUndefined();
    expect(noTools.tool_choice).toBeUndefined();
    expect(noTools.betas).toBeUndefined();
    expect(noTools.temperature).toBe(0); // only when LLM_TEMPERATURE is configured (§3.13.6)
  });

  it('AGT-01 nulls of nullable strict fields become absent before the Valibot re-parse', () => {
    expect(nullsToAbsent({ a: null, b: [{ c: null, d: 1 }], e: 'x' })).toEqual({
      b: [{ d: 1 }],
      e: 'x',
    });
  });

  it('AIS-06 the client takes the key only from configuration, with no other credential source, and effort defaults to medium', () => {
    const c = createAnthropicClient({ apiKey: 'configured-key', maxRetries: 1, timeoutMs: 45_000 });
    expect(c.apiKey).toBe('configured-key');
    expect(c.authToken).toBeNull();
    expect(c.baseURL).toBe('https://api.anthropic.com');
    expect(c.maxRetries).toBe(1);
    expect(c.timeout).toBe(45_000);
    expect(parseEffort('high')).toBe('high');
    expect(parseEffort('extreme')).toBe('medium');
  });

  it('AIS-06 the provider streams with the signal, the per-turn deadline and maxRetries 1, and reads usage, tool call and text', async () => {
    const sdk = new FakeSdk([
      fakeMessage({
        text: 'a',
        tool: { name: 'fs_find', input: { path: '/' } },
        usage: { cacheWrite: 10, cacheWrite1h: 4 },
      }),
    ]);
    const signal = new AbortController().signal;
    const r = await new AnthropicProvider(sdk).send(
      buildMessageParams({
        model: 'm',
        maxTokens: 1,
        effort: 'medium',
        system: 's',
        tools: [],
        messages: [],
        fallbacks: false,
      }),
      { signal, timeoutMs: 123 },
    );
    expect(sdk.calls[0]?.options).toEqual({ signal, timeout: 123, maxRetries: 1 });
    expect(r.requestId).toBe('req_1');
    expect(usageOf(r.message)).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 10,
      cacheWrite1h: 4,
    });
    expect(toolCallOf(r.message)).toEqual({
      id: 'toolu_01',
      name: 'fs_find',
      input: { path: '/' },
    });
    expect(textOf(r.message)).toBe('a');
    expect(toolCallOf(fakeMessage({ text: 'b' }))).toBeNull();
  });

  it('AIS-02 provider failures map to the degraded states of §3.13.7 with typed SDK errors, most specific first', () => {
    const ctx = { deadline: false, cancelled: false };
    const map = (e: unknown, c = ctx) => {
      const { error, bug } = classifyProviderError(e, c);
      return [error.status, error.errno, error.reason, bug];
    };
    expect(map(new Error('x'), { deadline: true, cancelled: false })).toEqual([
      504,
      'EAIUNAVAIL',
      'timeout',
      false,
    ]);
    expect(map(new APIConnectionTimeoutError())).toEqual([504, 'EAIUNAVAIL', 'timeout', false]);
    expect(map(new APIUserAbortError())).toEqual([500, 'ECANCELED', 'killed', false]);
    expect(map(new Error('x'), { deadline: false, cancelled: true })).toEqual([
      500,
      'ECANCELED',
      'killed',
      false,
    ]);
    expect(map(new NotFoundError(404, {}, 'no such model', new Headers()))).toEqual([
      503,
      'EAIUNAVAIL',
      'upstream',
      true,
    ]);
    expect(map(new PermissionDeniedError(403, {}, 'no', new Headers()))).toEqual([
      503,
      'EAIUNAVAIL',
      'upstream',
      false,
    ]);
    expect(map(new InternalServerError(529, {}, 'overloaded', new Headers()))).toEqual([
      503,
      'EAIUNAVAIL',
      'upstream',
      false,
    ]);
    expect(map(new APIConnectionError({ message: 'reset' }))).toEqual([
      503,
      'EAIUNAVAIL',
      'upstream',
      false,
    ]);
    expect(map(new TypeError('boom'))).toEqual([503, 'EAIUNAVAIL', 'upstream', true]);
    // errors of the cassette fetch arrive wrapped in the SDK's connection error
    expect(map(new APIConnectionError({ cause: new CassetteMiss('f'.repeat(64), '') }))).toEqual([
      503,
      'EAIUNAVAIL',
      'upstream',
      false,
    ]);
    expect(map(new ErrnoError('EAIUNAVAIL', { reason: 'budget' }))).toEqual([
      429,
      'EAIUNAVAIL',
      'budget',
      false,
    ]);
    expect(map(new ErrnoError('EAIUNAVAIL', { reason: 'timeout' }))).toEqual([
      504,
      'EAIUNAVAIL',
      'timeout',
      false,
    ]);
    expect(map(new ErrnoError('EINVAL', { field: 'x' }))).toEqual([
      400,
      'EINVAL',
      undefined,
      false,
    ]);
    const own = new HttpError(422, 'EAIREFUSED', 'no', { category: 'bio' });
    expect(classifyProviderError(own, ctx).error).toBe(own);
  });
});
