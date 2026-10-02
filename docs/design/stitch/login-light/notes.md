# Login / Lock screen: light

- **Stitch project:** 12849137298552292712
- **Stitch screen id:** none. `generate_screen_from_text` returned `sessionId 2240624124644553619` but no screen. `list_screens` stayed empty for 17 polls (15:23 to 15:46 UTC), and `get_screen` on the session id returned *not found*. The raw response is in `screen.json`.
- **Design system:** `assets/3690503530025860907` (Plotinium Glass: Light)
- **Model:** GEMINI_3_8_FLASH, device DESKTOP (1440x900)
- **Files:** `screen.json` (raw Stitch response). No Stitch `screen.html` or `screenshot.png` exists yet.
- **Fallback reference:** `reference.html` + `reference.png` are a hand-built render of this exact prompt using the design-system tokens, rendered at 1440x900 in headless Chrome. They are NOT a Stitch export. `reference.html` implements the mount, hover, press, focus, halo, badge, shake and orbit animations below, plus the `prefers-reduced-motion` fallback, so it doubles as a motion prototype. Re-run the prompt below in Stitch when the service is responsive, then save `screen.html` and `screenshot.png` beside these files.
- **Sibling:** `../login-dark/notes.md` uses the same structure and motion spec. This file lists only the light-specific values and the one content difference: the status pill here is `Signed-in sessions: 1`, where the dark screen shows the offline badge.

## Final prompt

```text
Screen title: "Plotinium Login — Light". A desktop 1440x900 lock / login screen for Plotinium, an AI-native web operating system, in LIGHT mode. Visual quality of the latest macOS lock screen (Liquid Glass era) but with its own identity. NO Apple logo, no Apple app names, no SF Symbols; use thin lucide-style line icons only. Font: Inter (or similar geometric sans), light weights for the clock.

BACKGROUND: full-bleed wallpaper — a soft daylight violet gradient (pale lavender #EEEBFF, periwinkle #C9C6FF, a luminous #5E5CE6 violet glow and a hint of peach/pink #FFD9E8 near the bottom-right), heavily blurred (60px gaussian), airy and bright with a gentle white haze at the top so dark text reads well.

TOP CENTRE: small date line 'Thursday, 24 September' in dark ink #1C1B2E at 70% (medium, 20px), and under it a very large thin clock '10:42' (ultra-light weight about 120px, dark ink #1C1B2E at 85%).

TOP-RIGHT CORNER small status cluster with no background: Wi-Fi icon, battery icon '82%', keyboard label 'EN' — dark ink icons.

CENTRE: a horizontal row of user avatars with names beneath, left to right:
 - 'alice' (64px circle, soft pastel initial avatar 'A', 75% opacity)
 - 'student' — SELECTED, enlarged 112px circular avatar with a 2px white ring and a soft violet #5E5CE6 halo shadow; name 'student' in dark ink semibold 18px
 - 'bob' (64px circle, initial 'B', 75% opacity)
 - 'Guest' (64px frosted white-glass circle with a user outline icon, 75% opacity)

Under the selected avatar: a frosted glass password pill field (260x40px, fully rounded, white at 55% fill with backdrop blur, 1px white 80% inner highlight, faint violet shadow) with the placeholder 'Enter password' in dark ink 45%, and a small circular violet #5E5CE6 arrow button with a white right-arrow icon at the right end inside the pill. Under the field a hint 'Press Enter to sign in' in dark ink 50% 12px and a link 'Forgot password?' in violet #5E5CE6.

Below that: a small glass status pill with a green dot and a users icon reading 'Signed-in sessions: 1' (12px, dark ink 70%, white glass background at 50%, rounded full).

BOTTOM CENTRE: three circular white-glass buttons 48px (frosted translucent white, 1px white border, soft diffuse violet-grey shadow) each with a dark lucide line icon and a label below: 'Sleep' (moon icon), 'Restart' (rotate-ccw icon), 'Shut Down' (power icon). Labels 12px dark ink 65%.

BOTTOM-LEFT: small branding — an abstract luminous atom logo (bright violet nucleus dot with 2 thin elliptical orbit rings in #5E5CE6, no radiation symbols) followed by 'Plotinium 0.3.0' in 12px dark ink 55% and 'build a1f93c2' in 11px monospace 40%.

BOTTOM-RIGHT: small glass icon buttons for accessibility (person-standing icon) and language (globe icon 'English').

Overall: airy, premium, lots of white space, centred composition, soft large shadows, layered white glass with vibrancy, crisp readable contrast (dark text on light glass), macOS-grade finish.
```

