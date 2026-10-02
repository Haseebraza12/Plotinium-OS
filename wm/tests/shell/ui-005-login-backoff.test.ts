/**
 * UI-005: a rate-limit back-off belongs to the user it was answered for. A refused guest sign-in
 * (guest-ip, per network) must not lock another user's password field, and coming back to the
 * Guest tile shows the same back-off until it ends.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AuthEnv, LoginResult } from '../../src/shell/env.ts';
import { LoginFlow, type LoginModel } from '../../src/shell/login-flow.ts';

const GUEST_WAIT_MS = 1_186_400;

function setup() {
  let t = 1_000_000;
  const login = vi.fn((_u: string, password: string) =>
    Promise.resolve<LoginResult>(
      password === 'pw'
        ? { ok: true, session: { uid: 1001, user: 'demo', kind: 'user' } }
        : { ok: false },
    ),
  );
  const guest = vi.fn(() =>
    Promise.resolve<LoginResult>({
      ok: false,
      error: 'No guest slot is free, try again soon',
      retryAt: t + GUEST_WAIT_MS,
    }),
  );
  const auth: AuthEnv = { users: () => [], login, guest };
  const models: LoginModel[] = [];
  const f = new LoginFlow(
    { auth, now: () => t, onChange: (m) => models.push(m), onSignedIn: () => undefined },
    'demo',
  );
  return {
    f,
    login,
    guest,
    models,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('UI-005 per-user rate-limit back-off', () => {
  it('UI-005 a guest 429 limits only the Guest tile; demo can still sign in', async () => {
    const { f, login, guest } = setup();
    f.select('guest');
    await f.continueWithout('guest');
    expect(f.model).toMatchObject({ state: 'rate-limited', selectedId: 'guest' });
    expect(f.retryInS()).toBe(Math.ceil(GUEST_WAIT_MS / 1000));
    await f.continueWithout('guest');
    expect(guest).toHaveBeenCalledTimes(1);

    f.select('demo');
    expect(f.model).toMatchObject({ state: 'idle', selectedId: 'demo', retryAt: undefined });
    expect(f.retryInS()).toBeUndefined();
    await f.submit('demo', 'pw');
    expect(login).toHaveBeenCalledTimes(1);
    expect(f.model.state).toBe('unlocking');
  });

  it('UI-005 back on the Guest tile the same back-off shows, and it ends on time', async () => {
    const { f, guest, advance } = setup();
    f.select('guest');
    await f.continueWithout('guest');
    const retryAt = f.model.retryAt;
    f.select('demo');
    advance(60_000);
    f.select('guest');
    expect(f.model).toMatchObject({ state: 'rate-limited', retryAt });
    expect(f.retryInS()).toBe(Math.ceil((GUEST_WAIT_MS - 60_000) / 1000));
    advance(GUEST_WAIT_MS);
    f.tick();
    expect(f.model).toMatchObject({ state: 'idle', retryAt: undefined });
    await f.continueWithout('guest');
    expect(guest).toHaveBeenCalledTimes(2);
  });

  it('UI-005 an expired back-off is forgotten when its user is selected again', async () => {
    const { f, advance } = setup();
    f.select('guest');
    await f.continueWithout('guest');
    f.select('demo');
    advance(GUEST_WAIT_MS + 1);
    f.select('guest');
    expect(f.model).toMatchObject({ state: 'idle', retryAt: undefined });
  });
});
