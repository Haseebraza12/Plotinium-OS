/**
 * The executor-only calls of the Files and Editor views, made by the app's own process
 * (window-manager.md §3.13 display channel; apps/src/descriptor.ts `AppSys` routing contract).
 *
 * The view port admits only the view calls (registry origin V or EV: `stat`, `lstat`, `readdir`,
 * `statfs`, `quota`, `lock.status`, `proc.cred`, `users.list`, `ai.semsearch`, …). Reading file
 * content, every change and every lease are executor calls (origin E: `open`, `read`, `close`,
 * `writeFile`, `mkdir`, `rename`, `copy`, `unlink`, `chmod`, `lock.acquire`, `lock.release`). So:
 *
 * - the view's client (`createRelaySys`) sends the V and EV calls over the view port as before and
 *   posts each allow-listed E call as an `input` on the window's display channel;
 * - the app's process (`appProcess`, apps/<app>/proc.ts) takes those inputs, checks the call
 *   against its allow-list, performs it with `ctx.sys` (so the kernel sees the app's pid,
 *   credentials and capabilities and checks rwx, quota and leases as for any program) and posts
 *   the reply back on the same channel.
 *
 * The request is data (`ev: {kind: 'sys', id, call, args}`); the kernel still validates `args`
 * against the call's schema at stage 3. Nothing on the display channel reaches the dispatcher by
 * itself. A view whose host has no display channel gets ENOSYS for these calls and shows that.
 *
 * The process's end of the channel is `display` in the `window.create` reply. When the host created
 * the window instead (`PLT_WINDOW=<wid>`), the executor is expected to pass it as `ctx.display`
 * (TODO(R1/R3): not in `ProgramContext` yet, so it is read structurally). Without a port the
 * process only owns the window.
 */
import type { ArgsIn, CallName, RetOf } from '@plotinium/protocol';
import { isErrno as isKnownErrno, lookupCall, TRANSFER_THRESHOLD_BYTES } from '@plotinium/protocol';
import type { Program, ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf, SysError } from '@plotinium/kernel/sys';

import { describeFailure, errnoOfReason, WINDOW_ENV } from '../../src/descriptor.ts';
import type { PromiseSys } from './sys.ts';

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** The executor calls a Files or Editor window may ask its process to make. */
export const FILE_RELAY_CALLS = [
  'open',
  'read',
  'close',
  'writeFile',
  'mkdir',
  'rename',
  'copy',
  'unlink',
  'chmod',
  'lock.acquire',
  'lock.release',
] as const satisfies readonly CallName[];

export type FileRelayCall = (typeof FILE_RELAY_CALLS)[number];

/** A relayed call: the `ev` of a display-channel `input`. */
export interface RelayRequest {
  readonly kind: 'sys';
  readonly id: number;
  readonly call: string;
  readonly args: unknown;
}

/** View → process (window-manager.md §4.4 `ViewToProc` `input`). */
export interface RelayInput {
  readonly t: 'input';
  readonly seq: number;
  readonly ev: RelayRequest;
}

/** Process → view: the outcome of one relayed call. */
export type RelayReply =
  | { readonly t: 'reply'; readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly t: 'reply';
      readonly id: number;
      readonly ok: false;
      readonly errno: string;
      readonly message: string;
    };

/** A MessagePort, or anything with the same two members (tests, a host adapter). */
export interface PortLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** The relay request inside a display-channel message, or undefined for anything else. */
export function parseRelayInput(msg: unknown): RelayRequest | undefined {
  if (!isRecord(msg) || msg['t'] !== 'input') return undefined;
  const ev = msg['ev'];
  if (!isRecord(ev) || ev['kind'] !== 'sys') return undefined;
  const id = ev['id'];
  const call = ev['call'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof call !== 'string')
    return undefined;
  if (call.length === 0 || call.length > 64) return undefined;
  return { kind: 'sys', id, call, args: ev['args'] };
}

/** The reply inside a display-channel message, or undefined for anything else. */
export function parseRelayReply(msg: unknown): RelayReply | undefined {
  if (!isRecord(msg) || msg['t'] !== 'reply') return undefined;
  const id = msg['id'];
  if (typeof id !== 'number') return undefined;
  if (msg['ok'] === true) return { t: 'reply', id, ok: true, value: msg['value'] };
  const errno = msg['errno'];
  const message = msg['message'];
  return {
    t: 'reply',
    id,
    ok: false,
    errno: typeof errno === 'string' ? errno : 'EIO',
    message: typeof message === 'string' ? message : '',
  };
}

