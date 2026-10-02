/**
 * The agent plan as the kernel-confirmation block shows it (ui-design-system.md §3.8.15;
 * shell-and-terminal.md §3.11 step 4; AGT-03, AGT-08). Pure: it maps a submitted plan (its steps
 * and the kernel's dry run) onto the block model that ui's ANSI helpers format
 * (`formatConfirmationBlock` in @plotinium/ui/apps/terminal), whose shapes are mirrored here.
 */
import type { ConfirmReason, PlanStep, SubmitResult } from '@plotinium/protocol';

export type DestructiveWord = 'delete' | 'overwrite' | 'chmod' | 'chown';

/** ui `PlanLine`. */
export interface PlanLineModel {
  command: string;
  args: string;
  effect: string;
  destructive?: DestructiveWord;
  files?: readonly string[];
  fileCount?: number;
}

/** ui `ConfirmationBlock`. */
export interface ConfirmationModel {
  header: { agent: string; pid: number };
  steps: readonly PlanLineModel[];
  transactions?: number;
  blast: {
    inodes: number;
    deletions: number;
    overwrites: number;
    quotaOk: boolean;
    quotaText?: string;
  };
  reasons: readonly string[];
}

export interface PlanForConfirmation {
  readonly steps: readonly PlanStep[];
  readonly result: SubmitResult;
  readonly requester: { readonly pid: number; readonly comm: string };
}

function rec(x: unknown): Readonly<Record<string, unknown>> {
  return typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
}

function field(a: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = a[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/** The step's arguments as typed: `~/a → ~/b`, `-R o-w ~/reports`, a glob, or its paths. */
export function stepArgs(step: PlanStep): string {
  const a = rec(step.args);
  const from = field(a, 'from');
  const to = field(a, 'to');
  if (from !== null && to !== null) return `${from} → ${to}`;
  const parts: string[] = [];
  if (a['recursive'] === true) parts.push('-R');
  const mode = rec(a['mode']);
  if (mode['op'] === 'set' && typeof mode['bits'] === 'number')
    parts.push(mode['bits'].toString(8));
  for (const key of ['pattern', 'name', 'glob', 'path', 'dir', 'target']) {
    const v = field(a, key);
    if (v !== null) parts.push(v);
  }
  if (parts.length === 0 && Array.isArray(step.sources)) parts.push(...step.sources.slice(0, 3));
  return parts.join(' ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** What a step would do, from the dry run's operations of the same kind. */
export function stepEffect(step: PlanStep, result: SubmitResult): string {
  const ops = result.dryRun.ops.filter((o) => o.op === step.op).length;
  switch (step.op) {
    case 'find':
    case 'glob': {
      const n = Array.isArray(step.sources) ? step.sources.length : 0;
      return n > 0 ? `→ ${plural(n, 'file')}` : 'select';
    }
    case 'mkdir':
      return `create ${plural(Math.max(1, ops), 'dir')}`;
    case 'write':
      return `write ${plural(Math.max(1, ops), 'file')}`;
    case 'unlink':
      return `remove ${plural(Math.max(1, ops), 'entry', 'entries')}`;
    case 'chmod':
    case 'chown':
    case 'utimes':
      return `modify ${plural(Math.max(1, ops), 'inode')}`;
    case 'rename':
      return `move ${plural(Math.max(1, ops), 'entry', 'entries')}`;
    case 'copy':
      return `copy ${plural(Math.max(1, ops), 'entry', 'entries')}`;
    case 'symlink':
      return `link ${plural(Math.max(1, ops), 'entry', 'entries')}`;
  }
}

/** The red word of a destructive step, from the kernel's confirmation reasons. */
export function stepDestructive(
  step: PlanStep,
  reasons: readonly ConfirmReason[],
): DestructiveWord | undefined {
  if (step.op === 'unlink' && reasons.includes('delete')) return 'delete';
  if (step.op === 'chmod' && reasons.includes('chmod')) return 'chmod';
  if (step.op === 'chown' && reasons.includes('chown')) return 'chown';
  if (
    (step.op === 'write' || step.op === 'rename' || step.op === 'copy') &&
    reasons.includes('overwrite')
  ) {
    return 'overwrite';
  }
  return undefined;
}

export function confirmationModel(plan: PlanForConfirmation): ConfirmationModel {
  const { result } = plan;
  const reasons = result.confirm.reasons;
  return {
    header: { agent: plan.requester.comm, pid: plan.requester.pid },
    steps: plan.steps.map((step) => {
      const line: PlanLineModel = {
        command: step.op,
        args: stepArgs(step),
        effect: stepEffect(step, result),
      };
      const word = stepDestructive(step, reasons);
      if (word !== undefined) line.destructive = word;
      if (Array.isArray(step.sources) && step.sources.length > 0) {
        line.files = step.sources.slice(0, 3);
        line.fileCount = step.sources.length;
      }
      return line;
    }),
    transactions: 1,
    blast: {
      inodes: result.dryRun.inodes,
      deletions: result.dryRun.deletions,
      overwrites: result.dryRun.overwrites,
      quotaOk: result.dryRun.quotaOk,
    },
    reasons,
  };
}
