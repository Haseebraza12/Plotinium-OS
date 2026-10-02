import ChevronDown from 'lucide-solid/icons/chevron-down';
import OctagonX from 'lucide-solid/icons/octagon-x';
import SlidersHorizontal from 'lucide-solid/icons/sliders-horizontal';
import {
  createEffect,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  Show,
  splitProps,
  type JSX,
} from 'solid-js';

import { Button } from '../../primitives/button/Button.tsx';
import { Dialog } from '../../primitives/dialog/Dialog.tsx';
import { cx } from '../../primitives/internal/cx.ts';
import { Menu, type MenuEntry } from '../../primitives/menu/Menu.tsx';
import { Popover } from '../../primitives/popover/Popover.tsx';
import { Slider } from '../../primitives/slider/Slider.tsx';
import { Tooltip } from '../../primitives/tooltip/Tooltip.tsx';
import { bandOf, basePriority, canEnd, formatNice } from './format.ts';
import type { ProcessRow, ProcessSignal } from './models.ts';
import styles from './ProcessActions.module.css';

/** How long the "End burn (301)?" confirmation stays armed. */
export const CONFIRM_MS = 3000;

export interface KillRequest {
  pid: number;
  name: string;
  signal: Extract<ProcessSignal, 'SIGTERM' | 'SIGKILL'>;
}

function disabledReason(target: ProcessRow | undefined): string {
  if (target === undefined) return 'Select a process to end it';
  return 'System process: cannot end';
}

export interface EndProcessButtonProps {
  /** The selected process, if any. */
  target: ProcessRow | undefined;
  /** Sends a signal directly (the confirmed End, Suspend, Continue). */
  onSignal: (pid: number, signal: ProcessSignal) => void;
  /** Asks for the kill -9 confirmation dialog. */
  onRequestKill: (request: KillRequest) => void;
  /** A signal is in flight: the label reads "Ending…" until the process terminates. */
  pending?: boolean;
  class?: string;
}

/**
 * End Process split button (task-manager-processes). The first press arms a 3 s confirmation
 * ("End burn (301)?"); the second sends SIGTERM. The chevron menu offers End, Force kill
 * (kill -9, always confirmed by a dialog), Suspend and Continue. Disabled for pid 1 and kernel
 * services, with the reason on hover and focus.
 */
export function EndProcessButton(props: EndProcessButtonProps): JSX.Element {
  const [local] = splitProps(props, ['target', 'onSignal', 'onRequestKill', 'pending', 'class']);
  const [confirming, setConfirming] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [chevron, setChevron] = createSignal<HTMLButtonElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const enabled = (): boolean => canEnd(local.target) && local.pending !== true;
  const disarm = (): void => {
    clearTimeout(timer);
    setConfirming(false);
  };
  // A new selection cancels an armed confirmation.
  createEffect(on(() => local.target?.pid, disarm, { defer: true }));
  onCleanup(() => clearTimeout(timer));

  const press = (): void => {
    const target = local.target;
    if (target === undefined || !enabled()) return;
    if (!confirming()) {
      setConfirming(true);
      timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
      return;
    }
    disarm();
    local.onSignal(target.pid, 'SIGTERM');
  };

  const items = (): MenuEntry[] => {
    const state = local.target?.state;
    return [
      { id: 'SIGTERM', label: 'End (SIGTERM)', shortcut: ['Delete'] },
      {
        id: 'SIGKILL',
        label: 'Force kill (kill -9)',
        danger: true,
        shortcut: ['Alt', 'Ctrl', 'Q'],
      },
      { kind: 'separator' },
      {
        id: 'SIGSTOP',
        label: 'Suspend (SIGSTOP)',
        disabled: state === 'STOPPED' || state === 'SUSPENDED',
      },
      { id: 'SIGCONT', label: 'Continue (SIGCONT)', disabled: state !== 'STOPPED' },
    ];
  };

  const choose = (id: string): void => {
    const target = local.target;
    if (target === undefined) return;
    disarm();
    if (id === 'SIGKILL')
      local.onRequestKill({ pid: target.pid, name: target.name, signal: 'SIGKILL' });
    else if (id === 'SIGTERM' || id === 'SIGSTOP' || id === 'SIGCONT')
      local.onSignal(target.pid, id);
  };

  const mainLabel = (): string => {
    if (local.pending === true) return 'Ending…';
    return 'End Process';
  };

  const group = (): JSX.Element => (
    <div
      class={cx(styles.split, !enabled() && styles.splitDisabled, local.class)}
      role="group"
      aria-label="End process"
      data-confirming={confirming() ? 'true' : undefined}
    >
      <button
        type="button"
        class={styles.main}
        aria-disabled={enabled() ? undefined : 'true'}
        aria-live="polite"
        onClick={press}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && confirming()) {
            event.preventDefault();
            event.stopPropagation();
            disarm();
          }
        }}
      >
        <span class={styles.confirmLayer} aria-hidden="true" />
        <span class={styles.labels}>
          <span class={styles.idle} aria-hidden={confirming() ? 'true' : undefined}>
            <OctagonX size={14} aria-hidden="true" />
            {mainLabel()}
          </span>
          <span class={styles.confirm} aria-hidden={confirming() ? undefined : 'true'}>
            {`End ${local.target?.name ?? ''} (${local.target?.pid ?? ''})?`}
          </span>
        </span>
      </button>
      <button
        ref={setChevron}
        type="button"
        class={styles.chevron}
        aria-label="More ways to end the process"
        aria-haspopup="menu"
        aria-expanded={menuOpen()}
        aria-disabled={enabled() ? undefined : 'true'}
        onClick={() => {
          if (enabled()) setMenuOpen((open) => !open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && enabled()) {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <Menu
        open={menuOpen()}
        anchor={chevron()}
        placement="bottom-end"
        label="End process"
        items={items()}
        onSelect={choose}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );

  return (
    <Show
      when={enabled() || local.pending === true}
      fallback={
        <Tooltip content={disabledReason(local.target)} placement="bottom">
          {group()}
        </Tooltip>
      }
    >
      {group()}
    </Show>
  );
}

export interface KillDialogProps {
  request: KillRequest | null;
  onConfirm: (request: KillRequest) => void;
  onCancel: () => void;
}

/** The alertdialog that names the process before kill -9 (and Delete-key ends). Cancel is focused. */
export function KillDialog(props: KillDialogProps): JSX.Element {
  const [local] = splitProps(props, ['request', 'onConfirm', 'onCancel']);
  const [last, setLast] = createSignal<KillRequest | null>(null);
  createEffect(() => {
    if (local.request !== null) setLast(local.request);
  });
  const force = (): boolean => last()?.signal === 'SIGKILL';
  return (
    <Dialog
      open={local.request !== null}
      role="alertdialog"
      size="sm"
      title={
        force()
          ? `Force kill ${last()?.name ?? ''} (${last()?.pid ?? ''})?`
          : `End ${last()?.name ?? ''} (${last()?.pid ?? ''})?`
      }
      description={
        force()
          ? 'kill -9 stops it at once. Unsaved work in the process is lost and it cannot clean up.'
          : 'The process is asked to exit (SIGTERM) and may save its work first.'
      }
      icon={<OctagonX size={28} />}
      onClose={() => local.onCancel()}
      actions={
        <>
          <Button data-autofocus onClick={() => local.onCancel()}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const request = local.request;
              if (request !== null) local.onConfirm(request);
            }}
          >
            {force() ? 'Force kill' : 'End process'}
          </Button>
        </>
      }
    />
  );
}

