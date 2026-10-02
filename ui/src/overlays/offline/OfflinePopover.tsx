import ArrowUpRight from 'lucide-solid/icons/arrow-up-right';
import CircleCheck from 'lucide-solid/icons/circle-check';
import Clock from 'lucide-solid/icons/clock';
import CloudCheck from 'lucide-solid/icons/cloud-check';
import CloudOff from 'lucide-solid/icons/cloud-off';
import LogIn from 'lucide-solid/icons/log-in';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import ShieldAlert from 'lucide-solid/icons/shield-alert';
import ShieldCheck from 'lucide-solid/icons/shield-check';
import Timer from 'lucide-solid/icons/timer';
import {
  createEffect,
  createSignal,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';

import { cx } from '../../primitives/internal/cx.ts';
import type { Placement } from '../../primitives/internal/position.ts';
import { Popover, type PopoverCloseReason } from '../../primitives/popover/Popover.tsx';
import type { NetView } from '../../shell/types.ts';
import shared from '../internal/shared.module.css';
import styles from './Offline.module.css';

export interface QueuedOp {
  id: string;
  /** The outbox verb: `write`, `mkdir`, `mv`, `rm`. */
  verb: string;
  path: string;
  /** Destination of a move. */
  target?: string;
  /** Queued at: `14:29`. */
  time: string;
  /** queued (default), replaying (with progress), or rejected by the server. */
  state?: 'queued' | 'replaying' | 'rejected';
  /** 0..1 while replaying. */
  progress?: number;
  /** `rejected · EACCES` and what happened to the local copy (`restored`, `kept as …`). */
  rejection?: string;
}

export interface DegradedService {
  id: string;
  /** The service name, shown in mono: `sync`, `lockd`. */
  name: string;
  /** `offline`, `local advisory locks only`, or the failure reason. */
  detail: string;
  /** `14:28:51`. */
  since: string;
  state?: 'degraded' | 'failed' | 'recovered';
}

export type RetryState = 'idle' | 'checking' | 'failed';

export interface OfflinePopoverProps {
  open: boolean;
  onClose: (reason: PopoverCloseReason) => void;
  /** The connectivity chip in the menu bar. */
  anchor: HTMLElement | undefined;
  /**
   * The tray's connectivity state: the header says what is true now (Online · synced, Syncing,
   * Reconnecting, You're offline, Sign in to sync, Sync unavailable). Without it the header
   * keeps the offline wording of the original mock.
   */
  net?: NetView;
  /** Opened from the "N degraded" pill: the header is about the services (UI-025). */
  focus?: 'connectivity' | 'services';
  queued: readonly QueuedOp[];
  degraded: readonly DegradedService[];
  /** Set while the outbox replays after reconnecting. */
  replay?: { done: number; total: number };
  retry: RetryState;
  /** Seconds to the next automatic probe (updated once a second by the caller). */
  nextCheckS?: number;
  onRetry: () => void;
  onOpenTaskManager?: () => void;
  onOpenOp?: (id: string) => void;
  onOpenService?: (id: string) => void;
  /** Each degraded or failed row gets a "Retry" button (svc.control retry). */
  onRetryService?: (id: string) => void;
  /** Services whose retry is in flight ("Retrying…"). */
  retryingServices?: readonly string[];
  /** Services whose last retry failed, with the reason ("Could not retry"). */
  retryErrors?: Readonly<Record<string, string>>;
  placement?: Placement;
  class?: string;
}

/**
 * The connectivity popover (OFF-01, OFF-02, OFF-04): what is queued in the durable outbox, the
 * promise that it replays exactly once, and the services running degraded. It is a non-modal
 * glass popover anchored to the menu-bar chip: Escape and a click outside close it and focus
 * returns to the chip. Each row reads as one sentence; colour is never the only signal.
 */
export function OfflinePopover(props: OfflinePopoverProps): JSX.Element {
  const [local] = splitProps(props, [
    'open',
    'onClose',
    'anchor',
    'net',
    'focus',
    'queued',
    'degraded',
    'replay',
    'retry',
    'nextCheckS',
    'onRetry',
    'onOpenTaskManager',
    'onOpenOp',
    'onOpenService',
    'onRetryService',
    'retryingServices',
    'retryErrors',
    'placement',
    'class',
  ]);
  // Retry spins its glyph once per press (a one-shot, not a loop).
  const [spin, setSpin] = createSignal(0);
  createEffect(
    on(
      () => local.open,
      (open) => {
        if (!open) setSpin(0);
      },
    ),
  );

  const retryLabel = (): string => (local.retry === 'checking' ? 'Checking…' : 'Retry now');
  const retryingService = (id: string): boolean => local.retryingServices?.includes(id) === true;
  const nextCheck = (): string => {
    if (local.nextCheckS === undefined) return '';
    const text = `next check in ${local.nextCheckS} s`;
    return local.retry === 'failed' ? `Still offline · ${text}` : text;
  };

  const activeDegraded = (): number => local.degraded.filter((d) => d.state !== 'recovered').length;
  const head = (): Header => headerFor(local.net, local.focus, activeDegraded());
  const nothingQueued = (): string =>
    local.net === undefined || local.net.state === 'LIVE'
      ? 'Nothing queued · all changes are on the server'
      : 'Nothing queued';

  return (
    <Popover
      open={local.open}
      onClose={(reason) => local.onClose(reason)}
      anchor={local.anchor}
      label={
        local.focus === 'services' ? 'Degraded services' : 'Connectivity and degraded services'
      }
      placement={local.placement ?? 'bottom-end'}
      flush
      class={cx(styles.popover, local.class)}
    >
      <header class={styles.header}>
        <span class={styles.badge} data-tone={head().tone} aria-hidden="true">
          <Dynamic component={head().icon} size={18} stroke-width={2} />
        </span>
        <div>
          <h2 class={styles.title}>{head().title}</h2>
          <p class={styles.subtitle}>{head().subtitle}</p>
        </div>
      </header>

      <section class={styles.section} aria-labelledby="pl-offline-queued">
        <div class={styles.sectionHead}>
          <h3 class={styles.sectionTitle} id="pl-offline-queued">
            Queued operations · {local.queued.length}
          </h3>
          <span class={styles.sectionNote}>outbox · durable</span>
        </div>
        <Show
          when={local.queued.length > 0}
          fallback={
            <p class={styles.emptyLine}>
              <CircleCheck size={14} stroke-width={2} aria-hidden="true" />
              {nothingQueued()}
            </p>
          }
        >
          <ul class={styles.queue} aria-label="Queued operations">
            <For each={local.queued}>
              {(op, index) => (
                <li
                  class={styles.op}
                  data-state={op.state ?? 'queued'}
                  style={{ '--pl-stagger-index': String(index()) }}
                >
                  <OpRow op={op} onOpen={local.onOpenOp} />
                </li>
              )}
            </For>
          </ul>
          <p class={styles.assurance}>
            <ShieldCheck size={14} stroke-width={2} aria-hidden="true" />
            <Show when={local.replay} fallback="Will replay automatically · exactly once">
              {(replay) => (
                <>
                  Replaying {replay().done} of {replay().total} · exactly once
                </>
              )}
            </Show>
          </p>
        </Show>
      </section>

      <section class={cx(styles.section, styles.sectionRule)} aria-labelledby="pl-offline-degraded">
        <div class={styles.sectionHead}>
          <h3 class={styles.sectionTitle} id="pl-offline-degraded">
            Degraded services · {activeDegraded()}
          </h3>
          <span class={styles.sectionNote}>since</span>
        </div>
        <Show
          when={local.degraded.length > 0}
          fallback={<p class={styles.emptyLine}>No degraded services</p>}
        >
          <ul class={styles.services} aria-label="Degraded services">
            <For each={local.degraded}>
              {(service) => (
                <li class={styles.service} data-state={service.state ?? 'degraded'}>
                  <ServiceRow
                    clickable={local.onOpenService !== undefined}
                    service={service}
                    onOpen={(id) => local.onOpenService?.(id)}
                  />
                  <Show when={local.onRetryService !== undefined && service.state !== 'recovered'}>
                    <div class={styles.serviceActions}>
                      <Show when={local.retryErrors?.[service.id]}>
                        {(error) => (
                          <span class={styles.retryError} role="status">
                            {error()}
                          </span>
                        )}
                      </Show>
                      <button
                        type="button"
                        class={styles.serviceRetry}
                        aria-disabled={retryingService(service.id) ? 'true' : undefined}
                        aria-label={
                          retryingService(service.id)
                            ? `Retrying ${service.name}`
                            : `Retry ${service.name} now`
                        }
                        onClick={() => {
                          if (!retryingService(service.id)) local.onRetryService?.(service.id);
                        }}
                      >
                        {retryingService(service.id) ? 'Retrying…' : 'Retry'}
                      </button>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <footer class={styles.footer}>
        <button
          type="button"
          class={styles.retry}
          aria-disabled={local.retry === 'checking' ? 'true' : undefined}
          onClick={() => {
            if (local.retry === 'checking') return;
            setSpin((n) => n + 1);
            local.onRetry();
          }}
          data-autofocus
        >
          <Show keyed when={String(spin())}>
            {(n) => (
              <span class={cx(styles.retryIcon, n !== '0' && styles.retrySpin)} aria-hidden="true">
                <RotateCcw size={14} stroke-width={2.2} />
              </span>
            )}
          </Show>
          {retryLabel()}
          <Show when={local.retry === 'checking'}>
            <span class={styles.retryBar} aria-hidden="true">
              <span class={styles.retryFill} />
            </span>
          </Show>
        </button>
        <span class={styles.nextCheck}>{nextCheck()}</span>
        <Show when={local.onOpenTaskManager}>
          {(open) => (
            <button type="button" class={styles.link} onClick={() => open()()}>
              Task Manager
              <ArrowUpRight size={12} stroke-width={2.2} aria-hidden="true" />
            </button>
          )}
        </Show>
      </footer>
      <div class={shared.srOnly} role="status" aria-live="polite">
        <Show when={local.retry === 'failed'}>{nextCheck()}</Show>
      </div>
    </Popover>
  );
}

interface Header {
  title: string;
  subtitle: string;
  tone: 'success' | 'accent' | 'warning';
  icon: typeof CloudOff;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The popover header: what is true about sync right now (UI-025). */
export function headerFor(
  net: NetView | undefined,
  focus: 'connectivity' | 'services' | undefined,
  degraded: number,
): Header {
  if (focus === 'services')
    return degraded === 0
      ? {
          title: 'Degraded services',
          subtitle: 'Every service is running normally.',
          tone: 'success',
          icon: ShieldCheck,
        }
      : {
          title: 'Degraded services',
          subtitle: `${plural(degraded, 'service runs', 'services run')} in a limited mode; your work is kept.`,
          tone: 'warning',
          icon: ShieldAlert,
        };
  switch (net?.state) {
    case 'LIVE':
      return {
        title: 'Online · synced',
        subtitle: 'All changes are on the server.',
        tone: 'success',
        icon: CloudCheck,
      };
    case 'SYNCING':
      return {
        title: `Syncing ${plural(net.ops, 'op', 'ops')}`,
        subtitle: 'Sending your changes to the server.',
        tone: 'accent',
        icon: RefreshCw,
      };
    case 'RECONNECTING':
      return {
        title: 'Reconnecting',
        subtitle: 'The server is unreachable; changes are saved on this device.',
        tone: 'warning',
        icon: Timer,
      };
    case 'AUTH_REQUIRED':
      return {
        title: 'Sign in to sync',
        subtitle: `${plural(net.queued, 'change waits', 'changes wait')} until you sign in again.`,
        tone: 'warning',
        icon: LogIn,
      };
    case 'UNAVAILABLE': {
      const reason = net.reason === '' ? 'The sync service is not running' : net.reason;
      return {
        title: 'Sync unavailable',
        subtitle: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. Changes are saved on this device.`,
        tone: 'warning',
        icon: CloudOff,
      };
    }
    case 'OFFLINE':
    case undefined:
      return {
        title: "You're offline",
        subtitle: 'Changes are saved on this device and queued.',
        tone: 'warning',
        icon: CloudOff,
      };
  }
}

function OpRow(props: { op: QueuedOp; onOpen: ((id: string) => void) | undefined }): JSX.Element {
  const body = (): JSX.Element => (
    <>
      <span class={styles.verb}>{props.op.verb}</span>
      <span class={styles.opPath}>
        {props.op.path}
        <Show when={props.op.target}>
          {(target) => (
            <>
              <span class={styles.arrow} aria-hidden="true">
                {' '}
                →{' '}
              </span>
              <span class={shared.srOnly}> to </span>
              {target()}
            </>
          )}
        </Show>
        <Show when={props.op.state === 'rejected' && props.op.rejection}>
          {(rejection) => <span class={styles.rejected}>{rejection()}</span>}
        </Show>
      </span>
      <Switch>
        <Match when={props.op.state === 'replaying'}>
          <span class={styles.opBar} aria-hidden="true">
            <span
              class={styles.opFill}
              style={{ '--pl-progress-ratio': String(props.op.progress ?? 0) }}
            />
          </span>
        </Match>
        <Match when={props.op.state !== 'replaying'}>
          <span class={styles.opTime}>
            <Clock size={12} stroke-width={2} aria-hidden="true" />
            <span class={shared.srOnly}>, queued </span>
            {props.op.time}
          </span>
        </Match>
      </Switch>
    </>
  );
  return (
    <Show when={props.onOpen} fallback={<div class={styles.opRow}>{body()}</div>}>
      {(open) => (
        <button
          type="button"
          class={cx(styles.opRow, styles.rowButton)}
          onClick={() => open()(props.op.id)}
        >
          {body()}
        </button>
      )}
    </Show>
  );
}

function ServiceRow(props: {
  clickable: boolean;
  service: DegradedService;
  onOpen: (id: string) => void;
}): JSX.Element {
  const body = (): JSX.Element => (
    <>
      <span class={styles.dot} aria-hidden="true" />
      <span class={styles.serviceText}>
        <code class={styles.serviceName}>{props.service.name}</code> —{' '}
        {props.service.state === 'failed'
          ? `failed · ${props.service.detail}`
          : props.service.detail}
        <Show when={props.service.state === 'recovered'}>
          <span class={shared.srOnly}>, recovered</span>
        </Show>
      </span>
      <span class={styles.since}>{props.service.since}</span>
    </>
  );
  return (
    <Show when={props.clickable} fallback={<div class={styles.serviceRow}>{body()}</div>}>
      <button
        type="button"
        class={cx(styles.serviceRow, styles.rowButton)}
        onClick={() => props.onOpen(props.service.id)}
      >
        {body()}
      </button>
    </Show>
  );
}
