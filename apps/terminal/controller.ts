/**
 * The Terminal window's model, without the DOM (UI guide §3.6.3; shell-and-terminal.md §3.2–§3.3):
 * its tabs, one session each; the byte stream between each tab's xterm and its TTY through the
 * view-side pumps of ./tty.ts (input split into `tty.input` chunks and retried on EAGAIN the next
 * frame, output written one batch at a time and acknowledged once xterm has parsed it, SHL-03);
 * the grid size (`tty.winsize`, SIGWINCH); the window title that follows the shell's directory
 * (`demo@plotinium: ~/notes`); background-tab activity; and closing the window when the last
 * shell exits. The Solid view (./view.tsx) only renders this state.
 */
import type { GridSize, OpenOptions, SessionBackend, SessionPort } from './session.ts';
import type { FrameClock } from './tty.ts';
import { InputPump, OutputPump } from './tty.ts';

export type TabActivity = 'none' | 'output' | 'bell';

export interface TerminalTabView {
  readonly id: string;
  /** `sh 2 — ~/notes`: the tab's number keeps tabs in the same directory apart (UI-122). */
  readonly label: string;
  /** The tab's tooltip: the shell's full working directory. */
  readonly title: string;
  readonly activity: TabActivity;
  /** The text a restored tab shows before its new shell starts (UI-127). */
  readonly initialText?: string;
}

/**
 * What a Terminal window keeps when the host saves the session (shell-and-terminal.md §3.3: the
 * `term` snapshot; UI-127): per tab, the shell's directory and up to the last
 * SNAPSHOT_MAX_LINES lines of plain text (at most SNAPSHOT_MAX_BYTES), and which tab was
 * selected. Styles are not kept.
 */
export interface TerminalSnapshot {
  readonly v: 1;
  readonly tabs: readonly { readonly cwd: string; readonly text: string }[];
  readonly selected: number;
}

export const SNAPSHOT_MAX_LINES = 2_000;
export const SNAPSHOT_MAX_BYTES = 512 * 1024;

const utf8 = new TextEncoder();

/**
 * Plain text for a snapshot: trailing blank lines dropped, then the last `maxLines` lines, then
 * whole lines from the top until the UTF-8 size fits `maxBytes`. Lines are joined with `\n`.
 */
export function snapshotText(
  lines: readonly string[],
  maxLines = SNAPSHOT_MAX_LINES,
  maxBytes = SNAPSHOT_MAX_BYTES,
): string {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  const kept = lines.slice(Math.max(0, end - maxLines), end);
  let bytes = kept.reduce((n, line) => n + utf8.encode(line).length + 1, 0);
  let start = 0;
  while (start < kept.length && bytes > maxBytes) {
    bytes -= utf8.encode(kept[start] ?? '').length + 1;
    start += 1;
  }
  return kept.slice(start).join('\n');
}

/**
 * A snapshot a host handed back, checked: anything that is not a `v: 1` snapshot is null, and the
 * tabs, texts and directory are capped as when it was taken, so a damaged or forged record
 * cannot make the view write more than one snapshot's worth.
 */
export function parseSnapshot(value: unknown, maxTabs = 16): TerminalSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as { v?: unknown; tabs?: unknown; selected?: unknown };
  if (r.v !== 1 || !Array.isArray(r.tabs)) return null;
  const tabs: { cwd: string; text: string }[] = [];
  for (const t of r.tabs.slice(0, maxTabs) as unknown[]) {
    if (typeof t !== 'object' || t === null) return null;
    const { cwd, text } = t as { cwd?: unknown; text?: unknown };
    if (typeof cwd !== 'string' || typeof text !== 'string') return null;
    tabs.push({
      cwd: cwd.startsWith('/') && cwd.length <= 4096 ? cwd : '',
      text: snapshotText(text.split('\n')),
    });
  }
  if (tabs.length === 0) return null;
  const selected =
    typeof r.selected === 'number' && Number.isInteger(r.selected) ? r.selected : tabs.length - 1;
  return { v: 1, tabs, selected: Math.min(Math.max(0, selected), tabs.length - 1) };
}

export interface TerminalViewState {
  readonly tabs: readonly TerminalTabView[];
  readonly selected: string;
  /** The window title, `demo@plotinium: ~/notes`. */
  readonly title: string;
  /** The selected shell's directory, for the status strip. */
  readonly cwd: string;
  readonly canAddTab: boolean;
  /** Why the last session could not start, shown in place of the terminal. */
  readonly error: string | null;
}

/** xterm as the controller writes to it (a subset of ui's TerminalHandle). */
export interface TermSurface {
  write(data: Uint8Array, parsed: () => void): void;
  size(): GridSize;
  /** Clears the scrollback (menu "Clear Scrollback"). */
  clear?(): void;
  focus?(): void;
  /** The selected text, '' when nothing is selected (Edit > Copy). */
  selection?(): string;
  /** Sends text to the TTY as a paste (Edit > Paste). */
  paste?(text: string): void;
  selectAll?(): void;
  /** The main screen's plain text, trimmed as `snapshotText` does (UI-127). */
  snapshot?(): string;
}

