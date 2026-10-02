import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';

import { AtomLogo } from '../../icons/index.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { Menu, type MenuEntry } from '../../primitives/menu/Menu.tsx';
import {
  connectivitySpoken,
  serviceIndicatorText,
  serviceSummary,
  type ClockOptions,
} from '../format.ts';
import type { AiView, MemoryView, NetView, StatusItemId, SvcView, SystemAction } from '../types.ts';
import styles from './MenuBar.module.css';
import { StatusItems } from './StatusItems.tsx';

/** One app menu title and its items. The ids 'system' and 'app' are reserved. */
export interface MenuBarMenu {
  id: string;
  label: string;
  items: readonly MenuEntry[];
  disabled?: boolean;
}

/** Imperative handle for the compositor's global keys (F10 focuses the bar). */
export interface MenuBarApi {
  /** Moves focus to the bar's current title (the roving tab stop). */
  focus: () => void;
  /** Opens a menu by id ('system', 'app' or an app menu id) and focuses its first item. */
  openMenu: (id: string) => void;
  close: () => void;
}

export interface MenuBarProps {
  /** The focused app's name, drawn bold; "Plotinium" when the desktop itself has focus. */
  appName: string;
  /**
   * The bold title's accessible name when it must differ from the atom menu's ("Plotinium
   * desktop" while no window has focus). It always contains the visible `appName` (WCAG 2.5.3).
   */
  appLabel?: string;
  /** Items of the bold app-name menu; defaults to About and Quit. */
  appMenu?: readonly MenuEntry[];
  /** The signed-in user, for the atom menu's "Log Out <user>…". */
  userName?: string;
  /** The focused app's menus (File, Edit, View, Window, Help …). */
  menus: readonly MenuBarMenu[];
  onMenuSelect: (menuId: string, itemId: string) => void;
  /** The atom menu: About Plotinium, Settings…, Restart…, Shut Down…, Lock Screen. */
  onSystemAction: (action: SystemAction) => void;
  net: NetView;
  /** Epoch ms; the host redraws once a minute (and once a second while a countdown shows). */
  now: number;
  clock?: ClockOptions;
  ai?: AiView;
  memory?: MemoryView;
  services?: readonly SvcView[];
  unreadNotifications?: number;
  /** Which status item's popover or panel is open (its button shows pressed). */
  openStatus?: StatusItemId;
  /** A status item was activated; the host opens its popover next to `anchor`. */
  onStatus: (item: StatusItemId, anchor: HTMLElement) => void;
  /** The Control Centre panel's id, for aria-controls while it is open. */
  controlCentreId?: string;
  /** Plays the slide-down entrance (desktop mount after login). */
  animateIn?: boolean;
  apiRef?: (api: MenuBarApi) => void;
  class?: string;
}

/**
 * The atom menu (ui-implementation-guide.md §3.4.2): About Plotinium, Settings…, Lock Screen,
 * Log Out <user>…, Restart…, Shut Down….
 */
export function systemMenuItems(userName?: string): MenuEntry[] {
  const who = userName === undefined || userName === '' ? '' : ` ${userName}`;
  return [
    { id: 'about', label: 'About Plotinium' },
    { kind: 'separator', id: 'system-sep-1' },
    { id: 'settings', label: 'Settings…' },
    { kind: 'separator', id: 'system-sep-2' },
    { id: 'lock', label: 'Lock Screen' },
    { id: 'logout', label: `Log Out${who}…` },
    { kind: 'separator', id: 'system-sep-3' },
    { id: 'restart', label: 'Restart…' },
    { id: 'shutdown', label: 'Shut Down…' },
  ];
}

const SYSTEM_ACTIONS = new Set<string>([
  'about',
  'settings',
  'restart',
  'shutdown',
  'lock',
  'logout',
]);

function isSystemAction(id: string): id is SystemAction {
  return SYSTEM_ACTIONS.has(id);
}

/**
 * The bold app menu of a focused app: About and Quit. Quit closes every window of the app, so it
 * carries no shortcut (Alt+Q closes only the focused window, UI-086).
 */
export function appMenuItems(appName: string): MenuEntry[] {
  return [
    { id: 'about', label: `About ${appName}` },
    { kind: 'separator', id: 'app-sep-1' },
    { id: 'quit', label: `Quit ${appName}` },
  ];
}

