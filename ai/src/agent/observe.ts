/**
 * Observation results rendered for the planner (agentic-shell.md §3.4 rule 5, §3.8 step 3; AIN-B1).
 *
 * Each observation is the result of exactly one read-only syscall made by the agent's own pid; it
 * is rendered in the same datamarked format as the envelope, with `source="<call> <args>"`.
 * Names and paths are untrusted; counts and sizes are numbers. `grep` returns names or counts,
 * never matching lines, so file contents never reach the model (I-B5). Errors are returned as
 * `is_error` results carrying the errno name only.
 */
import type { Errno, ReadOnlyTool } from '@plotinium/protocol';

import { canonicalJson } from '../util/canonical.ts';
import type { RandomSource } from '../util/rng.ts';
import { datamark, humanSize, listingLines, localMinute, renderName } from './envelope.ts';

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; errno: Errno };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function lines(call: ReadOnlyTool, args: Obj, value: unknown, tz: string): string[] {
  const v = isObj(value) ? value : {};
  switch (call) {
    case 'readdir': {
      const entries = arr(v['entries'])
        .filter(isObj)
        .map((e) => {
          const st = isObj(e['stat']) ? e['stat'] : {};
          const type = e['type'] === 'd' || e['type'] === 'l' ? e['type'] : 'f';
          return {
            name: str(e['name']),
            type,
            size: num(st['size']),
            mtime: num(st['mtime']),
          } as const;
        });
      return listingLines(entries, entries.length + (v['next'] === undefined ? 0 : 1), tz);
    }
    case 'stat':
      return [
        `${str(v['type'])} ${renderName(str(args['path']))} mode=${num(v['mode']).toString(8).padStart(4, '0')} uid=${num(v['uid'])} gid=${num(v['gid'])} size=${humanSize(num(v['size']))} nlink=${num(v['nlink'])} mtime=${localMinute(num(v['mtime']), tz)}`,
      ];
    case 'find': {
      const out = arr(v['paths']).map((p) => renderName(str(p)));
      if (v['truncated'] === true) out.push(`… more results (cap ${out.length})`);
      return out;
    }
    case 'grep':
      return arr(v['matches'])
        .filter(isObj)
        .map((m) =>
          args['mode'] === 'c'
            ? `${renderName(str(m['path']))} ${num(m['count'])}`
            : renderName(str(m['path'])),
        );
    case 'du': {
      const out = [`total ${humanSize(num(v['bytes']))} ${num(v['inodes'])} inodes`];
      for (const c of arr(v['children']).filter(isObj))
        out.push(
          `${renderName(str(c['name']))} ${humanSize(num(c['bytes']))} ${num(c['inodes'])} inodes`,
        );
      return out;
    }
    case 'wc':
      return arr(v['files'])
        .filter(isObj)
        .map(
          (f) =>
            `${renderName(str(f['path']))} ${num(f['lines'])} ${num(f['words'])} ${num(f['bytes'])}`,
        );
  }
}

/** The tool_result content for one observation, and whether it is an error. */
export function renderObservation(
  call: ReadOnlyTool,
  args: unknown,
  outcome: ToolOutcome,
  rng: RandomSource,
  tz: string,
): { content: string; isError: boolean } {
  if (!outcome.ok) return { content: `errno ${outcome.errno}`, isError: true };
  const a = isObj(args) ? args : {};
  const block = datamark(`${call} ${canonicalJson(args)}`, lines(call, a, outcome.value, tz), rng);
  return { content: block.text, isError: false };
}

/** Paths an observation showed the planner (argument grounding, §3.10). */
export function observedPaths(call: ReadOnlyTool, args: unknown, value: unknown): string[] {
  const a = isObj(args) ? args : {};
  const v = isObj(value) ? value : {};
  switch (call) {
    case 'readdir':
      return arr(v['entries'])
        .filter(isObj)
        .map((e) => joinPath(str(a['path']), str(e['name'])));
    case 'stat':
      return [str(a['path'])];
    case 'find':
      return arr(v['paths']).map(str);
    case 'grep':
      return arr(v['matches'])
        .filter(isObj)
        .map((m) => str(m['path']));
    case 'du':
      return [
        str(a['path']),
        ...arr(v['children'])
          .filter(isObj)
          .map((c) => joinPath(str(a['path']), str(c['name']))),
      ];
    case 'wc':
      return arr(v['files'])
        .filter(isObj)
        .map((f) => str(f['path']));
  }
}
