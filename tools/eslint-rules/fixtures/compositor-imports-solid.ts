// lint-as: wm/src/compositor/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// The compositor is framework-free and the sole writer of geometry (ARC-01, C11).
import { createSignal } from 'solid-js';

export const [x, setX] = createSignal(0);
