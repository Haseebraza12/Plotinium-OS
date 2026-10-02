// @vitest-environment happy-dom
/**
 * The Editor window in a DOM, mounted inside a non-modal `role="dialog"` window frame as the
 * desktop mounts it: the polish-wave fixes of apps/editor (docs/design/bug-hunt/BUGS.md,
 * fix-files-editor): UI-015, UI-037, UI-099, UI-100, UI-102, UI-103, UI-104, UI-117, UI-118.
 */
import type { NetStatus } from '@plotinium/protocol';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { editorWindowWith } from '../../files/lib/open-docs.ts';
import { demoWorld } from '../../files/tests/fake-sys.ts';
import {
  mountView,
  settle,
  type ExtraCalls,
  type MountedView,
} from '../../files/tests/view-harness.ts';
import { closeGuardReason, saveAsSuggestion } from '../lib/model.ts';
import { mount, syncStateOf } from '../view.tsx';
import editorViewSrc from '../view.tsx?raw';
import filesDialogsSrc from '../../files/dialogs.tsx?raw';
import filesViewSrc from '../../files/view.tsx?raw';

const NOTES = '/home/alice/notes/week6-standup.md';

const ONLINE: NetStatus = {
  state: 'online',
  queuedOps: 0,
  lastAckAt: null,
  degraded: [],
  leaseTtlMs: 30_000,
  serverBuild: null,
};

let view: MountedView | undefined;
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.useRealTimers();
});

function extras(net: NetStatus | 'enosys' = ONLINE): ExtraCalls {
  return {
    'net.status': () => {
      if (net === 'enosys') throw new Error('ENOSYS');
      return net;
    },
    'window.setCloseGuard': () => ({}),
    'window.focus': () => ({ focused: true }),
  };
}

async function openEditor(
  argv: readonly string[] = [NOTES],
  net: NetStatus | 'enosys' = ONLINE,
): Promise<MountedView> {
  const w = demoWorld();
  view = mountView(mount, { app: 'editor', sys: w.alice, argv, extras: extras(net), wid: 9 });
  await settle();
  return view;
}

function editorView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const found = dom === null ? null : EditorView.findFromDOM(dom);
  if (found === null) throw new Error('no editor');
  return found;
}

function type(text: string): void {
  const ed = editorView();
  ed.dispatch({ changes: { from: ed.state.doc.length, insert: text } });
}

