/**
 * The login screen fixes of the polish wave (docs/design/bug-hunt/BUGS.md): UI-001 (nothing
 * resets on a parent's clock tick), UI-005 (guest refusals are shown and announced), UI-064
 * (D-17 corners and power row), UI-065 (the back-off is announced once), UI-070 (initials
 * contrast), UI-149 and UI-150.
 */
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import tokensCss from '../tokens/tokens.css?raw';
import { LOGIN_NOW, LOGIN_USERS } from './fixtures.ts';
import loginCss from './LoginScreen.module.css?raw';
import {
  formatWait,
  LoginScreen,
  type LoginA11y,
  type LoginScreenProps,
  type LoginState,
} from './LoginScreen.tsx';

afterEach(() => {
  document.body.replaceChildren();
});

const base = (): LoginScreenProps => ({
  users: LOGIN_USERS,
  selectedId: 'student',
  onSelectUser: () => undefined,
  now: LOGIN_NOW,
  onSubmit: () => undefined,
  onContinueWithout: () => undefined,
  version: '0.3.0',
  build: 'a1f93c2',
  onRestart: () => undefined,
  onShutDown: () => undefined,
});

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

describe('UI-001 the login screen ignores re-reads of unchanged props', () => {
  it('UI-001 five parent clock ticks keep the typed password, Show password, focus and no shake', async () => {
    const [tick, setTick] = createSignal(0);
    // The old LoginGate: a conditional spread makes Solid merge props through a function that
    // reads the clock, so every prop read (selectedId, errorKey) subscribes to the tick.
    render(() => (
      <LoginScreen {...base()} {...(tick() < 0 ? {} : { retryInS: undefined })} errorKey={0} />
    ));
    const field = screen.getByLabelText<HTMLInputElement>('Password for student');
    fireEvent.input(field, { target: { value: 'abc' } });
    const eye = screen.getByRole('button', { name: 'Show password' });
    fireEvent.click(eye);
    const restart = within(screen.getByRole('navigation', { name: 'Power' })).getByRole('button', {
      name: 'Restart',
    });
    restart.focus();
    const pill = field.parentElement;
    for (let i = 1; i <= 5; i++) {
      setTick(i);
      await nextFrame();
    }
    expect(field.value).toBe('abc');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(field.type).toBe('text');
    expect(document.activeElement).toBe(restart);
    expect(pill?.classList.contains('pl-anim-login-shake')).toBe(false);
  });

  it('UI-001 a real change still resets: a new user clears the field and a new errorKey shakes', async () => {
    const [selected, setSelected] = createSignal('student');
    const [errorKey, setErrorKey] = createSignal(0);
    render(() => (
      <LoginScreen
        {...base()}
        selectedId={selected()}
        onSelectUser={setSelected}
        errorKey={errorKey()}
      />
    ));
    const field = (): HTMLInputElement => screen.getByLabelText(/^Password for /u);
    fireEvent.input(field(), { target: { value: 'abc' } });
    setSelected('alice');
    expect(field().value).toBe('');
    fireEvent.input(field(), { target: { value: 'wrong' } });
    setErrorKey(1);
    expect(field().value).toBe('');
    await nextFrame();
    expect(field().parentElement?.classList.contains('pl-anim-login-shake')).toBe(true);
  });
});

