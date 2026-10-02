import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  splitProps,
  untrack,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { firstEnabled, lastEnabled, stepIndex } from '../../primitives/internal/list-nav.ts';
import { prefersReducedMotion } from '../../primitives/internal/motion.ts';
import type { DockItem } from '../types.ts';
import styles from './Dock.module.css';
import { DockIcon } from './DockIcon.tsx';
import { DOCK_MAX_SCALE, magnify, type DockSlot } from './magnify.ts';

export const TRASH_ID = 'trash';

/** Imperative handle for the compositor. */
export interface DockApi {
  /**
   * The on-screen rectangle of an app's icon (or 'trash'): the minimise genie's target and the
   * window-open origin. Read once at animation start (R-READ), never per frame.
   */
  getIconRect: (appId: string) => DOMRect | undefined;
  /** Moves focus into the dock (Alt+N), on an app or on the current tab stop. */
  focus: (appId?: string) => void;
}

export interface DockProps {
  /** Pinned and running apps, in order. */
  items: readonly DockItem[];
  /** Trash after the separator; `full` swaps the glyph and the spoken name. */
  trash?: { full: boolean };
  /** Click or Enter: launch, focus, or restore (the host decides, WMD-10). */
  onActivate: (appId: string) => void;
  onTrash?: () => void;
  /** The item menu (right-click, Shift+F10, Menu key), anchored to the icon. */
  onItemMenu?: (appId: string, anchor: HTMLElement) => void;
  /** Hover magnification; always off under reduced motion. Default true. */
  magnification?: boolean;
  /** The largest magnified scale (Settings › Magnified size). Default DOCK_MAX_SCALE (1.5). */
  magnifiedScale?: number;
  /** Icon size in px (Settings › Dock size, 40–80). Default the `--pl-dock-icon` token (52). */
  iconSize?: number;
  /**
   * Hide the dock off the bottom edge until the pointer reaches the edge or focus enters it
   * (Alt+N). Only transform and opacity animate.
   */
  autoHide?: boolean;
  /** Keep an auto-hidden dock shown (its item menu is open). */
  holdOpen?: boolean;
  /** The running dots and the minimised markers. Default true. */
  indicators?: boolean;
  /** Escape inside the dock (no item menu open): the host returns focus to the window (§3.9). */
  onEscape?: () => void;
  /** Plays the spring entrance and the staggered icons (desktop mount after login). */
  animateIn?: boolean;
  apiRef?: (api: DockApi) => void;
  /** Accessible name of the toolbar. Default "Dock". */
  label?: string;
  class?: string;
}

const SEPARATOR_ID = '§separator';
/** Auto-hide: how long the dock stays after the pointer leaves it. */
const HIDE_DELAY_MS = 400;

type SlotKind = 'app' | 'separator' | 'trash';

function kindOf(id: string): SlotKind {
  if (id === SEPARATOR_ID) return 'separator';
  return id === TRASH_ID ? 'trash' : 'app';
}

/**
 * The floating glass dock: app icons, a separator and Trash. It is one APG toolbar with a roving
 * tab stop (Left, Right, Home, End; Enter and Space activate; Shift+F10 opens the item menu).
 * Magnification follows the pointer with transform only: slot centres are measured once at
 * pointerenter and one rAF batch per frame writes translateX on each slot and scale() on each
 * icon, so pointermove never reads layout (visual-language-macos.md §3.10 P8).
 */
