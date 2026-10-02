import Plus from 'lucide-solid/icons/plus';
import X from 'lucide-solid/icons/x';
import {
  createEffect,
  createMemo,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  untrack,
  type JSX,
} from 'solid-js';
import { Portal } from 'solid-js/web';

import { AppIcon, type IconId } from '../../icons/index.tsx';
import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { trapTabKey } from '../../primitives/internal/focus.ts';
import type { Rect } from '../../primitives/internal/position.ts';
import { Kbd } from '../../primitives/kbd/Kbd.tsx';
import { createModalLayer, idPart } from '../internal/behaviour.ts';
import styles from './Overview.module.css';

export type OverviewWindowState = 'normal' | 'minimised' | 'suspended' | 'restoring';

export interface OverviewWindow {
  id: string;
  /** `Terminal — ~`. */
  title: string;
  app: IconId;
  appName: string;
  state?: OverviewWindowState;
  /** Width / height of the real window; its slot keeps the proportion. */
  aspect: number;
  /** The real window rectangle (viewport px): the tile zooms out of it and back into it. */
  rect?: Rect;
  /**
   * A miniature for standalone use (gallery, tests). In the desktop the WM moves the real window
   * elements into the slots reported by `onLayout` instead, so live content keeps running.
   */
  thumbnail?: JSX.Element;
}

export interface OverviewDesktop {
  id: string;
  name: string;
  active?: boolean;
  preview?: JSX.Element;
}

export interface OverviewSlot {
  id: string;
  rect: Rect;
}

export interface OverviewProps {
  open: boolean;
  windows: readonly OverviewWindow[];
  selectedId: string | undefined;
  /** Arrow keys or the pointer moved the highlight. */
  onSelect: (id: string) => void;
  /** Enter or a click: focus that window and leave Overview. */
  onPick: (id: string) => void;
  /** Escape or a click on the empty backdrop: leave and restore the previous focus. */
  onCancel: () => void;
  /** The close button, Delete or Alt+Q on the highlighted window (close guards still apply). */
  onCloseWindow?: (id: string) => void;
  /** Slot rectangles after layout (and on resize), for the WM to FLIP the real windows. */
  onLayout?: (slots: readonly OverviewSlot[]) => void;
  /** Desktops strip (behind a flag until multiple desktops exist in the WM spec). */
  desktops?: readonly OverviewDesktop[];
  onSwitchDesktop?: (id: string) => void;
  onAddDesktop?: () => void;
  maxDesktops?: number;
  /** Empty state buttons. */
  onLaunch?: (app: 'terminal' | 'files') => void;
  /** Render inside the nearest positioned ancestor instead of a full-screen portal (gallery). */
  contained?: boolean;
  class?: string;
}

/**
 * An element's layout box in viewport px, ignoring every CSS transform: the slot is measured
 * while its tile is still zooming in (a FLIP transform that makes it window-sized) and while the
 * selected tile is scaled up, and the thumbnails must scale to the slot, not to the transformed
 * box (UI-029). Offsets are summed up the offsetParent chain to the fixed layer.
 */
export function layoutRect(el: HTMLElement): Rect {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node !== null) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return { x, y, width: el.offsetWidth, height: el.offsetHeight };
}

/** Columns for n windows: one row up to three, two rows up to eight, then a squarer grid. */
export function overviewColumns(count: number): number {
  if (count <= 3) return Math.max(1, count);
  if (count <= 8) return Math.ceil(count / 2);
  return Math.ceil(Math.sqrt(count * 1.4));
}

/** The FLIP start frame that makes a slot look like the window it came from (origin 0 0). */
export function flipFrom(from: Rect, slot: Rect): { x: number; y: number; sx: number; sy: number } {
  return {
    x: from.x - slot.x,
    y: from.y - slot.y,
    sx: slot.width > 0 ? from.width / slot.width : 1,
    sy: slot.height > 0 ? from.height / slot.height : 1,
  };
}

const STATE_LABEL: Readonly<Record<OverviewWindowState, string | undefined>> = {
  normal: undefined,
  minimised: 'minimised',
  suspended: 'suspended',
  restoring: 'Restoring…',
};

/**
 * Overview (WM-07; docs/design/stitch/overview-switcher): every window zoomed out and tiled over
 * a dimmed, blurred backdrop, each with a caption pill. It opens with a zoom: each tile FLIPs
 * from its real window rectangle into its slot (transform only), and zooms back on exit. The
 * grid is a listbox with 2-D arrow keys, Enter to pick, Delete or Alt+Q to close, Escape to
 * cancel.
 */
