import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  splitProps,
  type JSX,
} from 'solid-js';

import { cx } from '../../primitives/internal/cx.ts';
import { DocumentTabs, type DocumentTab } from '../editor/DocumentTabs.tsx';
import { isPasteKey, terminalKeyAction } from './keys.ts';
import styles from './Terminal.module.css';
import {
  TerminalHost,
  type TerminalFactory,
  type TerminalHandle,
  type TerminalSize,
} from './TerminalHost.tsx';
import { TerminalStatusStrip, type AgentStatus, type TxnStatus } from './TerminalStatusStrip.tsx';
import type { TokenResolver } from './theme.ts';

/** At most 16 tabs per Terminal window (terminal-ai notes: "+" disables at the limit). */
export const TERMINAL_TAB_LIMIT = 16;

export interface TerminalSessionTab {
  id: string;
  /** Tab label, e.g. "sh 1 — ~/notes". */
  label: string;
  /** Native tooltip of the tab, for example the full working directory. */
  title?: string;
  activity?: DocumentTab['activity'];
  /** Restored snapshot text for this session. */
  initialText?: string;
}

export interface TerminalAppProps {
  sessions: readonly TerminalSessionTab[];
  selected: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
  /** Accessible name prefix, usually the window title "student@plotinium: ~". */
  title: string;
  agent?: AgentStatus;
  txn?: TxnStatus;
  cwd: string;
  shell?: string;
  onData?: (sessionId: string, data: string) => void;
  onResize?: (sessionId: string, size: TerminalSize) => void;
  onTitleChange?: (sessionId: string, title: string) => void;
  onReady?: (sessionId: string, handle: TerminalHandle) => void;
  onAgentActivate?: () => void;
  onTxnActivate?: (txn: string) => void;
  /** Receives the selection on Ctrl+Shift+C; the default writes the system clipboard. */
  onCopy?: (text: string) => void;
  fontSize?: number;
  screenReaderMode?: boolean;
  createTerminal?: TerminalFactory;
  resolveToken?: TokenResolver;
  class?: string;
}

function writeClipboard(text: string): void {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  // Refused without focus or permission: the selection just stays uncopied.
  clipboard?.writeText(text).catch(() => undefined);
}

/**
 * The Terminal window's content: tab strip, one xterm per session (background sessions stay
 * mounted so their scrollback survives), and the status strip. The window's own chords
 * (keys.ts: Alt+Shift+N, Alt+Shift+W, Alt+Shift+] and [, Ctrl+Shift+C) are taken before xterm
 * sees them; Ctrl+V is kept from xterm so the browser pastes; every other key goes to the TTY.
 * When the selected tab closes, focus moves into the terminal that replaces it (WCAG 2.4.3).
 */
