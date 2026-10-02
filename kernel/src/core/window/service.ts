/**
 * The kernel's window table and its end of the compositor port (window-manager.md §3.3, §3.4,
 * §3.12–§3.15, §3.17; architecture.md §4.1, §4.3).
 *
 * - `create` binds a new `wid` to the calling pid (`pcb.windows`), creates the two channels of the
 *   window: the VIEW PORT (kernel ↔ view; a restricted syscall subset, identity from the port, C3)
 *   and the DISPLAY CHANNEL (process ↔ view; never syscalls), and asks the compositor for a frame.
 *   The compositor alone decides geometry (WM-01); the kernel keeps the final values it reports.
 * - Killing a process closes its windows (kill-path step 6); a close request from the compositor
 *   becomes SIGTERM through the kill path (`hooks.signal`), never a direct close.
 * - Bus events the desktop shows (net.state, svc.*, mem.pressure, update.available, ai.*) are
 *   forwarded as `{t:'events', batch}`, at most one batch per frame (boundary B2).
 * - Messages for the compositor are queued until the router attaches the port (the `wm` service).
 */
import type { KEvent } from '@plotinium/protocol';
import { OpenAddressingTable } from '@plotinium/dsa/hashtable';
import * as v from 'valibot';

import type { FrameScheduler } from '../events/batch.ts';
import type { EventBus, Subscription } from '../events/bus.ts';
import { KernelError } from '../errors.ts';
import type { ViewPortRec } from '../ipc/ports.ts';
import { viewPort } from '../ipc/ports.ts';
import type { PCB } from '../proc/pcb.ts';
import type {
  ChannelFactory,
  CompositorToKernel,
  DeskNotification,
  DeskUser,
  KernelToCompositor,
  LayoutWindow,
  PortLike,
  Rect,
  SessionLayout,
  Snap,
  WinState,
} from './types.ts';
import { ACTIVATION_WINDOW_MS, CompositorToKernelSchema, MAX_WINDOWS } from './types.ts';

/** Topics the desktop shows (window-manager.md §4.3 `events`). */
/** Longest close-guard reason (contract C4). */
export const CLOSE_GUARD_REASON_MAX = 256;

export const DESKTOP_TOPICS = [
  'net.*',
  'svc.*',
  'mem.pressure',
  'update.available',
  'ai.index.progress',
  'ai.model',
  'lock.lost',
  'proc.exit',
] as const;

/** Messages kept for the compositor before it attaches (boot order puts `wm` early). */
const QUEUE_MAX = 512;
/** Title rule of the view-port allow-list (§4.5): at most 200 characters, no control characters. */
const TITLE_MAX = 200;
/** How long a `launch` request marks its app's first window as user-activated. */
const LAUNCH_ACTIVATION_MS = 10_000;

