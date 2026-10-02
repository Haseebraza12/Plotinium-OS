/**
 * Boot diagnostics (boot-and-services.md §3.6 [D], §3.8 key D, §6.1): the main-thread boot record,
 * the capability matrix, the service states and the klog tail as one JSON document. It never
 * needs IndexedDB, so it works on every failure screen, including before the kernel exists.
 */
import type { CapabilityMatrix, KlogLine } from '@plotinium/kernel/host/main';

import type { BootRecordDraft } from './record.ts';

export interface ServiceRow {
  readonly name: string;
  readonly state: string;
  readonly reason?: string;
}

export interface DiagnosticsInput {
  readonly record: BootRecordDraft;
  readonly caps: CapabilityMatrix | null;
  readonly services: readonly ServiceRow[];
  readonly klog: readonly KlogLine[];
  readonly userAgent: string;
  readonly at: string;
  readonly panic?: {
    readonly kind: string;
    readonly text: string;
    readonly cycle?: readonly string[];
  };
}

export interface Diagnostics {
  readonly fileName: string;
  readonly json: string;
}

/** `plotinium-boot-<bootId>.json`, or the boot's start time while no bootId exists yet. */
export function diagnosticsFileName(bootId: string, t0: number): string {
  const id = bootId !== '' ? bootId : `t0-${String(Math.round(t0))}`;
  return `plotinium-boot-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export function buildDiagnostics(input: DiagnosticsInput, t0: number): Diagnostics {
  const doc = {
    kind: 'plotinium-boot-diagnostics',
    at: input.at,
    userAgent: input.userAgent,
    record: input.record,
    capabilities: input.caps,
    services: input.services,
    ...(input.panic === undefined ? {} : { panic: input.panic }),
    klog: input.klog.slice(-512),
  };
  return {
    fileName: diagnosticsFileName(input.record.bootId, t0),
    json: `${JSON.stringify(doc, null, 2)}\n`,
  };
}

/** Save as a file through a blob URL and a download anchor (no navigation, no HTML sink). */
export function download(doc: Document, d: Diagnostics): void {
  const url = URL.createObjectURL(new Blob([d.json], { type: 'application/json' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = d.fileName;
  a.rel = 'noopener';
  doc.body.append(a);
  a.click();
  a.remove();
  // The blob URL is not revoked: a download that has not started reading it yet would fail, and
  // a boot-diagnostics file is a few kilobytes at most, once per failure screen.
}

/** Copy to the clipboard; falls back to a download (UIG §3.4.6 "Copy diagnostics"). */
export async function copyOrDownload(
  doc: Document,
  clipboard: Clipboard | undefined,
  d: Diagnostics,
): Promise<'copied' | 'failed'> {
  try {
    if (clipboard === undefined) throw new Error('no clipboard');
    await clipboard.writeText(d.json);
    return 'copied';
  } catch {
    try {
      download(doc, d);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
}
