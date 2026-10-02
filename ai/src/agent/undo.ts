/**
 * `ai undo` (agentic-shell.md §3.18; AGT-10, MAY).
 *
 * The inverse actions are recorded at dry-run time, in execution order; undo applies them in
 * reverse: renames move back (trash moves included), created entries go to the undo transaction's
 * trash (so undo is itself recoverable), chmod and chown restore the recorded values, utimes the
 * recorded mtime. Precondition: every touched inode is still at its post-commit version, else
 * EAGAIN `changed-since` and nothing runs. The result is an ordinary plan (no model call) that goes
 * through the same predicate, confirmation and `batch`.
 */
import type { BatchOp } from '@plotinium/protocol';

import { type Result, fail, ok } from '../util/errors.ts';
import { type InverseAction, TRASH_DIR } from './apply.ts';
import { basename, joinPath } from './fsview.ts';

export interface UndoContext {
  home: string;
  /** UUIDv7 of the undo batch; names its trash directory. */
  undoTxnId: string;
  /** Whether `$HOME/.trash` already exists. */
  trashExists: boolean;
}

/** Inverse batch ops, reverse order of the original. */
export function buildInverse(actions: readonly InverseAction[], ctx: UndoContext): BatchOp[] {
  const out: BatchOp[] = [];
  const trashRoot = joinPath(ctx.home, TRASH_DIR);
  const txnDir = joinPath(trashRoot, ctx.undoTxnId);
  let seq = 0;
  let trashMade = false;
  const trash = (path: string): string => {
    if (!trashMade) {
      if (!ctx.trashExists) out.push({ op: 'mkdir', path: trashRoot, mode: 0o700, parents: true });
      out.push({ op: 'mkdir', path: txnDir, mode: 0o700 });
      trashMade = true;
    }
    return joinPath(txnDir, `${++seq}-${basename(path)}`);
  };
  for (const a of [...actions].reverse()) {
    switch (a.kind) {
      case 'rename':
        out.push({ op: 'rename', from: a.from, to: a.to });
        break;
      case 'trash':
        out.push({ op: 'rename', from: a.path, to: trash(a.path) });
        break;
      case 'chmod':
        out.push({ op: 'chmod', path: a.path, mode: { op: 'set', bits: a.mode } });
        break;
      case 'chown':
        out.push({ op: 'chown', path: a.path, uid: a.uid, gid: a.gid });
        break;
      case 'utimes':
        out.push({ op: 'utimes', path: a.path, mtime: a.mtime });
        break;
    }
  }
  return out;
}

/** Every touched inode must still be at its post-commit version. */
export function checkUndoPrecondition(
  postCommit: ReadonlyArray<{ ino: string; version: number }>,
  versionOf: (ino: string) => number | undefined,
): Result<undefined> {
  for (const e of postCommit) {
    if (versionOf(e.ino) !== e.version) return fail('EAGAIN', 'changed-since');
  }
  return ok(undefined);
}
