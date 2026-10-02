/**
 * Windows and notifications (syscall-abi.md §4.4.4).
 *
 * Spec: MUST, WM-01. Geometry, z-order, drag, resize and snapping are NEVER system calls: the
 * compositor is the only code that writes window geometry. The registry test WM-01 checks that no
 * call here sets geometry or z-order.
 */
import * as v from 'valibot';

import { Count, Rect, Wid } from './common.ts';

export const WindowCreateArgs = v.strictObject({
  title: v.pipe(v.string(), v.maxLength(256)),
  /** An icon id from the design system (for example `app-files`). */
  icon: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/))),
  /** Initial placement request; the compositor decides the final geometry. */
  rect: v.optional(Rect),
  minSize: v.optional(
    v.strictObject({
      w: v.pipe(v.number(), v.finite(), v.minValue(0)),
      h: v.pipe(v.number(), v.finite(), v.minValue(0)),
    }),
  ),
  /** Key under which session restore finds this window again (WM-06). */
  restoreKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
});
/** `display`: the transferred display channel between the process and its view. */
export const WindowCreateRet = v.strictObject({
  wid: Wid,
  rect: Rect,
  display: v.instance(MessagePort),
});

export const WindowCloseArgs = v.strictObject({ wid: Wid });
export const WindowCloseRet = v.strictObject({});

export const WindowFocusArgs = v.strictObject({ wid: Wid });
/** false: no recent user activation, downgraded to `requestAttention` (Spec §9.4, WM-02). */
export const WindowFocusRet = v.strictObject({ focused: v.boolean() });

export const WindowSetTitleArgs = v.strictObject({
  wid: Wid,
  title: v.pipe(v.string(), v.maxLength(256)),
});
export const WindowSetTitleRet = v.strictObject({});

/**
 * `window.setCloseGuard` (window-manager.md WMD-12; contract C4 of the polish wave, UI-036): the
 * shell asks "Discard unsaved changes?" with `reason` before it closes `wid`; null clears it.
 */
export const WindowSetCloseGuardArgs = v.strictObject({
  wid: Wid,
  reason: v.nullable(v.pipe(v.string(), v.maxLength(256))),
});
export const WindowSetCloseGuardRet = v.strictObject({});

export const WindowRequestAttentionArgs = v.strictObject({
  wid: Wid,
  level: v.picklist(['info', 'urgent']),
});
export const WindowRequestAttentionRet = v.strictObject({});

export const NotifyLevel = v.picklist(['info', 'warn', 'error']);
export const NotifyPostArgs = v.strictObject({
  title: v.pipe(v.string(), v.maxLength(128)),
  body: v.pipe(v.string(), v.maxLength(1024)),
  level: NotifyLevel,
  wid: v.optional(Wid),
});
export const NotifyPostRet = v.strictObject({ nid: Count });
