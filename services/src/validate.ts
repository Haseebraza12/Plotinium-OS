/**
 * Manifest validation rules V1–V9 (boot-and-services.md §3.4, SVC-01). Any violation is a kernel
 * panic naming the offending manifest; V1–V9 run before the cycle check (V10, levels.ts) so a
 * typo is never reported as a cycle.
 */
import { BOOT_TARGET, ServiceManifestSchema } from '@plotinium/protocol';

import type { ManifestFile, ServiceManifest, ServiceName } from './types.ts';

export type Rule = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8' | 'V9' | 'V10';

export interface ValidationError {
  readonly rule: Rule;
  readonly file: string;
  /** Panic text after `svc: KERNEL PANIC: `. */
  readonly text: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly manifests: ServiceManifest[] }
  | { readonly ok: false; readonly error: ValidationError };

type Issue = NonNullable<ReturnType<(typeof ServiceManifestSchema)['~run']>['issues']>[number];

/**
 * V1 parse, identical to `v.safeParse(ServiceManifestSchema, json, {abortEarly: true})`; services
 * does not depend on valibot directly (TODO(R5): add it and call v.safeParse).
 */
function parseManifest(
  json: unknown,
): { ok: true; manifest: ServiceManifest } | { ok: false; issue: Issue | undefined } {
  const dataset = ServiceManifestSchema['~run']({ value: json }, { abortEarly: true });
  if (dataset.issues === undefined) return { ok: true, manifest: dataset.value };
  return { ok: false, issue: dataset.issues[0] };
}

function describeIssue(issue: Issue | undefined): string {
  if (!issue) return 'invalid';
  const path = (issue.path ?? [])
    .map((p) => {
      const key: unknown = p.key;
      return typeof key === 'string' || typeof key === 'number' ? String(key) : '?';
    })
    .join('.');
  return `${path === '' ? '(root)' : path}: ${issue.message}`;
}

/**
 * Validate the manifest files in order. `implemented` is the set of service names this kernel
 * build has an implementation for (V9).
 */
export function validateManifests(
  files: readonly ManifestFile[],
  implemented: ReadonlySet<ServiceName>,
): ValidationResult {
  const manifests: ServiceManifest[] = [];
  const fail = (rule: Rule, file: string, text: string): ValidationResult => ({
    ok: false,
    error: { rule, file, text },
  });

  for (const f of files) {
    const parsed = parseManifest(f.json);
    if (!parsed.ok)
      return fail('V1', f.file, `invalid manifest ${f.file}: ${describeIssue(parsed.issue)}`);
    const expected = f.file.endsWith('.json') ? f.file.slice(0, -5) : f.file;
    if (parsed.manifest.name !== expected)
      return fail('V2', f.file, `manifest ${f.file} declares name "${parsed.manifest.name}"`);
    manifests.push(parsed.manifest);
  }

  const byName = new Map<ServiceName, ServiceManifest>();
  for (const m of manifests) {
    if (byName.has(m.name)) return fail('V3', `${m.name}.json`, `duplicate service "${m.name}"`);
    byName.set(m.name, m);
  }

  for (const m of manifests) {
    const file = `${m.name}.json`;
    for (const dep of m.requires) {
      if (!byName.has(dep)) return fail('V4', file, `${file} requires unknown service "${dep}"`);
    }
    if (m.requires.includes(m.name)) return fail('V5', file, `${file} requires itself`);
    if (new Set(m.requires).size !== m.requires.length)
      return fail('V5', file, `${file} lists a requirement twice`);
    if (m.critical) {
      const soft = m.requires.find((dep) => byName.get(dep)?.critical === false);
      if (soft !== undefined)
        return fail('V6', file, `critical service ${m.name} requires non-critical ${soft}`);
    }
  }

  const root = byName.get('kernel');
  if (!root) return fail('V7', 'kernel.json', 'no root service "kernel"');
  if (root.requires.length > 0)
    return fail('V7', 'kernel.json', 'kernel.json must have no requirements');
  const otherRoot = manifests.find((m) => m.name !== 'kernel' && m.requires.length === 0);
  if (otherRoot)
    return fail(
      'V7',
      `${otherRoot.name}.json`,
      `${otherRoot.name}.json has no requirements (only kernel may be a root)`,
    );

  const target = byName.get(BOOT_TARGET);
  if (!target?.critical)
    return fail('V8', `${BOOT_TARGET}.json`, `boot target ${BOOT_TARGET} missing or not critical`);

  const missing = manifests.find((m) => !implemented.has(m.name));
  if (missing)
    return fail('V9', `${missing.name}.json`, `no implementation for service "${missing.name}"`);

  return { ok: true, manifests };
}