export interface WindowHooks {
  /** The kill path: SIGTERM on a close request (then SIGKILL after 3 s), SIGKILL on Force quit. */
  signal?(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void;
  /** The launcher, dock or Alt+T asked for an app (window-manager.md §4.3 `launch`). */
  launch?(app: string, argv: readonly string[], restore?: LayoutWindow): void;
  power?(action: 'lock' | 'logout' | 'reboot' | 'shutdown'): void;
  /** Focus moved (the scheduler boosts and mm pins the focused process). */
  focusChanged?(pid: number | null): void;
  /** Minimised windows' processes are the first eviction candidates (WM-05). */
  minimised?(pid: number, on: boolean): void;
  /** First input per 100 ms per window (activation, pre-empt flag). */
  input?(pid: number): void;
  /** Geometry, open, close, focus or state changed: the session layout should be saved soon. */
  layoutChanged?(): void;
  /** The compositor sent its own debounced layout (§3.15). */
  layout?(layout: SessionLayout): void;
  /** A notification's action button or dismissal. */
  notifyAction?(id: string, action: string): void;
  /** A window was closed by its owner (for example the login view). */
  closeRequestedInternal?(wid: number, pid: number): boolean;
  /** The tray's Retry on a degraded service. */
  retryService?(name: string): void;
  /** The connectivity popover's Retry now. */
  retryNetwork?(): void;
}

export interface WindowsDeps {
  readonly bus: EventBus;
  readonly now: () => number;
  readonly epochMs: () => number;
  readonly log: (level: 'info' | 'warn', msg: string, pid?: number) => void;
  /** Routes a view-port message into the dispatcher (`kernel.viewMessage`). */
  readonly viewMessage: (port: ViewPortRec, msg: unknown) => void;
  readonly channel: ChannelFactory;
  readonly frame: FrameScheduler;
  readonly hooks?: WindowHooks;
  /** Session restore: the saved window this app's next window should reopen as (WM-06). */
  readonly restoreFor?: (app: string, restoreKey: string | undefined) => LayoutWindow | undefined;
}

export interface WinRec {
  readonly wid: number;
  readonly pid: number;
  readonly app: string;
  title: string;
  readonly icon: string;
  readonly restoreKey: string | null;
  rect: Rect | null;
  restoreRect: Rect | null;
  state: WinState;
  prevState: 'normal' | 'maximised' | 'fullscreen';
  snap: Snap;
  z: number;
  focused: boolean;
  readonly view: ViewPortRec;
  readonly kernelEnd: MessagePort;
  readonly createdAt: number;
  /** Internal windows (the login view) belong to a kernel service, not a user process. */
  readonly internal: boolean;
}

export interface CreateRequest {
  readonly title: string;
  readonly icon?: string;
  readonly rect?: Rect;
  readonly minSize?: { readonly w: number; readonly h: number };
  readonly restoreKey?: string;
}

export interface CreatedWindow {
  readonly wid: number;
  readonly rect: Rect;
  /** The process's end of the display channel. */
  readonly display: MessagePort;
}

const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The app id of a process: its manifest's basename, else its name, as an AppId. */
export function appIdOf(pcb: Pick<PCB, 'manifestPath' | 'name'>): string {
  const base =
    pcb.manifestPath === null
      ? pcb.name
      : (pcb.manifestPath.split('/').pop() ?? pcb.name).replace(/\.json$/, '');
  const id = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32);
  return APP_ID.test(id) ? id : 'app';
}

/** Strip control characters and bound the length (the §4.5 title rule). */
export function cleanTitle(title: string): string {
  let out = '';
  for (const ch of title) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    out += ch;
  }
  return out.slice(0, TITLE_MAX);
}

/** MessagePorts in a reply value (the executor host must list them in the transfer list). */
export function transferablesOf(value: unknown): Transferable[] {
  if (value === null || typeof value !== 'object') return [];
  const out: Transferable[] = [];
  for (const x of Object.values(value)) {
    if (typeof MessagePort !== 'undefined' && x instanceof MessagePort) out.push(x);
  }
  return out;
}

const DEFAULT_RECT: Rect = { x: 0, y: 0, w: 800, h: 560 };

export class Windows {
  private readonly deps: WindowsDeps;
  private readonly table = new OpenAddressingTable<WinRec>();
  private port: PortLike | null = null;
  private queue: { msg: KernelToCompositor; transfer: Transferable[] }[] = [];
  private seq = 0;
  private nextWid = 1;
  private nid = 0;
  private readonly lastInput = new Map<number, number>();
  private readonly launched = new Map<string, number>();
  private readonly subs: Subscription[] = [];
  private userSub: Subscription | null = null;
  private flushArmed = false;
  private user: DeskUser | null = null;
  private osSessionId = '';
  private readonly notifyRate = new Map<number, number[]>();
  /** Saved windows the shell asked to reopen (`launch {restore}`), taken by the app's next window. */
  private readonly restoreQueue: LayoutWindow[] = [];

  constructor(deps: WindowsDeps) {
    this.deps = deps;
    this.subs.push(
      deps.bus.subscribe(DESKTOP_TOPICS, {
        cred: { uid: 0, gid: 0, groups: [0] },
        onReady: () => {
          this.armEvents();
        },
      }),
    );
  }

  // -- the compositor port ------------------------------------------------------------------

  get attached(): boolean {
    return this.port !== null;
  }

