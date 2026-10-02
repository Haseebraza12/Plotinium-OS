/**
 * The login corner's Bohr P (docs/design/logo/DECISION.md §4): it must use a size the mark is
 * hinted for, or it is drawn on half pixels and looks soft at 1x (found by verify-a on :4718,
 * where the 28 px mark sat at y = 849.33).
 */
import { render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { LOGIN_NOW, LOGIN_USERS } from './fixtures.ts';
import loginCss from './LoginScreen.module.css?raw';
import { LoginScreen } from './LoginScreen.tsx';

afterEach(() => {
  document.body.replaceChildren();
});

describe('UI-152 the login corner mark is drawn at a hinted size', () => {
  it('UI-152 the corner mark is 32 px, a multiple of the 16-unit master grid', () => {
    render(() => (
      <LoginScreen
        users={LOGIN_USERS}
        selectedId="student"
        onSelectUser={() => undefined}
        now={LOGIN_NOW}
        onSubmit={() => undefined}
        onContinueWithout={() => undefined}
        version="0.3.0"
        build="a1f93c2"
        onRestart={() => undefined}
        onShutDown={() => undefined}
      />
    ));
    const mark = screen.getByRole('img', { name: 'Plotinium' });
    const size = Number(mark.getAttribute('width'));
    expect(size).toBe(32);
    expect([16, 20, 24].some((grid) => size % grid === 0)).toBe(true);
  });

  it('UI-152 the corner row is bottom-aligned, so the mark keeps the whole-pixel bottom edge', () => {
    const rule = /\.brand\s*\{([^}]*)\}/u.exec(loginCss)?.[1] ?? '';
    expect(rule).toMatch(/align-items:\s*flex-end/u);
  });
});
