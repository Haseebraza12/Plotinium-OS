/**
 * TTYs and job control (syscall-abi.md §4.4.3; line discipline in shell-and-terminal.md).
 *
 * The TTY line discipline runs in the kernel, so the kernel owns the `ai.agent.confirm` prompt and
 * reads the answer only from real keystrokes (AGT-03).
 */
import * as v from 'valibot';

import { TTY_INPUT_MAX_BYTES } from '../limits.ts';
import { Count, Fd, Pid, Wid } from './common.ts';

export const TtyAttr = v.strictObject({
  n: Count,
  canonical: v.boolean(),
  echo: v.boolean(),
  isig: v.boolean(),
  altScreen: v.boolean(),
  cols: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(1000)),
  rows: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
  fgPgid: Pid,
  sid: Pid,
});

export const TtyOpenArgs = v.strictObject({ wid: Wid });
export const TtyOpenRet = v.strictObject({ fd: Fd, n: Count });

/** View origin only; keystrokes are never logged. */
export const TtyInputArgs = v.strictObject({
  data: v.pipe(v.string(), v.maxBytes(TTY_INPUT_MAX_BYTES)),
});
export const TtyInputRet = v.strictObject({});

export const TtyResizeArgs = v.strictObject({
  cols: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(1000)),
  rows: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
});
export const TtyResizeRet = v.strictObject({});

export const TtyGetattrArgs = v.strictObject({ fd: Fd });
export const TtyGetattrRet = TtyAttr;

export const TtySetattrArgs = v.strictObject({
  fd: Fd,
  canonical: v.optional(v.boolean()),
  echo: v.optional(v.boolean()),
  isig: v.optional(v.boolean()),
  altScreen: v.optional(v.boolean()),
});
export const TtySetattrRet = TtyAttr;

export const TcsetpgrpArgs = v.strictObject({ fd: Fd, pgid: Pid });
export const TcsetpgrpRet = v.strictObject({});

export const TcgetpgrpArgs = v.strictObject({ fd: Fd });
export const TcgetpgrpRet = v.strictObject({ pgid: Pid });

export type TtyAttr = v.InferOutput<typeof TtyAttr>;
