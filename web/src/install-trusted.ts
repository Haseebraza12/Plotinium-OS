/**
 * Side-effect module, imported FIRST by main.ts: the Trusted Types `default` policy exists before
 * any other module (and so any Solid template) is evaluated (UI-137, ./trusted-default.ts).
 */
import { installDefaultPolicy } from './trusted-default.ts';

installDefaultPolicy(globalThis);
