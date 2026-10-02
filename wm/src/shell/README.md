# wm/src/shell: the desktop shell

The Solid desktop shell: the login and lock screens, the macOS-style desktop (wallpaper, menu bar with live status, floating dock, windows), and the system overlays (Control Centre, Notification Centre and banners, Search, Overview, the window switcher, the frame meter, the lease banner, the connectivity popover, Restart to update). It composes the presentational components of `@plotinium/ui` with the framework-free compositor in `wm/src/compositor`, which stays the only writer of window geometry and z-order. This is the graphical shell; the command shell lives in `apps/shell`.

- **Primary owner:** R3 WM / UI Subsystem Lead
- **Secondary reviewer:** R1 Kernel
- **Spec:** [window-manager.md](../../../specs/05-wm/window-manager.md), [ui-implementation-guide.md](../../../specs/05-wm/ui-implementation-guide.md), [visual-language-macos.md](../../../specs/05-wm/visual-language-macos.md), [ui-design-system.md](../../../specs/05-wm/ui-design-system.md)
- **Requirement IDs:** WM-01..07, BOOT-14, OFF-03, OFF-04, WMD-10, WMD-19, WMD-23

## Entry point

```ts
import { mountDesktop, type DesktopEnv } from '@plotinium/wm/shell';

const handle = mountDesktop(document.getElementById('plt-desktop')!, env);
// … later
handle.dispose();
```

`mountDesktop(root, env)` renders into `root` and returns a `DesktopHandle`:

| Member                        | What it does                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `dispose()`                   | Unmounts everything and removes every listener the shell added.                                       |
| `layout()`                    | Windows bottom to top, `{ wid, app, x, y, w, h, z, state }` (the `window.__plt.layout()` hook).       |
| `sessionId()`                 | The OS session id (the `window.__plt.sessionId()` hook), `null` before sign-in.                       |
| `compositor()`                | The compositor once the desktop is mounted (perf harnesses).                                          |
| `setPrefs(patch)` / `prefs()` | Change or read the preferences from outside the shell (the Settings app); saved via `env.prefs.save`. |
| `launch(app, argv?)`          | Open an app exactly as the Dock does (singletons focus their window).                                 |
| `notify(n)`                   | Post a notification (banner plus Notification Centre).                                                |
| `events(batch)`               | Push kernel event batches when the host gives no `kernel.subscribe`.                                  |
| `lock()`                      | Show the lock screen (needs `env.auth`).                                                              |

The host loads `@plotinium/ui/tokens.css` (inlined for boot) and the fonts; the shell imports `@plotinium/ui/motion.css` itself.

## `DesktopEnv`

Everything the shell needs is injected; the shell never imports the kernel, the apps or storage (package boundaries: wm may import protocol, dsa, `@plotinium/kernel/sys` and `@plotinium/ui`, never apps). Every field except `identity`, `apps` and one compositor source is optional: a missing feed leaves its status item neutral. The full type with doc comments is [env.ts](./env.ts).

