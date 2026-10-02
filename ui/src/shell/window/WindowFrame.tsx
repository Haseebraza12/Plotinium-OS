import Maximize2 from 'lucide-solid/icons/maximize-2';
import Minimize2 from 'lucide-solid/icons/minimize-2';
import Minus from 'lucide-solid/icons/minus';
import X from 'lucide-solid/icons/x';
import {
  children,
  createEffect,
  createUniqueId,
  For,
  Match,
  on,
  onCleanup,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';

import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { prefersReducedMotion } from '../../primitives/internal/motion.ts';
import { ProgressBar } from '../../primitives/progress/ProgressBar.tsx';
import { bytesAsMb } from '../format.ts';
import type {
  ResizeEdge,
  WindowOverlay,
  WindowOverlayAction,
  WindowPhase,
  WindowState,
} from '../types.ts';
import styles from './WindowFrame.module.css';

export interface WindowFrameProps {
  title: string;
  /** Names the controls ("Close Files"); defaults to the title. */
  appName?: string;
  focused: boolean;
  state?: WindowState;
  /**
   * Snapped to a half (window-manager.md §3.6): the corners on that screen edge are square
   * (`--pl-radius-win` → 0 on the snapped edge, D-24).
   */
  snap?: 'left' | 'right' | null;
  /** A drag or resize gesture is running: the heavy shadow tier drops (DSN-31, P4). */
  dragging?: boolean;
  /** A one-shot chrome animation; `onPhaseEnd` fires once when it finishes. */
  phase?: WindowPhase;
  onPhaseEnd?: (phase: WindowPhase) => void;
  /**
   * Minimise / restore target in px, read once at animation start (R-READ): the dock icon's centre
   * minus the window's bottom centre, because the genie keyframes scale about 50% 100%.
   */
  genie?: { x: number; y: number };
  /** Maximise / un-maximise FLIP start frame. */
  flip?: { x: number; y: number; sx: number; sy: number };
  /** One light sheen across the content (session restore finished). */
  shimmer?: boolean;
  /** Process coupling overlays (window-manager.md §3.12). */
  overlay?: WindowOverlay;
  onOverlayAction?: (action: WindowOverlayAction) => void;
  /** Unified toolbar content, drawn in the title bar after the traffic lights. */
  toolbar?: JSX.Element;
  /**
   * 'overlay': the app draws its own unified toolbar and full-height sidebar (Files, Settings,
   * Task Manager), so the frame keeps only the traffic lights, floating at the top-left over the
   * content (centred in the 52 px toolbar row, first circle 20 px in). The title is still the
   * accessible name. Any `[data-pl-drag-region]` in the content drags the window and zooms it on
   * double-click, like the title bar. Default 'standard'.
   */
  titlebar?: 'standard' | 'overlay';
  /** Hides the centred title visually (it still names the window). */
  hideTitle?: boolean;
  children?: JSX.Element;
  /** Geometry from the compositor (transform, width, height, z-index). */
  style?: JSX.CSSProperties;
  canMinimise?: boolean;
  canMaximise?: boolean;
  resizable?: boolean;
  onClose: () => void;
  onMinimise: () => void;
  /** Zoom button and title-bar double-click (WM-04, window-manager.md §3.8). */
  onMaximize: () => void;
  /**
   * A double-click on the title bar or a drag region. When set it replaces the default (zoom via
   * `onMaximize`, unless `canMaximise` is false), so the shell can apply the user's choice.
   */
  onTitleDoubleClick?: () => void;
  /** Pointer-down anywhere on the window: focus and raise it. */
  onFocusRequest?: () => void;
  /** Pointer-down on the title bar outside its controls: the compositor starts a drag. */
  onTitlePointerDown?: (event: PointerEvent) => void;
  /** Pointer-down on one of the eight resize handles. */
  onResizeStart?: (edge: ResizeEdge, event: PointerEvent) => void;
  /**
   * The window menu (Move, Size …, WCAG 2.5.7): Shift+F10 or the Menu key on the title bar
   * (`at` undefined), or a right-click on the title bar or a drag region (`at` = the pointer).
   */
  onWindowMenu?: (anchor: HTMLElement, at?: { x: number; y: number }) => void;
  /** The window's live region (keyboard move and size results, "Moved to 120, 80"). */
  status?: string;
  frameRef?: (el: HTMLElement) => void;
  id?: string;
  class?: string;
}

export const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const PHASE_CLASS: Record<WindowPhase, string> = {
  opening: 'pl-anim-window-open',
  closing: 'pl-anim-window-close',
  minimising: 'pl-anim-window-minimise',
  restoring: 'pl-anim-window-restore',
  maximising: 'pl-anim-window-maximise',
  unmaximising: 'pl-anim-window-unmaximise',
};

/** Upper bounds (ms) from the motion table, plus slack; a phase always ends even unseen. */
const PHASE_MAX_MS: Record<WindowPhase, number> = {
  opening: 460,
  closing: 260,
  minimising: 420,
  restoring: 420,
  maximising: 360,
  unmaximising: 360,
};

const NO_DRAG =
  'button, input, select, textarea, a[href], [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="menuitem"], [role="combobox"], [data-no-drag]';

/**
 * Window chrome only (window-manager.md §3.5–§3.8, §3.19): static tinted glass (no live blur),
 * traffic lights on the left (glyphs on hover, grey when unfocused), a centred title, a toolbar
 * slot, and eight resize handles that call props. Geometry comes from the compositor through
 * `style`; this component never measures or moves itself. The outer element carries the shadow
 * tiers (a crossfaded ::before for focus, DSN-31); the inner frame has contain: layout paint.
 */
export function WindowFrame(props: WindowFrameProps): JSX.Element {
  const [local] = splitProps(props, [
    'title',
    'appName',
    'focused',
    'state',
    'snap',
    'dragging',
    'phase',
    'onPhaseEnd',
    'genie',
    'flip',
    'shimmer',
    'overlay',
    'onOverlayAction',
    'toolbar',
    'titlebar',
    'hideTitle',
    'children',
    'style',
    'canMinimise',
    'canMaximise',
    'resizable',
    'onClose',
    'onMinimise',
    'onMaximize',
    'onTitleDoubleClick',
    'onFocusRequest',
    'onTitlePointerDown',
    'onResizeStart',
    'onWindowMenu',
    'status',
    'frameRef',
    'id',
    'class',
  ]);
  const uid = createUniqueId();
  const titleId = (): string => `${local.id ?? `pl-win-${uid}`}-title`;
  const name = (): string => local.appName ?? local.title;
  const state = (): WindowState => local.state ?? 'normal';
  const maximised = (): boolean => state() === 'maximised' || state() === 'fullscreen';
  const showHandles = (): boolean => local.resizable !== false && state() === 'normal';
  const toolbar = children(() => local.toolbar);
  const overlay = (): boolean => local.titlebar === 'overlay';

  // ---------- one-shot phases ----------
  const reduced = (): boolean => typeof document !== 'undefined' && prefersReducedMotion(document);
  let ended: WindowPhase | undefined;
  let safety: ReturnType<typeof setTimeout> | undefined;
  const finish = (phase: WindowPhase): void => {
    clearTimeout(safety);
    if (ended === phase) return;
    ended = phase;
    local.onPhaseEnd?.(phase);
  };
  createEffect(
    on(
      () => local.phase,
      (phase) => {
        clearTimeout(safety);
        ended = undefined;
        if (phase === undefined) return;
        if (reduced()) {
          queueMicrotask(() => finish(phase));
          return;
        }
        safety = setTimeout(() => finish(phase), PHASE_MAX_MS[phase]);
      },
    ),
  );
  onCleanup(() => clearTimeout(safety));
  const phaseClass = (): string | undefined =>
    local.phase === undefined || reduced() ? undefined : PHASE_CLASS[local.phase];

  const style = (): JSX.CSSProperties => {
    const out: JSX.CSSProperties = { ...(local.style ?? {}) };
    if (local.genie !== undefined) {
      out['--pl-genie-x'] = `${local.genie.x}px`;
      out['--pl-genie-y'] = `${local.genie.y}px`;
    }
    if (local.flip !== undefined) {
      out['--pl-flip-x'] = `${local.flip.x}px`;
      out['--pl-flip-y'] = `${local.flip.y}px`;
      out['--pl-flip-sx'] = String(local.flip.sx);
      out['--pl-flip-sy'] = String(local.flip.sy);
    }
    return out;
  };

  // ---------- title bar ----------
  const fromControl = (event: Event): boolean =>
    event.target instanceof Element && event.target.closest(NO_DRAG) !== null;
  /** Overlay title bar: a pointer on an app's drag region (toolbar, sidebar top) acts on the window. */
  const fromDragRegion = (event: Event): boolean =>
    overlay() &&
    event.target instanceof Element &&
    event.target.closest('[data-pl-drag-region]') !== null &&
    !fromControl(event);
  /**
   * The last primary press in the content began on a drag region. A drag region's press takes
   * pointer capture on the content element, so the `dblclick` that follows targets the content
   * element, not the region (UI-033); this remembers where the press really was.
   */
  let dragRegionPress = false;
  /** Double-click on the title bar or a drag region (WM-04 §3.8; the shell may apply a pref). */
  const titleDoubleClick = (): void => {
    if (local.onTitleDoubleClick !== undefined) local.onTitleDoubleClick();
    else if (local.canMaximise !== false) local.onMaximize();
  };
  /** Right-click on the title bar or a drag region: the window menu at the pointer (D-02). */
  const contextMenu = (event: MouseEvent, anchor: HTMLElement): void => {
    if (local.onWindowMenu === undefined || event.defaultPrevented) return;
    event.preventDefault();
    local.onWindowMenu(anchor, { x: event.clientX, y: event.clientY });
  };

  const overlayAction = (action: WindowOverlayAction) => () => local.onOverlayAction?.(action);
  const restoring = (): Extract<WindowOverlay, { kind: 'restoring' }> | undefined => {
    const overlay = local.overlay;
    return overlay?.kind === 'restoring' ? overlay : undefined;
  };

  return (
    <section
      ref={(el) => local.frameRef?.(el)}
      id={local.id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId()}
      inert={state() === 'minimised' && local.phase === undefined}
      class={cx(styles.window, 'pl-focus-shadow', phaseClass(), local.class)}
      style={style()}
      data-focused={local.focused ? 'true' : 'false'}
      data-dragging={local.dragging === true ? 'true' : 'false'}
      data-state={state()}
      data-snap={state() === 'normal' && local.snap != null ? local.snap : undefined}
      data-phase={local.phase}
      onPointerDown={() => local.onFocusRequest?.()}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && local.phase !== undefined) finish(local.phase);
      }}
    >
      <div class={styles.frame} data-titlebar={overlay() ? 'overlay' : 'standard'}>
        <div
          class={styles.titlebar}
          data-toolbar={toolbar() == null || overlay() ? 'false' : 'true'}
          onPointerDown={(event) => {
            if (event.button !== 0 || fromControl(event)) return;
            local.onTitlePointerDown?.(event);
          }}
          onDblClick={(event) => {
            if (fromControl(event)) return;
            titleDoubleClick();
          }}
          onContextMenu={(event) => {
            if (fromControl(event)) {
              // No page menu over the traffic lights either.
              if (local.onWindowMenu !== undefined) event.preventDefault();
              return;
            }
            contextMenu(event, event.currentTarget);
          }}
          onKeyDown={(event) => {
            if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
              if (local.onWindowMenu === undefined) return;
              event.preventDefault();
              local.onWindowMenu(event.currentTarget);
            }
          }}
        >
          <div class={styles.lights} role="group" aria-label="Window controls">
            <button
              type="button"
              class={cx(styles.light, styles.close)}
              aria-label={`Close ${name()}`}
              onClick={() => local.onClose()}
            >
              <X size={8} stroke-width={3} class={styles.glyph} aria-hidden="true" />
            </button>
            <button
              type="button"
              class={cx(styles.light, styles.minimise)}
              aria-label={`Minimise ${name()}`}
              aria-disabled={local.canMinimise === false ? 'true' : undefined}
              onClick={() => {
                if (local.canMinimise !== false) local.onMinimise();
              }}
            >
              <Minus size={8} stroke-width={3} class={styles.glyph} aria-hidden="true" />
            </button>
            <button
              type="button"
              class={cx(styles.light, styles.zoom)}
              aria-label={`${maximised() ? 'Restore' : 'Zoom'} ${name()}`}
              aria-disabled={local.canMaximise === false ? 'true' : undefined}
              onClick={() => {
                if (local.canMaximise !== false) local.onMaximize();
              }}
            >
              <Show
                when={maximised()}
                fallback={
                  <Maximize2 size={8} stroke-width={3} class={styles.glyph} aria-hidden="true" />
                }
              >
                <Minimize2 size={8} stroke-width={3} class={styles.glyph} aria-hidden="true" />
              </Show>
            </button>
          </div>
          <h2
            id={titleId()}
            class={cx(styles.title, (local.hideTitle === true || overlay()) && styles.srOnly)}
          >
            {local.title}
          </h2>
          <Show when={!overlay() && toolbar()}>
            <div class={styles.toolbar}>{toolbar()}</div>
          </Show>
        </div>

        <div
          class={cx(styles.content, local.shimmer === true && 'pl-anim-restore-shimmer')}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            dragRegionPress = fromDragRegion(event);
            if (!dragRegionPress) return;
            local.onTitlePointerDown?.(event);
          }}
          onDblClick={(event) => {
            const onRegion =
              fromDragRegion(event) ||
              (dragRegionPress && event.target === event.currentTarget && overlay());
            if (!onRegion) return;
            titleDoubleClick();
          }}
          onContextMenu={(event) => {
            if (fromDragRegion(event)) contextMenu(event, event.currentTarget);
          }}
        >
          {local.children}
          <Show when={local.overlay}>
            {(overlay) => (
              <div class={styles.overlay} data-kind={overlay().kind}>
                <Switch>
                  <Match when={restoring()}>
                    {(r) => (
                      <div class={styles.overlayCard}>
                        <ProgressBar
                          label="Restoring…"
                          value={r().doneBytes}
                          max={Math.max(1, r().totalBytes)}
                          valueText={`${bytesAsMb(r().doneBytes)} / ${bytesAsMb(r().totalBytes)} MB`}
                          showValue
                          sweep
                        />
                      </div>
                    )}
                  </Match>
                  <Match when={overlay().kind === 'suspended'}>
                    <button
                      type="button"
                      class={styles.suspended}
                      onClick={overlayAction('restore')}
                    >
                      Suspended — click to restore
                    </button>
                  </Match>
                  <Match when={overlay().kind === 'not-responding'}>
                    <div class={styles.overlayCard} role="alert">
                      <p class={styles.overlayTitle}>Not responding</p>
                      <div class={styles.overlayActions}>
                        <Button size="sm" onClick={overlayAction('wait')}>
                          Wait
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={overlayAction('force-quit')}
                        >
                          Force quit
                        </Button>
                      </div>
                    </div>
                  </Match>
                  <Match when={overlay().kind === 'restore-failed'}>
                    <div class={styles.overlayCard} role="alert">
                      <p class={styles.overlayTitle}>Could not restore</p>
                      <div class={styles.overlayActions}>
                        <Button size="sm" variant="primary" onClick={overlayAction('restart')}>
                          Restart app
                        </Button>
                        <Button size="sm" onClick={overlayAction('details')}>
                          Details
                        </Button>
                      </div>
                    </div>
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
        </div>
      </div>

      <Show when={showHandles()}>
        <For each={RESIZE_EDGES}>
          {(edge) => (
            <div
              class={styles.handle}
              data-edge={edge}
              aria-hidden="true"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                local.onFocusRequest?.();
                local.onResizeStart?.(edge, event);
              }}
            />
          )}
        </For>
      </Show>
      <div class={styles.srOnly} role="status" aria-live="polite">
        {local.status ?? ''}
      </div>
    </section>
  );
}
