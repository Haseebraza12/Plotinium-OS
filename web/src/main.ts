/**
 * Main-thread entry (boot-and-services.md §3.1–§3.2; architecture.md §3.6). The boot itself is
 * web/src/boot/driver.ts: POST, the streamed kernel bundle, the kernel-link router, the boot
 * menu, verbose log, panic, recovery and stall screens, all driven by real boot events. The
 * inlined splash (index.html) painted the identity before this module ran (BOOT-01).
 *
 * This file only wires the shell into the boot through `ShellHooks`.
 */
// First: the narrow Trusted Types default policy, before any template is created (UI-137).
import './install-trusted.ts';

import type { BootContext, ShellHooks } from './boot/driver.ts';
import { startBoot } from './boot/driver.ts';
import { DEV, IDENTITY, TEST_FLAGS, TIMEOUT_SCALE } from './identity.ts';
import type * as DesktopHost from './desktop/host.ts';
import kernelUrl from './kernel.worker.ts?worker&url';

// ==== desktop mount (assembler-owned) ========================================================
// The graphical shell (@plotinium/wm/shell) composed with the kernel link and the apps registry
// lives in ./desktop/host.ts, imported lazily so it stays out of the boot-critical chunk
// (BOOT-10). The chunk starts loading as soon as the compositor port is attached (stage 2), so
// the login screen is ready by the time the kernel's `login` service waits for a user.
//  - attachCompositor(port): the shell's end of the wm channel. Nothing reads it until the shell
//    binds it (a MessagePort queues), so the kernel's early messages are not lost.
//  - mountLogin(root, ctx): the shell with its login screen, speaking the LOGIN channel.
//  - mountDesktop(root, ctx): resolves once the desktop has mounted after sign-in; the driver then
//    marks `desktop-interactive` and the kernel asks for the Service Worker after idle.
type DesktopHostModule = typeof DesktopHost;
let compositorPort: MessagePort | null = null;
let desktopHost: Promise<DesktopHostModule> | null = null;
const loadDesktopHost = (): Promise<DesktopHostModule> =>
  (desktopHost ??= import('./desktop/host.ts'));

const shell: ShellHooks = {
  attachCompositor: (port: MessagePort) => {
    compositorPort = port;
    void loadDesktopHost();
  },
  mountLogin: async (root: HTMLElement, ctx: BootContext) => {
    const host = await loadDesktopHost();
    await host.mountLogin(root, ctx, compositorPort);
  },
  mountDesktop: async (root: HTMLElement, ctx: BootContext) => {
    const host = await loadDesktopHost();
    await host.mountDesktop(root, ctx, compositorPort);
  },
};
// ==== end of desktop mount ===================================================================

void startBoot(shell, {
  win: window,
  identity: IDENTITY,
  kernelUrl,
  testBuild: TEST_FLAGS,
  dev: DEV,
  timeoutScale: TIMEOUT_SCALE,
});
