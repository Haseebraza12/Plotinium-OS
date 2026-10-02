# Plotinium identity: usage

The short, practical version of [specs/00-product/identity-and-branding.md](../../specs/00-product/identity-and-branding.md) for anyone placing the logo in the OS, the README, the report, the slides or the demo video. Colours come from the design tokens in `ui/src/tokens/tokens.css` ([ui-design-system](../../specs/05-wm/ui-design-system.md)). If this page and the spec disagree, the spec wins.

## 1. The name

**Plotinium**: a capital P, then eight lower-case letters, one word, with no "OS" suffix and no ™ or ®.

- **Pronunciation:** ploh-TIN-ee-um (/ploʊˈtɪniəm/), stressed like "plu-TOH-nee-um". The spoken test from spec §5.1: _"Boot into Plotinium and open the terminal."_
- **Origin:** a coined word, made from **plutonium**, chemical element 94 (symbol Pu), which was named after the dwarf planet Pluto. It is not a person's name.
- **What it stands for:** only the element's physical character.
  - **Density.** A complete multi-user operating system (processes, paging, a UNIX-like file system, sync and AI services) packed into one browser tab.
  - **Energy.** The system does real work: it boots, schedules, pages, persists and reasons.
  - **Phases.** The element has six solid phases, each with its own crystal lattice. Release codenames follow those lattices (§9).
- **Never written as:** `PLOTINIUM`, `plotinium` (in user-visible text), `PlotiniumOS`, `Plotinium OS`, `Plotinium-OS`, `P.OS` or any abbreviation. The lower-case slug `plotinium` is only for technical identifiers: the npm scope, the database and lock names, the repository and image names.
- **Tagline** (stored once, in [`identity.json`](identity.json)): _A local-first web OS that pages its own memory and lets AI act only through the kernel._

| Say                                                                      | Never say or show                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| "Coined from plutonium, element 94."                                     | Any military, conflict or hazard theme, in words or in pictures.                   |
| "Dense and energetic, like the element."                                 | Hazard signs (the trefoil sign U+2622, warning triangles, hazard stripes, skulls). |
| "Named, like the element, after the dwarf planet Pluto."                 | Cloud shapes, and green or yellow "danger" palettes.                               |
| "Six solid phases; our release codenames follow their crystal lattices." | Any mythological or religious figure called Pluto (banned by spec §5.1).           |

## 2. The files

| File                                           | What it is                                                                                                                | Use it for                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`glyph.svg`](glyph.svg)                       | The mark on its 24-unit grid, flat and pixel-hinted. It follows light and dark mode. Same drawing as the UI's `AtomLogo`. | Small placements: 16 to 48 px, toolbars, badges                        |
| [`glyph-mono.svg`](glyph-mono.svg)             | The mark in one colour (`currentColor`), with no gradient or filter.                                                      | One-ink print, embossing, watermarks, white on a photo                 |
| [`logo.svg`](logo.svg)                         | The full-colour mark: the glyph plus, from 48 px up, a soft glow round the nucleus. It follows light and dark mode.       | Boot screen, Settings → About, README, report cover, slides            |
| [`logo-mono.svg`](logo-mono.svg)               | The same file as `glyph-mono.svg`, kept under the name `/system/branding` has always used.                                | As `glyph-mono.svg`                                                    |
| [`favicon.svg`](favicon.svg)                   | The mark redrawn on a 16-pixel grid: 2 px shell and stem on whole pixels and at least 1 px between shapes.                | `<link rel="icon">` and browser tabs                                   |
| [`wordmark.svg`](wordmark.svg)                 | "Plotinium" in Inter Semibold, converted to outlines.                                                                     | Anywhere the name is shown as artwork rather than live text            |
| [`lockup.svg`](lockup.svg)                     | The mark and the wordmark side by side.                                                                                   | README header, report cover, title slide, the demo video's first frame |
| [`app-icon.svg`](app-icon.svg)                 | A macOS-style app icon: a continuous-corner tile with a violet gradient and the white mark with a glowing nucleus.        | Launchers, docks, installed-app icon, social previews                  |
| [`maskable-icon.svg`](maskable-icon.svg)       | A full-bleed violet square with the mark inside the central 80 % safe zone.                                               | PWA `purpose: "maskable"` and the Apple touch icon                     |
| [`wallpaper-dark.svg`](wallpaper-dark.svg)     | A luminous gradient field in midnight navy, violet and magenta, with faint orbit arcs.                                    | Desktop, login and boot backgrounds in dark mode                       |
| [`wallpaper-light.svg`](wallpaper-light.svg)   | The light version: lilac, lavender and a peach bloom.                                                                     | Desktop and login backgrounds in light mode                            |
| [`manifest.webmanifest`](manifest.webmanifest) | The installable-app manifest: name, tagline, colours and icons.                                                           | Served at `/manifest.webmanifest`                                      |
| [`identity.json`](identity.json)               | The name, tagline, section, team code and members, read by About, the README and the report.                              | The single source of those strings                                     |
| `icons/*.png`                                  | PNG exports, rendered in Chrome from the SVGs (§8).                                                                       | Platforms that need raster icons                                       |

