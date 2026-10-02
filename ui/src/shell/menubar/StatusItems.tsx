import CircleAlert from 'lucide-solid/icons/circle-alert';
import CloudCheck from 'lucide-solid/icons/cloud-check';
import CloudOff from 'lucide-solid/icons/cloud-off';
import LogIn from 'lucide-solid/icons/log-in';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Search from 'lucide-solid/icons/search';
import Sparkles from 'lucide-solid/icons/sparkles';
import Timer from 'lucide-solid/icons/timer';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import {
  badgeText,
  connectivitySpoken,
  connectivityText,
  formatClock,
  memoryLevel,
  memoryRatio,
  memorySpoken,
  memoryText,
  serviceIndicatorText,
  serviceSummary,
  type ClockOptions,
} from '../format.ts';
import type { AiView, MemoryView, NetView, StatusItemId, SvcView } from '../types.ts';
import { ControlCentreGlyph } from './glyphs.tsx';
import styles from './MenuBar.module.css';

export interface StatusItemsProps {
  net: NetView;
  now: number;
  clock?: ClockOptions;
  ai?: AiView;
  memory?: MemoryView;
  services?: readonly SvcView[];
  unreadNotifications?: number;
  openStatus?: StatusItemId;
  onStatus: (item: StatusItemId, anchor: HTMLElement) => void;
  controlCentreId?: string;
}

const ICON = 15;

function aiLabel(ai: AiView): string {
  switch (ai.state) {
    case 'idle':
      return 'AI: ready';
    case 'indexing':
      return `AI ${Math.round((ai.progress ?? 0) * 100)}%, indexing`;
    case 'off':
      return 'AI off';
    case 'error':
      return `AI: error${ai.detail === undefined ? '' : `, ${ai.detail}`}`;
  }
}

/**
 * The menu bar's status area (the tray of window-manager.md §3.11, moved to the top right):
 * degraded services, connectivity and sync, AI, memory, Control Centre, Search and the clock.
 * Every item is a button with a full accessible name that contains its visible text, so no
 * state is carried by colour alone.
 */
