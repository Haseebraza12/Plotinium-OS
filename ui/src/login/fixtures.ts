/** Sample users for the login screen (tests and the gallery), from docs/design/stitch/login-*. */
import type { LoginUser } from './LoginScreen.tsx';

export const LOGIN_USERS: readonly LoginUser[] = [
  { id: 'alice', name: 'alice', colour: 4 },
  { id: 'student', name: 'student', colour: 1 },
  { id: 'bob', name: 'bob', colour: 2 },
  { id: 'guest', name: 'Guest', kind: 'guest' },
];

/** Thursday 24 September 2026, 10:42 local time. */
export const LOGIN_NOW = new Date(2026, 8, 24, 10, 42);