/** ArrayBuffers worth transferring (ABI-13: 64 KiB or more), at the top level of `value`. */
export function transferables(value: unknown): ArrayBuffer[] {
  if (value instanceof ArrayBuffer)
    return value.byteLength >= TRANSFER_THRESHOLD_BYTES ? [value] : [];
  if (!isRecord(value)) return [];
  const out: ArrayBuffer[] = [];
  for (const v of Object.values(value)) {
    if (v instanceof ArrayBuffer && v.byteLength >= TRANSFER_THRESHOLD_BYTES) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Process side
// ---------------------------------------------------------------------------------------------

/** The generator client the relay needs (`ctx.sys` satisfies it). */
export interface RelaySys {
  call<C extends CallName>(name: C, args: ArgsIn<C>): SysGen<RetOf<C>>;
}

/**
 * Performs one relayed request as this process: calls outside `allow` are refused with EPERM
 * before any system call; a failed call becomes an error reply with its errno. Never throws for
 * a system-call failure.
 */
export function* serveRelay(
  sys: RelaySys,
  req: RelayRequest,
  allow: readonly string[],
): SysGen<RelayReply> {
  if (!allow.includes(req.call)) {
    return {
      t: 'reply',
      id: req.id,
      ok: false,
      errno: 'EPERM',
      message: `${req.call.slice(0, 64)} is not relayed for this window`,
    };
  }
  try {
    const value: unknown = yield* sys.call(req.call as CallName, req.args as never);
    return { t: 'reply', id: req.id, ok: true, value };
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) {
      return { t: 'reply', id: req.id, ok: false, errno: 'EIO', message: describeFailure(e) };
    }
    return {
      t: 'reply',
      id: req.id,
      ok: false,
      errno,
      message: e instanceof Error ? e.message : errno,
    };
  }
}

/** `value` when it is a MessagePort or has the same two members, else undefined. */
export function asPort(value: unknown): PortLike | undefined {
  if (!isRecord(value) || typeof value['postMessage'] !== 'function' || !('onmessage' in value)) {
    return undefined;
  }
  return value as unknown as PortLike;
}

/** The display port the executor runtime gives the process, when it does (see the TODO above). */
export function displayOf(ctx: ProgramContext): PortLike | undefined {
  return 'display' in ctx ? asPort(ctx.display) : undefined;
}

/** State of an app process (serialisable: it is checkpointed and paged). */
export interface AppProcessState {
  readonly app: string;
  wid: number | null;
  /** Why no window could be created (ENOSYS before the WM is wired). */
  windowError: string | null;
  /** Relayed calls performed for the view. */
  served: number;
  wakes: number;
}

/** How long the process sleeps between checks for relayed calls while the view is active. */
export const RELAY_ACTIVE_SLEEP_MS = 16;
/** …and once the view has been quiet for RELAY_ACTIVE_WINDOW_MS. */
export const RELAY_IDLE_SLEEP_MS = 120;
export const RELAY_ACTIVE_WINDOW_MS = 2_000;
/** Without a display channel there is nothing to serve: wake rarely. */
export const RELAY_NO_DISPLAY_SLEEP_MS = 60_000;

export interface AppProcessSpec {
  readonly app: string;
  readonly title: string;
  readonly icon: string;
  readonly minWidth: number;
  readonly minHeight: number;
  /** The calls this app's view may ask for (default FILE_RELAY_CALLS). */
  readonly relay?: readonly string[];
}

/**
 * The process of the Files or Editor app (`/bin/<app>.json` entry `apps/<app>/proc`):
 *
 * 1. owns the window (`window.create`, unless the host already created it and set
 *    `PLT_WINDOW=<wid>`); closing the window sends SIGTERM, whose default action ends the
 *    process, and ending the process closes the window (window-manager.md §3.12);
 * 2. serves the view's relayed executor calls (above), one at a time and in order;
 * 3. keeps every loop yielding (`sleep` is a scheduler-visible B call), so it can be paged out
 *    and restored; its state is only counters and the window id.
 */
export function appProcess(spec: AppProcessSpec): Program<AppProcessState> {
  const allow = spec.relay ?? FILE_RELAY_CALLS;
  return {
    checkpointable: true,
    init: () => ({ app: spec.app, wid: null, windowError: null, served: 0, wakes: 0 }),
    *run(ctx: ProgramContext, st: AppProcessState): SysGen<number> {
      let fromCreate: PortLike | undefined;
      if (st.wid === null && st.windowError === null) {
        const given = Number.parseInt(ctx.env.get(WINDOW_ENV) ?? '', 10);
        if (Number.isInteger(given) && given > 0) {
          st.wid = given;
        } else {
          try {
            const win = yield* ctx.sys['window.create']({
              title: spec.title,
              icon: spec.icon,
              minSize: { w: spec.minWidth, h: spec.minHeight },
              restoreKey: spec.app,
            });
            st.wid = win.wid;
            fromCreate = asPort(win.display);
          } catch (e) {
            st.windowError = describeFailure(e);
          }
        }
      }
      // After a page-in or migration the runtime hands over the new channel (window-manager.md
      // §3.12); the one from `window.create` is only there on the first run.
      const port = fromCreate ?? displayOf(ctx);
      const queue: RelayRequest[] = [];
      if (port !== undefined) {
        port.onmessage = (ev: MessageEvent) => {
          const req = parseRelayInput(ev.data);
          if (req !== undefined) queue.push(req);
        };
      }
      let lastActive = ctx.now();
      for (;;) {
        while (port !== undefined && queue.length > 0) {
          const req = queue.shift();
          if (req === undefined) break;
          const reply = yield* serveRelay(ctx.sys, req, allow);
          st.served += 1;
          lastActive = ctx.now();
          try {
            port.postMessage(reply, reply.ok ? transferables(reply.value) : []);
          } catch {
            // The view went away (closed or dehydrated): the reply has no reader.
          }
        }
        const ms =
          port === undefined
            ? RELAY_NO_DISPLAY_SLEEP_MS
            : ctx.now() - lastActive < RELAY_ACTIVE_WINDOW_MS
              ? RELAY_ACTIVE_SLEEP_MS
              : RELAY_IDLE_SLEEP_MS;
        try {
          yield* ctx.sys.sleep({ ms });
        } catch (e) {
          // A caught signal interrupts the sleep (EINTR); anything else ends the process.
          if (errnoOfReason(e) !== 'EINTR') throw e;
        }
        st.wakes += 1;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// View side
// ---------------------------------------------------------------------------------------------

/** How long a relayed call may wait for its process (a paged-out process restores first). */
export const RELAY_TIMEOUT_MS = 30_000;

export interface RelaySysOptions {
  /** The E calls sent to the process (default FILE_RELAY_CALLS). */
  readonly allow?: readonly string[];
  readonly timeoutMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface RelaySysClient extends PromiseSys {
  /** Rejects every outstanding relayed call (the display channel closed or was replaced). */
  dispose(reason?: string): void;
}

/**
 * A view's system-call client that routes each call: executor-only calls in the allow-list go to
 * the app's process over `display`, everything else to the view port (`view`). Replies other
 * than relay replies are passed to `onOther` (snapshots, notices, …).
 */
export function createRelaySys(
  view: PromiseSys,
  display: PortLike,
  opts: RelaySysOptions & { readonly onOther?: (msg: unknown) => void } = {},
): RelaySysClient {
  const allow = opts.allow ?? FILE_RELAY_CALLS;
  const timeoutMs = opts.timeoutMs ?? RELAY_TIMEOUT_MS;
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; cancel: () => void }
  >();
  let nextId = 1;
  let seq = 0;

  display.onmessage = (ev: MessageEvent) => {
    const reply = parseRelayReply(ev.data);
    if (reply === undefined) {
      opts.onOther?.(ev.data);
      return;
    }
    const p = pending.get(reply.id);
    if (p === undefined) return;
    pending.delete(reply.id);
    p.cancel();
    if (reply.ok) p.resolve(reply.value);
    else p.reject(new SysError(isKnownErrno(reply.errno) ? reply.errno : 'EIO', reply.message));
  };

  const relayed = (name: string): boolean =>
    allow.includes(name) && lookupCall(name)?.origin === 'E';

  return {
    call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> {
      if (!relayed(name)) return view.call(name, args);
      const id = nextId;
      nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
      seq += 1;
      return new Promise<RetOf<C>>((resolve, reject) => {
        const cancel = setTimer(() => {
          if (!pending.delete(id)) return;
          reject(new SysError('ETIMEDOUT', `${name}: the app process did not answer`));
        }, timeoutMs);
        pending.set(id, { resolve: (v) => resolve(v as RetOf<C>), reject, cancel });
        const input: RelayInput = { t: 'input', seq, ev: { kind: 'sys', id, call: name, args } };
        try {
          display.postMessage(input, transferables(args));
        } catch (e) {
          pending.delete(id);
          cancel();
          reject(new SysError('EIO', describeFailure(e)));
        }
      });
    },
    dispose(reason = 'display channel closed') {
      for (const p of pending.values()) {
        p.cancel();
        p.reject(new SysError('ESRCH', reason));
      }
      pending.clear();
      display.onmessage = null;
    },
  };
}
