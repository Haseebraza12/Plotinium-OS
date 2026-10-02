/**
 * `time.now` (syscall-abi.md §4.4.6). In test mode the host's clock is a frozen fixture, so agent
 * envelopes and cassettes are reproducible (C12).
 */
import type { CallImpl } from '../ipc/handlers.ts';
import type { SyscallContext } from './context.ts';

export function timeNow(k: SyscallContext): CallImpl<'time.now'> {
  return {
    handle: () => {
      const { tz, offsetMin } = k.clock.timeZone();
      return {
        epochMs: Math.max(0, Math.floor(k.clock.epochMs())),
        monotonicMs: Math.max(0, k.clock.now()),
        tz,
        tzOffsetMin: Math.max(-840, Math.min(840, Math.round(offsetMin))),
      };
    },
  };
}
