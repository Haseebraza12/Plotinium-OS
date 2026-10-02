/**
 * The system-call surface coreutils programs use.
 *
 * TODO(R1): import from '@plotinium/kernel/sys' when it exports the program model; until then the
 * shell's stand-in (apps/src/_sys.ts) is the single definition.
 */
import type { SysGen, Sys } from '../../src/_sys.ts';

export type {
  AnyCallName,
  CallArgs,
  CallRet,
  Program,
  ProgramContext,
  Sys,
  SysGen,
  Yield,
} from '../../src/_sys.ts';
export { decodeText, encodeText, errnoOf, SysError } from '../../src/_sys.ts';

/**
 * Calls the shell spec marks as requested (†) that are not in protocol/src/sys/names.ts yet. Until
 * they land the kernel answers ENOSYS at stage 2, which the commands report as
 * "Function not implemented".
 * TODO(R1): add these to the protocol registry (syscall-abi.md) and delete this interface.
 */
export interface CoreExtraCalls {
  'swap.stat': {
    args: Record<string, never>;
    ret: {
      device: string;
      fallback: string;
      policy: 'auto' | 'local' | 'remote';
      local: { bytes: number; pages: number };
      remote: { bytes: number; pages: number };
      queue: { pages: number; bytes: number };
    };
  };
  'swap.ctl': {
    args: { tier?: 'auto' | 'local' | 'remote'; dropLocal?: boolean; pid?: number };
    ret: { dropped?: number };
  };
  'swap.bench': {
    args: { size: number; tier: 'local' | 'remote'; n: number };
    ret: { p95Ms: number; p50Ms: number; tier: 'local' | 'remote' };
  };
  'swap.checkpoint': { args: { pid: number }; ret: { bytes: number } };
  'svc.control': {
    args: { name: string; action: 'start' | 'stop' | 'retry' };
    ret: Record<string, never>;
  };
  /** boot-and-services.md §4.7: dry-run DAG build of the manifests. */
  'svc.verify': {
    args: { source: 'volume' | 'builtin' };
    ret: {
      ok: boolean;
      count: number;
      edges: number;
      levels: string[][];
      errors: { rule: string; file: string; text: string }[];
      cycle?: string[];
    };
  };
  'svc.restoreDefaults': { args: Record<string, never>; ret: { written: number } };
  'debug.status': {
    args: Record<string, never>;
    ret: { armed: { op: string; after: number; target: string }[] };
  };
  'debug.clear': { args: Record<string, never>; ret: { cleared: number } };
  'shutdown.cancel': { args: Record<string, never>; ret: Record<string, never> };
  'ai.status': {
    args: Record<string, never>;
    ret: { gateway: string; budgetLeft: number | null; model: string | null };
  };
}

interface UntypedSys {
  call(name: string, args: unknown): SysGen<unknown>;
}

/** Issues a requested call that the protocol registry does not type yet. */
export function* extCall<C extends keyof CoreExtraCalls>(
  sys: Sys,
  name: C,
  args: CoreExtraCalls[C]['args'],
): SysGen<CoreExtraCalls[C]['ret']> {
  // The stub is generic over the name; only the static type is missing for these calls.
  const raw = yield* (sys as unknown as UntypedSys).call(name, args);
  return raw as CoreExtraCalls[C]['ret'];
}
