/**
 * The kernel side of the compositor port and the session layout (architecture.md §4.3, extended by
 * window-manager.md §4.3 and §4.6). Geometry authority stays in the compositor (WM-01): the kernel
 * only asks for windows and records the final geometry it reports, for session restore (WM-06).
 *
 * TODO(protocol): protocol/src/host/compositor.ts and protocol/src/host/layout.ts (Valibot) should
 * own these; the incoming messages are validated here with the same shapes until they land. The
 * shapes are structurally the ones of wm/src/compositor/types.ts plus the §4.3 extension.
 */
import type { KEvent } from '@plotinium/protocol';
import { AppId, Rect as RectSchema, Wid } from '@plotinium/protocol';
import * as v from 'valibot';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type WinState = 'normal' | 'minimised' | 'maximised' | 'fullscreen';
export type Snap = 'left' | 'right' | null;

export const WinStateSchema = v.picklist(['normal', 'minimised', 'maximised', 'fullscreen']);
const SnapSchema = v.nullable(v.picklist(['left', 'right']));

/** One window of a saved layout (window-manager.md §4.6). */
export const LayoutWindowSchema = v.object({
  app: AppId,
  argv: v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.maxLength(256)),
  title: v.pipe(v.string(), v.maxLength(256)),
  rect: RectSchema,
  restoreRect: v.nullable(RectSchema),
  state: WinStateSchema,
  prevState: v.picklist(['normal', 'maximised', 'fullscreen']),
  snap: SnapSchema,
  z: v.pipe(v.number(), v.integer(), v.minValue(0)),
  focused: v.boolean(),
  proc: v.nullable(
    v.object({
      osSessionId: v.string(),
      pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
      pageIds: v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
  ),
});
export type LayoutWindow = v.InferOutput<typeof LayoutWindowSchema>;

export const SessionLayoutSchema = v.object({
  v: v.literal(1),
  osSessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  uid: v.pipe(v.number(), v.integer(), v.minValue(0)),
  savedAt: v.pipe(v.number(), v.minValue(0)),
  viewport: v.object({
    w: v.pipe(v.number(), v.minValue(0)),
    h: v.pipe(v.number(), v.minValue(0)),
    dpr: v.pipe(v.number(), v.minValue(0)),
  }),
  windows: v.pipe(v.array(LayoutWindowSchema), v.maxLength(64)),
});
export type SessionLayout = v.InferOutput<typeof SessionLayoutSchema>;

/** A desktop notification (window-manager.md §4.7, §3.17). */
export interface DeskNotification {
  readonly id: string;
  readonly level: 'info' | 'success' | 'warning' | 'error';
  readonly title: string;
  readonly body?: string;
  readonly actions?: readonly { readonly id: string; readonly label: string }[];
  readonly source: { readonly app?: string; readonly pid?: number; readonly svc?: string };
  readonly at: number;
}

/** The console user, for the menu bar, Control Centre and lock screen (local extension). */
export interface DeskUser {
  readonly uid: number;
  readonly username: string;
  readonly kind: string;
  readonly home: string;
  readonly mode: string;
}

export interface CreatePorts {
  /** The view's end of its view port (syscalls; bound to `(pid, wid)`). */
  readonly view: MessagePort;
  /** The view's end of the display channel (state out, input in; never syscalls). */
  readonly display: MessagePort;
}

export type KernelToCompositor =
  | {
      readonly t: 'create';
      readonly wid: number;
      readonly pid: number;
      readonly app: string;
      readonly title: string;
      readonly icon?: string;
      readonly rect?: Rect;
      readonly restore?: LayoutWindow;
      readonly seq: number;
      readonly activation: boolean;
      readonly limits?: { readonly minW?: number; readonly minH?: number };
      readonly ports: CreatePorts;
    }
  | { readonly t: 'close'; readonly wid: number; readonly seq: number }
  | { readonly t: 'focus'; readonly wid: number; readonly seq: number }
  | { readonly t: 'attention'; readonly wid: number; readonly level: 'info' | 'urgent' }
  | { readonly t: 'setTitle'; readonly wid: number; readonly title: string }
  /**
   * WMD-12 / contract C4 (UI-036): a close of `wid` must first ask "Discard unsaved changes?" with
   * `reason`; null clears the guard.
   */
  | { readonly t: 'closeGuard'; readonly wid: number; readonly reason: string | null }
  | {
      readonly t: 'restoring';
      readonly wid: number;
      readonly doneBytes: number;
      readonly totalBytes: number;
    }
  | { readonly t: 'notify'; readonly n: DeskNotification }
  /** At most one per frame: net.state, svc.*, mem.pressure, update.available, ai.* (§4.3). */
  | { readonly t: 'events'; readonly batch: readonly KEvent[] }
  /** Local extension: the console user changed (login, logout); null before login. */
  | { readonly t: 'session'; readonly user: DeskUser | null; readonly osSessionId: string };

export const CompositorToKernelSchema = v.variant('t', [
  v.object({ t: v.literal('focused'), wid: v.nullable(Wid), seq: v.number() }),
  v.object({
    t: v.picklist(['minimised', 'restored', 'closeRequested']),
    wid: Wid,
    seq: v.optional(v.number()),
  }),
  v.object({
    t: v.literal('geometry'),
    wid: Wid,
    rect: RectSchema,
    state: WinStateSchema,
    z: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /** Session restore (WM-06, UI-034/UI-035): the snap side and the rectangle a restore returns to. */
    snap: v.optional(SnapSchema),
    restoreRect: v.optional(v.nullable(RectSchema)),
  }),
  v.object({ t: v.literal('input'), wid: Wid }),
  v.object({ t: v.literal('dehydrated'), wid: Wid, lastSeq: v.number() }),
  v.object({ t: v.literal('kill'), wid: Wid, signal: v.literal('SIGKILL') }),
  v.object({
    t: v.literal('launch'),
    app: AppId,
    argv: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.maxLength(256))),
    /** Session restore (WM-06): the saved window, already scaled by the shell. */
    restore: v.optional(LayoutWindowSchema),
  }),
  v.object({ t: v.literal('power'), action: v.picklist(['lock', 'logout', 'reboot', 'shutdown']) }),
  v.object({ t: v.literal('layout'), layout: SessionLayoutSchema }),
  v.object({
    t: v.literal('viewCrashed'),
    wid: Wid,
    message: v.pipe(v.string(), v.maxLength(1024)),
  }),
  v.object({ t: v.literal('ready'), wid: Wid, launchToPaintMs: v.number() }),
  /** A notification action button or dismissal (§3.17; the shell sends `actionId`). */
  v.object({
    t: v.literal('notify.action'),
    id: v.pipe(v.string(), v.maxLength(64)),
    actionId: v.pipe(v.string(), v.maxLength(64)),
  }),
  /** The tray's "Retry" on a degraded service (`svc.control retry`). */
  v.object({
    t: v.literal('svc.retry'),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  }),
  /** The connectivity popover's "Retry now" (OFF-04). */
  v.object({ t: v.literal('net.retry') }),
]);
export type CompositorToKernel = v.InferOutput<typeof CompositorToKernelSchema>;

/** The kernel's end of the compositor port (a MessagePort in the worker, a fake in tests). */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  start?(): void;
  close?(): void;
}

/** Creates the channels of `window.create` (the host passes `() => new MessageChannel()`). */
export type ChannelFactory = () => { readonly port1: MessagePort; readonly port2: MessagePort };

/** At most this many windows per desktop session (window-manager.md §3.3). */
export const MAX_WINDOWS = 64;
/** A window created within this long after its process saw user input gets focus (§3.4 rule 7). */
export const ACTIVATION_WINDOW_MS = 1_000;
