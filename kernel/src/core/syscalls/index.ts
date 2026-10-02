/**
 * The syscalls the kernel core implements itself. Other groups (fs, fd, tty, window, mem, lock,
 * net, ev, ai) are registered by their subsystems; until then they answer ENOSYS at stage 2.
 */
import type { HandlerRegistry } from '../ipc/handlers.ts';
import type { SyscallContext } from './context.ts';
import { getpid, procList } from './proc.ts';
import { dmesg, uname } from './sys.ts';
import { timeNow } from './time.ts';

export type { SyscallContext } from './context.ts';

export function registerCoreSyscalls(reg: HandlerRegistry, k: SyscallContext): void {
  reg.register('getpid', getpid());
  reg.register('proc.list', procList(k));
  reg.register('uname', uname(k));
  reg.register('dmesg', dmesg(k));
  reg.register('time.now', timeNow(k));
}