export interface ReniceButtonProps {
  target: ProcessRow | undefined;
  onRenice: (pid: number, nice: number) => void;
  /** The current user may set a negative nice (root). */
  mayRaise?: boolean;
  /** Error from the kernel ("EPERM: only root may lower nice below 0"). */
  error?: string;
  /** Popover open state (controlled, e.g. from the row context menu). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  class?: string;
}

/** "Renice…" and its popover: a nice slider (−20 … 19), the resulting priority and Apply. */
export function ReniceButton(props: ReniceButtonProps): JSX.Element {
  const [local] = splitProps(props, [
    'target',
    'onRenice',
    'mayRaise',
    'error',
    'open',
    'onOpenChange',
    'class',
  ]);
  const uid = createUniqueId();
  const [ownOpen, setOwnOpen] = createSignal(false);
  const open = (): boolean => local.open ?? ownOpen();
  const setOpen = (next: boolean | ((prev: boolean) => boolean)): void => {
    const value = typeof next === 'function' ? next(open()) : next;
    setOwnOpen(value);
    local.onOpenChange?.(value);
  };
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const [nice, setNice] = createSignal(0);

  createEffect(
    on(open, (isOpen) => {
      if (isOpen) setNice(local.target?.nice ?? 0);
    }),
  );
  createEffect(
    on(
      () => local.target?.pid,
      () => setOpen(false),
      { defer: true },
    ),
  );

  const resulting = (): number => basePriority(local.target?.priority ?? 20, nice());
  const localError = (): string | undefined =>
    nice() < 0 && local.mayRaise !== true ? 'EPERM: only root may lower nice below 0' : undefined;
  const error = (): string | undefined => localError() ?? local.error;
  const unchanged = (): boolean => nice() === (local.target?.nice ?? 0);

  const apply = (): void => {
    const target = local.target;
    if (target === undefined || error() !== undefined || unchanged()) return;
    local.onRenice(target.pid, nice());
    setOpen(false);
  };

  return (
    <>
      <Button
        ref={setAnchor}
        class={local.class}
        icon={<SlidersHorizontal size={14} />}
        disabled={local.target === undefined}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen((o) => !o)}
      >
        Renice…
      </Button>
      <Popover
        open={open() && local.target !== undefined}
        anchor={anchor()}
        placement="bottom-end"
        label={`Renice ${local.target?.name ?? ''}`}
        onClose={() => setOpen(false)}
      >
        <div class={styles.renice}>
          <div class={styles.reniceHead}>
            <span class={styles.reniceTitle}>
              Renice {local.target?.name} <span class={styles.dim}>({local.target?.pid})</span>
            </span>
            <span class={styles.reniceValue} aria-hidden="true">
              {formatNice(nice())}
            </span>
          </div>
          <Slider
            label="Nice value"
            min={-20}
            max={19}
            value={nice()}
            onInput={setNice}
            format={(v) =>
              `nice ${formatNice(v)}, priority ${basePriority(local.target?.priority ?? 20, v)}`
            }
          />
          <div class={styles.scale} aria-hidden="true">
            <span>−20 · faster</span>
            <span>+19 · nicer</span>
          </div>
          <p class={styles.reniceInfo} id={`pl-renice-${uid}`}>
            Priority <strong>{resulting()}</strong> · {bandOf(resulting())} band
          </p>
          <Show when={error()}>
            {(message) => (
              <p class={styles.reniceError} role="alert">
                {message()}
              </p>
            )}
          </Show>
          <div class={styles.reniceActions}>
            <Button size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={error() !== undefined || unchanged()}
              aria-describedby={`pl-renice-${uid}`}
              onClick={apply}
            >
              Apply
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}