function key(target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function sheet(): HTMLElement | null {
  return document.querySelector('[role="dialog"][aria-modal="true"]');
}

function guardCalls(v: MountedView): unknown[] {
  return v.extraCalls.filter((c) => c.name === 'window.setCloseGuard').map((c) => c.args);
}

describe('Editor window (polish wave)', () => {
  it('UI-015 Ctrl+Alt+O opens the Open sheet inside the role="dialog" window frame', async () => {
    const v = await openEditor();
    expect(v.frame.getAttribute('role')).toBe('dialog');
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    expect(tab).not.toBeNull();
    key(tab as Element, { key: 'o', code: 'KeyO', ctrlKey: true, altKey: true });
    await settle(2);
    expect(sheet()?.textContent).toContain('Open');
    expect(sheet()?.querySelector('input')?.value).toBe('~/notes/');
  });

  it('UI-037 an unsaved document sets the close guard, and saving clears it', async () => {
    const v = await openEditor();
    expect(guardCalls(v)).toEqual([]);
    type('\nunsaved text here');
    await settle();
    expect(guardCalls(v)).toEqual([
      {
        wid: 9,
        reason:
          '“week6-standup.md” has unsaved changes. They will be lost if you close this window.',
      },
    ]);
    key(document.querySelector('.cm-content') as Element, {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
    });
    await settle();
    expect(guardCalls(v).at(-1)).toEqual({ wid: 9, reason: null });
  });

  it('UI-037 a kernel without window.setCloseGuard is no guard and shows no error', async () => {
    const w = demoWorld();
    view = mountView(mount, {
      app: 'editor',
      sys: w.alice,
      argv: [NOTES],
      extras: {
        'net.status': () => ONLINE,
        'window.setCloseGuard': () => {
          throw new Error('ENOSYS');
        },
      },
    });
    await settle();
    type('x');
    await settle();
    expect(document.querySelector('[data-testid="app-toast"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('UI-099 an Editor toast fades after its lifetime while the document keeps changing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = demoWorld();
    view = mountView(mount, { app: 'editor', sys: w.alice, argv: [NOTES], extras: extras() });
    await vi.advanceTimersByTimeAsync(50);
    // "You hold the lock on …" (a success toast, 3.5 s).
    view.menu('file.lock');
    await vi.advanceTimersByTimeAsync(0);
    const toast = (): string | undefined =>
      document.querySelector('[data-testid="app-toast"]')?.textContent ?? undefined;
    expect(toast()).toContain('You hold the lock');
    for (let t = 0; t < 3_000; t += 500) {
      type('a');
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(toast()).toContain('You hold the lock');
    await vi.advanceTimersByTimeAsync(600);
    expect(toast()).toBeUndefined();
  });

  it('UI-100 Ctrl+Shift+S opens Save As and does not save', async () => {
    const v = await openEditor();
    type('\nedited');
    await settle();
    const before = v.extraCalls.length;
    key(document.querySelector('.cm-content') as Element, {
      key: 'S',
      code: 'KeyS',
      keyCode: 83,
      ctrlKey: true,
      shiftKey: true,
    });
    await settle(2);
    expect(sheet()?.textContent).toContain('Save As');
    expect(sheet()?.querySelector('input')?.value).toBe('~/notes/week6-standup copy.md');
    // Still unsaved: the guard was not cleared by a save.
    const last = guardCalls(v).at(-1) as { reason?: unknown } | undefined;
    expect(String(last?.reason)).toContain('unsaved');
    expect(v.extraCalls.length).toBe(before);
  });

  it('UI-102 Save As suggests a file in the shown folder and names a missing folder', async () => {
    await openEditor([]);
    type('draft');
    await settle();
    key(document.querySelector('.cm-content') as Element, {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
    });
    await settle(2);
    const field = sheet()?.querySelector('input');
    // Home, not a ~/Documents that may not exist; .txt for a plain document.
    expect(field?.value).toBe('~/untitled.txt');
    const input = field as HTMLInputElement;
    input.value = '~/Missing/draft.txt';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    key(input, { key: 'Enter' });
    await settle();
    expect(document.querySelector('[data-testid="app-toast"]')?.textContent).toContain(
      'Could not save as draft.txt: the folder ~/Missing does not exist',
    );
  });

  it('UI-102 the suggestion follows the language and keeps a saved name beside itself', () => {
    expect(saveAsSuggestion({ path: undefined, name: 'Untitled' }, '/home/alice', 'plain')).toBe(
      '/home/alice/untitled.txt',
    );
    expect(saveAsSuggestion({ path: undefined, name: 'x' }, '/home/alice/notes', 'markdown')).toBe(
      '/home/alice/notes/untitled.md',
    );
    expect(saveAsSuggestion({ path: '/a/b/report.md', name: 'report.md' }, '/', 'markdown')).toBe(
      '/a/b/report copy.md',
    );
  });

  it('UI-103 "+ New tab" moves focus into the new document, never leaving it on "+"', async () => {
    await openEditor();
    const plus = document.querySelector<HTMLButtonElement>('button[aria-label="New tab"]');
    plus?.focus();
    plus?.click();
    await settle(2);
    expect(document.activeElement).not.toBe(plus);
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull();
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent ?? '');
    expect(tabs.some((t) => t.includes('Untitled'))).toBe(true);
  });

  it('UI-104 an open Editor window reveals a file it already shows', async () => {
    const v = await openEditor();
    const w = editorWindowWith(NOTES);
    expect(w?.wid).toBe(9);
    expect(editorWindowWith('/home/alice/other.md')).toBeUndefined();
    await expect(w?.reveal(NOTES, 2)).resolves.toBe(true);
    expect(v.extraCalls.some((c) => c.name === 'window.focus')).toBe(true);
    v.dispose();
    view = undefined;
    expect(editorWindowWith(NOTES)).toBeUndefined();
  });

  it('UI-117 the status bar says "local only" while sync is not linked', async () => {
    await openEditor([NOTES], { ...ONLINE, degraded: ['sync', 'lockd'] });
    const bar = document.querySelector('footer');
    expect(bar?.textContent).toContain('local only');
    expect(bar?.textContent).not.toContain('synced');
    expect(syncStateOf(undefined, undefined)).toEqual({ kind: 'local' });
    expect(syncStateOf(undefined, null)).toEqual({ kind: 'local' });
    expect(syncStateOf({ sync: 'synced', conflict: undefined }, ONLINE)).toEqual({
      kind: 'synced',
    });
    expect(
      syncStateOf({ sync: 'synced', conflict: undefined }, { ...ONLINE, state: 'offline' }),
    ).toEqual({ kind: 'offline', queued: 0 });
  });

  it('UI-118 the Editor and Files views have no all-literal style attributes', () => {
    const sources: Record<string, string> = {
      'apps/editor/view.tsx': editorViewSrc,
      'apps/files/view.tsx': filesViewSrc,
      'apps/files/dialogs.tsx': filesDialogsSrc,
    };
    for (const [file, src] of Object.entries(sources)) {
      expect(src.length, file).toBeGreaterThan(1_000);
      expect(staticStyles(src), file).toEqual([]);
    }
  });
});

describe('Editor close guard reason (UI-037)', () => {
  it('UI-037 names one document, counts several, and is null when all are saved', () => {
    expect(closeGuardReason([{ name: 'a.md', dirty: false }])).toBeNull();
    expect(closeGuardReason([{ name: 'a.md', dirty: true }])).toContain('“a.md” has unsaved');
    expect(
      closeGuardReason([
        { name: 'a.md', dirty: true },
        { name: 'b.md', dirty: true },
      ]),
    ).toContain('2 documents have unsaved changes');
    expect((closeGuardReason([{ name: 'x'.repeat(400), dirty: true }]) ?? '').length).toBe(256);
  });
});

/**
 * `style={{…}}` objects whose every value is a literal (Solid compiles them into a style
 * attribute the production CSP refuses). A value with an expression is set through the CSSOM.
 */
function staticStyles(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/style=\{\{([\s\S]*?)\}\}/gu)) {
    const body = (m[1] ?? '')
      .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/gu, 'S')
      .replace(/`[^`$]*`/gu, 'S');
    const values = body.split(',').map((part) => part.slice(part.indexOf(':') + 1).trim());
    if (values.filter((v) => v !== '').every((v) => v === 'S')) out.push(m[0]);
  }
  return out;
}
