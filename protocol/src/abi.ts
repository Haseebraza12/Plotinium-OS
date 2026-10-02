/**
 * ABI version and digest (syscall-abi.md §3.10, ABI-10).
 *
 * `ABI_VERSION` is an integer independent of the OS version and of the WebSocket protocol version.
 * It starts at 1 (with v0.2.0) and is bumped by: removing or renaming a call, event topic or field;
 * changing a field's type, meaning, default or limit so that previously valid input is rejected;
 * changing a call's class, origin set or capabilities; adding an errno to a call's list or to the
 * master table. Adding a call, an optional argument, a return field or an event topic does not bump
 * it, but it does change the digest. Every bump gets a CHANGELOG entry under "ABI".
 *
 * `abiDigest()` is the SHA-256 of the canonical JSON of the registry (call names, groups, classes,
 * origins, capabilities, audit levels, errnos, and a structural description of every argument and
 * return schema) plus the errno and capability tables. Executors and views send
 * `hello {abi, digest}`; any mismatch means a mixed-cache bug and the peer is refused. The build
 * MAY inline the value; computing it at run time gives the same result because every input is in
 * this package.
 */
import { CAP_NAMES } from './caps.ts';
import { ERRNO } from './errno.ts';
import { sha256Hex } from './sha256.ts';
import { SIGNALS } from './signals.ts';
import { CALL_NAMES } from './sys/names.ts';
import { CALLS } from './sys/registry.ts';
import type { CallSpec } from './sys/registry.ts';

export const ABI_VERSION = 1;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function describeRequirement(req: unknown): Json {
  if (req instanceof RegExp) return { regex: req.source, flags: req.flags };
  if (typeof req === 'function') return 'fn';
  if (req === undefined) return null;
  if (Array.isArray(req)) return req.map(describeRequirement);
  if (
    req === null ||
    typeof req === 'string' ||
    typeof req === 'number' ||
    typeof req === 'boolean'
  )
    return req;
  if (typeof req === 'bigint') return `${req.toString()}n`;
  return Object.prototype.toString.call(req);
}

/**
 * A structural, JSON-serialisable description of a Valibot schema or action. Deterministic:
 * functions are described as 'fn' (their source is not part of the ABI), regexes by source and
 * flags, classes by name.
 */
export function describeSchema(node: unknown): Json {
  if (node === null || typeof node !== 'object') return describeRequirement(node);
  const s = node as Record<string, unknown>;
  const out: { [key: string]: Json } = {};
  if (typeof s['kind'] === 'string') out['kind'] = s['kind'];
  if (typeof s['type'] === 'string') out['type'] = s['type'];
  if (s['kind'] !== 'schema') {
    out['requirement'] = describeRequirement(s['requirement']);
    if (typeof s['message'] === 'string') out['message'] = s['message'];
    return out;
  }
  const entries = s['entries'];
  if (entries !== null && typeof entries === 'object') {
    const described: { [key: string]: Json } = {};
    for (const key of Object.keys(entries).sort())
      described[key] = describeSchema((entries as Record<string, unknown>)[key]);
    out['entries'] = described;
  }
  const options = s['options'];
  if (Array.isArray(options))
    out['options'] = options.map((o) =>
      o !== null && typeof o === 'object' ? describeSchema(o) : describeRequirement(o),
    );
  for (const key of ['item', 'wrapped', 'key', 'value'] as const) {
    if (s[key] !== null && typeof s[key] === 'object') out[key] = describeSchema(s[key]);
  }
  const items = s['items'];
  if (Array.isArray(items)) out['items'] = items.map(describeSchema);
  if ('literal' in s) out['literal'] = describeRequirement(s['literal']);
  if ('default' in s && s['default'] !== undefined)
    out['default'] = describeRequirement(s['default']);
  if (typeof s['class'] === 'function') out['class'] = (s['class'] as { name: string }).name;
  if (typeof s['message'] === 'string') out['message'] = s['message'];
  const pipe = s['pipe'];
  // pipe[0] is the base schema itself, already described by the fields above.
  if (Array.isArray(pipe)) out['pipe'] = pipe.slice(1).map(describeSchema);
  return out;
}

function describeCall(name: string, spec: CallSpec): Json {
  return {
    name,
    group: spec.group,
    cls: spec.cls,
    clsAlt: spec.clsAlt ?? null,
    origin: spec.origin,
    caps: [...spec.caps],
    capsDynamic: [...(spec.capsDynamic ?? [])],
    capsAgent: spec.capsAgent === undefined ? null : [...spec.capsAgent],
    capsCrossUid: [...(spec.capsCrossUid ?? [])],
    audit: spec.audit,
    large: spec.large === true,
    may: spec.may === true,
    errnos: [...spec.errnos],
    args: describeSchema(spec.args),
    ret: describeSchema(spec.ret),
  };
}

/** Canonical JSON: object keys sorted at every level, no whitespace. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The description the digest is computed over. */
export function abiDescriptor(): Json {
  return {
    abi: ABI_VERSION,
    calls: CALL_NAMES.map((name) => describeCall(name, CALLS[name])),
    errnos: Object.entries(ERRNO).map(([name, e]) => ({ name, code: e.code, message: e.message })),
    caps: [...CAP_NAMES],
    signals: Object.entries(SIGNALS).map(([name, s]) => ({
      name,
      number: s.number,
      action: s.defaultAction,
      catchable: s.catchable,
    })),
  };
}

let memo: string | undefined;

/** SHA-256 (hex) of the canonical ABI descriptor; computed once per realm. */
export function abiDigest(): string {
  memo ??= sha256Hex(canonicalJson(abiDescriptor()));
  return memo;
}
