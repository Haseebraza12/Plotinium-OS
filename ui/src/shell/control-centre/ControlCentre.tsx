import ChevronRight from 'lucide-solid/icons/chevron-right';
import CloudOff from 'lucide-solid/icons/cloud-off';
import Gauge from 'lucide-solid/icons/gauge';
import LogIn from 'lucide-solid/icons/log-in';
import MemoryStick from 'lucide-solid/icons/memory-stick';
import Moon from 'lucide-solid/icons/moon';
import MoonStar from 'lucide-solid/icons/moon-star';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Settings from 'lucide-solid/icons/settings';
import ShieldAlert from 'lucide-solid/icons/shield-alert';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import Sparkle from 'lucide-solid/icons/sparkle';
import Sun from 'lucide-solid/icons/sun';
import Timer from 'lucide-solid/icons/timer';
import Wifi from 'lucide-solid/icons/wifi';
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';

import { Button } from '../../primitives/button/Button.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { Floating } from '../../primitives/internal/Floating.tsx';
import { focusInitial } from '../../primitives/internal/focus.ts';
import { createDismissableLayer } from '../../primitives/internal/layers.ts';
import { createPresence } from '../../primitives/internal/presence.ts';
import { SegmentedControl } from '../../primitives/segmented-control/SegmentedControl.tsx';
import { Slider } from '../../primitives/slider/Slider.tsx';
import { Toggle } from '../../primitives/toggle/Toggle.tsx';
import {
  connectivityDetail,
  connectivityShort,
  connectivityText,
  formatMb,
  formatTimeOfDay,
  serviceIndicatorText,
  serviceRowText,
  serviceSummary,
  type ClockOptions,
} from '../format.ts';
import type { NetView, SvcView, ThemeChoice } from '../types.ts';
import styles from './ControlCentre.module.css';

export type ControlCentreCloseReason = 'escape' | 'outside';

export interface MemoryBudgetView {
  budgetMb: number;
  usedMb: number;
  /** Default 128. */
  minMb?: number;
  /** Default 1024. */
  maxMb?: number;
  /** Default 64. */
  stepMb?: number;
  /** The kernel refused the last commit; the slider snaps back and this shows (role="alert"). */
  error?: string;
  /** The kernel is applying a commit. */
  applying?: boolean;
  /** Read-only, with the reason (a guest session: "Managed by the administrator"). */
  disabledReason?: string;
}

export interface ControlCentreProps {
  open: boolean;
  onClose: (reason: ControlCentreCloseReason) => void;
  /** The menu-bar trigger: the panel hangs under it and Escape returns focus to it. */
  anchor?: HTMLElement;
  /** Renders in place (no portal, no positioning), for compositions and previews. */
  inline?: boolean;
  /**
   * Moves focus to the first tile on open. Pass false when opened by pointer. Default true for
   * the floating panel; an `inline` panel moves focus only when this is true (opened by keyboard).
   */
  autoFocus?: boolean;
  /** Elements that open with the panel (the notification column); clicks there do not close it. */
  companions?: readonly (Element | undefined)[];
  id?: string;

  net: NetView;
  now: number;
  clock?: ClockOptions;
  lastSyncAt?: number;
  syncQueue: { pending: number; failed?: number };
  /** The connectivity tile opens the sync detail view. */
  onOpenSync?: () => void;
  onRetrySync?: () => void;

  services: readonly SvcView[];
  onRetryService?: (name: string) => void;
  /** Services whose retry is in flight ("Retrying…"). */
  retryingServices?: readonly string[];
  /** Services whose last retry failed, with the reason ("Could not retry"), shown under the row. */
  retryErrors?: Readonly<Record<string, string>>;

  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  /** The Settings override: true is "Always", false is "Follow system". */
  reducedMotion: boolean;
  /** The OS asks for reduced motion (shown when the override is off). */
  systemReducedMotion?: boolean;
  onReducedMotionChange: (on: boolean) => void;

