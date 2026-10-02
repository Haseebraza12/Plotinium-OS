
# Design identity: boot, login, desktop, tokens, logo, accessibility

## 1. Name, tagline and where the name appears

**Name.** **Plotinium**: a coined word, 9 Latin letters, original, and pronounceable ("Boot into Plotinium and open the terminal"). The wordmark is written the same way everywhere: capital P, one word, no "OS" suffix. It is registered in W2 and stays stable after Phase 1.

**Tagline.** It must state what Plotinium does that Puter and daedalOS do not. Pick one in W2:
1. **"A local-first web OS that pages its own memory and lets AI act only through the kernel."** Recommended: it names three differentiators, offline-first against Puter's cloud coupling, paging against daedalOS's memory bloat, and kernel-mediated AI against Puter's add-on AI.
2. "The web OS whose AI is a scheduled, permission-checked process — online or off."
3. "Offline-first, memory-managed, AI-native: a web OS where the kernel decides."

**Where the name must appear (s5.3), and how it gets there:**
- **Build identity.** Vite `define` injects name, version, short git SHA and build date into a kernel constant and into `version.json`.
- **`uname -a`:** `Plotinium 1.0.0 (kernel 1.0.0-a1f93c2, built 2026-12-20) · Chrome 154 · 8 cores · uid=1001(alice)`.
- **`cat /system/release`:** `NAME="Plotinium" VERSION="1.0.0" BUILD="a1f93c2" TEAM="Section <x> · Team <nn>"`.
- **Screens:**
  - boot screen, boot menu header ("Plotinium Boot Manager"), recovery console header, panic screen and login;
  - Settings → About: name, version, build hash, build date and the five team members;
  - browser tab title and favicon, and `manifest.webmanifest` (`name`, `short_name`, icons).
- **Artefacts:** repo name, README header, report cover, slides and the demo video title.

## 2. Principles

| Principle | What it means in practice |
|---|---|
| **Truthful** | Every moving indicator (boot bar, "Restoring… n MB", sync state, model loading) is driven by real work. |
| **Calm and dense** | An OS-like information density, neutral surfaces, and one accent colour. |
| **Keyboard-first** | Every action can be done without a pointer. |
| **Fast by construction** | No layout thrash; the compositor writes transforms only. |
| **One source of tokens** | Boot-ui, the shell, apps, the xterm theme and the CodeMirror theme all read `tokens.css`. |

## 3. Boot screen (framework-free, inlined, painted before any JS chunk loads)

**Layout** (centred, a single column, in the style of spec Figure 6.1):
- the 96 px logo;
- the wordmark;
- `version 1.0.0 · build a1f93c2`;
- a 320 px progress bar;
- the current service line: `vfs: mounting / (12,408 inodes)`;
- the count line: `Service start · 7 of 9`;
- the hint line: `Esc  boot menu    V  verbose log`.

**Themes and motion.** Both themes follow `prefers-color-scheme`. The bar animates its width over `--pl-motion-fast`, and not at all under reduced motion. There is no spinner and no fake animation.

**Verbose view.** A monospace log in the style of the reference boot log (`[    0.087] storage: opened …`). WARN lines use `--pl-warning` and DEGRADED lines use `--pl-danger`, each with a text prefix so colour is never the only signal.

**Boot menu.** A modal listbox headed "Plotinium Boot Manager" with the entries:
- ▶ Normal boot
- Safe mode: no AI services, no autostart, default theme
- Recovery: fsck · clear cache · reset session
- Verbose boot

Keys: ↑↓ to move, Enter to boot, Esc to close. The auto-boot countdown appears only while the menu is open.

**Other screens.**
- **Kernel panic:** a full-screen `--pl-surface`, a danger-coloured rule and the cycle printed in monospace (`sync → lockd → auth → sync`), with the buttons `[R] recovery console`, `[S] safe mode`, `[D] dump diagnostics`.
- **Recovery console:** a focusable list of actions, each with a one-line description of its consequence.
- **Unsupported browser:** lists each missing capability with a short fix, for example "Open http://localhost:4717, not a LAN IP".

## 4. Login screen

- **User tiles.** Initials avatar, display name and username for each user, plus **Guest** and **Demo** tiles (BOOT-14).
- **Password field.** Pasting and password managers are allowed (`autocomplete="current-password"`), and there is a show-password toggle. There are no cognitive tests (WCAG 2.2 SC 3.3.8). A passkey button is optional.
- **Offline.** A banner reads "Offline — signing in with this device's saved verifier". Root has no cached verifier, so it cannot log in offline.
- **Errors.** Always the single message "Invalid username or password". Back-off is shown as time remaining, never as a spinner.
- **Secure prompt** (used for `su` and for agent confirmation). It is drawn only by the compositor and the kernel, on its own `--pl-z-secure` layer, with the Plotinium mark and a lock glyph in its frame. The taskbar shows a matching indicator while it is open. No app can draw above this layer.

## 5. Desktop

**Wallpaper.** A generative SVG in token colours, a few KB in size (no bitmap on the boot path).

