/**
 * `ai.agent.submit` and the `batch` gate for agent-class callers (syscall-abi.md §5.4).
 *
 * submit: validate + dry run, then the predicate; when no confirmation is needed the token is
 * issued at once, otherwise only `ai.agent.confirm` issues it after a `y` from the kernel TTY.
 * batch: the predicate is recomputed over the received ops; if confirmation is required, or the
 * caller is agent-class, a valid, pid-bound, unexpired, single-use token whose grant covers every
 * op is mandatory (EPERM otherwise), and the expected versions must still match (EAGAIN
 * `stale-plan`). Nothing runs unless every check passes (I-B2).
 */
import { type BatchOp, EXPECTED_VERSIONS_MAX, type SubmitResult } from '@plotinium/protocol';

import { type Result, fail, ok } from '../util/errors.ts';
import { abiReasons, needsConfirmation, opsRequireConfirmation, type Reason } from './confirm.ts';
import type { GrantTable } from './token.ts';
import { grantHash } from './token.ts';
import { type DryRun, type ValidateInput, abiDryRunView, validatePlan } from './validator.ts';

export interface Submitted {
  result: SubmitResult;
  dryRun: DryRun;
  reasons: Reason[];
}

export async function submitPlan(
  input: ValidateInput,
  planId: string,
  pid: number,
  grants: GrantTable,
): Promise<Result<Submitted>> {
  const v = validatePlan(input);
  if (!v.ok) return v;
  const dr = v.value;
  if (dr.expectedVersions.length > EXPECTED_VERSIONS_MAX) return fail('EINVAL', 'plan-too-large');
  const confirm = needsConfirmation(dr);
  const result: SubmitResult = {
    planId,
    planHash: dr.planHash,
    dryRunHash: dr.dryRunHash,
    dryRun: abiDryRunView({
      batch: dr.batch,
      affectedInodes: dr.affectedInodes,
      bytes: dr.bytes,
      deletions: dr.counts.delete,
      overwrites: dr.counts.overwrite,
      quotaOk: dr.quotaOk,
      intervals: dr.intervals,
    }),
    confirm: { required: confirm.required, reasons: abiReasons(confirm.reasons) },
    expectedVersions: dr.expectedVersions,
  };
  if (!confirm.required) {
    const t = await grants.issue(
      {
        pid,
        planId,
        planHash: dr.planHash,
        dryRunHash: dr.dryRunHash,
        grantHash: grantHash(dr.grant),
      },
      dr.grant,
      dr.expectedVersions,
      input.now,
    );
    result.token = t.token;
  }
  return ok({ result, dryRun: dr, reasons: confirm.reasons });
}

/** Issue the token after the kernel TTY returned `y` (`ai.agent.confirm`). */
export async function tokenAfterConfirm(
  s: Submitted,
  pid: number,
  grants: GrantTable,
  now: number,
): Promise<{ token: string; expiresAt: number; granted: boolean }> {
  const dr = s.dryRun;
  const t = await grants.issue(
    {
      pid,
      planId: s.result.planId,
      planHash: dr.planHash,
      dryRunHash: dr.dryRunHash,
      grantHash: grantHash(dr.grant),
    },
    dr.grant,
    dr.expectedVersions,
    now,
  );
  return { token: t.token, expiresAt: t.exp, granted: true };
}

export interface BatchRequest {
  pid: number;
  callerClass: 'user' | 'agent' | 'system';
  ops: readonly BatchOp[];
  token?: string;
  planId?: string;
  /** `(op, ino)` for every op, resolved by the kernel. */
  pairs: ReadonlyArray<readonly [string, string]>;
  home: string;
  affectedInodes: number;
  exists(path: string): boolean;
  versionOf(ino: string): number | undefined;
}

/** Phase 1 of `batch` for agent plans: the recomputed predicate and the token checks. */
export async function authorizeBatch(
  req: BatchRequest,
  grants: GrantTable,
  now: number,
): Promise<Result<undefined>> {
  const needs = opsRequireConfirmation(req.ops, req);
  if (req.callerClass !== 'agent' && !needs) return ok(undefined);
  if (req.token === undefined) return fail('EPERM', 'no-token');
  return grants.check(
    {
      pid: req.pid,
      token: req.token,
      planId: req.planId,
      pairs: req.pairs,
      versionOf: (ino) => req.versionOf(ino),
    },
    now,
  );
}