  memory: MemoryBudgetView;
  /** Fires on release or a keyboard commit, never while dragging (MEM-01). */
  onMemoryBudgetCommit: (mb: number) => void;

  focusMode: boolean;
  onFocusModeChange: (on: boolean) => void;
  frameMeter: boolean;
  /** Live summary once the meter is on, e.g. "p95 16.7 ms · 60 Hz" (WMD-19). */
  frameMeterSummary?: string;
  onFrameMeterChange: (on: boolean) => void;

  /** "Plotinium 0.3.0 · build a1f93c2" */
  version?: string;
  onOpenSettings?: () => void;
  class?: string;
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const;

interface ToggleTileProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  /** Stagger position in the entrance. */
  index: number;
  icon?: JSX.Element;
  tone?: 'on' | 'idle';
}

/**
 * A half-width switch tile laid out like the reference: glyph, label and switch on one row, the
 * state line under them. The switch keeps its own label and description for assistive
 * technology; the visible text is a <label for> (so clicking it toggles) hidden from the tree to
 * avoid reading it twice.
 */
function ToggleTile(props: ToggleTileProps): JSX.Element {
  const id = `pl-cc-switch-${createUniqueId()}`;
  return (
    <div
      class={cx(styles.tile, styles.toggleTile, 'pl-anim-cc-tile')}
      style={{ '--pl-stagger-index': String(props.index) }}
    >
      <div class={styles.toggleRow}>
        <Show when={props.icon}>
          {(icon) => (
            <span class={styles.circleSm} data-tone={props.tone ?? 'idle'} aria-hidden="true">
              {icon()}
            </span>
          )}
        </Show>
        <label for={id} class={styles.toggleLabel} aria-hidden="true">
          {props.label}
        </label>
        <Toggle
          id={id}
          size="sm"
          hideLabel
          label={props.label}
          description={props.description}
          checked={props.checked}
          onChange={(on) => props.onChange(on)}
          class={styles.toggleSwitch}
        />
      </div>
      <label for={id} class={styles.toggleDesc} aria-hidden="true">
        {props.description}
      </label>
    </div>
  );
}

/**
 * Control Centre (WMD-18/19, OFF-04, MEM-01): a non-modal HUD panel of glass tiles for
 * connectivity and the sync queue, degraded services, Appearance, Reduced motion, the memory
 * budget, Focus and the frame meter. It springs in from the trigger with 20 ms tile stagger and
 * fades out. Escape and an outside click close it; Escape returns focus to the trigger.
 */
