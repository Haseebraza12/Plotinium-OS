# Login / Lock screen: dark

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. `generate_screen_from_text` timed out (not retried). `list_screens` stayed empty for 17 polls (15:23 to 15:46 UTC), so no screen id exists and `get_screen` / `edit_screens` could not run. The raw response is in `screen.json`.
- **Design system:** `assets/10121591451242352758` (Plotinium Glass: Dark)
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440x900)
- **Files:** `screen.json` (raw Stitch response). No Stitch `screen.html` or `screenshot.png` exists yet.
- **Fallback reference:** `reference.html` + `reference.png` are a hand-built render of this exact prompt using the design-system tokens, rendered at 1440x900 in headless Chrome. They are NOT a Stitch export. `reference.html` implements the mount, hover, press, focus, halo, badge, shake and orbit animations below, plus the `prefers-reduced-motion` fallback, so it doubles as a motion prototype. Re-run the prompt below in Stitch when the service is responsive, then save `screen.html` and `screenshot.png` beside these files.

## Final prompt

```text
Screen title: "Plotinium Login — Dark". A desktop 1440x900 lock / login screen for Plotinium, an AI-native web operating system. Visual quality of the latest macOS lock screen (Liquid Glass era) but with its own identity. NO Apple logo, no Apple app names, no SF Symbols; use thin lucide-style line icons only. Font: Inter (or similar geometric sans), light weights for the clock.

BACKGROUND: full-bleed wallpaper — a luminous deep violet gradient field (#0B0A1A near-black at edges, glowing #5E5CE6 violet and soft magenta/indigo nebula blobs in the middle), heavily blurred (like a 60px gaussian blur) with a subtle grain and a dark vignette so white text stays readable.

TOP CENTRE: small date line 'Thursday, 24 September' in semi-transparent white (medium weight, 20px), and under it a very large thin clock '10:42' (ultra-light weight, about 120px, white at 90% opacity, slight soft glow).

TOP-RIGHT CORNER status cluster (small, like a menu bar with no background): Wi-Fi-off icon, battery icon '82%', and a keyboard layout label 'EN'.

CENTRE: a horizontal row of user avatars with names beneath:
 - 'alice' (circle 64px, soft pastel photo-like initial avatar 'A', 70% opacity)
 - 'student' — SELECTED, enlarged to a 112px circular avatar with a thin 2px white/violet glowing ring and a soft violet halo; name 'student' in white semibold 18px below it
 - 'bob' (64px circle initial 'B', 70% opacity)
 - 'Guest' (64px frosted-glass circle with a user outline icon, 70% opacity)
Order left to right: alice, student (middle, enlarged), bob, Guest.

Under the selected avatar: a frosted glass password pill field (width 260px, height 40px, fully rounded, translucent white 12% fill with backdrop blur, 1px inner white 20% border highlight) with the placeholder 'Enter password' in 55% white, six masked dots area, and on the right end inside the pill a small circular violet (#5E5CE6) arrow button with a right arrow icon. Under the field a tiny hint text 'Press Enter to sign in · Touch key not available' in 50% white 12px, and a text link 'Forgot password?' in violet-tinted white.

Below that: a small glass status pill badge with an amber dot and a cloud-off icon reading 'Offline — using cached verifier' (12px, amber #FFB340 text-tinted, translucent dark glass background, rounded full).

BOTTOM CENTRE: three circular glass buttons 48px (frosted translucent, 1px light border, soft shadow) each with a lucide line icon and a label below: 'Sleep' (moon icon), 'Restart' (rotate-ccw icon), 'Shut Down' (power icon). Labels 12px white 70%.

BOTTOM-LEFT: small branding — an abstract luminous atom logo (bright white-violet nucleus dot with 2 thin elliptical orbit rings in #5E5CE6, no radiation symbols) followed by the text 'Plotinium 0.3.0' in 12px white 55%, and beneath it 'build a1f93c2' in 11px monospace 40%.

BOTTOM-RIGHT: small glass icon buttons for accessibility (person-standing icon) and language (globe icon 'English').

Overall: generous negative space, centred composition, soft large shadows, glass layers with vibrancy, crisp readable contrast, premium macOS-grade finish.
```

## Layout (top to bottom)

