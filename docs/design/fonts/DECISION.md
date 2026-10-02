# D15 Typography: decision record

| Field        | Value                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status       | Decided 2026-09-27; mono role revised 2026-09-30 by the §9 reversal trigger (§0). AI-assisted evaluation; the team re-scores it in a pre-registration PR, see "Where the scores come from" in `specs/15-decisions/stack-decisions.md` |
| Decision     | **UI: Inter 4, variable, with the optical-size axis (opsz 14–32, wght 100–900). Mono: JetBrains Mono, variable (wght 100–800), since 2026-09-30 (§0); Geist Mono before that.**                                                       |
| Replaces     | Inter (wght axis only, every subset) and JetBrains Mono 400/500/700 (static, Latin)                                                                                                                                                   |
| Short record | `specs/15-decisions/stack-decisions.md`, "D15 — Typography"                                                                                                                                                                           |
| Specimen     | `docs/design/fonts/specimen/` (static page with a real xterm.js; capture script `shoot.mjs`)                                                                                                                                          |
| Screenshots  | `docs/design/polish/fonts/` (specimen 1x/2x light/dark, gallery and real-app before/after)                                                                                                                                            |
| Machine      | Linux 7.0, Google Chrome 153.0.8010.52 (Playwright channel `chrome`), grayscale antialiasing, 1x and 2x device scale factor                                                                                                           |

## 0. Revision 2026-09-30: the mono role moves to JetBrains Mono (UI-004)

**What happened.** The polish-wave triage found that Geist Mono draws `r` like a small-capital `ɪ` at 12, 13 and 14 px on a **1x** screen, at weights 400 and 450, in both themes: `drwxr-xr-x` reads `drwxɪ-xɪ-x`, `root` reads `ɪoot`, `error` reads `eɪɪoɪ` (`docs/design/polish/triage/mono-r-compare-1x.png`, `mono-r-compare-14px-zoom3.png`). The original c2 test (§3) zoomed the 1x renders but looked at `rn`/`m`, `l`/`I`/`1` and `0`/`O`, not at a lone `r`, and the 2x renders are clean, so the evaluation missed it. The lab machines may be 1x. This is exactly the §9 reversal trigger, so its action was taken.

**Re-score (c2, 1x legibility, with the new evidence).** Geist Mono drops from 4 to **1**: the anchor for 1 is "glyphs collide at 11–12 px", and here a glyph misreads as another letter up to 14 px. JetBrains Mono keeps 5 (every test string clear at 12–14 px, 1x and 2x; `docs/design/polish/fix-apps-settings-a11y/mono-specimen-1x-{light,dark}-zoom2.png`). Nothing else changes: the variable JetBrains Mono package has the same c1, c3, c4, c5 and c6 scores as §4's row.

| Option             | c1 (30) | c2 (25) | c3 (15) | c4 (10) | c5 (15) | c6 (5) | **Total** |
| ------------------ | ------- | ------- | ------- | ------- | ------- | ------ | --------- |
| **JetBrains Mono** | 3       | 5       | 3       | 4       | 4       | 5      | **3.85**  |
| Geist Mono         | 5       | **1**   | 3       | 5       | 5       | 5      | 3.70      |
| Google Sans Code   | 2       | 4       | 3       | 5       | 3       | 5      | 3.25      |

The new winner is **fragile**: 0.15 apart. A c2 score of 2 for Geist Mono would give it 3.95 and the win back. It rests on c2, which is a hard requirement (constraint 3), so a tie still goes to the face that is legible.

**What shipped.**

