// lint-as: wm/src/shell/fixture.ts
// expect: @typescript-eslint/no-restricted-imports
// The desktop never imports the apps: web composes the app registry into the shell (ARC-01).
import { PACKAGE_NAME } from '@plotinium/apps';

export const leaked = PACKAGE_NAME;