| Zone | Content |
|---|---|
| Wallpaper | Full-bleed violet gradient field (#0B0A1A edges, #5E5CE6 glow, indigo/magenta blobs), 60px gaussian blur, subtle grain, dark vignette |
| Top-right status | Wi-Fi-off icon, battery `82%`, keyboard layout `EN` (no bar background) |
| Top centre | Date `Thursday, 24 September` (20px, 70% white) above clock `10:42` (~120px, ultra-light, 90% white, soft glow) |
| Centre | Avatar row: `alice`, **`student` (selected, 112px)**, `bob`, `Guest` |
| Under selected avatar | Glass password pill `Enter password` + violet circular arrow button; hint `Press Enter to sign in`; link `Forgot password?` |
| Status | Amber glass badge pill: cloud-off icon + `Offline — using cached verifier` |
| Bottom centre | Three 48px circular glass buttons: `Sleep` (moon), `Restart` (rotate-ccw), `Shut Down` (power) |
| Bottom-left | Atom logo (nucleus + 2 elliptical orbits, #5E5CE6) + `Plotinium 0.3.0`, `build a1f93c2` (mono) |
| Bottom-right | Glass icon buttons: Accessibility (person-standing), Language (globe, `English`) |

## Elements and states

### Wallpaper (`.lock-wallpaper`)
- **Default:** blurred gradient, slow ambient drift (see animations).
- **Locked vs. login:** in lock mode (an existing session) the wallpaper shows the session's desktop wallpaper blurred; at cold login it uses the default violet field.
- **Loading:** solid #0B0B1A until the wallpaper image decodes, then a crossfade.

### Clock and date (`<time>`)
- **Default:** `10:42`, `Thursday, 24 September`; updates each minute (digits cross-fade).
- **Settings:** follows the 12/24h setting in Settings > Date & Time. At login, before any user settings load, it uses the system default (24h).
- **Collapsed:** when the password field is focused and the window is short (< 700px tall), the clock scales down to 64px and moves up.

### User avatar tile (`button[role=radio]` inside a `radiogroup`)
- **Default (unselected):** 64px circle, 70% opacity, name label 14px 70% white.
- **Hover:** opacity 100%, scale 1.06, faint white ring 1px 30%.
- **Focus-visible:** 3px accent ring (#5E5CE6 at 55%) offset 3px; the name label goes to 100%.
- **Active (pressed):** scale 0.96.
- **Selected:** 112px, 2px white/violet ring, violet halo (0 0 40px rgba(94,92,230,0.45)), name 18px semibold; `aria-checked="true"`.
- **Disabled:** account locked by an admin: 40% opacity, a small lock glyph badge, tooltip `Account disabled`.
- **Signed-in badge:** a small green dot at the bottom-right of the avatar when the user already has a running session (lock mode).
- **Guest:** frosted glass circle with a user outline icon. Selecting it hides the password field and shows a `Continue as Guest` glass button instead.

### Password pill (`input type=password` + submit button)
- **Default:** 260x40, radius full, rgba(255,255,255,0.12) fill with 30px backdrop blur and a 1px inner top highlight; placeholder `Enter password` at 55% white.
- **Hover:** fill 0.16.
- **Focus:** fill 0.18, 3px accent focus ring at 55%, caret in accent; the placeholder fades to 35%.
- **Filled:** masked dots (8px) that pop in one by one; the arrow button becomes active (#5E5CE6 to #7472FF on hover).
- **Caps Lock on:** an up-arrow glyph appears inside the pill on the right, before the arrow button, with tooltip `Caps Lock is on`.
- **Show password:** an eye toggle (lucide `eye`/`eye-off`) appears on hover or focus, with `aria-pressed`.
- **Loading (verifying):** the arrow button turns into a 16px spinner ring (accent); the input goes read-only and the pill shows a soft luminous sweep.
- **Error (wrong password):** the pill shakes horizontally, the border turns danger #FF453A at 60%, the field clears, and the hint changes to `Incorrect password — 2 attempts before a 30 s wait` (with `role=alert`).
- **Rate-limited:** the input is disabled with `Try again in 28 s` counting down (`aria-live=polite`).
- **Disabled:** 40% opacity (while shutting down or restarting).

### Arrow / submit button (`button type=submit`, `aria-label="Sign in"`)
- **Default:** 28px circle, #5E5CE6 at 50% when the field is empty (`aria-disabled`), 100% when filled.
- **Hover:** #7472FF, scale 1.06. **Active:** scale 0.92. **Focus-visible:** 2px white ring plus the accent halo.
- **Loading:** spinner. **Disabled:** 35% opacity, no pointer.

### Hint and `Forgot password?` link
- Hint: 12px, 50% white; it switches to the error or countdown text in the states above.
- Link: 12px, violet-tinted white; hover underlines and brightens; focus shows an accent ring. It opens a glass sheet: `Ask an administrator to reset your password (sudo passwd student)`.

### Offline status badge (`role=status`)
- **Offline:** amber dot, cloud-off icon, `Offline — using cached verifier`, amber-tinted text on dark glass.
- **Online (hidden):** the badge collapses away.
- **Syncing:** blue info dot plus `Reconnecting…` with a pulsing dot.
- **Hover:** a tooltip explains `The server is unreachable. Your password is checked against the verifier cached on this device. Files sync when the connection returns.`

### Power buttons: Sleep / Restart / Shut Down (`button`s, `aria-label` = label)
- **Default:** 48px circular glass (rgba(255,255,255,0.10), blur 30px, 1px border rgba(255,255,255,0.14)), 20px lucide icon, 12px label at 70%.
- **Hover:** fill 0.18, icon 100%, lifts by 2px, stronger shadow.
- **Focus-visible:** 3px accent ring.
- **Active:** scale 0.94, fill 0.24.
- **Confirm state (Restart / Shut Down):** the first click morphs the button into a pill `Shut Down?` with `Cancel` beside it; it auto-cancels after 5 s.
- **Disabled:** 35% (while a sign-in is being verified).

### Branding (bottom-left)
- The atom logo, `Plotinium 0.3.0` and `build a1f93c2`. Non-interactive; on hover the version shows a tooltip with the build date.

### Accessibility and Language buttons (bottom-right)
- **Accessibility:** opens a glass popover with toggles for `Screen reader` hints, `Reduce motion`, `Increase contrast`, `Larger text` and an on-screen keyboard.
- **Language:** popover list `English`, `اردو (Urdu)`; the selected item shows a check.
- States: hover fill 0.16, focus ring, active scale 0.94, popover open (`aria-expanded=true`).

### Top-right status cluster
- Wi-Fi off / on / weak (lucide `wifi-off`, `wifi`, `wifi-low`), battery with a charging bolt variant, keyboard layout `EN` / `UR`. All are `aria-hidden`, and the same data is exposed as text in the offline badge and in `aria-describedby` on the form.

## Intended animations

All animations use only `transform` and `opacity`. Tokens:
- `--ease-spring: linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077 20.4%, 1.121, 1.149 24.3%, 1.159, 1.163 27%, 1.154, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1)`
- `--ease-out-soft: cubic-bezier(0.22, 1, 0.36, 1)`
- `--ease-snappy: cubic-bezier(0.34, 1.56, 0.64, 1)` (slight overshoot)

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| 1 | Wallpaper | Screen mount | opacity 0 to 1; transform scale(1.08) to scale(1) | 900ms | `--ease-out-soft` | opacity only, 200ms |
| 2 | Wallpaper glow blobs (2-3 layers) | Always (ambient) | transform translate(±24px) and rotate(±4deg) loop | 24s per cycle, alternate | `linear` | Static; no loop |
| 3 | Date + clock | Mount (after 120ms) | opacity 0 to 1; translateY(-12px) to 0 | 600ms | `--ease-spring` | opacity only, 150ms |
| 4 | Clock digits | Minute change | Outgoing digit: opacity 1 to 0, translateY(0 to -8px). Incoming: opacity 0 to 1, translateY(8px to 0) | 320ms | `--ease-out-soft` | Instant swap |
| 5 | Avatar row tiles | Mount (staggered 60ms each, from 220ms) | opacity 0 to 1; translateY(16px) to 0; scale(0.9) to 1 | 520ms | `--ease-spring` | opacity only, 150ms, no stagger |
| 6 | Avatar tile | Hover / press | scale 1 to 1.06 / to 0.96 | 180ms / 90ms | `--ease-snappy` / `--ease-out-soft` | No scale; opacity 0.7 to 1 |
| 7 | Avatar selection change | Click / arrow keys | New selection scale(0.57) to 1 (64 to 112px via transform); previous selection 1 to 0.57; the row re-centres with translateX (FLIP) | 420ms | `--ease-spring` | Instant swap with 120ms opacity crossfade |
| 8 | Selected avatar halo | While selected | opacity 0.35 to 0.6 breathing, scale 1 to 1.04 | 3.2s loop, alternate | `ease-in-out` | Static halo at 0.45 |
| 9 | Password pill + hint | Selection settles / mount (after 380ms) | opacity 0 to 1; translateY(8px) to 0; scale(0.96) to 1 | 360ms | `--ease-spring` | opacity only, 150ms |
| 10 | Password dots | Each keystroke | New dot scale(0) to 1, opacity 0 to 1 | 160ms | `--ease-snappy` | Instant |
| 11 | Arrow button | Field becomes non-empty | opacity 0.5 to 1; scale 0.9 to 1 | 200ms | `--ease-snappy` | opacity only |
| 12 | Verifying sweep | Submit (loading) | Highlight layer translateX(-100% to 100%) across the pill, looping; spinner rotate 0 to 360deg | 1.2s loop; spinner 800ms loop | `linear` | Static spinner replaced by text `Verifying…` |
| 13 | Wrong-password shake | Error | translateX keyframes 0, -10, 9, -7, 5, -3, 0 px | 420ms | `cubic-bezier(0.36, 0.07, 0.19, 0.97)` | No shake; border colour + `role=alert` text only |
| 14 | Error hint text | Error | opacity 0 to 1; translateY(-4px) to 0 | 200ms | `--ease-out-soft` | opacity only |
| 15 | Offline badge | Connectivity change | Appear: opacity 0 to 1, scale 0.9 to 1, translateY(6px to 0). Disappear: reverse | 280ms in / 200ms out | `--ease-spring` / `--ease-out-soft` | opacity only, 120ms |
| 16 | Offline badge dot | While offline / reconnecting | opacity 1 to 0.4 pulse, scale 1 to 1.3 | 1.6s loop | `ease-in-out` | Static dot |
| 17 | Power buttons | Mount (stagger 50ms from 500ms) | opacity 0 to 1; translateY(12px) to 0 | 420ms | `--ease-spring` | opacity only |
| 18 | Power button | Hover / press | translateY(0 to -2px) + scale 1.04 / scale 0.94 | 180ms / 90ms | `--ease-snappy` | No transform; opacity change of the fill layer |
| 19 | Power confirm morph | First click on Restart / Shut Down | Button scaleX morph into a pill (FLIP on the wrapper), label opacity crossfade; `Cancel` slides in translateX(8px to 0) | 300ms | `--ease-spring` | Instant swap |
| 20 | Successful sign-in: whole lock layer | Password verified | Avatar + pill: scale 1 to 1.04 and opacity to 0; clock translateY(0 to -24px), opacity to 0; wallpaper scale 1 to 1.06, opacity to 0 revealing the desktop (the desktop fades from scale 0.98 to 1) | 560ms | `--ease-out-soft` | 200ms crossfade |
| 21 | Sleep | Click Sleep | Whole screen opacity 1 to 0 to black overlay; the clock stays dimmed | 600ms | `--ease-out-soft` | Instant black |
| 22 | Popovers (Accessibility / Language) | Open / close | opacity 0 to 1, translateY(4px to 0), scale 0.98 to 1 from the button's origin | 200ms / 140ms | `--ease-spring` / `--ease-out-soft` | opacity only |
| 23 | Focus ring | Focus-visible | Ring pseudo-element scale 1.15 to 1, opacity 0 to 1 | 160ms | `--ease-snappy` | Instant ring |

Reduced motion is implemented with `@media (prefers-reduced-motion: reduce)` and with the Plotinium `Reduce motion` setting (a `data-reduce-motion` attribute on `<html>`). Both remove every loop and transform and keep only short opacity fades.

## Accessibility: landmarks and roles

- `<main aria-label="Sign in to Plotinium">` wraps the whole lock screen. The wallpaper is a decorative `aria-hidden` layer.
- The clock is `<time datetime="2026-09-24T10:42">` inside a `<header>` with `aria-live="off"`, so it is not announced every minute.
- The user picker is `role="radiogroup"` with `aria-label="Choose user"`; each tile is `role="radio"` with `aria-checked`. Arrow keys move the selection with a roving tabindex, and Enter or Space selects.
- `<form aria-label="Password for student">` contains the `<input type="password" autocomplete="current-password" aria-describedby="hint offline-status">` and a `<button type="submit" aria-label="Sign in">`. The hint and error use `role="alert"`, and the countdown uses `aria-live="polite"`.
- The offline badge is `role="status"`.
- Power controls are a `<nav aria-label="Power">` holding three `<button>`s with visible labels. Confirm states use `aria-describedby` for `Shut Down?`.
- The bottom-left branding is a `<footer>`; the logo SVG has `role="img"` and `aria-label="Plotinium"`.
- The Accessibility and Language buttons use `aria-haspopup="dialog"` / `"listbox"` and `aria-expanded`. Popovers trap focus and close on Escape.
- On mount the password input is auto-focused (focus goes to the selected user's field). The tab order is: user picker, password, submit, Forgot password, badge (skipped), power buttons, accessibility, language.
- Contrast: all text sits over a darkened scrim (vignette plus rgba(4,3,14,0.18)) or on a glass tint. Label tokens are primary 92%, secondary 68% and tertiary 64% white. Tertiary was raised from 50% after the reference review, because 12px hint text at 50% measured about 3.6:1 on the violet glow. Together these meet WCAG 2.2 AA: 4.5:1 for body text and 3:1 for the large clock. Information is never conveyed by colour alone: the badge has an icon plus text, and the error has an icon plus text.