/** `newTab` options: where the shell starts, and the text a restored tab shows first. */
export interface NewTabOptions extends OpenOptions {
  readonly initialText?: string;
}

export interface ControllerOptions {
  readonly backend: SessionBackend;
  readonly onChange: (state: TerminalViewState) => void;
  /** The last session ended: the window should close. */
  readonly onEmpty?: () => void;
  readonly setTitle?: (title: string) => void;
  /** `requestAnimationFrame` in the view; a manual clock in tests. */
  readonly frame?: FrameClock;
  readonly hostname?: string;
  /** ui's TERMINAL_TAB_LIMIT. */
  readonly maxTabs?: number;
  readonly initialSize?: GridSize;
}

interface Tab {
  readonly id: string;
  readonly n: number;
  port: SessionPort | null;
  readonly input: InputPump;
  surface: TermSurface | null;
  out: OutputPump | null;
  readonly acks: (() => void)[];
  readonly early: { data: Uint8Array; ack: () => void }[];
  cwd: string;
  display: string;
  activity: TabActivity;
  size: GridSize;
  closing: boolean;
  readonly initialText: string | undefined;
}

const BEL = 0x07;

function rafClock(): FrameClock {
  return {
    next: (callback) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
      else setTimeout(callback, 16);
    },
  };
}

