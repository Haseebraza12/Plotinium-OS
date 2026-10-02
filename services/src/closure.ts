/**
 * A: a service and everything it transitively requires (boot-and-services.md §5.5). O(V + E).
 * Kept free of dsa and protocol imports so the main-thread progress model stays tiny (BOOT-10).
 */
import type { ServiceManifest, ServiceName } from './types.ts';

export function ancestorClosure(
  manifests: readonly Pick<ServiceManifest, 'name' | 'requires'>[],
  target: ServiceName,
): Set<ServiceName> {
  const byName = new Map(manifests.map((m) => [m.name, m] as const));
  const seen = new Set<ServiceName>();
  const stack: ServiceName[] = byName.has(target) ? [target] : [];
  while (stack.length > 0) {
    const name = stack.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    for (const dep of byName.get(name)?.requires ?? []) stack.push(dep);
  }
  return seen;
}
