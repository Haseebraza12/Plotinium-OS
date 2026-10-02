/**
 * Truthful boot progress (boot-and-services.md §5.5, BOOT-02, INV-B2).
 *
 *   α  = W_assets / (W_assets + Σ_{s∈A} w_s^builtin)      W_assets = 10
 *   Pa = bytesDone / bytesTotal(T)
 *   Ps = Σ_{s∈A, done} w_s / Σ_{s∈A} w_s                  weights from the manifests in use
 *   P  = α · Pa + (1 − α) · Ps
 *
 * Every quantity comes from an event: asset bytes read or an asset finishing, the `boot.target`
 * message carrying the weights of A, and a service in A settling. Nothing here reads a clock, so
 * time without events leaves P unchanged. A service that times out or degrades is not done, so
 * its weight is never added (A ⊆ critical, INV-B3).
 */
import { ancestorClosure } from './closure.ts';
import { BUILTIN_MANIFEST_FILES } from './manifests.ts';
import type { ServiceManifest, ServiceName } from './types.ts';

export const W_ASSETS = 10;

export type BootTarget = 'desktop' | 'recovery';

/** Recovery's A is the recovery set (§5.5): kernel, sched, storage, wm, vfs. */
export function targetClosure(
  manifests: readonly Pick<ServiceManifest, 'name' | 'requires' | 'recovery'>[],
  target: BootTarget,
): Set<ServiceName> {
  if (target === 'recovery')
    return new Set(manifests.filter((m) => m.recovery === true).map((m) => m.name));
  // protocol BOOT_TARGET; spelled out so this module needs no protocol import on the main thread.
  return ancestorClosure(manifests, 'desktop');
}

function builtinManifests(): ServiceManifest[] {
  return BUILTIN_MANIFEST_FILES.map((f) => f.json as ServiceManifest);
}

/** α for a target, from the BUILT-IN weights (fixed at build time, so edits keep P monotone). */
export function alphaFor(target: BootTarget): number {
  const builtin = builtinManifests();
  const a = targetClosure(builtin, target);
  let sum = 0;
  for (const m of builtin) if (a.has(m.name)) sum += m.weight;
  return W_ASSETS / (W_ASSETS + sum);
}

export type ProgressEvent =
  | {
      readonly t: 'target';
      readonly target: BootTarget;
      readonly weights: Readonly<Record<ServiceName, number>>;
      readonly assetsTotal: number;
    }
  /** The decoded size of the target's boot assets, when the build could not inline it (dev). Fixed once set. */
  | { readonly t: 'assets-total'; readonly bytes: number }
  | { readonly t: 'asset-bytes'; readonly url: string; readonly bytes: number }
  | { readonly t: 'asset-done'; readonly url: string; readonly bytes: number }
  | { readonly t: 'service-done'; readonly name: ServiceName };

export interface ProgressSnapshot {
  readonly p: number;
  readonly pa: number;
  readonly ps: number;
  readonly servicesDone: number;
  readonly servicesTotal: number;
}

export class BootProgress {
  private target: BootTarget;
  private alpha: number;
  private weights: Readonly<Record<ServiceName, number>> | null = null;
  private assetsTotal: number;
  private readonly assetBytes = new Map<string, number>();
  private readonly done = new Set<ServiceName>();

  constructor(target: BootTarget = 'desktop', assetsTotal = 0) {
    this.target = target;
    this.alpha = alphaFor(target);
    this.assetsTotal = assetsTotal;
  }

  /** The only way to change progress. Returns the new snapshot. */
  apply(ev: ProgressEvent): ProgressSnapshot {
    switch (ev.t) {
      case 'target':
        this.target = ev.target;
        this.alpha = alphaFor(ev.target);
        this.weights = ev.weights;
        if (ev.assetsTotal > 0) this.assetsTotal = ev.assetsTotal;
        break;
      case 'assets-total':
        if (this.assetsTotal === 0 && ev.bytes > 0) this.assetsTotal = ev.bytes;
        break;
      case 'asset-bytes':
      case 'asset-done': {
        const before = this.assetBytes.get(ev.url) ?? 0;
        this.assetBytes.set(ev.url, Math.max(before, ev.bytes));
        break;
      }
      case 'service-done':
        if (this.weights && Object.hasOwn(this.weights, ev.name)) this.done.add(ev.name);
        break;
    }
    return this.snapshot();
  }

  get currentTarget(): BootTarget {
    return this.target;
  }

  snapshot(): ProgressSnapshot {
    let bytesDone = 0;
    for (const b of this.assetBytes.values()) bytesDone += b;
    const pa = this.assetsTotal > 0 ? Math.min(1, bytesDone / this.assetsTotal) : 0;
    let total = 0;
    let doneW = 0;
    const names = this.weights ? Object.keys(this.weights) : [];
    for (const name of names) {
      const w = this.weights?.[name] ?? 0;
      total += w;
      if (this.done.has(name)) doneW += w;
    }
    const ps = total > 0 ? doneW / total : 0;
    const p = Math.min(1, Math.max(0, this.alpha * pa + (1 - this.alpha) * ps));
    return { p, pa, ps, servicesDone: this.done.size, servicesTotal: names.length };
  }
}