- `ui/src/tokens/fonts.css`: `JetBrains Mono Variable` from `@fontsource-variable/jetbrains-mono` 5.3.0 (Latin 40,404 B, Latin Extended 15,196 B), `font-display: swap`, with `font-feature-settings: 'calt' 0` in each `@font-face`, so `->`, `!=` and `==` stay the typed characters (checked in Chrome 153: `docs/design/wave3/fix-apps-settings-a11y/ui-004-calt-probe.png`, the two lines are identical).
- `ui/src/tokens/tokens.css`: `--pl-font-mono` leads with `'JetBrains Mono Variable'`, then the system mono stack. `ui/src/tokens/fonts.test.ts` checks the family, the two subsets and that every file exists.
- Box drawing: the fontsource JetBrains Mono subsets have none, so `tree` rules come from the system mono face (DejaVu Sans Mono on the lab's Linux). xterm sizes each fallback glyph to its cell, so columns stay aligned.
- Given up: Geist Mono's closer SF Mono feel (c1) and its own box-drawing subset, and 17 KB per first load.
- `@fontsource-variable/geist-mono` stays installed for the specimen page and is no longer shipped. `THIRD_PARTY.md` §2.2 lists every font package and whether it ships.

**New reversal trigger.** If a JetBrains Mono complaint appears at 12–14 px on 1x (for example the taller x-height crowding the Terminal's 1.2 line height), re-run the §2 specimen at 1x with a lone-`r` string for every candidate before switching.

## 1. Constraints

1. **Self-hosted only.** The CSP (`default-src 'self'`), COEP `require-corp` and offline boot (C10, C11) rule out the Google Fonts CDN. Every candidate comes from an `@fontsource` package already installed in `ui/`, under OFL-1.1.
2. **macOS-inspired, not Apple's.** SF Pro and SF Mono are the look we are aiming for. We never ship them (DSN-22).
3. **Legible at 11–13 px at 1x on Linux Chrome.** That is where most Plotinium text lives: the menu bar, sidebars, tables and captions.
4. **Boot budget.** Fonts are not JavaScript and are not on the boot-critical path (DSN-27), but every woff2 is precached by the Service Worker (`web/src/sw/routes.ts`), so size still counts.
5. **Terminal glyphs.** The shell prints `─ │ ├ └` (`tree`, the kernel-confirmation rule), `→ ↑ ↓ · … ✓ ✗` and tabular `ps` columns.

## 2. Candidates and measured facts

The axes and OpenType features come from each file's `fvar` and `GSUB` tables (fontTools 4.63). Sizes are the Latin woff2 in bytes, as installed. Glyph coverage was checked with `cmap`.

| Candidate (package)                          | Latin woff2 | Axes in the file                                         | Notable features       | x-height / cap | Box drawing `─│├└`       | `→`                      |
| -------------------------------------------- | ----------- | -------------------------------------------------------- | ---------------------- | -------------- | ------------------------ | ------------------------ |
| Inter 4, opsz (`@fontsource-variable/inter`) | 72.9 KB     | opsz 14–32, wght 100–900                                 | tnum, pnum, frac, calt | 0.546 / 0.728  | no                       | no                       |
| Inter, wght only (shipped until now)         | 48.3 KB     | wght 100–900                                             | tnum, pnum, frac, calt | 0.546 / 0.728  | no                       | no                       |
| Inter Tight (`inter-tight`)                  | 44.9 KB     | wght 100–900                                             | tnum, pnum, frac       | 0.546 / 0.728  | no                       | no                       |
| Geist (`geist`)                              | 29.4 KB     | wght 100–900                                             | tnum, pnum, liga       | 0.530 / 0.710  | no                       | no                       |
| Google Sans Flex, opsz (`google-sans-flex`)  | 119.9 KB    | opsz 6–144, wght 1–1000                                  | tnum, zero, ss01, ss02 | 0.510 / 0.716  | no                       | no                       |
| JetBrains Mono (`jetbrains-mono`)            | 40.4 KB     | wght 100–800 (static files: none)                        | calt                   | 0.550 / 0.730  | **no subset has it**     | no                       |
| Geist Mono (`geist-mono`)                    | 23.1 KB     | wght 100–900                                             | frac                   | 0.530 / 0.710  | yes, `symbols2` (5.8 KB) | no                       |
| Google Sans Code (`google-sans-code`)        | 34.5 KB     | wght 300–800 (MONO axis only in the `mono`/`full` files) | ss01                   | 0.523 / 0.716  | yes, `symbols2` (6.4 KB) | yes, `symbols` (17.4 KB) |

Findings that decided things:

- **The Google Fonts build of Inter has no character variants or stylistic sets.** `cv11` (single-storey a) and `ss01` (open digits), which `--pl-font-features` has turned on since the first commit, were silent no-ops with the web font. They only took effect when a locally installed full Inter was used as the boot fallback, so boot and desktop could draw different glyphs. The disambiguation sets (`ss02`, `cv05`, `cv08`) are missing too, so `I` and `l` look the same in every UI candidate (Google Sans Flex has a `zero` feature, no `l` feature).
- **No UI candidate's Latin subset contains `→` (U+2192),** although `↑` and `↓` are there. The arrow comes from the system fallback in every option, as it did before.
- **JetBrains Mono from fontsource has no box-drawing characters in any subset.** `tree` and the confirmation rules were drawn in DejaVu Sans Mono.

## 3. Criteria, weights and anchored scales

The weights sum to 100. Scores run from 1 to 5, and the total is the weighted mean (stack-decisions.md §5.1).

| #   | Criterion                                                                         | Weight | 5                                                                              | 3                                                                                   | 1                                                  |
| --- | --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| c1  | Closeness to the SF feel (UI: SF Pro Text/Display; mono: SF Mono)                 | 30     | neo-grotesque with Text and Display optical sizes; mono: neutral, slashed zero | neo-grotesque without optical sizes; mono: programmer face with its own personality | a brand voice clearly unlike SF (geometric, swash) |
| c2  | Legibility at 11–13 px, 1x, Linux Chrome (zoomed 3x, nearest-neighbour)           | 25     | every test string clear at 11 px, `rn` ≠ `m`                                   | fine at 13 px, weaker at 11 px                                                      | glyphs collide at 11–12 px                         |
| c3  | Variable axes                                                                     | 15     | weight + optical size                                                          | weight only                                                                         | static files                                       |
| c4  | Glyphs: tabular figures, l/I/1 and 0/O (mono: plus box drawing from its own face) | 10     | all present                                                                    | tabular, but one pair is ambiguous or the box drawing falls back                    | no tabular figures                                 |
| c5  | Latin woff2 size (the file the first screens need; precached offline)             | 15     | ≤ 30 KB                                                                        | ≤ 65 KB (4: ≤ 50 KB; 2: ≤ 80 KB)                                                    | > 80 KB                                            |
| c6  | Licence                                                                           | 5      | OFL-1.1                                                                        | –                                                                                   | not redistributable                                |

## 4. Scores

### UI sans

| Option                    | c1 (30) | c2 (25) | c3 (15) | c4 (10) | c5 (15) | c6 (5) | **Total** |
| ------------------------- | ------- | ------- | ------- | ------- | ------- | ------ | --------- |
| **Inter 4, opsz + wght**  | 5       | 5       | 5       | 3       | 2       | 5      | **4.35**  |
| Inter, wght only (before) | 4       | 5       | 3       | 3       | 4       | 5      | 4.05      |
| Geist                     | 4       | 4       | 3       | 3       | 5       | 5      | 3.95      |
| Google Sans Flex, opsz    | 2       | 4       | 5       | 4       | 1       | 5      | 3.15      |
| Inter Tight               | 3       | 2       | 3       | 3       | 4       | 5      | 3.00      |

### Monospace

| Option                  | c1 (30) | c2 (25) | c3 (15) | c4 (10) | c5 (15) | c6 (5) | **Total** |
| ----------------------- | ------- | ------- | ------- | ------- | ------- | ------ | --------- |
| **Geist Mono**          | 5       | 4       | 3       | 5       | 5       | 5      | **4.45**  |
| JetBrains Mono (before) | 3       | 5       | 3       | 4       | 4       | 5      | 3.85      |
| Google Sans Code        | 2       | 4       | 3       | 5       | 3       | 5      | 3.25      |

### Sensitivity (stack-decisions.md §4.3)

| Weighting                          | UI: 1st / 2nd                            | Mono: 1st / 2nd                           |
| ---------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Declared weights                   | Inter 4 4.35 / Inter wght 4.05           | Geist Mono 4.45 / JetBrains Mono 3.85     |
| Equal weights                      | Inter 4 4.17 / Inter wght and Geist 4.00 | Geist Mono 4.50 / JetBrains Mono 4.00     |
| c1 ±10                             | Inter 4 stays first                      | Geist Mono stays first                    |
| c2 ±10                             | Inter 4 stays first                      | Geist Mono stays first                    |
| c5 +10 (size matters more)         | **tie**: Inter 4 4.07 / Geist 4.07       | Geist Mono stays first                    |
| every other ±10                    | Inter 4 stays first                      | Geist Mono stays first                    |
| Top criterion (c1) removed         | **tie**: Inter 4 / Inter wght 4.07       | **tie**: JetBrains Mono / Geist Mono 4.21 |
| Rank-reversal distance, 1st vs 2nd | **7.5 points (fragile)**                 | 20 points                                 |

The UI record is **fragile** by the §4.3 rule. What decides it is how much the optical-size axis is worth against 24.6 KB of extra woff2. The fallback is named in advance: **Inter wght only**, a one-line change to `ui/src/tokens/fonts.css` (`inter-latin-opsz-normal` → `inter-latin-wght-normal`, same family name, no token change). The mono record is robust.

## 5. Evidence

Specimen (`docs/design/polish/fonts/specimen/`, every section at 1x and 2x, light and dark; `fonts-loaded.json` shows all eight specimen faces loaded, with no failed request):

- **SF feel and optical size.** In `clock-*.png` and `heads-*.png`, Inter 4 draws the 96/120 px weight-200 clock and the 22–36 px bold headlines in its Display cut: tighter spacing and finer joins, the way SF Pro Display does. The wght-only build uses the Text design at every size, so large type looks loose. Google Sans Flex reads as Google's own voice (round, geometric `4`, `G`, `a`). Geist is close to SF but has no optical sizes. The `heads` section also compares three tracking variants: none, Inter's full dynamic metrics, and half of them (the shipped scale). With the Display cut, full dynamic tracking crowds `ni` and `li` at 34 px.
- **11–13 px at 1x.** In the zooms `zoom-1x-legibility-*.png` (3x nearest-neighbour of the 1x render), Inter 4 is the clearest at 11 px. **Inter Tight merges `rn` into `m` at 11 px.** Geist and Google Sans Flex are clean but read smaller (x-height 0.53 and 0.51 against Inter's 0.546).
- **Tabular figures.** `table-*.png` shows PID, % CPU and Memory right-aligned in every candidate; all of them carry `tnum`.
- **Terminal (a real xterm.js 6, DOM renderer, 13 px, line height 1.2).** In `mono-*.png`, Geist Mono draws `├── └──` and the confirmation rule in its own face, with a slashed zero and a distinct `l`/`I`/`1`. JetBrains Mono falls back to DejaVu Sans Mono for those glyphs. Google Sans Code has swash-like braces `{ }` and the most unusual shapes.

Real UI, before (QA Docker build) and after (a production build served by `vite preview` with the production CSP, proxied to the same QA backend):

- `real-login-clock-{dark,light}@2x-before-after.png`: the login clock and date in Inter 4 Display.
- `real-terminal-{dark,light}-before-after.png`: **before, the production Terminal rendered in Inter (proportional) with no ANSI colours** (see §6). After, it renders in Geist Mono at its configured 14 px, with green and blue prompt colours.
- `real-taskmgr-*-before-after.png` and `gallery-*-before-after.png`: same layout, with the face changes only. Every gallery page kept its exact height (7 pages × 2 themes).
- `document.fonts` after the change: `Inter Variable` (Latin) and `Geist Mono Variable` (Latin, plus `symbols2` once `tree` prints) are `loaded`, and `document.fonts.check()` is true for both, on the login screen and on the desktop in both themes. The fonts arrive 160–380 ms after navigation, `initiator: css`, long before the login screen.
- Font bytes emitted by the web build: **249.9 KB in 5 files, down from 367.3 KB in 13** (Inter Latin + Latin Extended, Geist Mono Latin + Latin Extended + box drawing). This is also what the Service Worker precaches.

## 6. Bugs found while applying the fonts (fixed in this change)

1. **The production Terminal ignored its font and colours.** xterm's DOM renderer styles its rows (font family, cell size, ANSI colour classes, selection, scrollbar) through `<style>` elements it creates at run time. The production CSP (`style-src 'self'` plus the boot hashes) blocks them, so `sheet === null` and the console logs "Applying inline style violates … style-src". The rows then inherited the page's Inter at 13 px. Fix: `mirrorBlockedStyles()` in `ui/src/primitives/internal/csp-styles.ts` (called by `ui/src/apps/terminal/TerminalHost.tsx`) copies each blocked `<style>` into a constructable stylesheet on `document.adoptedStyleSheets` and keeps it in step. CSP does not govern constructable stylesheets (checked in Chrome 153 under `style-src 'self'`). Styles the CSP allows (the dev server) are left alone. Chrome still logs the violation when xterm writes its `<style>`; the styles apply anyway.
   1a. **The production Editor had no CodeMirror styles.** CodeMirror's style-mod puts the base theme and our `EditorView.theme` into one `<style>` at the top of `<head>`; it uses adopted sheets only inside a shadow root. The same CSP refused it. On the QA build, `.cm-editor` was `display: block; position: static`, the gutter number sat above the text, and the code was drawn in Inter (`real-editor-dark-before-after.png`). Fix: `CodeEditor.tsx` calls `mirrorBlockedHeadStyles(document)` (same module, once per document, never disposed because style-mod never removes its element). After the fix, on the QA build: 93 CodeMirror rules adopted, `.cm-editor` is flex and relative, and `.cm-scroller` is Geist Mono at 20.8 px line height.
   1b. **A black strip at the bottom of the Terminal.** xterm.css paints `.xterm .xterm-viewport` `#000`; the fitted rows (17 × 21 px = 357 px in a 360 px host) leave 3 px of it visible, in both themes. It predates this change and has nothing to do with fonts. Fix: `Terminal.module.css` makes the viewport transparent so the host's `--pl-surface` shows (`real-terminal-viewport-after.png`).
2. **The Terminal never used the `--pl-font-mono` token.** `createTokenResolver` probes tokens through `color`. For a font list that returns the inherited text colour, so the host always fell back to a hard-coded `'JetBrains Mono'`. Fix: `monoFontFamily()` reads the custom property directly.
3. **The xterm cell was measured with the fallback face.** xterm measures once, at `open()`. The web font was usually still loading, so rows were 18 px instead of 20 px at 13 px, which tightened the line height by about 10%. Fix: `whenFontLoaded()` measures again once the face has loaded (gallery: 18 px before, 20 px after).
4. **`'cv11', 'ss01'` were no-ops** (§2). `--pl-font-features` is now `normal`, which also gives the SF-like double-storey `a`.
5. **The `font` shorthand resets `font-variant-numeric`** (checked in Chrome 153; it also resets `font-feature-settings` and `font-optical-sizing`). A table cell styled with `font: var(--pl-type-*)` lost the table's tabular figures. The reset layer now gives tables, grids, rows, cells, meters and progress bars `font-variant-numeric: tabular-nums`. This is the high-level form of `'tnum'` and does not clobber other features.

## 7. What changed

- `ui/src/tokens/fonts.css`: hand-written `@font-face` rules pointing at the fontsource files, Latin and Latin Extended only (plus Geist Mono `symbols2`), `font-display: swap`, family names `Inter Variable` and `Geist Mono Variable`.
- `ui/src/tokens/tokens.css` (typography block and reset):
  - `--pl-font-mono` now leads with Geist Mono, and `--pl-font-features: normal`.
  - New `--pl-weight-thin: 200`.
  - An SF-like tracking scale: `--pl-tracking-open` +0.005em (11 px and below), none at 12–16 px, `--pl-tracking-title` −0.008em (20–22 px), `--pl-tracking-tight` −0.01em (28–36 px, unchanged), `--pl-tracking-display` −0.02em (64 px and up), and `--pl-tracking-caps` unchanged.
  - `font-optical-sizing: auto` on the root.
  - Tabular figures for tables and meters.
  - Minified and gzipped, tokens.css is 4,485 bytes of the 5,120-byte DSN-39 budget.
- `ui/src/apps/terminal/`:
  - `theme.ts`: `TERMINAL_FONT_FALLBACK` (Geist Mono), `monoFontFamily()` and `whenFontLoaded()`.
  - `TerminalHost.tsx`: the style mirror (from `ui/src/primitives/internal/csp-styles.ts`), the token font, and the re-measure.
  - `Terminal.module.css`: the transparent viewport (§6, 1b).
  - Tests: `UI-TerminalTheme …`, `UI-TerminalHost measures the cell again …` and `UI-TerminalStyles …` (the helper, the host under a refused `<style>`, and the viewport rule).
- `ui/src/primitives/internal/csp-styles.ts`: `mirrorBlockedStyles()` and `mirrorBlockedHeadStyles()`, shared by the Terminal and the Editor so neither imports the other.
- `ui/src/apps/editor/CodeEditor.tsx`: installs the head mirror for CodeMirror's `<style>` (§6, 1a); test `UI-EditorStyles …` in `CodeEditorStyles.test.tsx`. The font itself needed no change: the CodeMirror theme already uses `var(--pl-font-mono)`, and CodeMirror re-measures on `document.fonts.ready`.
- `web/index.html` is unchanged. See §8.
- Stitch: both design systems (`assets/10121591451242352758` dark, `assets/3690503530025860907` light) keep `INTER` for headline, body and label (Geist Mono has no enum value). Their `designMd` Type sections now describe optical sizing, the tracking scale, tabular figures and Geist Mono.

## 8. Preload: measured and not shipped

A `<link rel="preload" as="font" crossorigin>` for the Latin Inter file was built and measured. In the production build Vite rewrote it to the same hashed URL the stylesheet uses; it was fetched once (no double download), at about 20 ms instead of about 160 ms, and the boot JS budget was unaffected. It was still not shipped, for two reasons:

- It does not help: without it, the splash wordmark already uses `--pl-font-ui`, so the host stylesheet starts the download at 160–380 ms, seconds before the login screen appears.
- Its path breaks `pnpm dev`. The file sits outside `web/`, the Vite dev server does not rewrite a relative `href` there, and the request got `index.html` back as `text/html`: a wasted request and a console warning.

The boot splash keeps the fallback stack (DSN-27).

## 9. Reversal triggers

- Either font makes a gate fail: offline precache over budget, or a lab-machine boot measurement shows the 72.9 KB opsz file delays the first login-screen frame by more than 50 ms against the wght file. Action: swap to `inter-latin-wght-normal` (§4 fallback).
- A user-visible script outside Latin and Latin Extended needs the brand face. Action: add that subset's `@font-face` (the files are in the same package).
- xterm or CodeMirror gains a CSP-safe style path (nonce or constructable sheets upstream), or xterm's WebGL addon is adopted. Action: drop that library's call to `csp-styles.ts`.
- Geist Mono shows a legibility complaint at 13–14 px on the lab machine's 1x display. Action: JetBrains Mono variable (40.4 KB; box drawing stays on the fallback face). **Fired 2026-09-30 (UI-004); see §0.**

## 10. Follow-ups for other owners (outside this change's write scope)

- `specs/05-wm/visual-language-macos.md` §3.5 and DSN-27 still say "Inter (wght) and JetBrains Mono 400/500/700" and `'cv11', 'ss01'`; they should point to D15. The `mono` role row there says JetBrains Mono.
- `THIRD_PARTY.md` §2.2: list `@fontsource-variable/geist-mono` 5.3.0 (OFL-1.1, Copyright 2024 The Geist Project Authors). Drop `@fontsource/jetbrains-mono` once the package is removed. Change Inter to "opsz + wght, Latin and Latin Extended".
- `ui/gallery/pages/tokens.tsx` ("Inter (variable) and JetBrains Mono") and the comment on line 8 of `ui/src/index.ts` still name JetBrains Mono.
- Packages that are no longer needed (not removed here): `@fontsource/jetbrains-mono`, `@fontsource-variable/jetbrains-mono`, `@fontsource-variable/inter-tight`, `@fontsource-variable/geist`, `@fontsource-variable/google-sans-flex`, `@fontsource-variable/google-sans-code`. **Keep `@fontsource-variable/inter` and `@fontsource-variable/geist-mono`.** (Revised 2026-09-30, §0: keep `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`; `geist-mono` is specimen-only now.) The specimen page reads the other packages from `ui/node_modules`, so it stops rendering them once they are removed. The committed screenshots stay as the record.
- **Static JSX `style={{…}}` attributes are dropped in production** (found while verifying this change). Solid compiles a static style object into a `style="…"` attribute in its template HTML, and the CSP refuses those (`style-src-attr`). On the QA build, opening each app logged enforced violations: Editor 6, Files 2, Task Manager 1, Settings 1. Decision: move them to CSS modules or tokens, and keep the CSP strict. The owners are listed in the wave's bug list.

## How to reproduce

```sh
python3 -m http.server 4791 --bind 127.0.0.1          # from the repository root
open http://127.0.0.1:4791/docs/design/fonts/specimen/  # ?only=<section id> shows one section
node docs/design/fonts/specimen/shoot.mjs http://127.0.0.1:4791 docs/design/polish/fonts/specimen
```
