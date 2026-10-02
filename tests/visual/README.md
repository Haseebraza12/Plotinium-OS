# tests/visual

Visual regression of the @plotinium/ui component gallery (`ui/gallery`): every gallery page in the light and the dark theme, compared with committed reference screenshots (PLT-ID-06: one token set, both themes).

- Pages are discovered from `ui/gallery/pages/*.tsx` (`export const meta = { id, … }`), so a new page is covered without editing the harness; `PLOTINIUM_GALLERY_PAGES=a,b` narrows the run.
- Each page opens at `#/<id>?theme=<t>&motion=reduce` with the matching emulated colour scheme, fonts loaded and animations off; the viewport grows to the page's full height (the gallery scrolls inside its own container).
- **References** live in `__screenshots__/visual/<id>-<theme>.png` and are recorded on the CI image (ubuntu-24.04, Chrome stable), because font rasterisation differs between systems. Record or update them with `--update-snapshots` and review the images in the pull request.
- **How to run:** `pnpm --filter @plotinium/ui gallery` (or serve `ui/gallery/dist`), then `PLOTINIUM_GALLERY_URL=http://localhost:4718 pnpm exec playwright test -c tests/playwright.config.ts --project=visual`. Skipped without the URL.
- **Primary owner:** R3 (gallery), R5 (harness). **Reviewer:** R1.

Every test title MUST begin with its requirement ID, for example `DB-02 rm -r with a server fault at node 500 rolls back with zero orphans and unchanged checksum and quota` (C18). `pnpm traceability` builds the requirement-to-test matrix from these titles.
