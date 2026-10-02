# Plotinium: rules for AI coding sessions

Plotinium is an AI-native web OS and a 5-student capstone. The spec is `CapstoneProject-AI-Native WebOS-Fall2026.pdf`, and the normative specs are in `specs/` (index: `specs/README.md`). AI assistance is disclosed in `AI_USAGE.md`, so append an entry for significant AI-generated work.

## Commands

- `pnpm start` (docker compose up -d --wait --build) then http://localhost:4717; `pnpm stop`; `pnpm creds`; `pnpm dev`; `pnpm logs`.
- Checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @plotinium/web build`.

## Standing decisions: do not revert

1. **Strict CSP.** Caddy sends `style-src 'self'` plus hashes, with NO `'unsafe-inline'` and no `style-src-attr` relaxation. Consequences:
   - **No static `style={{…}}` in JSX.** Solid compiles it to a `style="…"` template attribute, which the CSP drops in the Docker build. Put static styles in CSS modules or tokens. Only genuinely dynamic values may use `style` (they go through the CSSOM).
   - **Runtime `<style>` elements are blocked**, for example xterm and CodeMirror. They are mirrored into `document.adoptedStyleSheets` via `ui/src/primitives/internal/csp-styles.ts` (`mirrorBlockedStyles`, `mirrorBlockedHeadStyles`). Keep these.
   - **Verify UI work on the Docker build** with a `securitypolicyviolation` listener (record `disposition`) and 0 enforced violations. Use the QA copy: compose project `plotinium-qa` on :4718. `compose.yaml` pins the edge subnet 172.30.47.0/24, so a QA copy that runs next to :4717 needs an override that moves it (for example to 172.30.48.0/24) and gives it its own image tags. The dev server and the ui gallery do not send the CSP. `vite preview` sends the Caddy CSP, and the dev server sends it Report-Only.
   - The ESLint rule `local/no-static-jsx-style` (`tools/eslint-rules/no-static-jsx-style.js`) flags all-literal `style={{…}}` objects. Do not disable it.
2. **Fonts (D15, revised 2026-09-30):** Inter 4 variable with opsz for the UI, and **JetBrains Mono variable** for code (Terminal, Editor), self-hosted via `ui/src/tokens/fonts.css`. Geist Mono was dropped by UI-004: its `r` reads as `ɪ` at 12–14 px on 1x screens. The other candidate packages stay installed only for the D15 specimen. There is **NO font preload** in `web/index.html`: it breaks `pnpm dev` and the gain is negligible. Decision record: `docs/design/fonts/DECISION.md` (§0 is the revision).
3. **Logo:** the "Bohr P" mark (`ui/src/icons/atom-logo.ts`, `docs/identity/*`). Decision record: `docs/design/logo/DECISION.md`.
4. **`web/index.html` is a small source template.** The boot splash is inlined at build by the Vite plugin, and the CSP hashes are generated at build (`web/dist/csp-hashes.json`, `csp.caddy`). Edit it only with targeted edits, never whole-file rewrites. `compactCss()` (`web/src/boot/compact-css.ts`) must keep the descendant space before `:`, so `.a :where(…)` never becomes `.a:where(…)`. UI-013 has a regression test for this.
5. **DSA:** the graded structures in `dsa/` are implemented (the team decided on 2026-09-25 to let the AI write them, disclosed). They are hand-written, and no library may replace them (spec §10.2).
6. **Package boundaries** are enforced by `tools/eslint-rules/boundaries.js`: apps and ui have no storage access, and wm does not import apps.
7. **Never touch the user's running instance** (compose project `plotinium` on :4717) from automated work. Use the QA project `plotinium-qa` on :4718.
8. **Secrets** never go in the repo. Credentials are printed once by the seed (`pnpm creds`). Server secrets are read from `*_FILE` paths outside the checkout.
9. **Design and change process (Wave 3, 2026-09-30).**
   - A feature is designed as an RFC in `docs/rfcs/` (process and template: `docs/rfcs/README.md`). It is reviewed (`docs/rfcs/reviews/`) and approved by the ARB, which writes the build plan `docs/rfcs/PLAN.md`: one owner per file, interface contracts, flags.
   - The stack has been frozen since the Phase 1 defence, so any stack or ABI change also needs an ADR in `docs/adr/` and the instructor's written approval (spec §14.4). Until approval, the change ships behind its flag, and the default leaves today's behaviour unchanged (PLAN §C-19).
   - The bug list and its verified status are in `docs/design/bug-hunt/BUGS.md`.

## Style

Strict TypeScript with no `any`. Test titles start with the requirement ID (e.g. `VFS-06 …`). Animate only transform and opacity. Honour reduced motion. WCAG 2.2 AA.