export function ControlCentre(props: ControlCentreProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'anchor',
    'inline',
    'autoFocus',
    'companions',
    'id',
    'net',
    'now',
    'clock',
    'lastSyncAt',
    'syncQueue',
    'onOpenSync',
    'onRetrySync',
    'services',
    'onRetryService',
    'retryingServices',
    'retryErrors',
    'theme',
    'onThemeChange',
    'reducedMotion',
    'systemReducedMotion',
    'onReducedMotionChange',
    'memory',
    'onMemoryBudgetCommit',
    'focusMode',
    'onFocusModeChange',
    'frameMeter',
    'frameMeterSummary',
    'onFrameMeterChange',
    'version',
    'onOpenSettings',
    'class',
  ]);
  const uid = createUniqueId();
  const panelId = (): string => local.id ?? `pl-cc-${uid}`;
  const presence = createPresence(() => local.open, 160);
  const [surface, setSurface] = createSignal<HTMLDivElement>();

  createDismissableLayer({
    active: () => local.open,
    inside: () => [surface(), local.anchor, ...(local.companions ?? [])],
    onEscape: () => {
      local.onClose('escape');
      local.anchor?.focus();
    },
    onOutside: () => local.onClose('outside'),
  });

  // ---------- connectivity ----------
  const lastSync = (): string | undefined =>
    local.lastSyncAt === undefined ? undefined : formatTimeOfDay(local.lastSyncAt, local.clock);
  const netTone = (): 'on' | 'warn' | 'idle' => {
    switch (local.net.state) {
      case 'LIVE':
      case 'SYNCING':
        return 'on';
      case 'OFFLINE':
      case 'AUTH_REQUIRED':
      case 'UNAVAILABLE':
        return 'warn';
      case 'RECONNECTING':
        return 'idle';
    }
  };

  // ---------- services ----------
  const summary = createMemo(() => serviceSummary(local.services));
  const unhealthy = createMemo(() => local.services.filter((s) => s.state !== 'running'));
  const [expanded, setExpanded] = createSignal(false);
  const servicesTitle = (): string => {
    const text = serviceIndicatorText(summary());
    return text === undefined ? 'Degraded services: none' : `Degraded services: ${text}`;
  };
  const servicesDetail = (): string => {
    const s = summary();
    if (s.total === 0) return 'No services reported yet';
    if (s.degraded === 0 && s.starting === 0) return `All ${s.total} services healthy`;
    return `${s.healthy} of ${s.total} services healthy`;
  };
  const retrying = (name: string): boolean => local.retryingServices?.includes(name) === true;
  const retryError = (name: string): string | undefined => local.retryErrors?.[name];

  // ---------- memory budget ----------
  const minMb = (): number => local.memory.minMb ?? 128;
  const maxMb = (): number => local.memory.maxMb ?? 1024;
  const [draft, setDraft] = createSignal(untrack(() => local.memory.budgetMb));
  // A new committed value, or a refusal, snaps the thumb back to what the kernel holds.
  createEffect(
    on(
      () => [local.memory.budgetMb, local.memory.error] as const,
      ([budget]) => setDraft(budget),
    ),
  );

  // ---------- focus on open ----------
  createEffect(() => {
    const el = surface();
    const wanted = local.inline === true ? local.autoFocus === true : local.autoFocus !== false;
    if (el === undefined || !local.open || !wanted) return;
    queueMicrotask(() => {
      if (el.isConnected) focusInitial(el);
    });
  });
  const panelClass = (): string =>
    cx(
      styles.panel,
      presence.state() === 'closing' ? 'pl-anim-popover-out' : 'pl-anim-cc-in',
      local.inline === true && styles.inline,
      local.class,
    );

  const Body = (): JSX.Element => (
    <>
      <div class={styles.grid}>
        {/* Connectivity and sync queue */}
        <div class={cx(styles.tile, styles.tall, 'pl-anim-cc-tile')} data-stagger="0">
          <button
            type="button"
            class={styles.row}
            data-autofocus
            aria-label={`Connectivity: ${connectivityText(local.net, local.now)}, ${connectivityDetail(local.net, lastSync())}`}
            onClick={() => local.onOpenSync?.()}
          >
            <span class={styles.circle} data-tone={netTone()} aria-hidden="true">
              <Switch>
                <Match when={local.net.state === 'LIVE' || local.net.state === 'SYNCING'}>
                  <Wifi size={15} />
                </Match>
                <Match when={local.net.state === 'RECONNECTING'}>
                  <Timer size={15} />
                </Match>
                <Match when={local.net.state === 'OFFLINE' || local.net.state === 'UNAVAILABLE'}>
                  <CloudOff size={15} />
                </Match>
                <Match when={local.net.state === 'AUTH_REQUIRED'}>
                  <LogIn size={15} />
                </Match>
              </Switch>
            </span>
            <span class={styles.text}>
              <span class={styles.title}>{connectivityText(local.net, local.now)}</span>
              {/* One line: the full reason is in the tooltip and the accessible name (UI-151). */}
              <span
                class={cx(styles.sub, styles.oneLine)}
                title={connectivityDetail(local.net, lastSync())}
              >
                {connectivityShort(local.net, lastSync())}
              </span>
            </span>
          </button>
          <div class={styles.row}>
            <span
              class={styles.circle}
              data-tone={(local.syncQueue.failed ?? 0) > 0 ? 'warn' : 'idle'}
              aria-hidden="true"
            >
              <RefreshCw size={14} />
            </span>
            <span class={styles.text}>
              <span class={styles.title}>Sync queue</span>
              <span class={styles.sub}>
                <span
                  class={styles.num}
                  data-active={local.syncQueue.pending > 0 ? 'true' : 'false'}
                >
                  {local.syncQueue.pending}
                </span>{' '}
                pending
                <Show when={(local.syncQueue.failed ?? 0) > 0}>
                  {' · '}
                  <span class={styles.warnText}>{local.syncQueue.failed} failed</span>
                </Show>
              </span>
              <Show when={(local.syncQueue.failed ?? 0) > 0 && local.onRetrySync !== undefined}>
                <button
                  type="button"
                  class={styles.inlineLink}
                  aria-label="Retry failed sync operations"
                  onClick={() => local.onRetrySync?.()}
                >
                  Retry
                </button>
              </Show>
            </span>
          </div>
        </div>

        {/* Appearance */}
        <div class={cx(styles.tile, 'pl-anim-cc-tile')} data-stagger="1">
          <span class={styles.tileHead} id={`${panelId()}-appearance`}>
            <Moon size={12} aria-hidden="true" />
            Appearance
          </span>
          <SegmentedControl
            options={THEME_OPTIONS}
            value={local.theme}
            onChange={(theme) => local.onThemeChange(theme)}
            label="Appearance"
            size="sm"
            tone="accent"
            fullWidth
          />
        </div>

        {/* Reduced motion */}
        <ToggleTile
          index={2}
          label="Reduced motion"
          description={
            local.reducedMotion
              ? 'Always'
              : local.systemReducedMotion === true
                ? 'System setting is on'
                : 'Follow system'
          }
          checked={local.reducedMotion}
          onChange={(on) => local.onReducedMotionChange(on)}
        />

        {/* Degraded services */}
        <div
          class={cx(styles.tile, styles.wide, 'pl-anim-cc-tile')}
          data-stagger="3"
          data-degraded={unhealthy().length > 0 ? 'true' : 'false'}
        >
          <button
            type="button"
            class={styles.row}
            aria-expanded={unhealthy().length > 0 ? expanded() : undefined}
            aria-controls={unhealthy().length > 0 ? `${panelId()}-services` : undefined}
            aria-disabled={unhealthy().length > 0 ? undefined : 'true'}
            onClick={() => {
              if (unhealthy().length > 0) setExpanded((v) => !v);
            }}
          >
            <span
              class={styles.circle}
              data-tone={summary().degraded > 0 ? 'warn' : 'ok'}
              aria-hidden="true"
            >
              <Show when={summary().degraded > 0} fallback={<ShieldCheck size={15} />}>
                <ShieldAlert size={15} />
              </Show>
            </span>
            <span class={styles.text}>
              <span class={styles.title}>{servicesTitle()}</span>
              <span class={styles.sub}>{servicesDetail()}</span>
            </span>
            <Show when={unhealthy().length > 0}>
              <span
                class={styles.chevron}
                data-open={expanded() ? 'true' : 'false'}
                aria-hidden="true"
              >
                <ChevronRight size={14} />
              </span>
            </Show>
          </button>
          <Show when={expanded() && unhealthy().length > 0}>
            <ul class={styles.services} id={`${panelId()}-services`} aria-label="Services">
              <For each={unhealthy()}>
                {(svc, index) => (
                  <li class={styles.service} style={{ '--pl-stagger-index': String(index()) }}>
                    <span class={styles.serviceText}>
                      {serviceRowText(svc, local.now)}
                      <Show when={retryError(svc.name)}>
                        {(error) => (
                          <span class={styles.serviceError} role="status">
                            {error()}
                          </span>
                        )}
                      </Show>
                    </span>
                    <Show
                      when={
                        local.onRetryService !== undefined &&
                        (svc.state === 'degraded' || svc.state === 'failed')
                      }
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        class={styles.retryButton}
                        disabled={retrying(svc.name)}
                        aria-label={
                          retrying(svc.name) ? `Retrying ${svc.name}` : `Retry ${svc.name} now`
                        }
                        onClick={() => local.onRetryService?.(svc.name)}
                      >
                        {retrying(svc.name) ? 'Retrying…' : 'Retry now'}
                      </Button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        {/* Memory budget */}
        <div class={cx(styles.tile, styles.wide, 'pl-anim-cc-tile')} data-stagger="4">
          <div class={styles.memHead}>
            <span class={styles.tileHead}>
              <MemoryStick size={13} aria-hidden="true" />
              Memory budget
            </span>
            <span class={styles.memValue} aria-hidden="true">
              {local.memory.applying === true ? 'Applying…' : formatMb(draft())}
            </span>
          </div>
          <Slider
            label="Memory budget"
            value={draft()}
            min={minMb()}
            max={maxMb()}
            step={local.memory.stepMb ?? 64}
            format={formatMb}
            disabled={local.memory.disabledReason !== undefined || local.memory.applying === true}
            onInput={(value) => setDraft(value)}
            onCommit={(value) => {
              if (value !== local.memory.budgetMb) local.onMemoryBudgetCommit(value);
            }}
            class={styles.slider}
          />
          <div class={styles.ticks} aria-hidden="true">
            <span>{formatMb(minMb())}</span>
            <span>Using {formatMb(local.memory.usedMb)}</span>
            <span>{formatMb(maxMb())}</span>
          </div>
          <Show when={local.memory.error}>
            {(error) => (
              <p class={styles.error} role="alert">
                {error()}
              </p>
            )}
          </Show>
          <Show when={local.memory.disabledReason}>
            {(reason) => <p class={styles.note}>{reason()}</p>}
          </Show>
        </div>

        {/* Focus and the frame meter: an even pair under the wide tiles */}
        <div class={styles.pair}>
          <ToggleTile
            index={5}
            label="Focus"
            description={
              local.focusMode ? 'Banners silenced · errors still shown' : 'Notifications allowed'
            }
            checked={local.focusMode}
            onChange={(on) => local.onFocusModeChange(on)}
            tone={local.focusMode ? 'on' : 'idle'}
            icon={
              <Show when={local.focusMode} fallback={<Moon size={13} />}>
                <MoonStar size={13} class={styles.moonOn} />
              </Show>
            }
          />

          {/* Frame meter */}
          <ToggleTile
            index={6}
            label="Frame meter"
            description={
              local.frameMeter ? (local.frameMeterSummary ?? 'Overlay on') : 'Shows frame timing'
            }
            checked={local.frameMeter}
            onChange={(on) => local.onFrameMeterChange(on)}
            tone={local.frameMeter ? 'on' : 'idle'}
            icon={<Gauge size={13} />}
          />
        </div>
      </div>

      <div class={cx(styles.footer, 'pl-anim-cc-tile')} data-stagger="7">
        <span class={styles.version} title={local.version ?? 'Plotinium'}>
          <Sparkle size={11} aria-hidden="true" class={styles.versionMark} />
          <span class={styles.versionText}>{local.version ?? 'Plotinium'}</span>
        </span>
        <Show when={local.onOpenSettings}>
          <button type="button" class={styles.link} onClick={() => local.onOpenSettings?.()}>
            <Settings size={12} aria-hidden="true" />
            Settings…
          </button>
        </Show>
      </div>
    </>
  );

  return (
    <Show when={presence.mounted()}>
      <Show
        when={local.inline !== true && local.anchor !== undefined}
        fallback={
          <div
            ref={setSurface}
            id={panelId()}
            role="dialog"
            aria-modal="false"
            aria-label="Control Centre"
            tabindex={-1}
            data-state={presence.state()}
            class={panelClass()}
          >
            <Body />
          </div>
        }
      >
        <Floating
          anchor={local.anchor}
          placement="bottom-end"
          offset={8}
          glass={false}
          floatingRef={(el) => setSurface(el)}
          id={panelId()}
          role="dialog"
          aria-modal="false"
          aria-label="Control Centre"
          tabindex={-1}
          data-state={presence.state()}
          class={panelClass()}
        >
          <Body />
        </Floating>
      </Show>
    </Show>
  );
}
