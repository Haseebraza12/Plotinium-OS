/**
 * Window and notification system calls (syscall-abi.md §4.4.4; window-manager.md §3.12, §4.5).
 *
 * Ownership: the kernel checks `pcb.windows.has(wid)` on every window call (EPERM otherwise); from
 * a view port the only window a view may name is its own (the port's `wid`). Geometry, z-order,
 * drag and resize are never system calls (WM-01).
 */
import { KernelError } from '../errors.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';
import type { Caller } from '../ipc/ports.ts';
import type { Windows } from './service.ts';

export const WINDOW_SYSCALLS = [
  'window.create',
  'window.close',
  'window.focus',
  'window.setTitle',
  'window.requestAttention',
  'notify.post',
] as const;

function owns(c: Caller, wid: number): KernelError | null {
  if (c.origin === 'V' && c.wid !== wid)
    return new KernelError('EPERM', { reason: 'owner' }, 'a view may only name its own window');
  if (!c.pcb.windows.has(wid))
    return new KernelError('EPERM', { reason: 'owner' }, 'not your window');
  return null;
}

export function registerWindowSyscalls(reg: HandlerRegistry, w: Windows): void {
  reg.register('window.create', {
    handle: (c, a) => {
      const made = w.create(c.pcb, {
        title: a.title,
        ...(a.icon === undefined ? {} : { icon: a.icon }),
        ...(a.rect === undefined ? {} : { rect: a.rect }),
        ...(a.minSize === undefined ? {} : { minSize: a.minSize }),
        ...(a.restoreKey === undefined ? {} : { restoreKey: a.restoreKey }),
      });
      return { wid: made.wid, rect: made.rect, display: made.display };
    },
  });
  reg.register('window.close', {
    authorize: (c, a) => owns(c, a.wid),
    handle: (c, a) => {
      w.close(a.wid, 'window-closed', c.pcb);
      return {};
    },
  });
  reg.register('window.focus', {
    authorize: (c, a) => owns(c, a.wid),
    handle: (c, a) => ({ focused: w.focus(c.pcb, a.wid) }),
  });
  reg.register('window.setTitle', {
    authorize: (c, a) => owns(c, a.wid),
    handle: (_c, a) => {
      w.setTitle(a.wid, a.title);
      return {};
    },
  });
  reg.register('window.setCloseGuard', { handle: (c, a) => setCloseGuard(w, c, a) });
  reg.register('window.requestAttention', {
    authorize: (c, a) => owns(c, a.wid),
    handle: (_c, a) => {
      w.attention(a.wid, a.level);
      return {};
    },
  });
  reg.register('notify.post', {
    authorize: (c, a) => (a.wid === undefined ? null : owns(c, a.wid)),
    handle: (c, a) => w.postNotification(c.pcb, a),
  });
}

/**
 * The handler of `window.setCloseGuard {wid, reason}` (contract C4; UI-036): EPERM when the caller
 * does not own `wid`, EINVAL for an unknown window or a reason over 256 characters (the protocol
 * schema rejects a longer reason before it gets here). Registered by `registerWindowSyscalls`.
 */
export function setCloseGuard(
  w: Windows,
  c: Caller,
  a: { readonly wid: number; readonly reason: string | null },
): Record<string, never> {
  const denied = owns(c, a.wid);
  if (denied !== null) throw denied;
  w.setCloseGuard(a.wid, a.reason);
  return {};
}