The SVGs are the source of truth. Every file is plain vector (fills and gradients, and one blur filter in the app icons), from 0.6 KB to 5 KB, with no fonts, raster images or scripts. The mark's files are written by [`docs/design/logo/build-identity.mjs`](../design/logo/build-identity.mjs) from the UI's own drawing (`ui/src/icons/atom-logo.ts`), so the kit and the running OS show one mark. Why this mark was chosen: [`docs/design/logo/DECISION.md`](../design/logo/DECISION.md).

## 3. The mark

**The Bohr P.** An electron shell round a dense nucleus, open at 1:30, where the one electron sits. The shell grows a stem on its left, so the atom is also the P of Plotinium, and the electron in the gap is the "plotted point on an orbit" of the identity spec. It is four filled shapes and no strokes:

| Shape    | Geometry on the 24-unit grid                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| stem     | x 4.5 to 7.5, from the shell's centre line down to y 22.5, round at both ends                               |
| shell    | a ring round (12, 9): outer radius 7.5, inner radius 4.5 (3 wide), round ends, open 93°                     |
| nucleus  | a disc of radius 2.8 at (12, 9), 1.7 units clear of the shell                                               |
| electron | a disc of radius 2 on the shell's centre line (radius 6) at -45° (1:30), 1.25 units clear of each shell end |

- **Pixel hinting.** Every edge of the master drawing is a multiple of 1.5 units, so it lands on whole pixels at 16, 32 and 48 px. The UI's `AtomLogo` switches to drawings hinted for 20 px and 24 px at those sizes (`atomLogoFor`). The favicon is redrawn on its own 16-pixel grid.
- **One outline at 16 px.** The outline is two shapes, the P body and the electron. The nucleus sits inside the bowl. Shell and stem are 2 px wide at 16 px; nothing is thinner.
- **On the boot screen** the electron and the shell's gap step once round the nucleus for each real boot event, and the nucleus flashes when a service starts. With reduced motion the electron does not move.

## 4. Clear space and minimum sizes

- **Clear space, mark:** keep at least a quarter of the mark's rendered size clear on every side (for a 96 px boot-screen mark, 24 px). Nothing else (text, window edges, other logos) enters that space.
- **Clear space, wordmark and lock-up:** at least the wordmark's x-height on every side.
- **Lock-up proportions:** the mark's height is 1.25 × the wordmark's cap height, and the gap between them is half the mark's height. The mark is centred on the cap height, so the stem drops below the baseline like a descender. Use `lockup.svg` rather than rebuilding it.