  /** Bind the compositor port (the router's `compositor.attach`); flush what was queued. */
  attach(port: PortLike): void {
    this.port = port;
    port.onmessage = (ev: MessageEvent) => {
      this.onCompositor(ev.data);
    };
    port.start?.();
    const queued = this.queue;
    this.queue = [];
    for (const q of queued) this.post(q.msg, q.transfer);
    this.post({ t: 'session', user: this.user, osSessionId: this.osSessionId });
  }

  private post(msg: KernelToCompositor, transfer: Transferable[] = []): void {
    if (this.port === null) {
      if (this.queue.length >= QUEUE_MAX) this.queue.shift();
      this.queue.push({ msg, transfer });
      return;
    }
    try {
      this.port.postMessage(msg, transfer);
    } catch (e) {
      this.deps.log(
        'warn',
        `compositor post failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private armEvents(): void {
    if (this.flushArmed) return;
    this.flushArmed = true;
    this.deps.frame(() => {
      this.flushArmed = false;
      const batch: KEvent[] = [];
      for (const sub of [...this.subs, ...(this.userSub ? [this.userSub] : [])]) {
        batch.push(...sub.take().events);
      }
      if (batch.length > 0) this.post({ t: 'events', batch });
    });
  }

  private onCompositor(raw: unknown): void {
    const parsed = v.safeParse(CompositorToKernelSchema, raw);
    if (!parsed.success) return;
    this.handle(parsed.output);
  }

  private handle(m: CompositorToKernel): void {
    const hooks = this.deps.hooks;
    switch (m.t) {
      case 'focused': {
        for (const w of this.all()) w.focused = w.wid === m.wid;
        const w = m.wid === null ? undefined : this.table.get(m.wid);
        hooks?.focusChanged?.(w?.pid ?? null);
        if (w) this.publishWm('wm.focus', w);
        hooks?.layoutChanged?.();
        return;
      }
      case 'minimised':
      case 'restored': {
        const w = this.table.get(m.wid);
        if (!w) return;
        if (m.t === 'minimised') {
          if (w.state !== 'minimised') w.prevState = w.state === 'normal' ? 'normal' : w.state;
          w.state = 'minimised';
        } else if (w.state === 'minimised') w.state = w.prevState;
        hooks?.minimised?.(w.pid, m.t === 'minimised');
        this.publishWm(m.t === 'minimised' ? 'wm.minimise' : 'wm.restore', w);
        hooks?.layoutChanged?.();
        return;
      }
      case 'closeRequested': {
        const w = this.table.get(m.wid);
        if (!w) return;
        if (w.internal) {
          if (hooks?.closeRequestedInternal?.(w.wid, w.pid) !== true) return;
          this.close(w.wid, 'window-closed');
          return;
        }
        if (hooks?.signal) hooks.signal(w.pid, 'SIGTERM');
        else {
          // No kill path linked in this host: close the frame and tell the view (the process
          // keeps running headless; `kill` still works).
          this.deps.log(
            'warn',
            `close ${String(w.wid)}: no kill path linked, window closed`,
            w.pid,
          );
          this.close(w.wid, 'window-closed');
        }
        return;
      }
      case 'geometry': {
        const w = this.table.get(m.wid);
        if (!w) return;
        // The compositor's own restore rectangle and snap side win when it sends them (UI-035);
        // an older compositor sends neither, and the mirror infers the restore rectangle.
        if (m.restoreRect !== undefined) w.restoreRect = m.restoreRect;
        else if (m.state === 'normal') w.restoreRect = null;
        else if (w.state === 'normal' && w.rect !== null) w.restoreRect = w.rect;
        if (m.snap !== undefined) w.snap = m.snap;
        w.rect = m.rect;
        w.state = m.state;
        if (m.state !== 'minimised') w.prevState = m.state === 'normal' ? 'normal' : m.state;
        w.z = m.z;
        hooks?.layoutChanged?.();
        return;
      }
      case 'input': {
        const w = this.table.get(m.wid);
        if (!w) return;
        this.lastInput.set(w.pid, this.deps.now());
        hooks?.input?.(w.pid);
        return;
      }
      case 'dehydrated':
        return;
      case 'kill': {
        const w = this.table.get(m.wid);
        if (w && !w.internal) hooks?.signal?.(w.pid, 'SIGKILL');
        return;
      }
      case 'launch':
        this.launched.set(m.app, this.deps.now());
        if (m.restore !== undefined) this.restoreQueue.push(m.restore);
        if (hooks?.launch) hooks.launch(m.app, m.argv ?? [], m.restore);
        else this.deps.log('warn', `launch ${m.app}: no spawner linked in this host`);
        return;
      case 'power':
        if (hooks?.power) hooks.power(m.action);
        else this.deps.log('warn', `power ${m.action}: not linked in this host`);
        return;
      case 'layout':
        hooks?.layout?.(m.layout);
        return;
      case 'viewCrashed':
        this.deps.log('warn', `view of window ${String(m.wid)} crashed: ${m.message}`);
        return;
      case 'ready':
        return;
      case 'notify.action':
        hooks?.notifyAction?.(m.id, m.actionId);
        return;
      case 'svc.retry':
        hooks?.retryService?.(m.name);
        return;
      case 'net.retry':
        hooks?.retryNetwork?.();
        return;
    }
  }

  private publishWm(
    topic: 'wm.create' | 'wm.focus' | 'wm.minimise' | 'wm.restore' | 'wm.close',
    w: WinRec,
  ): void {
    this.deps.bus.publish(topic, { wid: w.wid, pid: w.pid, app: w.app });
  }

  // -- the table ----------------------------------------------------------------------------

  get count(): number {
    return this.table.size;
  }

  get(wid: number): WinRec | undefined {
    return this.table.get(wid);
  }

  all(): WinRec[] {
    const out: WinRec[] = [];
    this.table.forEach((w) => out.push(w));
    return out.sort((a, b) => a.wid - b.wid);
  }

  ofPid(pid: number): WinRec[] {
    return this.all().filter((w) => w.pid === pid);
  }

  /** Whether `pid` (or its parent) saw user input recently, or its app was just launched. */
  private activated(pcb: PCB, app: string): boolean {
    const now = this.deps.now();
    const recent = (pid: number): boolean =>
      now - (this.lastInput.get(pid) ?? -Infinity) <= ACTIVATION_WINDOW_MS;
    const launch = this.launched.get(app);
    if (launch !== undefined && now - launch <= LAUNCH_ACTIVATION_MS) {
      this.launched.delete(app);
      return true;
    }
    return recent(pcb.pid) || recent(pcb.ppid);
  }

  /** `window.create` for `pcb` (or an internal window of a kernel service). */
  create(
    pcb: PCB,
    req: CreateRequest,
    opts: {
      readonly app?: string;
      readonly internal?: boolean;
      readonly activation?: boolean;
    } = {},
  ): CreatedWindow {
    if (this.table.size >= MAX_WINDOWS)
      throw new KernelError('EAGAIN', { reason: 'window-limit' }, 'too many windows');
    const app = opts.app ?? appIdOf(pcb);
    const wid = this.nextWid++;
    const view = this.deps.channel();
    const display = this.deps.channel();
    const restore =
      opts.internal === true
        ? undefined
        : (this.takeQueuedRestore(app) ?? this.deps.restoreFor?.(app, req.restoreKey));
    const rect = restore?.rect ?? req.rect;
    const activation =
      opts.activation ?? (restore !== undefined ? restore.focused : this.activated(pcb, app));
    const kernelEnd = view.port1;
    const rec: WinRec = {
      wid,
      pid: pcb.pid,
      app,
      title: cleanTitle(req.title),
      icon: req.icon ?? `app-${app}`,
      restoreKey: req.restoreKey ?? null,
      rect: rect ?? null,
      restoreRect: restore?.restoreRect ?? null,
      state: restore?.state ?? 'normal',
      prevState: restore?.prevState ?? 'normal',
      snap: restore?.snap ?? null,
      z: restore?.z ?? 0,
      focused: false,
      kernelEnd,
      createdAt: this.deps.now(),
      internal: opts.internal === true,
      view: viewPort(
        pcb.pid,
        wid,
        (res) => {
          kernelEnd.postMessage({ t: 'res', res });
        },
        (reason) => {
          kernelEnd.postMessage({ t: 'close', reason });
          kernelEnd.close();
        },
      ),
    };
    kernelEnd.onmessage = (ev: MessageEvent) => {
      this.deps.viewMessage(rec.view, ev.data);
    };
    this.table.set(wid, rec);
    pcb.windows.add(wid);
    const minSize = req.minSize;
    this.post(
      {
        t: 'create',
        wid,
        pid: pcb.pid,
        app,
        title: rec.title,
        icon: rec.icon,
        ...(rect === undefined ? {} : { rect }),
        ...(restore === undefined ? {} : { restore }),
        seq: ++this.seq,
        activation,
        ...(minSize === undefined ? {} : { limits: { minW: minSize.w, minH: minSize.h } }),
        ports: { view: view.port2, display: display.port2 },
      },
      [view.port2, display.port2],
    );
    this.publishWm('wm.create', rec);
    this.deps.hooks?.layoutChanged?.();
    return { wid, rect: rect ?? DEFAULT_RECT, display: display.port1 };
  }

  private takeQueuedRestore(app: string): LayoutWindow | undefined {
    const i = this.restoreQueue.findIndex((w) => w.app === app);
    if (i < 0) return undefined;
    return this.restoreQueue.splice(i, 1)[0];
  }

  /** Close one window: compositor `close`, view port closed, table and PCB updated. */
  close(wid: number, reason: 'window-closed' | 'process-exit', pcb?: PCB): boolean {
    const w = this.table.get(wid);
    if (!w) return false;
    this.table.delete(wid);
    pcb?.windows.delete(wid);
    this.post({ t: 'close', wid, seq: ++this.seq });
    w.view.close(reason);
    this.publishWm('wm.close', w);
    this.deps.hooks?.layoutChanged?.();
    return true;
  }

  /** Kill-path step 6: every window of a terminated process. */
  closeAllOf(pcb: PCB): number {
    let n = 0;
    for (const w of this.ofPid(pcb.pid)) if (this.close(w.wid, 'process-exit', pcb)) n++;
    pcb.windows.clear();
    this.lastInput.delete(pcb.pid);
    this.notifyRate.delete(pcb.pid);
    return n;
  }

  /** `window.focus`: honoured only with recent user activation, else attention (WMD-09). */
  focus(pcb: PCB, wid: number): boolean {
    const w = this.table.get(wid);
    if (!w) throw new KernelError('EINVAL', undefined, 'no such window');
    const now = this.deps.now();
    const recent = now - (this.lastInput.get(pcb.pid) ?? -Infinity) <= ACTIVATION_WINDOW_MS;
    if (recent) {
      this.post({ t: 'focus', wid, seq: ++this.seq });
      return true;
    }
    this.post({ t: 'attention', wid, level: 'info' });
    return false;
  }

  /** Focus a window on the kernel's own behalf (the login view, session restore). */
  focusInternal(wid: number): void {
    if (this.table.has(wid)) this.post({ t: 'focus', wid, seq: ++this.seq });
  }

  setTitle(wid: number, title: string): void {
    const w = this.table.get(wid);
    if (!w) throw new KernelError('EINVAL', undefined, 'no such window');
    w.title = cleanTitle(title);
    this.post({ t: 'setTitle', wid, title: w.title });
    this.deps.hooks?.layoutChanged?.();
  }

  /**
   * `window.setCloseGuard` (contract C4, WMD-12; UI-036): the shell asks "Discard unsaved changes?"
   * with `reason` before closing `wid`; null clears it. EINVAL for an unknown window (ownership is
   * the syscall's check). The reason is at most 256 characters.
   */
  setCloseGuard(wid: number, reason: string | null): void {
    if (!this.table.has(wid)) throw new KernelError('EINVAL', undefined, 'no such window');
    if (reason !== null && reason.length > CLOSE_GUARD_REASON_MAX)
      throw new KernelError('EINVAL', { field: 'reason' }, 'reason is too long');
    this.post({ t: 'closeGuard', wid, reason });
  }

  attention(wid: number, level: 'info' | 'urgent'): void {
    if (!this.table.has(wid)) throw new KernelError('EINVAL', undefined, 'no such window');
    this.post({ t: 'attention', wid, level });
  }

  restoring(pid: number, doneBytes: number, totalBytes: number): void {
    for (const w of this.ofPid(pid))
      this.post({ t: 'restoring', wid: w.wid, doneBytes, totalBytes });
  }

  // -- notifications (§3.17) ----------------------------------------------------------------

  /** A kernel-originated notification (sync rejections, lock lost, degraded services, updates). */
  notify(n: Omit<DeskNotification, 'id' | 'at'>): string {
    const id = `k${String(++this.nid)}`;
    this.post({ t: 'notify', n: { ...n, id, at: Math.floor(this.deps.epochMs()) } });
    return id;
  }

  /** `notify.post` from a process: rate-limited to 5 per 10 s per process (EAGAIN `rate`). */
  postNotification(
    pcb: PCB,
    a: { title: string; body: string; level: 'info' | 'warn' | 'error'; wid?: number | undefined },
  ): { nid: number } {
    const now = this.deps.now();
    const recent = (this.notifyRate.get(pcb.pid) ?? []).filter((t) => now - t < 10_000);
    if (recent.length >= 5)
      throw new KernelError('EAGAIN', { reason: 'rate' }, 'too many notifications');
    recent.push(now);
    this.notifyRate.set(pcb.pid, recent);
    const nid = ++this.nid;
    const app = a.wid === undefined ? appIdOf(pcb) : (this.table.get(a.wid)?.app ?? appIdOf(pcb));
    const level = a.level === 'warn' ? 'warning' : a.level;
    this.post({
      t: 'notify',
      n: {
        id: `p${String(nid)}`,
        level,
        title: a.title,
        ...(a.body === '' ? {} : { body: a.body }),
        source: { app, pid: pcb.pid },
        at: Math.floor(this.deps.epochMs()),
      },
    });
    this.deps.bus.publish('notify', {
      nid,
      title: a.title,
      body: a.body,
      level: a.level,
      pid: pcb.pid,
    });
    return { nid };
  }

  // -- the console user ---------------------------------------------------------------------

  setUser(
    user: DeskUser | null,
    osSessionId: string,
    cred?: { uid: number; gid: number; groups: readonly number[] },
  ): void {
    this.user = user;
    this.osSessionId = osSessionId;
    if (this.userSub) this.deps.bus.unsubscribe(this.userSub);
    this.userSub = null;
    if (cred !== undefined) {
      this.userSub = this.deps.bus.subscribe(['ai.predict'], {
        cred,
        onReady: () => {
          this.armEvents();
        },
      });
    }
    this.post({ t: 'session', user, osSessionId });
  }

  get consoleUser(): DeskUser | null {
    return this.user;
  }

  /**
   * The windows as a layout, bottom to top (for the session service). A window whose geometry the
   * compositor has not reported yet is kept with the default rectangle, never dropped (UI-035).
   */
  layoutWindows(argvOf: (pid: number) => readonly string[]): LayoutWindow[] {
    return this.all()
      .filter((w) => !w.internal)
      .sort((a, b) => a.z - b.z || a.wid - b.wid)
      .map((w, i) => ({
        app: w.app,
        argv: [...argvOf(w.pid)],
        title: w.title,
        rect: w.rect ?? DEFAULT_RECT,
        restoreRect: w.restoreRect,
        state: w.state,
        prevState: w.prevState,
        snap: w.snap,
        z: i + 1,
        focused: w.focused,
        proc: null,
      }));
  }

  dispose(): void {
    for (const s of this.subs) this.deps.bus.unsubscribe(s);
    this.subs.length = 0;
    if (this.userSub) this.deps.bus.unsubscribe(this.userSub);
    this.userSub = null;
    for (const w of this.all()) w.view.close('window-closed');
    this.table.clear();
  }
}
