/**
 * Descriptors and pipes (syscall-abi.md §4.4.3).
 */
import * as v from 'valibot';

import { PIPE_CAPACITY_DEFAULT, PIPE_CAPACITY_MAX, PIPE_CAPACITY_MIN } from '../limits.ts';
import { Count, Fd } from './common.ts';

export const PipeArgs = v.strictObject({
  capacity: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(PIPE_CAPACITY_MIN), v.maxValue(PIPE_CAPACITY_MAX)),
    PIPE_CAPACITY_DEFAULT,
  ),
});
export const PipeRet = v.strictObject({ r: Fd, w: Fd });

export const DupArgs = v.strictObject({ fd: Fd });
export const DupRet = v.strictObject({ fd: Fd });

export const Dup2Args = v.strictObject({ fd: Fd, to: Fd });
export const Dup2Ret = v.strictObject({ fd: Fd });

export const IsattyArgs = v.strictObject({ fd: Fd });
/** `n`: the TTY number when `tty` is true. */
export const IsattyRet = v.strictObject({ tty: v.boolean(), n: v.optional(Count) });