const ANNOUNCE_GAP_MS = 2000;

/**
 * The glass menu bar (28 px): the atom menu, the focused app's bold name and menus, and the
 * status area. Keyboard: the titles form one APG menubar with a roving tab stop (Left and Right
 * move, and switch the open menu; Down, Enter and Space open; Up opens on the last item; Home and
 * End; Escape closes). Hovering another title while a menu is open switches to it, as on macOS.
 * Connectivity and service changes are announced in one polite live region, at most every 2 s.
 */
export function MenuBar(props: MenuBarProps): JSX.Element {
  const [local, status] = splitProps(props, [
    'appName',
    'appLabel',
    'appMenu',
    'userName',
    'menus',
    'onMenuSelect',
    'onSystemAction',
    'animateIn',
    'apiRef',
    'class',
  ]);
  const uid = createUniqueId();
  const titles = new Map<string, HTMLButtonElement>();
  const [openId, setOpenId] = createSignal<string>();
  const [initial, setInitial] = createSignal<'first' | 'last'>('first');
  const [tabStop, setTabStop] = createSignal('system');

  // Each part is memoised on its own value, so a status event (which re-evaluates the props of
  // the parent's JSX) never hands <For> new objects: the titles and an open menu stay mounted and
  // keep focus; the app label animates only when the focused app really changes (UI-023).
  const appName = createMemo(() => local.appName);
  const appLabel = createMemo(() => local.appLabel ?? local.appName);
  const appItems = createMemo(() => local.appMenu ?? appMenuItems(appName()));
  const userName = createMemo(() => local.userName);
  const systemEntry = createMemo((): MenuBarMenu => ({
    id: 'system',
    label: 'Plotinium',
    items: systemMenuItems(userName()),
  }));
  const appEntry = createMemo((): MenuBarMenu => ({
    id: 'app',
    label: appLabel(),
    items: appItems(),
  }));
  const appMenus = createMemo(() => local.menus);
  const entries = createMemo((): MenuBarMenu[] => [systemEntry(), appEntry(), ...appMenus()]);
  const enabledIds = (): string[] =>
    entries()
      .filter((m) => m.disabled !== true)
      .map((m) => m.id);
  const menuDomId = (id: string): string => `pl-menubar-${uid}-${id}`;

  // Keep the tab stop on a title that exists (the app's menus change with focus).
  createEffect(() => {
    const ids = enabledIds();
    if (!ids.includes(untrack(tabStop))) setTabStop(ids[0] ?? 'system');
    const open = untrack(openId);
    if (open !== undefined && !ids.includes(open)) setOpenId(undefined);
  });

  const neighbour = (id: string, delta: 1 | -1): string => {
    const ids = enabledIds();
    const index = ids.indexOf(id);
    if (ids.length === 0) return id;
    return ids[(index + delta + ids.length) % ids.length] ?? id;
  };

  const focusTitle = (id: string): void => {
    setTabStop(id);
    titles.get(id)?.focus();
  };

  const openMenu = (id: string, from: 'first' | 'last' = 'first'): void => {
    const menu = entries().find((m) => m.id === id);
    if (menu === undefined || menu.disabled === true) return;
    setTabStop(id);
    setInitial(from);
    setOpenId(id);
  };

  const select = (menuId: string, itemId: string): void => {
    if (menuId === 'system') {
      if (isSystemAction(itemId)) local.onSystemAction(itemId);
      return;
    }
    local.onMenuSelect(menuId, itemId);
  };

  const onBarKeyDown = (event: KeyboardEvent): void => {
    const current = tabStop();
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        const next = neighbour(current, event.key === 'ArrowRight' ? 1 : -1);
        focusTitle(next);
        if (openId() !== undefined) openMenu(next);
        break;
      }
      case 'Home': {
        const first = enabledIds()[0];
        if (first !== undefined) focusTitle(first);
        break;
      }
      case 'End': {
        const ids = enabledIds();
        const last = ids[ids.length - 1];
        if (last !== undefined) focusTitle(last);
        break;
      }
      case 'ArrowDown':
        openMenu(current, 'first');
        break;
      case 'ArrowUp':
        openMenu(current, 'last');
        break;
      case 'Escape':
        if (openId() === undefined) return;
        setOpenId(undefined);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // Left and Right inside an open (portalled) menu move to the neighbouring menu.
  createEffect(() => {
    if (openId() === undefined || typeof document === 'undefined') return;
    const onKey = (event: KeyboardEvent): void => {
      const open = openId();
      if (open === undefined || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      const surface = document.getElementById(menuDomId(open));
      if (surface === null || !(event.target instanceof Node) || !surface.contains(event.target))
        return;
      event.preventDefault();
      openMenu(neighbour(open, event.key === 'ArrowRight' ? 1 : -1));
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => document.removeEventListener('keydown', onKey));
  });

  // Status announcements (WCAG 4.1.3): state changes only, never countdown ticks.
  const [announcement, setAnnouncement] = createSignal('');
  const announceKey = createMemo(() => {
    const net = status.net;
    const count = net.state === 'SYNCING' ? net.ops : 'queued' in net ? net.queued : 0;
    return `${net.state}:${count}|${serviceIndicatorText(serviceSummary(status.services ?? [])) ?? ''}`;
  });
  let lastAnnounced = Number.NEGATIVE_INFINITY;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (): void => {
    const services = serviceIndicatorText(serviceSummary(status.services ?? []));
    const net = connectivitySpoken(status.net, status.now);
    setAnnouncement(services === undefined ? net : `${net}. Services: ${services}`);
    lastAnnounced = Date.now();
  };
  createEffect(
    on(
      announceKey,
      () => {
        clearTimeout(announceTimer);
        const wait = ANNOUNCE_GAP_MS - (Date.now() - lastAnnounced);
        if (wait <= 0) untrack(say);
        else announceTimer = setTimeout(say, wait);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(announceTimer));

  onMount(() => {
    local.apiRef?.({
      focus: () => focusTitle(tabStop()),
      openMenu: (id) => openMenu(id),
      close: () => setOpenId(undefined),
    });
  });

  return (
    <header class={cx(styles.bar, local.animateIn === true && 'pl-anim-menubar-in', local.class)}>
      <nav aria-label="Menu bar" class={styles.nav}>
        <div
          role="menubar"
          aria-label="Application menu"
          class={styles.menus}
          onKeyDown={onBarKeyDown}
        >
          <For each={entries()}>
            {(menu) => (
              <button
                type="button"
                ref={(el) => titles.set(menu.id, el)}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openId() === menu.id}
                aria-controls={openId() === menu.id ? menuDomId(menu.id) : undefined}
                aria-disabled={menu.disabled === true ? 'true' : undefined}
                aria-label={
                  menu.id === 'system'
                    ? 'Plotinium'
                    : menu.id === 'app' && menu.label !== appName()
                      ? menu.label
                      : undefined
                }
                tabindex={tabStop() === menu.id ? 0 : -1}
                class={cx(
                  styles.title,
                  menu.id === 'system' && styles.logo,
                  menu.id === 'app' && styles.appName,
                )}
                onFocus={() => setTabStop(menu.id)}
                onClick={() => {
                  if (menu.disabled === true) return;
                  if (openId() === menu.id) setOpenId(undefined);
                  else openMenu(menu.id);
                }}
                onPointerEnter={() => {
                  const open = openId();
                  if (open !== undefined && open !== menu.id && menu.disabled !== true)
                    openMenu(menu.id);
                }}
              >
                <Switch fallback={menu.label}>
                  <Match when={menu.id === 'system'}>
                    {/* 16 px on whole pixels: the 24-unit mark's 3-unit strokes land on 2 px (UI-152). */}
                    <AtomLogo size={16} class={styles.atom} />
                  </Match>
                  <Match when={menu.id === 'app'}>
                    <Show when={appName()} keyed>
                      {(name) => <span class={styles.appLabel}>{name}</span>}
                    </Show>
                  </Match>
                </Switch>
              </button>
            )}
          </For>
        </div>

        <StatusItems {...status} />
      </nav>

      <For each={entries()}>
        {(menu) => (
          <Menu
            open={openId() === menu.id}
            anchor={titles.get(menu.id)}
            items={menu.items}
            label={menu.label}
            id={menuDomId(menu.id)}
            initialFocus={initial()}
            onSelect={(itemId) => select(menu.id, itemId)}
            onClose={() => setOpenId(undefined)}
          />
        )}
      </For>

      <div role="status" aria-live="polite" class={styles.srOnly}>
        {announcement()}
      </div>
    </header>
  );
}