export class TerminalController {
  private readonly opts: ControllerOptions;
  private readonly frame: FrameClock;
  private readonly list: Tab[] = [];
  private selectedId = '';
  private counter = 0;
  private error: string | null = null;
  private disposed = false;
  private lastTitle = '';

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.frame = opts.frame ?? rafClock();
  }

  get backend(): SessionBackend {
    return this.opts.backend;
  }

  state(): TerminalViewState {
    const sel = this.find(this.selectedId);
    const max = this.opts.maxTabs ?? 16;
    return {
      tabs: this.list.map((t) => ({
        id: t.id,
        label: this.label(t),
        title: t.cwd === '' ? t.display : t.cwd,
        activity: t.activity,
        ...(t.initialText === undefined ? {} : { initialText: t.initialText }),
      })),
      selected: this.selectedId,
      title: this.title(sel),
      cwd: sel?.cwd ?? '',
      canAddTab: this.opts.backend.tabs && this.list.length < max,
      error: this.error,
    };
  }

  /**
   * Opens a new tab with its own TTY and shell: a login shell in the home directory, or, with
   * `opts.cwd` (Files' Open in Terminal), a shell started in that directory. `opts.initialText`
   * is written into the tab before the shell's first output (a restored tab, UI-127).
   */
  async newTab(opts: NewTabOptions = {}): Promise<string | null> {
    if (this.disposed) return null;
    const first = this.list.length === 0;
    if (!first && !this.state().canAddTab) return null;
    this.counter += 1;
    const n = this.counter;
    const id = `tab-${String(n)}`;
    const size = this.list.at(-1)?.size ?? this.opts.initialSize ?? { cols: 80, rows: 24 };
    const tab: Tab = {
      id,
      n,
      port: null,
      input: new InputPump(
        {
          send: (chunk) => (tab.port === null ? Promise.resolve('again') : tab.port.send(chunk)),
        },
        this.frame,
      ),
      surface: null,
      out: null,
      acks: [],
      early: [],
      cwd: '',
      display: '~',
      activity: 'none',
      size,
      closing: false,
      initialText:
        opts.initialText === undefined || opts.initialText === ''
          ? undefined
          : `${opts.initialText.replace(/\r?\n/gu, '\r\n')}\r\n`,
    };
    this.list.push(tab);
    this.selectedId = id;
    this.emit();
    let port: SessionPort;
    try {
      port = await this.opts.backend.open(size, opts.cwd === undefined ? {} : { cwd: opts.cwd });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.remove(tab);
      return null;
    }
    if (this.disposed || !this.list.includes(tab)) {
      port.close();
      return null;
    }
    this.error = null;
    tab.port = port;
    port.onOutput((data, ack) => this.output(tab, data, ack));
    port.onExit(() => this.remove(tab));
    port.onCwd((cwd, display) => {
      tab.cwd = cwd;
      tab.display = display;
      this.emit();
    });
    if (tab.surface !== null) port.resize(tab.surface.size());
    else port.resize(tab.size);
    this.emit();
    return id;
  }

  /** The selected tab's id ('' when none). */
  get selected(): string {
    return this.selectedId;
  }

  /** Next (+1) or previous (-1) tab, wrapping (View menu, Alt+Shift+] / Alt+Shift+[; UI-022). */
  step(delta: number): void {
    const n = this.list.length;
    if (n < 2) return;
    const i = this.list.findIndex((t) => t.id === this.selectedId);
    const next = this.list[(((i + delta) % n) + n) % n];
    if (next === undefined) return;
    this.select(next.id);
    next.surface?.focus?.();
  }

  /** Clears the tab's scrollback; the shell's screen state is untouched (it redraws on Enter). */
  clear(id: string): void {
    this.find(id)?.surface?.clear?.();
  }

  /** Puts the keyboard focus into the tab's terminal (after a menu command, WCAG 2.4.3). */
  focus(id: string): void {
    this.find(id)?.surface?.focus?.();
  }

  /** The tab's selected text, or '' (Edit > Copy). */
  selection(id: string): string {
    return this.find(id)?.surface?.selection?.() ?? '';
  }

  /** Types `text` into the tab as one paste (Edit > Paste). */
  paste(id: string, text: string): void {
    if (text === '') return;
    this.find(id)?.surface?.paste?.(text);
  }

  selectAll(id: string): void {
    this.find(id)?.surface?.selectAll?.();
  }

  select(id: string): void {
    const tab = this.find(id);
    if (tab === undefined) return;
    this.selectedId = id;
    tab.activity = 'none';
    this.emit();
  }

  /** Shell > Close Tab (Alt+Shift+W), the tab's close button or the chord: hang up its session. */
  closeTab(id: string): void {
    const tab = this.find(id);
    if (tab === undefined || tab.closing) return;
    tab.closing = true;
    if (tab.port === null) this.remove(tab);
    else tab.port.close();
  }

  /** The tab's xterm is mounted: output starts flowing into it. */
  ready(id: string, surface: TermSurface): void {
    const tab = this.find(id);
    if (tab === undefined) return;
    tab.surface = surface;
    tab.out = new OutputPump(surface, () => tab.acks.shift()?.());
    for (const b of tab.early.splice(0)) this.output(tab, b.data, b.ack);
    this.resize(id, surface.size());
  }

  /** Keystrokes and pastes from xterm (SHL-01): Ctrl-C and Ctrl-Z are bytes for the TTY. */
  data(id: string, text: string): void {
    this.find(id)?.input.push(text);
  }

  /** The grid changed size: `tty.winsize`, SIGWINCH to the foreground job. */
  resize(id: string, size: GridSize): void {
    const tab = this.find(id);
    if (tab === undefined || size.cols < 2 || size.rows < 1) return;
    tab.size = size;
    tab.port?.resize(size);
  }

  /**
   * The window's snapshot for the host to keep (UI-127): each tab's directory and main-screen
   * text, and the selected tab. A tab whose xterm is not mounted yet keeps the text it was
   * restored with.
   */
  snapshot(): TerminalSnapshot {
    const selected = this.list.findIndex((t) => t.id === this.selectedId);
    return {
      v: 1,
      tabs: this.list.map((t) => ({
        cwd: t.cwd,
        text: t.surface?.snapshot?.() ?? snapshotText((t.initialText ?? '').split('\r\n')),
      })),
      selected: Math.max(0, selected),
    };
  }

  /**
   * Reopens a saved window (UI-127): one tab per saved tab, each showing its text and starting
   * its shell in its directory (a directory that is gone falls back to home), then the saved
   * selection. Resolves when every tab has been asked for.
   */
  async restore(snapshot: TerminalSnapshot): Promise<void> {
    const ids: (string | null)[] = [];
    for (const t of snapshot.tabs) {
      if (this.disposed) return;
      ids.push(await this.newTab({ ...(t.cwd === '' ? {} : { cwd: t.cwd }), initialText: t.text }));
    }
    const id = ids[snapshot.selected];
    if (id !== null && id !== undefined) this.select(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tab of this.list) tab.port?.close();
    this.opts.backend.dispose();
  }

  // -------------------------------------------------------------------------------------------

  private find(id: string): Tab | undefined {
    return this.list.find((t) => t.id === id);
  }

  private label(t: Tab): string {
    return `sh ${String(t.n)} — ${t.display}`;
  }

  private title(t: Tab | undefined): string {
    const user = this.opts.backend.user();
    const host = this.opts.hostname ?? 'plotinium';
    return t === undefined ? 'Terminal' : `${user}@${host}: ${t.display}`;
  }

  private output(tab: Tab, data: Uint8Array, ack: () => void): void {
    if (tab.out === null) {
      tab.early.push({ data, ack });
      return;
    }
    if (tab.id !== this.selectedId && tab.activity !== 'bell') {
      tab.activity = data.includes(BEL) ? 'bell' : 'output';
      this.emit();
    }
    tab.acks.push(ack);
    tab.out.receive(data);
  }

  private remove(tab: Tab): void {
    const i = this.list.indexOf(tab);
    if (i < 0) return;
    this.list.splice(i, 1);
    for (const ack of tab.acks.splice(0)) ack();
    if (this.selectedId === tab.id) {
      const next = this.list[Math.min(i, this.list.length - 1)];
      this.selectedId = next?.id ?? '';
      if (next !== undefined) next.activity = 'none';
    }
    this.emit();
    if (this.list.length === 0 && !this.disposed && this.error === null) this.opts.onEmpty?.();
  }

  private emit(): void {
    if (this.disposed) return;
    const state = this.state();
    if (state.title !== this.lastTitle) {
      this.lastTitle = state.title;
      this.opts.setTitle?.(state.title);
    }
    this.opts.onChange(state);
  }
}