export function StatusItems(props: StatusItemsProps): JSX.Element {
  const [local] = splitProps(props, [
    'net',
    'now',
    'clock',
    'ai',
    'memory',
    'services',
    'unreadNotifications',
    'openStatus',
    'onStatus',
    'controlCentreId',
  ]);

  const services = createMemo(() => serviceSummary(local.services ?? []));
  const servicesText = createMemo(() => serviceIndicatorText(services()));
  const clock = createMemo(() => formatClock(local.now, local.clock));
  const netText = createMemo(() => connectivityText(local.net, local.now));
  const unread = (): number => Math.max(0, local.unreadNotifications ?? 0);

  // One ring pulse on each connectivity state change (never at mount, never looping).
  const [netChanges, setNetChanges] = createSignal(0);
  createEffect(
    on(
      () => local.net.state,
      () => setNetChanges((n) => n + 1),
      { defer: true },
    ),
  );

  /**
   * Whether the popup this item controls is open. The degraded-services pill and the sync chip
   * open the same connectivity popover, and the clock and the Control Centre button the same
   * panel, so both triggers of one popup report it (UI-085).
   */
  const open = (item: StatusItemId): boolean => {
    const shown = local.openStatus;
    if (shown === undefined) return false;
    const group = (id: StatusItemId): StatusItemId =>
      id === 'services' ? 'connectivity' : id === 'clock' ? 'control-centre' : id;
    return group(shown) === group(item);
  };
  const warnNet = (): boolean =>
    local.net.state === 'OFFLINE' ||
    local.net.state === 'AUTH_REQUIRED' ||
    local.net.state === 'UNAVAILABLE';
  const activate = (item: StatusItemId) => (event: MouseEvent) => {
    if (event.currentTarget instanceof HTMLElement) local.onStatus(item, event.currentTarget);
  };

  return (
    <div role="group" aria-label="Status" class={styles.status}>
      <Show when={servicesText()}>
        {(text) => (
          <button
            type="button"
            class={cx(styles.item, styles.pill, styles.warning)}
            data-status-item="services"
            aria-label={`${text()} services`}
            aria-haspopup="dialog"
            aria-expanded={open('services')}
            onClick={activate('services')}
          >
            <TriangleAlert size={ICON - 2} aria-hidden="true" />
            <span>{text()}</span>
          </button>
        )}
      </Show>

      <button
        type="button"
        class={cx(
          styles.item,
          styles.net,
          local.net.state !== 'LIVE' && styles.pill,
          warnNet() && styles.warning,
        )}
        data-net={local.net.state}
        data-status-item="connectivity"
        aria-label={connectivitySpoken(local.net, local.now)}
        aria-haspopup="dialog"
        aria-expanded={open('connectivity')}
        onClick={activate('connectivity')}
      >
        <span class={styles.netIcon}>
          <Switch>
            <Match when={local.net.state === 'LIVE'}>
              <CloudCheck size={ICON + 1} aria-hidden="true" />
              <span class={styles.onlineDot} aria-hidden="true" />
            </Match>
            <Match when={local.net.state === 'SYNCING'}>
              <RefreshCw size={ICON - 2} aria-hidden="true" />
            </Match>
            <Match when={local.net.state === 'RECONNECTING'}>
              <Timer size={ICON - 2} aria-hidden="true" />
            </Match>
            <Match when={local.net.state === 'OFFLINE' || local.net.state === 'UNAVAILABLE'}>
              <CloudOff size={ICON - 1} aria-hidden="true" />
            </Match>
            <Match when={local.net.state === 'AUTH_REQUIRED'}>
              <LogIn size={ICON - 2} aria-hidden="true" />
            </Match>
          </Switch>
          <Show when={netChanges()} keyed>
            {(change) => <span class={styles.pulse} data-change={change} aria-hidden="true" />}
          </Show>
        </span>
        <Show when={local.net.state !== 'LIVE'}>
          <span class={styles.netText}>{netText()}</span>
        </Show>
      </button>

      <Show when={local.ai}>
        {(ai) => (
          <button
            type="button"
            class={cx(styles.item, styles.aiItem)}
            data-status-item="ai"
            aria-label={aiLabel(ai())}
            aria-haspopup="dialog"
            aria-expanded={open('ai')}
            onClick={activate('ai')}
          >
            <span class={styles.ai} data-state={ai().state}>
              <Show
                when={ai().state === 'error'}
                fallback={<Sparkles size={12} aria-hidden="true" />}
              >
                <CircleAlert size={12} aria-hidden="true" />
              </Show>
              <span class={styles.aiText}>AI</span>
              <Show when={ai().state === 'indexing'}>
                <span class={styles.aiProgress}>{Math.round((ai().progress ?? 0) * 100)}%</span>
              </Show>
              <Show when={ai().state === 'off'}>
                <span class={styles.aiProgress}>off</span>
              </Show>
            </span>
          </button>
        )}
      </Show>

      <Show when={local.memory}>
        {(memory) => (
          <button
            type="button"
            class={cx(styles.item, styles.memory)}
            data-level={memoryLevel(memory())}
            data-status-item="memory"
            aria-label={`${memorySpoken(memory())}${
              memoryLevel(memory()) === 'normal'
                ? ''
                : memoryLevel(memory()) === 'warning'
                  ? ', above 85%, reclaiming'
                  : ', above 95%, critical'
            }`}
            aria-haspopup="dialog"
            aria-expanded={open('memory')}
            onClick={activate('memory')}
          >
            <span class={styles.memGlyph} aria-hidden="true">
              <span
                class={styles.memFill}
                style={{ transform: `scaleX(${memoryRatio(memory())})` }}
              />
            </span>
            <span
              class={cx(styles.memText, memoryLevel(memory()) === 'critical' && styles.memPulse)}
            >
              {memoryText(memory())}
            </span>
          </button>
        )}
      </Show>

      <button
        type="button"
        class={cx(styles.item, styles.iconItem)}
        data-status-item="control-centre"
        aria-label="Control Centre"
        aria-haspopup="dialog"
        aria-expanded={open('control-centre')}
        aria-controls={open('control-centre') ? local.controlCentreId : undefined}
        onClick={activate('control-centre')}
      >
        <ControlCentreGlyph size={ICON} />
      </button>

      <button
        type="button"
        class={cx(styles.item, styles.iconItem)}
        data-status-item="search"
        aria-label="Search"
        aria-keyshortcuts="Control+Space"
        aria-haspopup="dialog"
        aria-expanded={open('search')}
        onClick={activate('search')}
      >
        <Search size={ICON - 1} aria-hidden="true" />
      </button>

      <button
        type="button"
        class={cx(styles.item, styles.clock)}
        data-status-item="clock"
        aria-label={`${clock().date} ${clock().time}, notifications${
          unread() > 0 ? `, ${unread()} unread` : ''
        }`}
        aria-haspopup="dialog"
        aria-expanded={open('clock')}
        aria-controls={open('clock') ? local.controlCentreId : undefined}
        onClick={activate('clock')}
      >
        <span class={styles.clockDate}>{clock().date}</span>
        <span>{clock().time}</span>
        <Show when={unread() > 0}>
          <span class={cx(styles.unread, 'pl-anim-pop-in')} aria-hidden="true">
            {badgeText(unread())}
          </span>
        </Show>
      </button>
    </div>
  );
}