| Field                                            | Purpose                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                                       | `{ version, build, … }` for the login footer, Control Centre and About.                                                                                       |
| `apps`                                           | The app registry: `list()` in Dock order and `get(id)` (see below).                                                                                           |
| `kernel.compositorPort`                          | The shell's end of the kernel compositor channel (a `MessagePort`). The shell creates the compositor and binds it once. Give this **or** `kernel.compositor`. |
| `kernel.compositor`                              | A compositor the host created itself (then the host owns its animation hooks and the port).                                                                   |
| `kernel.viewSys(win, handlers)`                  | Builds the view-port system-call client of a window (web passes `createViewSys` from `@plotinium/kernel/sys`); without it views get an EPERM client.          |
| `kernel.subscribe(fn)`                           | Kernel event batches for the menu bar, Control Centre and notifications (`net.state`, `svc.*`, `mem.pressure`, `ai.*`, `update.available`, `lock.*`, …).      |
| `kernel.launch(app, { argv, restore? })`         | Spawn an app's process; its `window.create` then opens the window over the port. Without it the shell posts `{t:'launch'}` on the port.                       |
| `kernel.interactive(active)`                     | The router's `interactive` hint during drags and resizes (WMD-05).                                                                                            |
| `auth.users()`                                   | Login tiles: `{ id, name, kind: 'user' \| 'guest' \| 'demo' }`.                                                                                               |
| `auth.login(user, password, report)`             | Password sign-in; `report(stage)` shows the real stage text (no spinner). Resolve `{ ok: false, retryAt? }` to fail or rate-limit.                            |
| `auth.guest(user, report)`                       | Guest and Demo tiles.                                                                                                                                         |
| `auth.offline()`                                 | Server unreachable: the login shows the offline-verifier notice (OFF-03).                                                                                     |
| `auth.current()`                                 | An already signed-in session: the login screen is skipped. Without `auth` a local user is signed in (`LOCAL_SESSION`).                                        |
| `auth.shown()` / `onPhase('login' \| 'desktop')` | The login is input-ready (start the user-wait clock) / the desktop mounted (mark `desktop-interactive`).                                                      |
| `auth.unlock(user, password)`                    | Lock-screen verification (falls back to `login`).                                                                                                             |
| `session.loadLayout(session)`                    | The saved `SessionLayout` (WM-06); the shell relaunches each window, scales it to the viewport and restores state, snap, z and focus.                         |
| `session.saveLayout(layout, durability)`         | Persist: `relaxed` 500 ms after coarse changes, `strict` before shutdown, restart and update. Without it the shell posts `{t:'layout'}` on the port.          |
| `prefs.initial` / `prefs.save(prefs)`            | `{ theme, reducedMotion, frameMeter, focusMode, dockMagnification }`, applied as `data-theme` and `data-motion` on `<html>`.                                  |
| `search.query(q, signal)`                        | Search results (files, semantic matches, commands); apps are matched by the shell itself. Optional `preview`, `open`, `askAgent`.                             |
| `power(action)`                                  | `lock`, `logout`, `reboot`, `reboot-menu` (Restart with the boot menu), `shutdown`, called after the strict layout save.                                      |
| `setMemoryBudget(mb)`                            | Control Centre's budget slider (MEM-01); resolve an error text when the kernel refuses.                                                                       |
| `retryService(name)` / `retryNetwork()`          | Retry buttons (the kernel's port schema has no `svc.retry` or `net.retry`, so give these).                                                                    |
| `outbox()`                                       | Queued operations for the connectivity popover.                                                                                                               |
| `notificationAction(id, action)`                 | A notification button (default: `{t:'notify.action', id, actionId}` on the port).                                                                             |
| `update`                                         | `{ offer(), restart() }` for Restart to update (BOOT-12).                                                                                                     |
| `ai`                                             | `false` hides the AI status item and Search's agent mode (the AI-off build, C12).                                                                             |
| `now`, `notifications`                           | Injectable clock; seed notifications (the harness).                                                                                                           |

### Apps: `AppEntry` and `ViewContext`

```ts
interface AppEntry {
  id: string;
  title: string;
  icon: IconId; // 'files' | 'terminal' | 'editor' | 'task-manager' | 'settings' | 'atom' …
  pinned?: boolean;
  launchable?: boolean;
  singleton?: boolean;
  menus?: MenuBarMenu[]; // the shell adds Window and Help
  window?: { chrome?: 'titlebar' | 'unified'; resizable?: boolean; maximizable?: boolean };
  mountView(container: HTMLElement, ctx: ViewContext): (() => void) | Promise<() => void>;
}
```

`unified` windows get floating traffic lights over the app's own toolbar (Files, Settings, Task Manager); the app marks `data-pl-drag-region` areas. The view renders into `container` and returns its disposer (or a promise of one, for a lazy chunk). A view that throws, rejects or calls `ctx.reportCrash` is replaced by "<App> stopped" in that window only (WMD-23).

`ViewContext` gives: `pid`, `wid`, `app`, `argv`, `container`, `sys` (the view-port client bound to (pid, wid)), `display`, `session`, `theme()`, `prefs()`, `setTitle(title)`, `launch(app, argv?)`, `subscribe(topics, fn)` (`'proc.*'` prefix patterns), `onViewEvent('tty.output' | 'kernel.events' | 'view.close' | 'window.resize', cb)`, `onMenuCommand(cb(menuId, itemId))`, `reportCrash(err)` and `requestClose()`.

An `apps/` descriptor (`AppDescriptor` with `load(): Promise<AppMount>`) adapts in the host:

```ts
const entry: AppEntry = {
  id: d.id,
  title: d.title,
  icon: d.icon,
  pinned: d.dock !== false,
  singleton: d.window.singleInstance,
  window: {
    chrome: d.window.chrome,
    resizable: d.window.resizable,
    maximizable: d.window.maximizable,
  },
  menus: d.menus,
  mountView: (container, ctx) =>
    d.load().then((mount) =>
      mount({
        app: ctx.app,
        wid: ctx.wid,
        pid: ctx.pid,
        argv: ctx.argv,
        container,
        sys: ctx.sys,
        env: {
          identity,
          prefs: appPrefs,
          aiAvailable,
          user: {
            name: ctx.session.user,
            uid: ctx.session.uid,
            guest: ctx.session.kind === 'guest',
          },
        },
        window: { setTitle: ctx.setTitle, close: ctx.requestClose },
        launch: (app, o) => ctx.launch(app, o?.argv),
        subscribe: ctx.subscribe,
        onMenuCommand: (fn) => ctx.onMenuCommand((_menu, item) => fn(item)),
        reportCrash: ctx.reportCrash,
      }),
    ),
};
```

The shell resolves its own system-app shortcuts through the registry (`taskmgr` or any entry with the `task-manager` icon, `settings`, `terminal`, `files`), so registry ids need not match.

## Kernel wiring

The shell speaks the compositor-port protocol of window-manager.md §4.3 (`kernel/src/core/window/service.ts` is the kernel side). The kernel's `create` (with its transferred `ports.view` and `ports.display`) opens a window; the compositor animates it, and the shell mounts the app view into it with a view-port client from `kernel.viewSys`. The close button posts `closeRequested`; the kernel answers `close` (SIGTERM through the kill path). The shell also reads `events`, `notify`, `suspend`, `notResponding`, `restoring`, `restoreFailed`, `closeGuard` and `attach`, and posts `launch`, `power`, `layout`, `viewCrashed`, `kill` and `notify.action`.

Do not set `onmessage` or call `start()` on the port before `mountDesktop`: a `MessagePort` queues messages until the shell binds it, and the kernel queues its own until the port is attached.

## Behaviour

- **Login (BOOT-14, OFF-03):** users plus Guest, the password straight to `auth.login`, a failure clears and shakes the field with "Invalid username or password", rate-limit countdown, the unlock transition, then the desktop mounts. The lock screen reuses it for the signed-in user.
- **Windows (WM-01..04):** the `WindowLayer` renders one `WindowFrame` per window inside a slot the compositor positions (translate3d, width, height, z-index in one rAF flush). Traffic lights, title-bar drag and double-click, the eight resize handles and click-to-focus go straight to the compositor. Open, close, minimise to the dock icon (genie), restore and maximise are Web Animations on `transform` and `opacity` only, with the motion tokens; a dragging window drops its heavy shadow; under reduced motion no animation is created.
- **Dock (WMD-10):** pinned apps, running dots, launch bounce, magnification, attention; click semantics launch / focus / minimise / restore / choose; `getIconRect` feeds the genie target (the icon centre minus the window's bottom centre).
- **Menu bar:** the atom menu (About, Settings, Restart with the boot-menu option, Shut Down, Lock), the focused app's menus plus Window and Help, and status items fed from kernel events: connectivity and sync queue, AI, memory, degraded services, the clock.
- **Session restore (WM-06):** the layout is saved debounced and strictly before power actions, and restored at sign-in.

### Keyboard (WM-07, window-manager.md §3.9, D-11)

| Keys                                   | Action                                 |
| -------------------------------------- | -------------------------------------- |
| Alt+` / Alt+Shift+` (Alt+Tab, Cmd+Tab) | Window switcher; release Alt to commit |
| Ctrl+Space (Alt+S, Cmd+Space)          | Search                                 |
| Alt+O, F3, Ctrl+Up                     | Overview                               |
| Alt+C                                  | Control Centre                         |
| Alt+Shift+Left / Right                 | Snap to the left / right half          |
| Alt+Shift+Up / Down                    | Maximise / restore or minimise         |
| Alt+M, Alt+Q, Alt+W                    | Minimise, close, window menu           |
| Alt+T, Alt+L                           | New terminal, launcher                 |
| Alt+N, Alt+B                           | Focus the dock, focus the menu bar     |

## Dev harness

[dev-harness.tsx](./dev-harness.tsx) mounts the shell with [fixtures/dev-env.ts](./fixtures/dev-env.ts): demo apps built from ui primitives, a fake kernel on the real port protocol ([fixtures/fake-kernel.ts](./fixtures/fake-kernel.ts)), users `student` and `alice` (password `plotinium`) plus Guest, and a saved three-window layout matching the Stitch `desktop-dark` reference.

```sh
node_modules/.bin/vite --config wm/src/shell/dev/vite.config.mjs   # http://localhost:4720/dev/
```

Query parameters: `login=0`, `windows=0`, `theme=light|dark`, `motion=reduce`, `offline=1`. Screenshots are in `docs/design/integration-shots/`.

## Tests

`wm/tests/shell/*.test.ts(x)` (the `wm` Vitest project): key bindings, dock semantics, the genie target, the switcher, layout snapshot and restore, the login flow, status mapping, the kernel link, the view host, the WAAPI animator and a happy-dom render of the whole desktop (login, launch, focus and z, minimise, maximise, close guard, keyboard, Search, Overview, Control Centre, notifications, power).

```sh
pnpm exec vitest run --project wm
```

## Integration gap

`wm/src/shell/ui.ts` imports the shell, overlay and login components from the `@plotinium/ui` package root, as ui-implementation-guide.md §3.3 requires ("the package root re-exports every Solid area"). `ui/src/index.ts` still lacks three lines, `export * from './shell/index.ts';`, `export * from './overlays/index.ts';` and `export * from './login/index.ts';` (checked: no name clashes). Until they land, `tsc` reports the missing names in `ui.ts`; the dev harness config and the render tests (`wm/tests/shell/ui-areas.ts`) bridge the gap and step aside automatically once the root exports them.