export function Dock(props: DockProps): JSX.Element {
  const [local] = splitProps(props, [
    'items',
    'trash',
    'onActivate',
    'onTrash',
    'onItemMenu',
    'magnification',
    'magnifiedScale',
    'iconSize',
    'autoHide',
    'holdOpen',
    'indicators',
    'onEscape',
    'animateIn',
    'apiRef',
    'label',
    'class',
  ]);

  /** Slot ids in order; strings keep <For> rows stable when an item's state changes. */
  const slots = createMemo((): string[] => [
    ...local.items.map((item) => item.id),
    SEPARATOR_ID,
    TRASH_ID,
  ]);
  /** Focusable entries (apps and Trash) in order. */
  const focusIds = createMemo(() => slots().filter((id) => id !== SEPARATOR_ID));
  // The roving tab stop starts on the first app, so Alt+N lands on Files, not Trash (UI-078).
  const [tabStop, setTabStop] = createSignal<string>(untrack(() => focusIds()[0] ?? TRASH_ID));

  createEffect(() => {
    const ids = focusIds();
    if (!ids.includes(untrack(tabStop))) setTabStop(ids[0] ?? TRASH_ID);
  });

  const slotEls = new Map<string, HTMLElement>();
  const iconEls = new Map<string, HTMLElement>();
  const buttons = new Map<string, HTMLButtonElement>();
  let toolbar: HTMLDivElement | undefined;
  let glass: HTMLDivElement | undefined;

  // ---------- magnification ----------
  const [magnifying, setMagnifying] = createSignal(false);
  let cache: { ids: string[]; slots: DockSlot[]; size: number; width: number } | undefined;
  let pointerX = 0;
  let frame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const enabled = (): boolean =>
    local.magnification !== false &&
    typeof document !== 'undefined' &&
    !prefersReducedMotion(document);
  const maxScale = (): number => {
    const scale = local.magnifiedScale;
    return scale === undefined || !(scale >= 1) ? DOCK_MAX_SCALE : Math.min(2, scale);
  };

  const setWillChange = (value: string): void => {
    for (const el of slotEls.values()) el.style.willChange = value;
    for (const el of iconEls.values()) el.style.willChange = value;
    if (glass !== undefined) glass.style.willChange = value;
  };

  const measure = (): void => {
    if (toolbar === undefined) return;
    const left = toolbar.getBoundingClientRect().left;
    const ids: string[] = [];
    const measured: DockSlot[] = [];
    let size = 0;
    for (const id of slots()) {
      const el = slotEls.get(id);
      if (el === undefined) continue;
      const magnifies = kindOf(id) !== 'separator';
      ids.push(id);
      measured.push({ centre: left + el.offsetLeft + el.offsetWidth / 2, magnify: magnifies });
      if (magnifies) size = Math.max(size, el.offsetWidth);
    }
    cache = { ids, slots: measured, size, width: toolbar.offsetWidth };
  };

  const write = (): void => {
    frame = 0;
    if (cache === undefined) return;
    const m = magnify(pointerX, cache.slots, cache.size, maxScale());
    cache.ids.forEach((id, i) => {
      const slot = slotEls.get(id);
      if (slot !== undefined) slot.style.transform = `translate3d(${m.shifts[i] ?? 0}px, 0, 0)`;
      const icon = iconEls.get(id);
      if (icon !== undefined) icon.style.transform = `scale(${m.scales[i] ?? 1})`;
    });
    if (glass !== undefined && cache.width > 0)
      glass.style.transform = `scaleX(${(cache.width + m.extra) / cache.width})`;
  };

  const schedule = (x: number): void => {
    pointerX = x;
    if (frame === 0) frame = requestAnimationFrame(write);
  };

  const onPointerEnter = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || !enabled()) return;
    clearTimeout(settleTimer);
    measure();
    setWillChange('transform');
    setMagnifying(true);
    schedule(event.clientX);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (cache !== undefined) schedule(event.clientX);
  };
  const rest = (): void => {
    cancelAnimationFrame(frame);
    frame = 0;
    cache = undefined;
    setMagnifying(false);
    for (const el of slotEls.values()) el.style.transform = '';
    for (const el of iconEls.values()) el.style.transform = '';
    if (glass !== undefined) glass.style.transform = '';
    // Keep the layers promoted while they spring back, then release them.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => setWillChange(''), 400);
  };

  onCleanup(() => {
    cancelAnimationFrame(frame);
    clearTimeout(settleTimer);
  });

  // ---------- auto-hide ----------
  const [revealed, setRevealed] = createSignal(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const reveal = (): void => {
    clearTimeout(hideTimer);
    setRevealed(true);
  };
  const hideSoon = (): void => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => setRevealed(false), HIDE_DELAY_MS);
  };
  onCleanup(() => clearTimeout(hideTimer));

  // ---------- keyboard ----------
  const move = (event: KeyboardEvent): void => {
    const ids = focusIds();
    const index = ids.indexOf(tabStop());
    const never = (): boolean => false;
    let next: number;
    switch (event.key) {
      case 'Escape':
        if (local.onEscape === undefined) return;
        event.preventDefault();
        local.onEscape();
        return;
      case 'ArrowRight':
      case 'ArrowDown':
        next = stepIndex(index, 1, ids.length, never, true);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = stepIndex(index, -1, ids.length, never, true);
        break;
      case 'Home':
        next = firstEnabled(ids.length, never);
        break;
      case 'End':
        next = lastEnabled(ids.length, never);
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = ids[next];
    if (id === undefined) return;
    setTabStop(id);
    buttons.get(id)?.focus();
  };

  onMount(() => {
    local.apiRef?.({
      getIconRect: (appId) => iconEls.get(appId)?.getBoundingClientRect(),
      focus: (appId) => {
        const id = appId !== undefined && buttons.has(appId) ? appId : tabStop();
        setTabStop(id);
        buttons.get(id)?.focus();
      },
    });
  });

  const register =
    (id: string) =>
    (el: HTMLDivElement): void => {
      slotEls.set(id, el);
      onCleanup(() => slotEls.delete(id));
    };
  const registerIcon =
    (id: string) =>
    (el: HTMLDivElement): void => {
      iconEls.set(id, el);
      onCleanup(() => iconEls.delete(id));
    };
  const registerButton =
    (id: string) =>
    (el: HTMLButtonElement): void => {
      buttons.set(id, el);
      onCleanup(() => buttons.delete(id));
    };

  const itemById = (id: string): DockItem | undefined => local.items.find((i) => i.id === id);
  const full = (): boolean => local.trash?.full === true;

  return (
    <nav
      aria-label="Dock"
      class={cx(styles.wrap, local.animateIn === true && 'pl-anim-dock-in', local.class)}
      data-autohide={local.autoHide === true ? 'true' : undefined}
      data-revealed={
        local.autoHide === true && (revealed() || local.holdOpen === true) ? 'true' : undefined
      }
      data-indicators={local.indicators === false ? 'false' : undefined}
      style={{
        '--pl-dock-icon': local.iconSize === undefined ? undefined : `${String(local.iconSize)}px`,
      }}
    >
      <Show when={local.autoHide === true}>
        <div
          class={styles.hotZone}
          aria-hidden="true"
          onPointerEnter={reveal}
          onPointerLeave={hideSoon}
        />
      </Show>
      <div
        ref={(el) => (toolbar = el)}
        role="toolbar"
        aria-label={local.label ?? 'Dock'}
        aria-orientation="horizontal"
        class={cx(styles.dock, magnifying() && styles.magnifying)}
        onPointerEnter={(event) => {
          if (local.autoHide === true) reveal();
          onPointerEnter(event);
        }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          rest();
          if (local.autoHide === true) hideSoon();
        }}
        onKeyDown={move}
      >
        <div ref={(el) => (glass = el)} class={styles.glass} aria-hidden="true" />
        <For each={slots()}>
          {(id, index) => {
            const kind = kindOf(id);
            if (kind === 'separator')
              return (
                <div
                  ref={register(id)}
                  role="separator"
                  aria-orientation="vertical"
                  class={styles.separator}
                />
              );
            if (kind === 'trash')
              return (
                <DockIcon
                  item={{ id: TRASH_ID, label: 'Trash', icon: full() ? 'trash-full' : 'trash' }}
                  spokenLabel={full() ? 'Trash, has items' : 'Trash, empty'}
                  tabIndex={tabStop() === TRASH_ID ? 0 : -1}
                  animateIn={local.animateIn}
                  staggerIndex={index()}
                  slotRef={register(TRASH_ID)}
                  iconRef={registerIcon(TRASH_ID)}
                  buttonRef={registerButton(TRASH_ID)}
                  onFocus={() => setTabStop(TRASH_ID)}
                  onActivate={() => local.onTrash?.()}
                />
              );
            return (
              <DockIcon
                item={itemById(id) ?? { id, label: id, icon: 'files' }}
                tabIndex={tabStop() === id ? 0 : -1}
                animateIn={local.animateIn}
                staggerIndex={index()}
                slotRef={register(id)}
                iconRef={registerIcon(id)}
                buttonRef={registerButton(id)}
                onFocus={() => setTabStop(id)}
                onActivate={() => local.onActivate(id)}
                onMenu={
                  local.onItemMenu === undefined
                    ? undefined
                    : (anchor) => local.onItemMenu?.(id, anchor)
                }
              />
            );
          }}
        </For>
      </div>
    </nav>
  );
}