**Taskbar** (44 px, at the bottom), left to right:
- the launcher;
- running apps **grouped by app**, with a background-activity dot and a count badge;
- the tray:
  - connectivity: `Online` / `Syncing n` / `Reconnecting in 4 s` / `Offline · n queued` (OFF-04);
  - degraded-services badge, whose popover lists each service and its next retry;
  - memory meter (accounted / budget);
  - "Offline-ready" badge;
  - "Restart to update" badge (OFF-05);
  - clock.

**Windows.**
- 32 px title bar with an icon and title, plus minimise, maximise and close buttons of at least 24×24 px.
- The focused window gets an accent title strip and a stronger shadow; unfocused windows are muted.
- `contain: layout paint`.
- 8 resize handles with a hit area of at least 8 px.
- Snap preview overlays for the edges and the left and right halves.
- Special states:
  - **"Restoring… 3.1 / 5.0 MB"** overlay during page-in, with real byte progress;
  - **"This app stopped"** error-boundary panel, offering Restart and Details;
  - **read-only lock banner**, for example "Locked by alice — read-only".

**Keyboard shortcuts.** Documented in `help` and in Settings.
- `Alt+`` ` / `Alt+Shift+`` `: cycle windows.
- `Alt+Space`: window menu, with keyboard move and resize and snap choices. This is the dragging alternative for WCAG 2.2 SC 2.5.7.
- `Alt+Shift+←/→/↑`: snap left or right, or maximise.
- `Alt+M`: minimise.
- `Alt+Q`: close (sends SIGTERM).
- `Alt+T`: open a Terminal.

Chrome reserves Ctrl+W, Ctrl+T and Ctrl+N, and Ubuntu may take Ctrl+Alt+T, so Plotinium avoids them. Verify the final set on the lab OS in W5.

## 6. Design tokens (`wm/tokens/tokens.css`, one file, used by every system screen)

```css
:root {
  color-scheme: light dark;
  /* colour roles (every text/surface pair computed ≥ 4.5:1 in both schemes; CI re-checks) */
  --pl-bg: light-dark(#f4f5f9, #10121a);
  --pl-surface: light-dark(#ffffff, #1b1e29);
  --pl-surface-2: light-dark(#eceef5, #242836);
  --pl-border: light-dark(#8b91a6, #5d637a);          /* ≥ 3:1 for UI component boundaries */
  --pl-text: light-dark(#151823, #e7e9f1);
  --pl-text-muted: light-dark(#4a5066, #a9aec2);
  --pl-accent: light-dark(#3452d6, #8aa2ff);
  --pl-on-accent: light-dark(#ffffff, #0d1330);
  --pl-danger: light-dark(#b3261e, #ffb4ab);
  --pl-warning: light-dark(#8a5a00, #ffcf70);
  --pl-success: light-dark(#1f7a3a, #7fdc9a);
  --pl-focus-ring: 2px solid var(--pl-accent);
  --pl-focus-offset: 2px;
  /* typography: system stacks only (no font download, COEP-safe) */
  --pl-font-ui: system-ui, 'Segoe UI', Roboto, sans-serif;
  --pl-font-mono: ui-monospace, 'Cascadia Mono', 'DejaVu Sans Mono', monospace;
  --pl-text-xs: 12px; --pl-text-sm: 13px; --pl-text-md: 14px; --pl-text-lg: 16px;
  --pl-text-xl: 20px; --pl-text-2xl: 28px; --pl-leading: 1.45;
  --pl-weight-regular: 400; --pl-weight-semibold: 600;
  /* spacing and shape (4-pt scale) */
  --pl-space-1: 4px; --pl-space-2: 8px; --pl-space-3: 12px; --pl-space-4: 16px; --pl-space-6: 24px;
  --pl-radius-win: 10px; --pl-radius-ctl: 6px;
  --pl-titlebar-h: 32px; --pl-taskbar-h: 44px; --pl-target-min: 24px;
  /* elevation */
  --pl-shadow-win: 0 6px 20px light-dark(rgb(0 0 0 / .12), rgb(0 0 0 / .45));
  --pl-shadow-win-focus: 0 10px 32px light-dark(rgb(0 0 0 / .20), rgb(0 0 0 / .60));
  /* motion (zeroed under reduced motion) */
  --pl-motion-fast: 120ms; --pl-motion-med: 200ms; --pl-motion-slow: 320ms;
  --pl-ease: cubic-bezier(.2, .8, .2, 1);
  /* layers (windows are a stacking context renumbered 1..n inside --pl-z-windows) */
  --pl-z-desktop: 0; --pl-z-windows: 100; --pl-z-taskbar: 10000; --pl-z-notify: 10100;
  --pl-z-secure: 10200; --pl-z-boot: 10300;
}
:root[data-theme=light] { color-scheme: light }  :root[data-theme=dark] { color-scheme: dark }
@media (prefers-reduced-motion: reduce) { :root { --pl-motion-fast: 0ms; --pl-motion-med: 0ms; --pl-motion-slow: 0ms } }
@media (forced-colors: active) { :root { --pl-focus-ring: 2px solid CanvasText } }
```