export function TerminalApp(props: TerminalAppProps): JSX.Element {
  const [local] = splitProps(props, [
    'sessions',
    'selected',
    'onSelect',
    'onClose',
    'onNew',
    'title',
    'agent',
    'txn',
    'cwd',
    'shell',
    'onData',
    'onResize',
    'onTitleChange',
    'onReady',
    'onAgentActivate',
    'onTxnActivate',
    'onCopy',
    'fontSize',
    'screenReaderMode',
    'createTerminal',
    'resolveToken',
    'class',
  ]);
  const uid = createUniqueId();
  const [sizes, setSizes] = createSignal<Readonly<Record<string, TerminalSize>>>({});
  const handles = new Map<string, TerminalHandle>();
  let root: HTMLDivElement | undefined;

  const size = (): TerminalSize => sizes()[local.selected] ?? { cols: 80, rows: 24 };
  const tabs = (): DocumentTab[] =>
    local.sessions.map((s) => ({
      id: s.id,
      label: s.label,
      ...(s.title === undefined ? {} : { title: s.title }),
      activity: s.id === local.selected ? 'none' : (s.activity ?? 'none'),
      closable: local.onClose !== undefined,
    }));

  const step = (delta: number): void => {
    const list = local.sessions;
    const index = list.findIndex((s) => s.id === local.selected);
    const next = list[(index + delta + list.length) % list.length];
    if (next !== undefined && next.id !== local.selected) {
      local.onSelect(next.id);
      queueMicrotask(() => handles.get(next.id)?.focus());
    }
  };

  const copySelection = (): void => {
    const handle = handles.get(local.selected);
    if (handle === undefined || !handle.hasSelection()) return;
    const text = handle.selection();
    if (local.onCopy !== undefined) local.onCopy(text);
    else writeClipboard(text);
  };

  const onKeyDownCapture = (event: KeyboardEvent): void => {
    if (isPasteKey(event)) {
      // xterm would turn Ctrl+V into ^V and cancel the event. Kept from xterm, the key does the
      // browser's paste into xterm's textarea, which xterm sends on as one (bracketed) paste.
      event.stopPropagation();
      return;
    }
    const action = terminalKeyAction(event);
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'newTab') {
      if (local.sessions.length < TERMINAL_TAB_LIMIT) local.onNew?.();
    } else if (action === 'closeTab') local.onClose?.(local.selected);
    else if (action === 'nextTab') step(1);
    else if (action === 'prevTab') step(-1);
    else copySelection();
  };

  onMount(() => {
    root?.addEventListener('keydown', onKeyDownCapture, true);
    onCleanup(() => root?.removeEventListener('keydown', onKeyDownCapture, true));
  });

  // When the selected tab closes (its × button, the close chord, `exit` or Ctrl-D), its terminal
  // takes the keyboard focus with it. Give the focus to the tab that replaced it, unless the user
  // had already moved the focus outside this window.
  createEffect(
    on(
      () => ({ selected: local.selected, ids: local.sessions.map((s) => s.id) }),
      (now, before) => {
        if (before === undefined || before.selected === now.selected) return;
        if (now.ids.includes(before.selected)) return;
        const doc = root?.ownerDocument;
        const active = doc?.activeElement ?? null;
        const lost = active === null || active === doc?.body || root?.contains(active) === true;
        if (lost) queueMicrotask(() => handles.get(now.selected)?.focus());
      },
    ),
  );

  return (
    <div ref={(el) => (root = el)} class={cx(styles.app, local.class)}>
      <DocumentTabs
        variant="terminal"
        label="Terminal tabs"
        tabs={tabs()}
        selected={local.selected}
        onSelect={(id) => local.onSelect(id)}
        onClose={local.onClose === undefined ? undefined : (id) => local.onClose?.(id)}
        onNew={local.onNew === undefined ? undefined : () => local.onNew?.()}
        newDisabledReason={
          local.sessions.length >= TERMINAL_TAB_LIMIT ? 'Tab limit reached' : undefined
        }
        panelId={`pl-term-panel-${uid}`}
      />
      <div id={`pl-term-panel-${uid}`} role="tabpanel" class={styles.panels}>
        <For each={local.sessions}>
          {(session) => {
            onCleanup(() => handles.delete(session.id));
            return (
              <div class={styles.panel} hidden={session.id !== local.selected}>
                <TerminalHost
                  label={`Terminal, ${local.title}`}
                  initialText={session.initialText}
                  fontSize={local.fontSize}
                  screenReaderMode={local.screenReaderMode}
                  createTerminal={local.createTerminal}
                  resolveToken={local.resolveToken}
                  autofocus={session.id === local.selected}
                  onData={(data) => local.onData?.(session.id, data)}
                  onResize={(next) => {
                    setSizes((all) => ({ ...all, [session.id]: next }));
                    local.onResize?.(session.id, next);
                  }}
                  onTitleChange={(title) => local.onTitleChange?.(session.id, title)}
                  onReady={(handle) => {
                    handles.set(session.id, handle);
                    setSizes((all) => ({ ...all, [session.id]: handle.size() }));
                    local.onReady?.(session.id, handle);
                  }}
                />
              </div>
            );
          }}
        </For>
      </div>
      <TerminalStatusStrip
        agent={local.agent}
        txn={local.txn}
        shell={local.shell}
        cwd={local.cwd}
        cols={size().cols}
        rows={size().rows}
        onAgentActivate={local.onAgentActivate}
        onTxnActivate={local.onTxnActivate}
      />
    </div>
  );
}