| Asset            | Minimum size                                         | Below that, use |
| ---------------- | ---------------------------------------------------- | --------------- |
| `glyph.svg`      | 16 px                                                | nothing         |
| `logo.svg`       | 24 px; its glow appears from 48 px                   | `glyph.svg`     |
| `favicon.svg`    | 16 px; designed for 16 and 32 px                     | nothing         |
| `glyph-mono.svg` | 16 px                                                | nothing         |
| `wordmark.svg`   | cap height 12 CSS px, which is about 66 px wide      | the mark alone  |
| `lockup.svg`     | 86 px wide (the wordmark's cap height is then 12 px) | the mark alone  |
| `app-icon.svg`   | 32 px                                                | `favicon.svg`   |

Standard placements: boot screen mark 96 px (`--pl-boot-logo`), About 120 px, login corner 28 px, menu bar 17 px.

## 5. Colour

| Role           | Light                                                                            | Dark      | Token                |
| -------------- | -------------------------------------------------------------------------------- | --------- | -------------------- |
| Accent         | `#5856D6`                                                                        | `#5E5CE6` | `--pl-accent`        |
| Shell and stem | `#5856D6`                                                                        | `#B3B1FF` | `--pl-logo-orbit-a`  |
| Nucleus        | `#4F4DC9`                                                                        | `#FFFFFF` | `--pl-logo-core`     |
| Electron       | `#5856D6`                                                                        | `#CFCEFF` | `--pl-logo-electron` |
| Wordmark       | `#1C1C24`                                                                        | `#F4F4FA` | `--pl-text`          |
| Background     | `#EEF0F8`                                                                        | `#0B0D1F` | `--pl-bg`            |
| App-icon field | `#8E8CFF` → `#5E5CE6` → `#3B2A9E`, with a `#C040AA` bloom at the lower right     | same      | none                 |
| App-icon mark  | white, the body shaded to `#ECEBFF` at the foot, the nucleus the brightest shape | same      | none                 |

Inlined into a Plotinium page, the SVGs read these tokens. As standalone files they use the fallback values above: light by default, and dark under `prefers-color-scheme: dark`. If a token changes, update the fallbacks in `build-identity.mjs` and run it again.

Measured contrast (WCAG 2.2): shell 4.96:1 and nucleus 5.70:1 on the light background; shell 9.76:1, electron 12.76:1 and nucleus 19.24:1 on the dark background; wordmark 14.9:1 (light) and 17.6:1 (dark). On the app icon the white mark measures 5.06:1 against the accent at the tile's centre, from 2.86:1 at the lightest corner (`#8E8CFF`) to 10.44:1 at the darkest (`#3B2A9E`); the mark's soft violet shadow keeps its edge visible over the light corner.

**Typography:** the wordmark is Inter Semibold (weight 600, optical size 32, the display cut), tracked −0.02 em, as outlines ([Inter](https://github.com/rsms/inter), SIL OFL 1.1, © The Inter Project Authors). Live UI text uses `--pl-font-ui`. Never retype the wordmark in another font.

## 6. Do

- Use the files as they are and scale them uniformly.
- Put the colour mark on the Plotinium wallpapers or on `--pl-bg` / `--pl-surface`.
- Use `glyph-mono.svg` for one colour, for example white on a photo or on a strong violet. It takes the text colour only when it is inlined or used as a CSS mask (`mask: url(glyph-mono.svg) center / contain no-repeat; background: currentColor`). Loaded through `<img>` it always renders black, because an SVG image cannot inherit `color`.
- In code, use `AtomLogo` from `@plotinium/ui` (it picks the hinted drawing for its size), not an `<img>` of `logo.svg`.
- Use `app-icon.svg` wherever an app tile is expected, and `maskable-icon.svg` wherever the platform crops the icon.
- Keep the mark still, or move it only in response to real events, as the boot screen does, respecting reduced motion. Never loop it (WCAG 2.2.2).

## 7. Don't

- Don't recolour the mark outside the palette above, or swap the nucleus and shell colours.
- Don't close the shell, move the electron out of its gap, change the 1:30 angle, drop the nucleus, or add orbits. Don't go back to the crossed-ellipse atom.
- Don't draw the mark with strokes or thin its shapes: shell and stem stay 3/24 of the mark's box.
- Don't rotate, skew, mirror or stretch the mark (the boot screen's electron step is the only movement).
- Don't add outlines, drop shadows or extra effects to the wordmark or the lock-up (the app icon's own shadows are part of its artwork).
- Don't set the name in another typeface, change its tracking, or write it in any of the variants listed in §1.
- Don't place the colour mark on busy images or on mid-violet backgrounds, where the shell disappears. Use the mono mark in white instead.
- Don't combine the name, the mark or any copy with military, conflict or hazard imagery: no trefoil or warning signs, no hazard stripes, no cloud shapes, no green or yellow "danger" colours.

## 8. On the web

The paths in `manifest.webmanifest` are relative, so copying the kit keeps them valid. Copy `favicon.svg`, `app-icon.svg`, `maskable-icon.svg`, `manifest.webmanifest` and `icons/` into `web/public/` with the layout unchanged, then link them from `index.html`:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#EEF0F8" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0B0D1F" media="(prefers-color-scheme: dark)" />
```

| PNG                          | Size | Rendered from       | Purpose                                               |
| ---------------------------- | ---- | ------------------- | ----------------------------------------------------- |
| `icons/favicon-16.png`       | 16   | `favicon.svg`       | raster favicon fallback                               |
| `icons/favicon-32.png`       | 32   | `favicon.svg`       | raster favicon fallback (high-DPI tabs)               |
| `icons/apple-touch-icon.png` | 180  | `maskable-icon.svg` | `apple-touch-icon` (opaque; iOS applies its own mask) |
| `icons/icon-192.png`         | 192  | `app-icon.svg`      | manifest, `purpose: "any"`                            |
| `icons/icon-512.png`         | 512  | `app-icon.svg`      | manifest, `purpose: "any"`, install dialogs           |
| `icons/maskable-192.png`     | 192  | `maskable-icon.svg` | manifest, `purpose: "maskable"`                       |
| `icons/maskable-512.png`     | 512  | `maskable-icon.svg` | manifest, `purpose: "maskable"`, splash screens       |

To regenerate the PNGs after changing an SVG, run `node docs/identity/render-png.mjs` from the repository root. It renders each SVG in Chrome through Playwright, in the light colour scheme, at one device pixel per CSS pixel.

The wallpapers are 2560 × 1600 and use `preserveAspectRatio="xMidYMid slice"`. Show them with `object-fit: cover` or `background-size: cover`, and mark them `aria-hidden="true"`.

## 9. Versions and the kernel identifier (short form)

- **Versions:** SemVer `MAJOR.MINOR.PATCH`, starting at `0.1.0`. Gate tags are `v0.2.0` (P2), `v0.3.0` (P3), `v0.4.0` (P4), `v1.0.0-rc.N` (freeze) and `v1.0.0` (final). A development build is `X.Y.Z-dev.N`.
- **Codenames** follow the crystal lattices of the element's solid phases, in order of increasing symmetry: `v0.2.x` Monoclinic, `v0.3.x` Orthorhombic, `v0.4.x` Tetragonal, `v1.0.x` Cubic. A codename never replaces the version.
- **`uname -a`:** `Plotinium 0.3.0 (kernel 0.3.0-a1f93c2, built 2026-11-02) · Chrome 154 · 8 cores · uid=1001(alice)`
- **`/system/release`:**

```text
NAME="Plotinium"   VERSION="0.3.0"   BUILD="a1f93c2"
TEAM="Section <S> · Team <NN>"
CODENAME="Orthorhombic"   BUILD_DATE="2026-11-02"   ABI="1"
```
