import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { LOGIN_NOW, LOGIN_USERS } from './fixtures.ts';
import {
  formatLockClock,
  LoginScreen,
  type LoginScreenProps,
  type LoginState,
  type LoginUser,
} from './LoginScreen.tsx';

function Harness(props: { overrides?: Partial<LoginScreenProps>; users?: readonly LoginUser[] }) {
  const [selected, setSelected] = createSignal('student');
  return (
    <LoginScreen
      users={props.users ?? LOGIN_USERS}
      selectedId={selected()}
      onSelectUser={setSelected}
      now={LOGIN_NOW}
      onSubmit={() => undefined}
      onContinueWithout={() => undefined}
      version="0.3.0"
      build="a1f93c2"
      status={{ wifi: 'off', battery: 82, layout: 'EN' }}
      onSleep={() => undefined}
      onRestart={() => undefined}
      onShutDown={() => undefined}
      onForgotPassword={() => undefined}
      onAccessibility={() => undefined}
      onLanguage={() => undefined}
      {...props.overrides}
    />
  );
}

const password = (): HTMLInputElement => screen.getByLabelText('Password for student');

describe('UI-LoginScreen', () => {
  it('BOOT-14 the screen is a labelled main region with a clock and a radiogroup of users plus Guest', () => {
    render(() => <Harness />);
    expect(screen.getByRole('main', { name: 'Sign in to Plotinium' })).toBeTruthy();
    expect(screen.getByText('Thursday, 24 September')).toBeTruthy();
    const time = document.querySelector('time');
    expect(time?.textContent).toBe('10:42');
    const group = screen.getByRole('radiogroup', { name: 'Choose user' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'alice',
      'student',
      'bob',
      'Guest, no password',
    ]);
    expect(screen.getByRole('radio', { name: 'student' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: 'student' }).tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'alice' }).tabIndex).toBe(-1);
  });

  it('BOOT-14 arrow keys move the selection with a roving tab stop and skip disabled users', async () => {
    const users: LoginUser[] = [
      ...LOGIN_USERS.slice(0, 2),
      {
        id: 'bob',
        name: 'bob',
        disabled: true,
        disabledReason: 'Needs network (no saved verifier)',
      },
      LOGIN_USERS[3] as LoginUser,
    ];
    render(() => <Harness users={users} />);
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    const guest = screen.getByRole('radio', { name: 'Guest, no password' });
    expect(guest.getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(guest));
    expect(
      screen
        .getByRole('radio', { name: 'bob, Needs network (no saved verifier)' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'alice' }).getAttribute('aria-checked')).toBe('true');
  });

  it('BOOT-14 Enter submits the password for the selected user; the arrow is disabled while empty', () => {
    const onSubmit = vi.fn();
    render(() => <Harness overrides={{ onSubmit }} />);
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.submit(password().form as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.input(password(), { target: { value: 'hunter2' } });
    expect(signIn.getAttribute('aria-disabled')).toBeNull();
    fireEvent.submit(password().form as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledWith('student', 'hunter2');
    expect(password().getAttribute('autocomplete')).toBe('current-password');
  });

  it('BOOT-14 a wrong password clears the field, marks it invalid and announces the error', () => {
    const [state, setState] = createSignal<LoginState>('idle');
    const [errorKey, setErrorKey] = createSignal(0);
    render(() => (
      <Harness
        overrides={{
          get state() {
            return state();
          },
          get errorKey() {
            return errorKey();
          },
        }}
      />
    ));
    fireEvent.input(password(), { target: { value: 'wrong' } });
    setState('error');
    setErrorKey(1);
    expect(password().value).toBe('');
    expect(password().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Invalid username or password');
  });

  it('BOOT-14 Guest continues without a password', () => {
    const onContinueWithout = vi.fn();
    render(() => <Harness overrides={{ onContinueWithout }} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guest, no password' }));
    expect(screen.queryByLabelText(/Password for/u)).toBeNull();
    expect(screen.getByText('Guest files are deleted when you log out.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue as Guest' }));
    expect(onContinueWithout).toHaveBeenCalledWith('guest');
  });

  it('OFF-03 offline login states that the cached verifier is used', () => {
    render(() => <Harness overrides={{ offline: true }} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Offline — using cached verifier');
    const describedBy = password().getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ').some((id) => document.getElementById(id)?.contains(status))).toBe(
      true,
    );
  });

  it('UI-LoginScreen shows the signed-in sessions pill when online', () => {
    render(() => <Harness overrides={{ sessions: 1 }} />);
    expect(screen.getByRole('status').textContent).toBe('Signed-in sessions: 1');
  });

  it('UI-LoginScreen verifying shows the real stage in words and blocks a second submit', () => {
    const onSubmit = vi.fn();
    render(() => (
      <Harness overrides={{ state: 'verifying', stage: 'Checking password', onSubmit }} />
    ));
    expect(screen.getByText('Checking password…')).toBeTruthy();
    fireEvent.input(password(), { target: { value: 'x' } });
    fireEvent.submit(password().form as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('UI-LoginScreen rate limiting disables the field and counts down in words', () => {
    render(() => <Harness overrides={{ state: 'rate-limited', retryInS: 28 }} />);
    expect(password().disabled).toBe(true);
    expect(screen.getByText('Too many attempts. Try again in 28 s')).toBeTruthy();
  });

  it('UI-064 the power row is Restart and Shut Down only (D-17: no Sleep); both ask first', async () => {
    const onSleep = vi.fn();
    const onShutDown = vi.fn();
    render(() => <Harness overrides={{ onSleep, onShutDown, sessions: 1 }} />);
    const power = screen.getByRole('navigation', { name: 'Power' });
    expect(within(power).queryByRole('button', { name: 'Sleep' })).toBeNull();
    expect(
      within(power)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Restart', 'Shut Down']);
    fireEvent.click(within(power).getByRole('button', { name: 'Shut Down' }));
    expect(onShutDown).not.toHaveBeenCalled();
    const confirm = within(power).getByRole('button', { name: 'Shut Down?' });
    expect(
      document.getElementById(confirm.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('1 user is signed in — unsaved work may be lost');
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(within(power).getByRole('button', { name: 'Cancel' }));
    expect(within(power).getByRole('button', { name: 'Shut Down' })).toBeTruthy();
    fireEvent.click(within(power).getByRole('button', { name: 'Shut Down' }));
    fireEvent.click(within(power).getByRole('button', { name: 'Shut Down?' }));
    expect(onShutDown).toHaveBeenCalledTimes(1);
  });

  it('UI-LoginScreen the unlock transition ends with onUnlocked', async () => {
    document.documentElement.dataset.motion = 'reduce';
    const onUnlocked = vi.fn();
    render(() => <Harness overrides={{ state: 'unlocking', onUnlocked }} />);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
  });

  it('UI-LoginScreen the show-password toggle is a pressed button and caps lock is announced', () => {
    render(() => <Harness />);
    const eye = screen.getByRole('button', { name: 'Show password' });
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(eye);
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(password().type).toBe('text');
  });

  it('UI-LoginScreen formats the lock clock as "Thursday, 24 September" and 10:42', () => {
    const { date, time } = formatLockClock(LOGIN_NOW);
    expect(date).toBe('Thursday, 24 September');
    expect(time).toBe('10:42');
    expect(formatLockClock(new Date(2026, 8, 24, 9, 5)).time).toBe('09:05');
  });
});
