/**
 * The window layer (window-manager.md §3.1–§3.8, §3.19): one ui `WindowFrame` per window,
 * rendered in creation order (R-DOM) inside a slot element that the compositor alone positions
 * (R-GEO: its flush writes translate3d, width, height and z-index on the slot; nothing here binds
 * geometry). The chrome's intents go straight to the compositor: traffic lights, title-bar drag
 * and double-click (with the user's double-click action, UI-041), the eight resize handles,
 * click-to-focus. The layer also holds the snap preview element (§3.6, UI-038).
 */
import { For, onCleanup, onMount, untrack, type JSX } from 'solid-js';

import type { Compositor, Snap } from '../compositor/index.ts';
import type { WinState } from '../compositor/index.ts';
import { captureTarget, titleDoubleClickAction } from './dom.ts';
import styles from './Shell.module.css';
import type { IconId, WindowOverlay, WindowOverlayAction } from './ui.ts';
import { WindowFrame } from './ui.ts';
import layer from './WindowLayer.module.css';

/** One window as the chrome draws it (coarse state only, R-STATE). */
export interface WinView {
  readonly wid: number;
  readonly pid: number;
  readonly app: string;
  readonly appName: string;
  readonly icon: IconId;
  /** `unified`: the app draws its own toolbar under floating traffic lights. */
  readonly chrome: 'titlebar' | 'unified';
  readonly resizable: boolean;
  readonly maximizable: boolean;
  title: string;
  state: WinState;
  /** Snapped to a half: square corners on that edge (D-24, UI-154). */
  snap: Snap;
  focused: boolean;
  dragging: boolean;
  attention: boolean;
  overlay: WindowOverlay | undefined;
  /** The window's live region (keyboard move and size results). */
  status: string;
}

export interface WindowParts {
  /** The compositor's geometry target. */
  readonly slot: HTMLDivElement;
  /** The WindowFrame section: chrome, focus shadow and the WAAPI motion. */
  readonly section: HTMLElement;
  /** The app view's container. */
  readonly view: HTMLDivElement;
}

export interface WindowLayerProps {
  windows: readonly WinView[];
  compositor: Compositor;
  /** Overview is open: the real windows step aside for their tiles. */
  overview: boolean;
  onParts: (wid: number, parts: WindowParts) => void;
  onGone: (wid: number) => void;
  onClose: (wid: number) => void;
  /** The window menu, anchored on the title bar or at a right-click's pointer position. */
  onWindowMenu: (wid: number, anchor: HTMLElement, at?: { x: number; y: number }) => void;
  onOverlayAction: (wid: number, action: WindowOverlayAction) => void;
  /** The snap preview element, handed to the compositor's preview writer. */
  previewRef?: (el: HTMLDivElement) => void;
}

function WindowSlot(props: {
  win: WinView;
  compositor: Compositor;
  onParts: WindowLayerProps['onParts'];
  onGone: WindowLayerProps['onGone'];
  onClose: WindowLayerProps['onClose'];
  onWindowMenu: WindowLayerProps['onWindowMenu'];
  onOverlayAction: WindowLayerProps['onOverlayAction'];
}): JSX.Element {
  let slot: HTMLDivElement | undefined;
  let section: HTMLElement | undefined;
  let view: HTMLDivElement | undefined;
  // A window's id never changes; read it once.
  const wid = untrack(() => props.win.wid);
  const cmp = untrack(() => props.compositor);

  onMount(() => {
    if (slot !== undefined && section !== undefined && view !== undefined)
      props.onParts(wid, { slot, section, view });
  });
  onCleanup(() => props.onGone(wid));

  /** The Settings choice for a title-bar double-click, read at the moment of the click (C3). */
  const titleDoubleClick = (): void => {
    const root = section?.ownerDocument.documentElement;
    const action = root === undefined ? 'zoom' : titleDoubleClickAction(root);
    if (action === 'minimise') void cmp.minimise(wid);
    else if (action === 'zoom' && props.win.maximizable) cmp.titleDoubleClick(wid);
  };

  return (
    <div ref={(el) => (slot = el)} class={styles.slot}>
      <WindowFrame
        class={styles.frame}
        frameRef={(el) => (section = el)}
        id={`pl-win-${String(wid)}`}
        title={props.win.title}
        appName={props.win.appName}
        focused={props.win.focused}
        state={props.win.state}
        snap={props.win.snap}
        dragging={props.win.dragging}
        titlebar={props.win.chrome === 'unified' ? 'overlay' : 'standard'}
        resizable={props.win.resizable}
        canMaximise={props.win.maximizable}
        overlay={props.win.overlay}
        status={props.win.status}
        onOverlayAction={(action) => props.onOverlayAction(wid, action)}
        onClose={() => props.onClose(wid)}
        onMinimise={() => void cmp.minimise(wid)}
        onMaximize={() => void cmp.toggleMaximise(wid)}
        onTitleDoubleClick={titleDoubleClick}
        onFocusRequest={() => {
          cmp.focus(wid);
          cmp.input(wid);
        }}
        onTitlePointerDown={(event) => {
          const target = event.currentTarget;
          if (target instanceof HTMLElement)
            cmp.titlePointerDown(wid, event, captureTarget(target));
        }}
        onResizeStart={(edge, event) => {
          const target = event.currentTarget;
          if (target instanceof HTMLElement)
            cmp.resizeStart(wid, edge, event, captureTarget(target));
        }}
        onWindowMenu={(anchor, at) => props.onWindowMenu(wid, anchor, at)}
      >
        <div ref={(el) => (view = el)} class={styles.view} data-wm-view="" />
      </WindowFrame>
    </div>
  );
}

export function WindowLayer(props: WindowLayerProps): JSX.Element {
  return (
    <>
      <div
        class={styles.windows}
        role="region"
        aria-label="Windows"
        data-overview={props.overview ? 'true' : 'false'}
      >
        <For each={props.windows}>
          {(win) => (
            <WindowSlot
              win={win}
              compositor={props.compositor}
              onParts={props.onParts}
              onGone={props.onGone}
              onClose={props.onClose}
              onWindowMenu={props.onWindowMenu}
              onOverlayAction={props.onOverlayAction}
            />
          )}
        </For>
      </div>
      <div
        ref={(el) => props.previewRef?.(el)}
        class={layer.snapPreview}
        data-testid="snap-preview"
        data-visible="false"
        aria-hidden="true"
      />
    </>
  );
}
