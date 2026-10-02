/**
 * The op handlers the sync engine does not implement itself (it owns `write`): the factory passed
 * to createSyncRuntime({ handlers }). Structural ops are wrapped in withBaseCheck, so a stale base
 * (someone changed the file, or anything in the subtree, since the client planned the op) is
 * rejected EAGAIN `stale-version` with nothing changed (offline-and-sync.md §3.12.3, VFS-10).
 *
 * Not implemented yet (the engine answers `retry ENOSYS not-implemented`, 60 s, so clients keep
 * the op rather than losing it): the atomic multi-op `batch` (agent plans, §4.11.11). TODO(R2).
 */
import type { OpSubmit } from '@plotinium/protocol';

import { withBaseCheck } from '../../engine/sync/base-check.ts';
import type { StoredResult } from '../../engine/sync/outcome.ts';
import type { OpHandler } from '../tx.ts';
import type { Ino, Locked } from '../types.ts';
import { ChmodHandler, ChownHandler, UtimesHandler } from './attr.ts';
import type { Tx } from './common.ts';
import { CopyHandler } from './copy.ts';
import { CreateHandler } from './create.ts';
import { LinkHandler } from './link.ts';
import { RenameHandler } from './rename.ts';
import { AuditAppendHandler, SessionLayoutHandler } from './session.ts';
import { UnlinkHandler } from './unlink.ts';

export { AuditAppendHandler, SessionLayoutHandler } from './session.ts';
export { ChmodHandler, ChownHandler, UtimesHandler } from './attr.ts';
export { CopyHandler, planCopyActions } from './copy.ts';
export { CreateHandler } from './create.ts';
export { LinkHandler } from './link.ts';
export { RenameHandler } from './rename.ts';
export { UnlinkHandler } from './unlink.ts';

export interface StructuralOptions {
  /** PLOTINIUM_TZ (reserved for conflicted-copy names of structural ops). */
  readonly timeZone: string;
}

/** Every locked row except `exclude` (the parent): the subtree a digest base describes. */
function lockedExcept(exclude: Ino | null) {
  return (locked: Locked) =>
    [...locked.rows.values()]
      .filter((r) => r.ino !== exclude)
      .map((r) => ({ ino: r.ino, version: r.version }));
}

export function structuralHandlers(
  _options: StructuralOptions,
): (submit: OpSubmit) => OpHandler<Tx, StoredResult> | undefined {
  return (submit) => {
    const op = submit.op;
    switch (op.kind) {
      case 'create':
        return withBaseCheck(new CreateHandler(op), 'structural');
      case 'unlink':
        return withBaseCheck(
          new UnlinkHandler(submit, op),
          'structural',
          lockedExcept(op.parentIno),
        );
      case 'rename':
        return withBaseCheck(new RenameHandler(submit, op), 'structural');
      case 'link':
        return withBaseCheck(new LinkHandler(op), 'structural');
      case 'chmod':
        return withBaseCheck(new ChmodHandler(submit, op), 'structural', lockedExcept(null));
      case 'chown':
        return withBaseCheck(new ChownHandler(submit, op), 'structural', lockedExcept(null));
      case 'utimes':
        return withBaseCheck(new UtimesHandler(submit, op), 'structural');
      case 'session.layout':
        return new SessionLayoutHandler(op);
      case 'audit.append':
        return new AuditAppendHandler(op);
      case 'copy': {
        const h = new CopyHandler(submit, op);
        return withBaseCheck(h, 'structural', (locked, root) => h.sourceRows(locked, root));
      }
      case 'write': // the engine's ContentWriteHandler
      case 'batch':
        return undefined;
    }
  };
}
