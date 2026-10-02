/**
 * Platform events the main thread forwards to the kernel (offline-and-sync.md SYN-15;
 * architecture.md §4.2): the main thread only forwards `online`/`offline`, `visibilitychange`,
 * `pagehide`, the viewport and the Service Worker's lifecycle; every decision (sync, session
 * save, the update badge) is made in the kernel worker.
 *
 * The viewport is sent once when the kernel is ready and then at most once per animation frame
 * while the window is resized.
 */
import type { UpdateState } from '../sw/update.ts';

/** The router → kernel messages this module sends (a subset of `RouterToKernel`). */
export type PlatformMessage =
  | { readonly t: 'net.online' }
  | { readonly t: 'net.offline' }
  | { readonly t: 'visibility'; readonly state: 'hidden' | 'visible' }
  | { readonly t: 'pagehide' }
  | { readonly t: 'viewport'; readonly w: number; readonly h: number; readonly dpr: number }
  | { readonly t: 'sw'; readonly event: 'registered' | 'waiting' | 'activated' | 'error' };

export interface PlatformWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly document: { readonly visibilityState: DocumentVisibilityState } & Pick<
    EventTarget,
    'addEventListener' | 'removeEventListener'
  >;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  requestAnimationFrame(fn: () => void): number;
}

export interface PlatformForwarder {
  /** Send the current viewport now (call when the kernel is ready). */
  viewport(): void;
  dispose(): void;
}

export function forwardPlatformEvents(
  win: PlatformWindow,
  post: (msg: PlatformMessage) => void,
): PlatformForwarder {
  const doc = win.document;
  let framed = false;
  let last = '';
  const viewport = (): void => {
    const msg = {
      t: 'viewport',
      w: Math.round(win.innerWidth),
      h: Math.round(win.innerHeight),
      dpr: win.devicePixelRatio || 1,
    } as const;
    const key = `${String(msg.w)}x${String(msg.h)}@${String(msg.dpr)}`;
    if (key === last) return;
    last = key;
    post(msg);
  };
  const onResize = (): void => {
    if (framed) return;
    framed = true;
    win.requestAnimationFrame(() => {
      framed = false;
      viewport();
    });
  };
  const onOnline = (): void => {
    post({ t: 'net.online' });
  };
  const onOffline = (): void => {
    post({ t: 'net.offline' });
  };
  const onVisibility = (): void => {
    post({ t: 'visibility', state: doc.visibilityState === 'hidden' ? 'hidden' : 'visible' });
  };
  const onPageHide = (): void => {
    post({ t: 'pagehide' });
  };
  win.addEventListener('online', onOnline);
  win.addEventListener('offline', onOffline);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('resize', onResize);
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    viewport,
    dispose() {
      win.removeEventListener('online', onOnline);
      win.removeEventListener('offline', onOffline);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('resize', onResize);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/**
 * Service Worker lifecycle as the kernel's `update` service reads it (`SwEvent`): each transition
 * of the update controller's state is sent once.
 */
export function swEvents(
  prev: UpdateState,
  next: UpdateState,
): ('registered' | 'waiting' | 'activated' | 'error')[] {
  const out: ('registered' | 'waiting' | 'activated' | 'error')[] = [];
  if (prev.phase !== 'active' && next.phase === 'active') out.push('registered');
  if (!prev.offlineReady && next.offlineReady) out.push('activated');
  if (prev.waiting === null && next.waiting !== null) out.push('waiting');
  if (prev.phase !== 'error' && next.phase === 'error') out.push('error');
  return out;
}