export function Overview(props: OverviewProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'windows',
    'selectedId',
    'onSelect',
    'onPick',
    'onCancel',
    'onCloseWindow',
    'onLayout',
    'desktops',
    'onSwitchDesktop',
    'onAddDesktop',
    'maxDesktops',
    'onLaunch',
    'contained',
    'class',
  ]);
  const uid = createUniqueId();
  const optionId = (id: string): string => `pl-overview-${uid}-${idPart(id)}`;
  let panel: HTMLDivElement | undefined;
  let grid: HTMLDivElement | undefined;
  const presence = createModalLayer({
    open: () => local.open,
    panel: () => panel,
    exitMs: 340,
    onEscape: () => local.onCancel(),
  });
  const closing = (): boolean => presence.state() === 'closing';
  const columns = createMemo(() => overviewColumns(local.windows.length));
  const index = createMemo(() => local.windows.findIndex((w) => w.id === local.selectedId));

  // Roving focus follows the highlight (after the first frame, focusInitial puts it there).
  createEffect(
    on(
      () => local.selectedId,
      (id) => {
        if (id === undefined || grid === undefined) return;
        const el = grid.querySelector<HTMLElement>(`[id="${optionId(id)}"]`);
        if (el !== null && grid.contains(el.ownerDocument.activeElement)) el.focus();
      },
      { defer: true },
    ),
  );

  const reportLayout = (): void => {
    if (local.onLayout === undefined || grid === undefined) return;
    const slots: OverviewSlot[] = [];
    for (const w of local.windows) {
      const frame = grid.querySelector<HTMLElement>(`[data-frame="${idPart(w.id)}"]`);
      if (frame === null) continue;
      slots.push({ id: w.id, rect: layoutRect(frame) });
    }
    local.onLayout(slots);
  };

  const step = (delta: number): void => {
    const count = local.windows.length;
    if (count === 0) return;
    const current = index() < 0 ? 0 : index();
    const next = Math.min(count - 1, Math.max(0, current + delta));
    const win = local.windows[next];
    if (win !== undefined) local.onSelect(win.id);
  };

  const onGridKeyDown = (event: KeyboardEvent): void => {
    const current = local.windows[index()];
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        step(1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        step(-1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        step(columns());
        return;
      case 'ArrowUp':
        event.preventDefault();
        step(-columns());
        return;
      case 'Home':
        event.preventDefault();
        step(-local.windows.length);
        return;
      case 'End':
        event.preventDefault();
        step(local.windows.length);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current !== undefined) local.onPick(current.id);
        return;
      case 'Delete':
      case 'q':
      case 'Q':
        if ((event.key === 'q' || event.key === 'Q') && !event.altKey) return;
        event.preventDefault();
        if (current !== undefined) local.onCloseWindow?.(current.id);
        return;
      default:
        return;
    }
  };

  const Tile = (tileProps: { win: OverviewWindow; index: number }): JSX.Element => {
    let frame: HTMLDivElement | undefined;
    const selected = (): boolean => tileProps.win.id === local.selectedId;
    const stateLabel = (): string | undefined => STATE_LABEL[tileProps.win.state ?? 'normal'];
    const spoken = (): string =>
      [tileProps.win.title, tileProps.win.appName, stateLabel() ?? 'running'].join(', ');

    onMount(() => {
      const from = untrack(() => tileProps.win.rect);
      if (frame === undefined || from === undefined) return;
      // One layout read at animation start (R-READ), then transform only.
      const r = frame.getBoundingClientRect();
      const f = flipFrom(from, { x: r.left, y: r.top, width: r.width, height: r.height });
      frame.style.setProperty('--pl-flip-x', `${f.x}px`);
      frame.style.setProperty('--pl-flip-y', `${f.y}px`);
      frame.style.setProperty('--pl-flip-sx', String(f.sx));
      frame.style.setProperty('--pl-flip-sy', String(f.sy));
      frame.style.willChange = 'transform';
      frame.classList.add(styles.zoomIn ?? '');
      const done = (): void => {
        if (frame === undefined) return;
        frame.style.willChange = '';
        frame.classList.remove(styles.zoomIn ?? '');
      };
      frame.addEventListener('animationend', done, { once: true });
    });

    return (
      <div
        class={styles.tile}
        style={{ '--pl-stagger-index': String(tileProps.index) }}
        data-state={tileProps.win.state ?? 'normal'}
      >
        <div
          id={optionId(tileProps.win.id)}
          role="option"
          aria-selected={selected() ? 'true' : 'false'}
          aria-label={spoken()}
          aria-keyshortcuts="Enter Delete Alt+Q"
          tabindex={selected() ? 0 : -1}
          data-autofocus={selected() ? '' : undefined}
          class={styles.option}
          data-selected={selected() ? 'true' : undefined}
          onClick={() => local.onPick(tileProps.win.id)}
          onPointerEnter={() => local.onSelect(tileProps.win.id)}
          onFocus={() => {
            if (!selected()) local.onSelect(tileProps.win.id);
          }}
        >
          <div
            ref={(el) => (frame = el)}
            class={cx(
              styles.frame,
              closing() && tileProps.win.rect !== undefined && styles.zoomOut,
            )}
            data-frame={idPart(tileProps.win.id)}
            style={{ '--pl-aspect': String(tileProps.win.aspect) }}
          >
            <div class={styles.content} aria-hidden="true">
              {tileProps.win.thumbnail}
            </div>
            <span class={styles.outline} aria-hidden="true" />
          </div>
          <span class={styles.caption} aria-hidden="true">
            <AppIcon app={tileProps.win.app} size={18} />
            <span class={styles.captionText}>{tileProps.win.title}</span>
            <Show when={stateLabel()}>
              {(label) => <span class={styles.captionState}>{label()}</span>}
            </Show>
          </span>
        </div>
        <Show when={local.onCloseWindow}>
          {(onClose) => (
            <button
              type="button"
              class={styles.close}
              tabindex={-1}
              aria-hidden="true"
              title={`Close ${tileProps.win.title}`}
              onClick={() => onClose()(tileProps.win.id)}
            >
              <X size={12} stroke-width={3} />
            </button>
          )}
        </Show>
      </div>
    );
  };

  onMount(() => {
    const view = typeof window === 'undefined' ? undefined : window;
    const onResize = (): void => reportLayout();
    view?.addEventListener('resize', onResize);
    onCleanup(() => view?.removeEventListener('resize', onResize));
  });
  createEffect(
    on([() => presence.mounted(), () => local.windows.length], ([mounted]) => {
      if (mounted) requestAnimationFrame(reportLayout);
    }),
  );

  const maxDesktops = (): number => local.maxDesktops ?? 4;
  /** With real window rectangles each tile zooms itself; otherwise the whole grid scales in. */
  const zooms = (): boolean => local.windows.some((w) => w.rect !== undefined);

  const layer = (): JSX.Element => (
    <div
      ref={(el) => (panel = el)}
      role="dialog"
      aria-modal="true"
      aria-label="Overview"
      class={cx(styles.layer, local.contained === true && styles.contained, local.class)}
      data-state={presence.state()}
      onKeyDown={(event) => {
        if (panel !== undefined && !event.defaultPrevented) trapTabKey(event, panel);
      }}
    >
      <div
        class={cx(styles.backdrop, closing() ? 'pl-anim-scrim-out' : styles.backdropIn)}
        aria-hidden="true"
        onClick={() => local.onCancel()}
      />

      <div class={styles.top}>
        <Show when={local.desktops !== undefined && local.desktops.length > 0}>
          <div class={cx(styles.desktops, !closing() && styles.desktopsIn)}>
            <div class={styles.desktopTabs} role="tablist" aria-label="Desktops">
              <For each={local.desktops}>
                {(desktop) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={desktop.active === true ? 'true' : 'false'}
                    tabindex={desktop.active === true ? 0 : -1}
                    class={styles.desktop}
                    onClick={() => local.onSwitchDesktop?.(desktop.id)}
                  >
                    <span class={styles.desktopPreview} aria-hidden="true">
                      {desktop.preview}
                    </span>
                    <span class={styles.desktopName}>{desktop.name}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={local.onAddDesktop}>
              {(add) => (
                <button
                  type="button"
                  class={styles.addDesktop}
                  aria-label="Add desktop"
                  title={
                    (local.desktops?.length ?? 0) >= maxDesktops()
                      ? `Up to ${maxDesktops()} desktops`
                      : 'Add desktop'
                  }
                  aria-disabled={
                    (local.desktops?.length ?? 0) >= maxDesktops() ? 'true' : undefined
                  }
                  onClick={() => {
                    if ((local.desktops?.length ?? 0) < maxDesktops()) add()();
                  }}
                >
                  <Plus size={18} stroke-width={2.2} />
                </button>
              )}
            </Show>
          </div>
        </Show>
        <p class={styles.hint}>
          <Kbd keys={['Alt', 'O']} /> Overview
        </p>
      </div>

      <Show
        when={local.windows.length > 0}
        fallback={
          <div
            class={styles.empty}
            onClick={(event) => {
              if (event.target === event.currentTarget) local.onCancel();
            }}
          >
            <p class={styles.emptyTitle}>No open windows</p>
            <Show when={local.onLaunch}>
              {(launch) => (
                <div class={styles.emptyActions}>
                  <Button
                    variant="primary"
                    aria-keyshortcuts="Alt+T"
                    onClick={() => launch()('terminal')}
                  >
                    Open Terminal
                  </Button>
                  <Button onClick={() => launch()('files')}>Open Files</Button>
                </div>
              )}
            </Show>
          </div>
        }
      >
        <div
          ref={(el) => (grid = el)}
          role="listbox"
          aria-label="Open windows"
          aria-orientation="horizontal"
          class={cx(
            styles.grid,
            closing() ? !zooms() && 'pl-anim-fade-out' : !zooms() && 'pl-anim-overview-in',
          )}
          style={{ '--pl-cols': String(columns()) }}
          onKeyDown={onGridKeyDown}
          onClick={(event) => {
            // A click on the empty space between tiles leaves Overview, like the backdrop.
            if (event.target === event.currentTarget) local.onCancel();
          }}
        >
          <For each={local.windows}>{(win, i) => <Tile win={win} index={i()} />}</For>
        </div>
      </Show>
    </div>
  );

  return (
    <Show when={presence.mounted()}>
      <Show when={local.contained === true} fallback={<Portal>{layer()}</Portal>}>
        {layer()}
      </Show>
    </Show>
  );
}
