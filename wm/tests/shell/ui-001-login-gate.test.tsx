// @vitest-environment happy-dom
/**
 * UI-001 through the real LoginGate: its 1 s clock (the lock-screen time and the back-off
 * countdown) must not reset the password field, the Show password toggle, focus or the shake.
 * UI-064: the gate offers Restart and Shut Down only and wires the Accessibility popover to the
 * <html> attributes that reduce motion and transparency.
 */
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthEnv, LoginResult } from '../../src/shell/env.ts';
import { LoginGate } from '../../src/shell/Login.tsx';

vi.mock('@plotinium/ui', async (importOriginal) => {
  const { withUiAreas } = await import('./ui-areas.ts');
  return withUiAreas(await importOriginal());
});

const IDENTITY = { version: '0.3.0', build: 'a1f93c2' } as const;

/** Minimal DOM helpers (wm has no testing-library): names are aria-label or text content. */
const nameOf = (el: Element): string =>
  (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
function byRole(role: string, name: string, root: ParentNode = document): HTMLElement {
  const implicit = role === 'button' ? 'button:not([role])' : role === 'navigation' ? 'nav' : '';
  const found = [
    ...root.querySelectorAll<HTMLElement>(
      `[role="${role}"]${implicit === '' ? '' : `, ${implicit}`}`,
    ),
  ].filter((el) => nameOf(el) === name);
  if (found.length !== 1) throw new Error(`${String(found.length)} ${role} named "${name}"`);
  return found[0] as HTMLElement;
}
const buttons = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('button:not([role])'),
];
const click = (el: HTMLElement): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const type = (el: HTMLInputElement, value: string): void => {
  el.value = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
};
const byText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('span, p')].find((el) => el.textContent === text);

function auth(over: Partial<AuthEnv> = {}): AuthEnv {
  return {
    users: () => [
      { id: 'demo', name: 'demo', kind: 'user' },
      { id: 'guest', name: 'Guest', kind: 'guest' },
    ],
    login: () => Promise.resolve<LoginResult>({ ok: false }),
    guest: () => Promise.resolve<LoginResult>({ ok: false }),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-motion');
  document.documentElement.removeAttribute('data-transparency');
  document.body.replaceChildren();
});

async function mount(a: AuthEnv = auth()) {
  const onPower = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  render(
    () => (
      <LoginGate
        auth={a}
        identity={IDENTITY}
        now={() => Date.now()}
        onVerified={() => undefined}
        onDone={() => undefined}
        onPower={onPower}
      />
    ),
    host,
  );
  // auth.users() resolves on a microtask.
  await vi.advanceTimersByTimeAsync(0);
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Password for demo"]');
  if (field === null) throw new Error('no password field');
  return { onPower, field };
}

describe('UI-001 the login gate clock resets nothing', () => {
  it('UI-001 six clock ticks keep typed characters, Show password and the focused power button', async () => {
    const { field } = await mount();
    const typed: string[] = [];
    for (const ch of 'abcdef') {
      type(field, `${field.value}${ch}`);
      await vi.advanceTimersByTimeAsync(400); // one character per 400 ms, across the ticks
      typed.push(field.value);
    }
    expect(typed).toEqual(['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']);
    const eye = byRole('button', 'Show password');
    click(eye);
    const power = byRole('navigation', 'Power');
    const restart = byRole('button', 'Restart', power);
    restart.focus();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(field.value).toBe('abcdef');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(restart);
    expect(field.parentElement?.classList.contains('pl-anim-login-shake')).toBe(false);
  });

  it('UI-064 the gate shows Restart and Shut Down only, and Restart still asks first', async () => {
    const { onPower } = await mount();
    const power = byRole('navigation', 'Power');
    expect(buttons(power).map((b) => b.textContent)).toEqual(['Restart', 'Shut Down']);
    click(byRole('button', 'Restart', power));
    click(byRole('button', 'Restart?', power));
    expect(onPower).toHaveBeenCalledWith('reboot');
  });

  it('UI-064 the Accessibility switches write data-motion and data-transparency on <html>', async () => {
    await mount();
    click(byRole('button', 'Accessibility'));
    const panel = byRole('group', 'Accessibility');
    const switchNamed = (label: string): HTMLElement => {
      const el = [...panel.querySelectorAll<HTMLElement>('[role="switch"]')].find(
        (s) =>
          document.getElementById(s.getAttribute('aria-labelledby') ?? '')?.textContent === label,
      );
      if (el === undefined) throw new Error(`no switch ${label}`);
      return el;
    };
    click(switchNamed('Reduce motion'));
    click(switchNamed('Reduce transparency'));
    const html = document.documentElement;
    expect([html.dataset['motion'], html.dataset['transparency']]).toEqual(['reduce', 'reduce']);
    click(switchNamed('Reduce motion'));
    expect(html.dataset['motion']).toBeUndefined();
    expect(switchNamed('Reduce motion').getAttribute('aria-checked')).toBe('false');
  });

  it('UI-005 a guest 429 counts down on the Guest tile only; demo keeps its password field', async () => {
    const guest = vi.fn(() =>
      Promise.resolve<LoginResult>({
        ok: false,
        error: 'No guest slot is free, try again soon',
        retryAt: Date.now() + 1_186_400,
      }),
    );
    const { field } = await mount(auth({ guest }));
    click(byRole('radio', 'Guest, no password'));
    const cont = byRole('button', 'Continue as Guest');
    click(cont);
    await vi.advanceTimersByTimeAsync(0);
    expect(guest).toHaveBeenCalledTimes(1);
    expect(byText('Too many guest sessions from this network. Try again in 20 min')).toBeDefined();
    expect(cont.getAttribute('aria-disabled')).toBe('true');
    click(cont);
    await vi.advanceTimersByTimeAsync(0);
    expect(guest).toHaveBeenCalledTimes(1);
    click(byRole('radio', 'demo'));
    const again = document.querySelector<HTMLInputElement>('input[aria-label="Password for demo"]');
    expect(again?.disabled).toBe(false);
    expect(byText('Press Enter to sign in')).toBeDefined();
    expect(field.isConnected || again?.isConnected === true).toBe(true);
  });
});
