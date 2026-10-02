// @vitest-environment happy-dom
/**
 * UI-031: a boot message card (halted, takeover, stall …) makes the login screen or desktop
 * under it inert, so Enter reaches the card's primary action; the halted card claims a saved
 * session only when one existed. UI-060: the recovery console says an action was sent, ends the
 * wait on the kernel's answer, and says so when no answer came.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KlogLine, RouterToKernel } from '@plotinium/kernel/host/main';

import type { BootRecordDraft } from '../src/boot/record.ts';
import {
  answersRun,
  openRecoveryConsole,
  RECOVERY_ANSWER_MS,
} from '../src/boot/recovery-console.ts';
import { haltedScreen, silenceDesktop, takeoverScreen } from '../src/boot/screens.ts';
import type { TimerApi } from '../src/boot/timers.ts';

const IDENTITY = { version: '0.3.0', build: 'a1f93c2' } as const;

const consoles: { destroy(): void }[] = [];
afterEach(() => {
  for (const c of consoles.splice(0)) c.destroy();
  document.body.replaceChildren();
});

function desktopWithLogin(): { desktop: HTMLElement; field: HTMLInputElement } {
  const desktop = document.createElement('div');
  desktop.id = 'plt-desktop';
  const field = document.createElement('input');
  field.type = 'password';
  desktop.append(field);
  document.body.append(desktop);
  field.focus();
  return { desktop, field };
}

describe('UI-031 boot message cards take over the keyboard', () => {
  it('UI-031 the halted card makes the login inert, takes focus, and Enter starts the system', () => {
    const { desktop, field } = desktopWithLogin();
    expect(document.activeElement).toBe(field);
    const start = vi.fn();
    const screen = haltedScreen(document, IDENTITY, start);
    screen.focus();
    expect(desktop.hasAttribute('inert')).toBe(true);
    expect(document.activeElement?.textContent).toBe('↵Start');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(start).toHaveBeenCalledTimes(1);
    screen.destroy();
    expect(desktop.hasAttribute('inert')).toBe(false);
  });

  it('UI-031 shutting down from the login screen does not claim a saved session', () => {
    const fromLogin = haltedScreen(document, IDENTITY, () => undefined);
    expect(fromLogin.el.textContent).toContain(
      'Every service stopped cleanly. Start again to boot.',
    );
    expect(fromLogin.el.textContent).not.toContain('session was saved');
    fromLogin.destroy();
    const fromDesktop = haltedScreen(document, IDENTITY, () => undefined, true);
    expect(fromDesktop.el.textContent).toContain('your session was saved');
    fromDesktop.destroy();
  });

  it('UI-031 the takeover card: Enter from the page uses the kernel here; the desktop stays inert until it closes', () => {
    const { desktop } = desktopWithLogin();
    const useHere = vi.fn();
    const screen = takeoverScreen(document, IDENTITY, useHere);
    expect(desktop.hasAttribute('inert')).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(useHere).toHaveBeenCalledTimes(1);
    screen.destroy();
    expect(desktop.hasAttribute('inert')).toBe(false);
  });

  it('UI-031 silenceDesktop keeps an inert desktop inert when it is released', () => {
    const { desktop } = desktopWithLogin();
    desktop.setAttribute('inert', '');
    const release = silenceDesktop(document);
    release();
    expect(desktop.hasAttribute('inert')).toBe(true);
    expect(silenceDesktop(document.implementation.createHTMLDocument(''))).toBeTypeOf('function');
  });
});

function fakeTimers(): TimerApi & { fire(): void; pending(): number } {
  let queue: { fn: () => void; at: number; id: number }[] = [];
  let seq = 0;
  return {
    set: (fn, ms) => {
      seq += 1;
      queue.push({ fn, at: ms, id: seq });
      return seq;
    },
    clear: (h) => {
      queue = queue.filter((t) => t.id !== h);
    },
    now: () => 0,
    fire: () => {
      const due = queue;
      queue = [];
      for (const t of due) t.fn();
    },
    pending: () => queue.length,
  };
}

function console$() {
  const posted: RouterToKernel[] = [];
  const timers = fakeTimers();
  const handle = openRecoveryConsole({
    doc: document,
    identity: IDENTITY,
    record: {
      bootId: '',
      profile: 'recovery',
      kind: 'cold',
      flags: [],
      outcome: 'recovery',
    } as unknown as BootRecordDraft,
    services: ['kernel', 'sched', 'storage', 'wm', 'vfs · ro'],
    status: 'Online',
    post: (m) => posted.push(m),
    diagnostics: () => undefined,
    reboot: () => undefined,
    now: () => 1.5,
    timers,
  });
  consoles.push(handle.console);
  const text = (): string => {
    handle.console.output.flush();
    return handle.console.output.el.textContent;
  };
  return { handle, posted, timers, text };
}

describe('UI-060 the recovery console only claims what is true', () => {
  it('UI-060 an unanswered action says so after the wait', () => {
    const { posted, timers, text } = console$();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    expect(posted).toEqual([{ t: 'recovery.run', action: 'fsck' }]);
    expect(text()).toContain('fsck: sent to the kernel, waiting for its answer');
    expect(text()).not.toContain('report follows');
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(text()).toContain(
      `fsck: no answer from the kernel after ${String(RECOVERY_ANSWER_MS / 1000)} s`,
    );
  });

  it('UI-060 the kernel answering ends the wait, and its lines are shown', () => {
    const { handle, timers, text } = console$();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    const report: KlogLine = { t: 1.6, sub: 'fsck', level: 'info', msg: 'pass 1 inodes · ok' };
    handle.klog([report]);
    expect(timers.pending()).toBe(0);
    expect(text()).toContain('pass 1 inodes · ok');
    expect(text()).not.toContain('no answer');
  });

  it('UI-060 an answer is a line from recovery or named after the action, not any klog line', () => {
    const line = (sub: string, msg: string): KlogLine => ({ t: 1, sub, level: 'info', msg });
    expect(answersRun(line('recovery', 'restore-manifests: 18 written'), 'restore-manifests')).toBe(
      true,
    );
    expect(answersRun(line('fsck', 'repaired 2'), 'fsck-repair')).toBe(true);
    expect(answersRun(line('storage', 'clear-cache: outbox exported'), 'clear-cache')).toBe(true);
    expect(answersRun(line('sched', 'tick'), 'bootlog')).toBe(false);
  });
});
