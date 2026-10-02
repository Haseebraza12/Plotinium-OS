# docs/identity

The Plotinium identity kit (spec §5.2): the Bohr P mark (an electron shell and nucleus that is also the letter P), the wordmark, icons, wallpapers and the web manifest. How to use each file (clear space, minimum sizes, colours, do and don't, the name's origin) is in [usage.md](usage.md). Rules: [specs/00-product/identity-and-branding.md](../../specs/00-product/identity-and-branding.md).

| File                                        | Contents                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `glyph.svg`, `glyph-mono.svg`               | the mark on its 24-unit grid, pixel-hinted: adaptive colour; one colour (`currentColor`)          |
| `logo.svg`, `logo-mono.svg`, `favicon.svg`  | the full-colour mark (a glow from 48 px); one colour (same as `glyph-mono.svg`); the 16 px redraw |
| `wordmark.svg`, `lockup.svg`                | "Plotinium" as Inter Semibold outlines; mark and wordmark side by side                            |
| `app-icon.svg`, `maskable-icon.svg`         | macOS-style app tile; full-bleed maskable icon                                                    |
| `wallpaper-dark.svg`, `wallpaper-light.svg` | desktop, login and boot backgrounds                                                               |
| `manifest.webmanifest`                      | installable-app manifest (relative icon paths)                                                    |
| `identity.json`                             | name, tagline, section, team code, members (`TeamIdentitySchema`)                                 |
| `icons/*.png`                               | 16, 32, 180, 192 and 512 px exports and maskable 192 and 512                                      |
| `render-png.mjs`                            | regenerates `icons/*.png` in Chrome: `node docs/identity/render-png.mjs`                          |

The mark's SVGs are written from the UI's drawing (`ui/src/icons/atom-logo.ts`) and copied into `web/public` by `node docs/design/logo/build-identity.mjs`; run `render-png.mjs` after it and copy `icons/*.png` into `web/public/icons`. The design decision and the size contact sheet are in [docs/design/logo](../design/logo/DECISION.md).

The kit is seeded to `/system/branding` at first boot. `tokens.css` is copied here from `ui/src/tokens/tokens.css` at build time; the copy is not kept by hand.

- **Primary owner:** R3 WM/UI
- **Secondary reviewer:** R5 QA/DevOps