describe('UI-005 guest refusals on the login screen', () => {
  function guest(state: LoginState, extra: Partial<LoginScreenProps> = {}) {
    const onContinueWithout = vi.fn();
    render(() => (
      <LoginScreen
        {...base()}
        selectedId="guest"
        state={state}
        onContinueWithout={onContinueWithout}
        {...extra}
      />
    ));
    return { onContinueWithout, button: screen.getByRole('button', { name: 'Continue as Guest' }) };
  }

  it('UI-005 a guest 429 shows the wait in minutes, disables Continue and announces it once', () => {
    const { onContinueWithout, button } = guest('rate-limited', { retryInS: 1_186 });
    expect(
      screen.getByText('Too many guest sessions from this network. Try again in 20 min'),
    ).toBeTruthy();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onContinueWithout).not.toHaveBeenCalled();
    const live = document.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(live?.textContent).toBe(
      'Too many guest sessions from this network. Try again in 20 minutes.',
    );
    // The visible line describes the button.
    const describedBy = button.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy.split(' ')[0] ?? '')?.textContent).toContain(
      'Try again in 20 min',
    );
  });

  it('UI-005 a guest 403 says guest accounts are disabled, as an alert', () => {
    const { button } = guest('error', { errorText: 'Guest accounts are disabled' });
    expect(screen.getByRole('alert').textContent).toBe('Guest accounts are disabled');
    expect(button.getAttribute('data-error')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });

  it('UI-005 while a guest session starts the line shows the real stage', () => {
    guest('verifying', { stage: 'Starting session' });
    expect(screen.getByText('Starting session…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue as Guest' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('UI-005 waits read in seconds below a minute and in whole minutes from there', () => {
    expect([formatWait(28), formatWait(59), formatWait(59.2), formatWait(1_186)]).toEqual([
      '28 s',
      '59 s',
      '1 min',
      '20 min',
    ]);
  });
});

describe('UI-065 the back-off countdown is shown, not spoken every second', () => {
  it('UI-065 the countdown ticks on screen while the live region keeps its first sentence', () => {
    const [left, setLeft] = createSignal(28);
    render(() => <LoginScreen {...base()} state="rate-limited" retryInS={left()} />);
    const live = document.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(live?.textContent).toBe('Too many attempts. Try again in 28 seconds.');
    setLeft(27);
    expect(screen.getByText('Too many attempts. Try again in 27 s')).toBeTruthy();
    expect(live?.textContent).toBe('Too many attempts. Try again in 28 seconds.');
    expect(screen.queryByRole('alert')).toBeNull();
    for (const region of document.querySelectorAll('[aria-live="polite"], [role="status"]'))
      expect(region.textContent).not.toContain('27');
  });
});

describe('UI-064 login corners and power row (D-17)', () => {
  it('UI-064 Esc cancels "Shut Down?" and focus goes back to Shut Down', async () => {
    const onShutDown = vi.fn();
    render(() => <LoginScreen {...base()} onShutDown={onShutDown} />);
    const power = screen.getByRole('navigation', { name: 'Power' });
    fireEvent.click(within(power).getByRole('button', { name: 'Shut Down' }));
    const confirm = within(power).getByRole('button', { name: 'Shut Down?' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(within(power).queryByRole('button', { name: 'Shut Down?' })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(power).getByRole('button', { name: 'Shut Down' })),
    );
    expect(onShutDown).not.toHaveBeenCalled();
  });

  it('UI-064 "Forgot password?" opens a text popover that Esc closes', async () => {
    const onForgotPassword = vi.fn();
    render(() => <LoginScreen {...base()} onForgotPassword={onForgotPassword} />);
    const forgot = screen.getByRole('button', { name: 'Forgot password?' });
    expect(forgot.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(forgot);
    expect(forgot.getAttribute('aria-expanded')).toBe('true');
    expect(onForgotPassword).toHaveBeenCalledTimes(1);
    const region = document.getElementById(forgot.getAttribute('aria-controls') ?? '');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('Ask an administrator to reset your password.');
    fireEvent.keyDown(forgot, { key: 'Escape' });
    expect(region?.textContent).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(forgot));
  });

  it('UI-064 the Accessibility popover switches reduce motion and reduce transparency', async () => {
    const [a11y, setA11y] = createSignal<LoginA11y>({
      reduceMotion: false,
      reduceTransparency: false,
    });
    const onA11y = vi.fn((setting: keyof LoginA11y, on: boolean) =>
      setA11y((prev) => ({ ...prev, [setting]: on })),
    );
    render(() => <LoginScreen {...base()} a11y={a11y()} onA11y={onA11y} />);
    const button = screen.getByRole('button', { name: 'Accessibility' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('group', { name: 'Accessibility' });
    const motion = within(panel).getByRole('switch', { name: 'Reduce motion' });
    await waitFor(() => expect(document.activeElement).toBe(motion));
    fireEvent.click(motion);
    expect(onA11y).toHaveBeenLastCalledWith('reduceMotion', true);
    expect(motion.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(panel).getByRole('switch', { name: 'Reduce transparency' }));
    expect(onA11y).toHaveBeenLastCalledWith('reduceTransparency', true);
    fireEvent.keyDown(motion, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Accessibility' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe('UI-149 and UI-150', () => {
  it('UI-149 while unlocking the line shows the real stage, not "Press Enter to sign in"', () => {
    render(() => <LoginScreen {...base()} state="unlocking" stage="Loading your desktop" />);
    expect(screen.getByText('Loading your desktop…')).toBeTruthy();
    expect(screen.queryByText('Press Enter to sign in')).toBeNull();
  });

  it('UI-150 the clock is read as one time, not digit by digit', () => {
    render(() => <LoginScreen {...base()} />);
    const time = document.querySelector('time');
    expect(time?.getAttribute('aria-label')).toBe('10:42');
    const digits = time?.firstElementChild;
    expect(digits?.getAttribute('aria-hidden')).toBe('true');
    expect(digits?.textContent).toBe('10:42');
    expect(time?.children).toHaveLength(1);
  });
});

describe('UI-070 login tile initials contrast', () => {
  const luminance = (rgb: readonly number[]): number => {
    const [r = 0, g = 0, b = 0] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hex = (h: string): number[] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));

  it('UI-070 white initials keep 3:1 against both ends of every avatar gradient under the shade', () => {
    const shade = /--login-initials-shade:\s*linear-gradient\(rgb\(0 0 0 \/ ([\d.]+)\)/u.exec(
      loginCss,
    );
    const alpha = Number(shade?.[1]);
    expect(alpha).toBeGreaterThan(0);
    const gradients = [
      ...tokensCss.matchAll(
        /--pl-avatar-(\d): linear-gradient\([^,]+, (#[0-9a-f]{6}), (#[0-9a-f]{6})\)/gu,
      ),
    ];
    expect(gradients).toHaveLength(6);
    for (const [, slot, from, to] of gradients) {
      expect(loginCss).toContain(
        `background: var(--login-initials-shade), var(--pl-avatar-${slot ?? ''})`,
      );
      for (const stop of [from, to]) {
        const shaded = hex(stop ?? '#ffffff').map((v) => v * (1 - alpha));
        const ratio = 1.05 / (luminance(shaded) + 0.05);
        expect(ratio, `avatar ${slot ?? ''} ${stop ?? ''}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('UI-070 other users are shown smaller, not faded (a fade would lower the contrast)', () => {
    const box = /\.avatarBox \{[^}]*\}/u.exec(loginCss)?.[0] ?? '';
    expect(box).toContain('transform: scale(0.57)');
    expect(box).not.toMatch(/opacity:/u);
  });
});
