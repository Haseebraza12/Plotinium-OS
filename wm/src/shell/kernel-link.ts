/**
 * The shell's side of the kernel compositor port (window-manager.md §4.3; R-PORT, WMD-02). The
 * compositor is bound to a thin proxy of the port: every kernel message is first read here for
 * what the shell itself needs (the view and display ports and argv of `create`, `notify`, the
 * `events` batches, `closeGuard`, `notResponding`, `restoring`, `restoreFailed`, `suspend`), then
 * handed to the compositor unchanged. Shell intents to the kernel go out on the same port.
 * Framework-free.
 */
import type { KEvent } from '@plotinium/protocol';

import type { CompositorToKernel } from '../compositor/index.ts';
import type { LayoutWindow, PortLike, SessionLayout } from './env.ts';

/** Shell → kernel messages (window-manager.md §4.3, ui-implementation-guide.md §4.9). */
export type ShellToKernel =
  | CompositorToKernel
  | {
      readonly t: 'launch';
      readonly app: string;
      readonly argv: readonly string[];
      readonly restore?: LayoutWindow;
    }
  | { readonly t: 'power'; readonly action: 'lock' | 'logout' | 'reboot' | 'shutdown' }
  | { readonly t: 'layout'; readonly layout: SessionLayout }
  | { readonly t: 'viewCrashed'; readonly wid: number; readonly message: string }
  | { readonly t: 'kill'; readonly wid: number; readonly signal: 'SIGKILL' }
  | { readonly t: 'ready'; readonly wid: number; readonly launchToPaintMs: number }
  | { readonly t: 'svc.retry'; readonly name: string }
  | { readonly t: 'net.retry' }
  | { readonly t: 'notify.action'; readonly id: string; readonly actionId: string };

/** What the shell reads from kernel messages before the compositor sees them. */
export interface KernelLinkHooks {
  onCreate?(m: {
    wid: number;
    pid: number;
    app: string | undefined;
    argv: readonly string[];
    viewPort: MessagePort | null;
    display: MessagePort | null;
    restore: LayoutWindow | null;
  }): void;
  onEvents?(batch: readonly KEvent[]): void;
  onNotify?(n: unknown): void;
  onOverlay?(wid: number, overlay: WindowSignal): void;
  onAttach?(wid: number, display: MessagePort): void;
}

export type WindowSignal =
  | { readonly kind: 'restoring'; readonly doneBytes: number; readonly totalBytes: number }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'not-responding'; readonly on: boolean }
  | { readonly kind: 'restore-failed' }
  | { readonly kind: 'close-guard'; readonly reason: string | null };

function rec(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;
}

function portOf(x: unknown): MessagePort | null {
  return typeof MessagePort !== 'undefined' && x instanceof MessagePort ? x : null;
}

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Read one kernel message for the shell (returns true when it is shell-only). */
export function readKernelMessage(data: unknown, hooks: KernelLinkHooks): boolean {
  const m = rec(data);
  if (m === null || typeof m['t'] !== 'string') return false;
  const wid = num(m['wid']);
  switch (m['t']) {
    case 'create': {
      const pid = num(m['pid']);
      if (wid === null || pid === null) return false;
      const ports = rec(m['ports']);
      const argv = Array.isArray(m['argv'])
        ? m['argv'].filter((a): a is string => typeof a === 'string')
        : [];
      hooks.onCreate?.({
        wid,
        pid,
        app: typeof m['app'] === 'string' ? m['app'] : undefined,
        argv,
        viewPort: portOf(ports?.['view']),
        display: portOf(ports?.['display']),
        restore: (rec(m['restore']) as LayoutWindow | null) ?? null,
      });
      return false;
    }
    case 'events':
      if (Array.isArray(m['batch'])) hooks.onEvents?.(m['batch'] as KEvent[]);
      return true;
    case 'notify':
      hooks.onNotify?.(m['n']);
      return true;
    case 'restoring': {
      const done = num(m['doneBytes']);
      const total = num(m['totalBytes']);
      if (wid !== null && done !== null && total !== null)
        hooks.onOverlay?.(wid, { kind: 'restoring', doneBytes: done, totalBytes: total });
      return false;
    }
    case 'suspend':
      if (wid !== null) hooks.onOverlay?.(wid, { kind: 'suspended' });
      return true;
    case 'attach': {
      const display = portOf(m['display']);
      if (wid !== null && display !== null) hooks.onAttach?.(wid, display);
      return true;
    }
    case 'notResponding':
      if (wid !== null) hooks.onOverlay?.(wid, { kind: 'not-responding', on: m['since'] !== null });
      return true;
    case 'restoreFailed':
      if (wid !== null) hooks.onOverlay?.(wid, { kind: 'restore-failed' });
      return true;
    case 'closeGuard':
      if (wid !== null)
        hooks.onOverlay?.(wid, {
          kind: 'close-guard',
          reason: typeof m['reason'] === 'string' ? m['reason'] : null,
        });
      return true;
    default:
      return false;
  }
}

export interface KernelLink {
  /** Bind this to the compositor (`compositor.bindKernelPort(link.compositorPort)`). */
  readonly compositorPort: PortLike;
  post(m: ShellToKernel): void;
  dispose(): void;
}

/** Wrap the kernel port: the shell reads first, then the compositor's handler runs. */
export function createKernelLink(port: PortLike, hooks: KernelLinkHooks): KernelLink {
  const proxy: PortLike = {
    onmessage: null,
    postMessage: (m: unknown, transfer?: Transferable[]) => {
      port.postMessage(m, transfer);
    },
  };
  port.onmessage = (ev: MessageEvent) => {
    const shellOnly = readKernelMessage(ev.data, hooks);
    if (!shellOnly) proxy.onmessage?.(ev);
  };
  return {
    compositorPort: proxy,
    post: (m) => {
      port.postMessage(m);
    },
    dispose: () => {
      port.onmessage = null;
    },
  };
}