- **Where it lives.** The file is inlined into `index.html` for the boot screen. It is seeded into `/system/branding/tokens.css` and copied to `docs/identity/`.
- **CSS layer order:** `reset, tokens, shell, apps`.
- **Themes for xterm and CodeMirror** are built from `getComputedStyle` and re-applied when the theme changes. The 16 ANSI colours are extra tokens, `--pl-ansi-0..15`, contrast-checked against the terminal background.
- **Contrast test.** A unit test computes the WCAG contrast of every text/surface pair in both schemes:
  - at least 4.5:1 for text;
  - at least 3:1 for borders, focus rings and icons.

  Spot checks while drafting the tokens: muted text on white is about 8:1, and the dark accent on the dark surface is about 6.9:1.

## 7. Logo: legible at 16 px and at 256 px (s5.2)

**Concept.** An open ring with a solid point sitting on it at the 1 o'clock position: "a plotted point on an orbit". It is two shapes with no text, so it survives 16 px.

**Constraints, checked at every Phase-2 review.**
- The master is drawn on a 16×16 grid inside `viewBox="0 0 160 160"`.
- The ring stroke is at least 20 units, which is 2 px at 16 px.
- The point's diameter is at least 50 units (5 px).
- At least 16 units (1.6 px) of clear space separate the point from the ring's inner edge, so the shapes do not merge when downscaled.
- No hairlines, gradients or text.
- It is monochrome through `currentColor`. A two-tone variant (accent ring, text-colour point) is used at 64 px and above.
- There is one SVG for every size. It has no separate "simplified favicon", because the spec asks for one logo legible at both sizes.

**Files:**
- `docs/identity/logo.svg`, `logo-mono.svg`, `wordmark.svg` and `favicon.svg`;
- maskable PWA icons at 192 and 512 px, with the mark kept inside the central 80% safe zone and rendered at build time;
- all mirrored to `/system/branding/`.

**Wordmark.** "Plotinium" drawn as SVG outlines by the team, so it renders the same on every OS. If it is traced from an OFL-licensed font, credit it in THIRD_PARTY.md.

**Check.** A Playwright job renders the favicon at 16 px and the boot logo at 256 px in both themes. The screenshots are attached to the P2 gate PR for review.

## 8. Accessibility (WCAG 2.2 AA target, WM-07; BOOT-13 must)

WCAG 2.2 added these AA and A criteria, which this design addresses directly ([W3C: what's new in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)):

| Criterion | How Plotinium meets it |
|---|---|
| 2.4.11 Focus Not Obscured (Minimum), AA | Focusing a window raises it. The taskbar reserves its own height, so maximised windows never sit under it. Notifications never cover the focused control. |
| 2.5.7 Dragging Movements, AA | The window menu offers keyboard move and resize, plus snap buttons. The taskbar offers minimise and restore with a single click. |
| 2.5.8 Target Size (Minimum), AA | Controls are at least 24×24 px (`--pl-target-min`), including title-bar buttons and tray icons. |
| 3.3.8 Accessible Authentication (Minimum), AA | Paste and password managers are allowed. A passkey is optional. No puzzles. |
| 3.2.6 Consistent Help, A | `help` and Settings → Help sit in the same place on every screen. |

Other criteria:
- **Contrast** (1.4.3, 1.4.11): token tests.
- **Keyboard** (2.1.1): every app, the boot menu and the login screen can be used without a pointer.
- **Focus visible** (2.4.7): `--pl-focus-ring`.
- **Status messages** (4.1.3): `role="status"` regions for boot, sync, degraded services and notifications.
- **Name, role, value** (4.1.2):
  - windows are `role="dialog" aria-modal="false"`, labelled by their title;
  - the taskbar is a `toolbar`;
  - the Task Manager is a `grid` with sortable column headers;
  - the Terminal has xterm `screenReaderMode`, toggled in Settings → Accessibility.
- **Reduced motion:** all motion tokens are 0 ms (BOOT-13).
- **Forced colours:** supported.
- **Modals:** the agent's destructive confirmation and the kill confirmation trap focus, restore it on close, and default to the safe answer.

**Testing.**
- `@axe-core/playwright` runs on every screen in both themes on every `main` build, with zero serious or critical issues allowed.
- Keyboard-only e2e flows cover the boot menu, login, window switching, window move and resize, and agent confirmation.
- At each gate, a manual screen-reader pass: NVDA on a Windows lab PC, or Orca on Linux.
- R3 owns the audit report, and it is attached to the P2, P3 and P4 gate evidence.

## 9. Identity kit checklist (due at the Phase-2 gate)

- [ ] Name and wordmark, used identically everywhere
- [ ] SVG logo legible at 16 px and 256 px, with the 16 px and 256 px renders reviewed
- [ ] SemVer starting at 0.1.0; tags v0.2.0, v0.3.0, v0.4.0 and v1.0.0
- [ ] Tagline in the README and on the About screen
- [ ] One `tokens.css` with light and dark themes, used by every system screen
- [ ] `uname` string containing the name, version, short build hash and build date
- [ ] Name on the boot screen, boot menu, recovery console, login, About, tab title and favicon, manifest, repo, README, report cover, slides and video
