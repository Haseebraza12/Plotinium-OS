/**
 * Shared error and accounting types of dsa/ (specs/08-dsa/data-structures.md §3.4 and §4.0).
 *
 * Queries return `undefined`/`false` for "absent"; contract violations throw `DsaError` with a
 * `code`. The kernel maps codes to errnos at its boundary (§6.0); a DsaError never crosses the
 * system-call boundary raw.
 */

export type DsaErrorCode =
  | 'DUPLICATE'
  | 'NOT_FOUND'
  | 'NOT_DIR'
  | 'NOT_LOADED'
  | 'INVALID'
  | 'RANGE'
  | 'CYCLE'
  | 'FULL'
  | 'NOT_IMPLEMENTED';

export class DsaError extends Error {
  readonly code: DsaErrorCode;

  constructor(code: DsaErrorCode, message: string) {
    super(message);
    this.name = 'DsaError';
    this.code = code;
  }
}

/** The five roles of C15 that own structures (§3.3). */
export type OwnerRole = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

/**
 * Thrown by every method of a structure whose `IMPLEMENTED` flag is still false (C16). The owner
 * replaces the stub with a first-principles implementation and flips the flag in the same PR.
 */
export class NotImplementedError extends DsaError {
  readonly module: string;

  constructor(module: string, owner: OwnerRole) {
    super(
      'NOT_IMPLEMENTED',
      `TODO(${owner}): implement from first principles — see specs/08-dsa/data-structures.md`,
    );
    this.name = 'NotImplementedError';
    this.module = module;
  }
}

/** Memory accounting reported by every structure (§3.4 "Accounting"). */
export interface DsaStats {
  /** Live entries. */
  size: number;
  /** Entries the current allocation can hold without growing. */
  capacity: number;
  /** Bytes of typed arrays and pools allocated. */
  bytesAllocated: number;
  /** Bytes of those allocations in use. */
  bytesUsed: number;
}