## Layout (top to bottom)

| Zone | Content |
|---|---|
| Wallpaper | Daylight violet gradient: lavender #EEEBFF, periwinkle #C9C6FF, #5E5CE6 glow, peach/pink #FFD9E8 at bottom-right; 60px blur; white haze at the top |
| Top-right status | Wi-Fi, battery `82%`, keyboard `EN` in dark ink |
| Top centre | `Thursday, 24 September` (20px, ink #1C1B2E at 70%) above `10:42` (~120px ultra-light, ink 85%) |
| Centre | Avatar row: `alice`, **`student` (selected, 112px)**, `bob`, `Guest` |
| Under selected avatar | White glass pill `Enter password` + violet arrow button; hint `Press Enter to sign in`; link `Forgot password?` (#5E5CE6) |
| Status | White glass pill: green dot + users icon + `Signed-in sessions: 1` |
| Bottom centre | Three 48px white-glass circles: `Sleep` (moon), `Restart` (rotate-ccw), `Shut Down` (power) |
| Bottom-left | Atom logo (#5E5CE6 nucleus + 2 orbits) + `Plotinium 0.3.0`, `build a1f93c2` (mono) |
| Bottom-right | Accessibility (person-standing) and Language (globe, `English`) glass buttons |

## Light-mode material tokens

| Token | Value |
|---|---|
| Ink / label | #1C1B2E at 92%; secondary 72%; tertiary 62% (raised from 50% after the reference review; 12px hint text at 50% measured about 3.6:1 on the lavender glow) |
| Glass fill (pill, buttons) | rgba(255,255,255,0.55); hover 0.70; active 0.80 |
| Glass border | 1px rgba(255,255,255,0.80) inner highlight + 1px rgba(28,27,46,0.06) outer hairline |
| Backdrop | `backdrop-filter: blur(30px) saturate(180%)` |
| Shadow | 0 10px 30px rgba(60,50,140,0.14), 0 1px 2px rgba(28,27,46,0.08) |
| Accent | #5E5CE6; hover #4B49D6 (darker in light mode for contrast); focus ring #5E5CE6 at 55%, 3px |
| Selected halo | 0 0 48px rgba(94,92,230,0.35) + 2px white ring |
| Error | #D70015 border at 55% on the pill, error text #C4001A |
| Success dot | #28A745 (darker than the dark-mode #30D158, for contrast on white glass) |

## Elements and states

The elements match `login-dark`, with these light-mode values.

### User avatar tile (`role=radio`)
- **Default:** 64px, 75% opacity, name 14px ink 65%.
- **Hover:** 100% opacity, scale 1.06, 1px ring rgba(94,92,230,0.25).
- **Focus-visible:** 3px accent ring at 55% offset 3px.
- **Active:** scale 0.96.
- **Selected:** 112px, 2px white ring, violet halo, name 18px semibold ink 92%.
- **Disabled:** 40% plus a lock glyph badge, tooltip `Account disabled`.
- **Signed-in badge:** a green dot on `student`, which matches `Signed-in sessions: 1`.
- **Guest:** replaces the password pill with a `Continue as Guest` glass button.

### Password pill
- **Default:** white glass 0.55, placeholder ink 62%.
- **Hover:** 0.70.
- **Focus:** 0.80 + focus ring; the caret is accent.
- **Filled:** ink dots, and the arrow button becomes active.
- **Caps Lock:** an up-arrow glyph with tooltip `Caps Lock is on`.
- **Show password:** eye toggle with `aria-pressed`.
- **Loading:** spinner in the arrow button, read-only, with a white-violet luminous sweep.
- **Error:** shake, red border, the field clears, hint `Incorrect password — 2 attempts before a 30 s wait` (`role=alert`).
- **Rate-limited:** `Try again in 28 s` countdown, input disabled.
- **Disabled:** 40%.

### Arrow / submit button
- **Empty field:** #5E5CE6 at 45% (`aria-disabled`).
- **Filled:** 100% with a white arrow.
- **Hover:** #4B49D6 + scale 1.06. **Active:** 0.92. **Focus:** 2px white + accent halo.
- **Loading:** spinner.

### Sessions status pill (`role=status`)
- **Default:** `Signed-in sessions: 1` with a green dot and lucide `users` icon, white glass 0.50.
- **Zero sessions:** hidden (cold login).
- **Multiple sessions:** `Signed-in sessions: 2` with a hover tooltip listing `student — since 08:15 · alice — since 09:02`.
- **Offline variant:** swaps to the amber `Offline — using cached verifier` pill (same component as the dark screen).
- **Hover:** tooltip with the session list. **Focus:** accent ring (the pill is focusable only when it has a tooltip).

### Power buttons
- **Default:** 48px white glass, ink icon 20px, label 12px ink 65%.
- **Hover:** fill 0.70, translateY -2px, stronger shadow.
- **Focus:** accent ring. **Active:** scale 0.94.
- **Confirm:** Restart / Shut Down morph into a `Shut Down?` pill plus `Cancel`. When sessions exist, the confirm pill warns `1 user is signed in — unsaved work may be lost`.
- **Disabled:** 35%.

### Forgot password, branding, Accessibility and Language, status cluster
- Same as dark. The link is #5E5CE6 (a 4.9:1 contrast ratio on the lavender glass); the hover state underlines it and darkens it to #4B49D6.

## Intended animations

These are identical in timing and easing to `login-dark` (see that table; items 1 to 23). The light-specific differences:

| # | Element | Trigger | Properties | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|---|---|
| L1 | Wallpaper haze layer | Mount | opacity 0 to 1 over the gradient, translateY(-20px) to 0 | 900ms | `cubic-bezier(0.22, 1, 0.36, 1)` | opacity only, 200ms |
| L2 | Wallpaper colour blobs | Always (ambient) | transform translate(±20px), scale(1 to 1.05) loop | 28s, alternate | `linear` | Static |
| L3 | Sessions pill | Mount (after 460ms) / session count change | opacity 0 to 1, scale 0.9 to 1, translateY(6px to 0). The count digit rolls with translateY(8px to 0) + opacity on change | 280ms | spring `linear()` (as `--ease-spring`) | opacity only |
| L4 | Green session dot | While sessions > 0 | A soft ring pseudo-element scale 1 to 2.2, opacity 0.5 to 0 (ripple) | 2.4s loop | `cubic-bezier(0.22, 1, 0.36, 1)` | Static dot |
| L5 | Glass hover | Hover on pill or power button | A specular highlight layer translateX(-30% to 30%), opacity 0 to 0.6 to 0, simulating light moving across the glass | 600ms | `cubic-bezier(0.22, 1, 0.36, 1)` | None |
| L6 | Successful sign-in | Verified | Same as dark #20, plus a white flash layer opacity 0 to 0.35 to 0 before the desktop is revealed | 560ms | `cubic-bezier(0.22, 1, 0.36, 1)` | 200ms crossfade, no flash |

Easing tokens (shared):
- `--ease-spring: linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077 20.4%, 1.121, 1.149 24.3%, 1.159, 1.163 27%, 1.154, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1)`
- `--ease-out-soft: cubic-bezier(0.22, 1, 0.36, 1)`
- `--ease-snappy: cubic-bezier(0.34, 1.56, 0.64, 1)`

Only `transform` and `opacity` are animated. `backdrop-filter`, blur radius and colour are never animated; state colour changes swap classes on a pre-rendered overlay layer, and the animation is an opacity crossfade of that layer.

## Accessibility: landmarks and roles

These are the same as `login-dark`:
- `<main aria-label="Sign in to Plotinium">`.
- The clock is `<time>` with `aria-live="off"`.
- The user picker is `role="radiogroup"` with `role="radio"` tiles and a roving tabindex.
- The password `<form>` has `autocomplete="current-password"`; the error uses `role="alert"` and the countdown uses `aria-live="polite"`.
- The sessions pill is `role="status"`.
- Power controls are a `<nav aria-label="Power">`.
- The branding is a `<footer>` with the logo as `role="img"` and `aria-label="Plotinium"`.
- The Accessibility and Language popovers use `aria-haspopup` and `aria-expanded`, trap focus and close on Escape.

Light-mode contrast notes:
- Ink text on white glass over the lavender wallpaper keeps at least 4.5:1, because the pill and buttons sit on a 0.55 or higher white tint.
- The clock (ultra-light, 120px) is large text, so 3:1 is required; ink at 85% on #EEEBFF gives about 12:1.
- Tertiary text is never below 62% ink.
- `Increase contrast` raises the glass to 0.85 opacity and adds a 1px ink border at 20%.
