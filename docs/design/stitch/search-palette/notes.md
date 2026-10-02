# Search palette (dark)

| Field | Value |
|---|---|
| Stitch project | `12849137298552292712` |
| Stitch screen id | none: generation timed out and never appeared in `list_screens` (about 20 polls, 15:24Z to 15:48Z). Not retried, per run instructions. See `screen.json`. |
| Design system | Plotinium Glass (Dark), `assets/10121591451242352758` |
| Model | GEMINI_3_8_FLASH, DESKTOP 1440 x 900 |
| Files | `screen.json` (Stitch timeout record), `reference.html` + `reference.png` (hand-built render of the final prompt; NOT a Stitch export). `screen.html` / `screenshot.png` are absent because Stitch returned no screen. |
| Spec sources | `specs/10-ai/rag-semantic-search.md` §3.5 (query path, `ai.search.focus`, notices, `path:line` citations, RAG-05 ≤ 500 ms p95, RAG-06 keyword fallback); `specs/10-ai/agentic-shell.md` (`ai "…"`, confirmation); `specs/05-wm/ui-design-system.md` §3.6 motion, §3.7 keycap, §3.8.7 launcher, §3.8.11 citations |

## What this screen shows

The system-wide **Search** palette (opened with `Ctrl+Space`, `⌘Space` on a Mac keyboard, or the magnifier in the menu bar). It is a large, centred command palette of thick dark glass, floating over the desktop, which is dimmed and blurred behind it. The query is `budget report from last week`, and the results are grouped as follows.

- **Top hit**: `os-report.md` at `/home/student/notes/os-report.md`, with a highlighted snippet.
- **Semantic matches**: three files, each with a `path:line` citation and a relevance bar with a percentage. One of them is in `/home/alice/shared/…`, which shows that results the user can read in other homes are included.
- **Apps**: Files and Editor.
- **Commands**: `ai "summarise budget report"` (hands off to the agent in the Terminal, where the plan is still validated and confirmed) and `semsearch budget`.

On the right, a preview pane renders the selected result, with the matched lines highlighted. The footer holds the key hints `↩ open · ⌘↩ reveal in Files · ⇥ ai mode` and a timing line such as `8 results · 38 ms · local index`.

On non-Mac keyboards the `⌘` keycap is shown as `Ctrl`. The glyph itself is a key legend, not an Apple mark.

## Final prompt

```text
Plotinium Search palette — a large centred command palette of dark Liquid Glass floating over a dimmed, blurred desktop. Inspired by the latest macOS launcher look, but Plotinium's own identity (NO Apple logo, NO Apple app names, NO SF Symbols; thin lucide-style line icons; accent violet #5E5CE6). Crisp and fast-feeling.

BACKGROUND (1440x900): the Plotinium desktop dimmed to ~40% with blur: a translucent top menu bar (small luminous atom logo — violet nucleus with 2 thin elliptical orbits — then "Files  File  Edit  View  Go  Window  Help", right side clock "Thu 24 Sep  10:42"), a faint Files window (/home/student/notes) and a Terminal window showing `ps` (init pid 1, sched, vfs, syncd, ai.indexer pid 23 at priority 32, terminal, files) behind, and a floating dock at the bottom (Files, Terminal, Editor, Task Manager, Settings), all dimmed.

PALETTE (centred, ~940x604, 18px corner radius, thick layered translucent dark glass with a bright 1px inner top highlight and a huge soft shadow with a faint violet glow):

TOP FIELD (64px): a magnifier line icon at left, the query in large 22px white text "budget report from last week" with a violet caret, at right a small pill "Semantic" with a sparkle icon and a keycap "esc". A hairline separator.

BODY split into two columns:

LEFT RESULTS LIST (520px), grouped with small grey uppercase section headers:
- "TOP HIT": a selected row (violet #5E5CE6 highlight, rounded 10px) with a document tile, title "os-report.md", path "/home/student/notes/os-report.md:14", and a snippet "…the weekly budget report shows compute spend of $3.20 for last week…" with the matched words highlighted. At right "Edited 18 Sep".
- "SEMANTIC MATCHES": 3 rows, each with a file tile, file name, a path:line citation in monospace, and a thin relevance bar at right with a percentage:
  1. "budget-2026-w38.csv" — "~/finance/budget-2026-w38.csv:14" — 92%
  2. "meeting-notes-17-sep.md" — "~/notes/meeting-notes-17-sep.md:42" — 81%
  3. "lab4-costs.md" (owner alice) — "/home/alice/shared/lab4-costs.md:7" — 67%
- "APPS": "Files" (with a green "running" dot) and "Editor", each labelled "Application".
- "COMMANDS": `ai "summarise budget report"` ("Ask the AI agent · Terminal") and `semsearch budget` ("Semantic search in shell"), each with a >_ tile.

RIGHT PREVIEW PANE (slightly lighter glass, left hairline divider): the selected result "os-report.md": a header with a document tile, the name, and "Markdown · 12 KB · owner student · modified 18 Sep 16:20"; then a line-numbered rendered Markdown preview: "# OS Report — Week 38", "Team 07 · Section B · compiled by student", a scheduler line, "## Budget", line 14 highlighted with a violet left rule ("The weekly budget report shows compute spend of $3.20 for last week, against the $50 monthly cap."), a small table (Item | Cost: LLM gateway $3.20, Storage $0.00, CI minutes $0.00). Under it action chips: "Open" (primary), "Reveal in Files", "Ask AI about this".

FOOTER (40px, hairline top border, small grey text with keycaps): "↩ open · ⌘↩ reveal in Files · ⇥ ai mode" at left, and at right a green dot and "8 results · 38 ms · local index".

Style: Inter, crisp white primary text, 60% white secondary, hairline separators rgba(255,255,255,0.08), JetBrains Mono for paths and commands, strong readable contrast, compact spacing.
```

## UI elements and states

### Overlay
| Element | States |
|---|---|
| Desktop scrim (dimmed and blurred desktop, menu bar and dock) | shown while the palette is open; a click on the scrim closes the palette and returns focus to the previous window |
| Palette panel | opening; open; **closing** (`Esc`, a scrim click or running a result); moved to the top third on small viewports; high-contrast/forced-colours version (solid `Canvas` background, 1px `CanvasText` border) |

### Query field
| Element | States |
|---|---|
| Magnifier icon | default (60% label); turns into a sparkle icon in **AI mode** (`⇥`) with the placeholder `Ask the agent…` |
| Input `budget report from last week` | empty (placeholder `Search files, apps and commands`); typing (results update after a 60 ms debounce); **loading** (a thin 2px determinate bar under the field shows how far the query has got, keyword first and then semantic; there is no spinner); focus (the field is always focused while the palette is open, with the caret in the accent colour) |
| `Semantic` pill | on (accent-subtle); **model loading** (`Keyword` pill + notice `semantic model loading — showing keyword matches`); **unavailable** (`Semantic search unavailable — showing keyword matches`); AI-off build (the pill is hidden) |
| `esc` keycap | static hint; hover shows the tooltip `Close` |

### Results list (`listbox`)
| Element | States |
|---|---|
| Section headers `TOP HIT`, `SEMANTIC MATCHES`, `APPS`, `COMMANDS` | default; a section is hidden when it has no rows |
| Result row (icon, title, path or citation, snippet, meta) | default; hover (4% white fill, and the preview does not change until the row is selected); **selected** (accent fill at 85% with white text; the preview follows); pressed; focus-visible (a ring inside the selected pill when reached by keyboard); disabled (a file the user can no longer read shows `No permission` and cannot be selected) |
| Snippet with highlighted matches | matched terms in accent text on an accent-subtle background, bold; at most 2 lines with an ellipsis |
| Citation (`~/finance/budget-2026-w38.csv:14`) | mono, link-styled; hover underline; `⌘↩` / `Ctrl+↩` reveals it in Files |
| Relevance bar + % | 92% / 81% / 67% fills; the score is always printed as text too |
| App row (Files, Editor) | default, selected, running (small dot); opening launches or focuses the app |
| Command row (`ai "summarise budget report"`, `semsearch budget`) | default; selected; runs in a new Terminal window; offline (the `ai` row shows `Needs the gateway — offline` and is disabled) |
| **Empty** | `No results for "xyz"`, with a suggestion row `Ask the agent: ai "xyz"` (`⇥`) |
| **Error** | `role="alert"` banner inside the list: `Search failed — EIO. Showing keyword matches.` |
| **Offline** | the normal results plus the notice `1 shared result hidden while offline` |

### Preview pane (`region`)
| Element | States |
|---|---|
| File header (icon, name, `Markdown · 12 KB · owner student · modified 18 Sep 2026 16:20`) | default |
| Rendered Markdown preview with highlighted lines | **loading** (static skeleton lines); loaded (scrolls so the first match is centred); **too large or binary** (`No preview — 48 MB binary`); **permission denied** (`You do not have permission to read this file · EACCES`) |
| Action chips `Open`, `Reveal in Files`, `Ask AI about this` | default, hover, pressed, focus |
| App or command preview | an app shows its icon, description and the `Open` chip; a command shows its syntax, a `man` excerpt and the note `The agent will show a plan before changing anything` |

### Footer
Keycaps `↩`, `⌘↩`, `⇥` with their labels, and the count/timing line `8 results · 38 ms · local index`. When the query takes longer than 500 ms the timing text turns to the warning colour (the RAG-05 budget).

## Intended animations

Only `transform` and `opacity` animate. The tokens are `--pl-motion-fast` 120 ms, `--pl-motion-med` 200 ms and `--pl-motion-slow` 320 ms; `--pl-ease` is `cubic-bezier(.2, .8, .2, 1)`; `--pl-spring` is `linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%, 1.061 22.1%, 1.072 24.5%, 1.061 27.4%, 1.004 34.6%, 0.99 39.2%, 0.999 50.5%, 1)`.

This palette must **feel instant**, so every animation stays at 200 ms or less, and input is never blocked by an animation.

The reduced-motion rule: under `prefers-reduced-motion: reduce` or `data-motion="reduce"` the tokens are 0 ms. The palette and scrim appear with at most a 120 ms opacity fade, and nothing slides, scales or loops. The text caret is the native caret, and there is no custom blink.

| # | Element | Trigger | Properties | Duration | Easing | Reduced motion |
|---|---|---|---|---|---|---|
| 1 | Desktop scrim | palette opens / closes | `opacity 0 → 1` (the dim and blur layer is prebuilt, so only its opacity changes) | 160 ms in, 120 ms out | `--pl-ease` | fade 120 ms |
| 2 | Palette panel | opens | `transform: scale(.98) translateY(-8px) → none`, `opacity 0 → 1` | 200 ms | `--pl-spring` | fade 120 ms |
| 3 | Palette panel | closes (Esc or scrim) | `scale(1 → .98)`, `opacity 1 → 0` | 120 ms | `--pl-ease-in` `cubic-bezier(.4,0,1,1)` | instant hide |
| 4 | Palette panel | a result runs (`↩`) | `scale(1 → 1.02)`, `opacity → 0`, a "launch" feel, while the target window opens with its own open animation | 160 ms | `--pl-ease` | instant hide |
| 5 | Result groups | results first arrive | each section `translateY(4px) → 0`, `opacity 0 → 1`, with a 24 ms stagger per section (max 4) | 160 ms | `--pl-ease` | appear at once |
| 6 | Result rows | results change while typing | rows that stay move with a FLIP `translateY`; new rows `opacity 0 → 1`; removed rows `opacity → 0` (no height animation) | 120 ms | `--pl-ease` | instant replace |
| 7 | Selection pill | ↑/↓ or hover-click | one pill element slides to the new row: `translateY(Δ)` (FLIP); `scaleY` when rows differ in height | 180 ms | `--pl-spring` | jumps |
| 8 | Preview pane content | selection changes | outgoing `opacity → 0` in 60 ms; incoming `translateX(8px) → 0`, `opacity 0 → 1` | 160 ms | `--pl-ease` | instant swap |
| 9 | Relevance bars | rows appear | fill layer `scaleX(0 → p)` (origin left), 20 ms stagger | 320 ms | `--pl-spring` | set directly |
| 10 | Query progress hairline | query in flight | `transform: scaleX(0 → .5)` when the keyword stage finishes, then `→ 1` for semantic, then `opacity → 0` (determinate; no looping sweep) | 120 ms per step, 200 ms fade | `--pl-ease` | opacity only |
| 11 | AI mode (`⇥`) | toggle | the magnifier cross-fades to a sparkle (`opacity` + `rotate(-30deg → 0)` + `scale(.8 → 1)`); the field's accent glow layer `opacity 0 → 1` once | 200 ms | `--pl-spring` | icon swap, no glow |
| 12 | `Semantic` pill | changes to `Keyword` (model loading) | `opacity` cross-fade between two labels | 120 ms | `--pl-ease` | instant |
| 13 | Keycaps in the footer | the matching key is pressed | the keycap is pressed down: `translateY(1px)`, `scale(.96)` then back | 120 ms | `--pl-ease` | no motion |
| 14 | Action chips | hover / press | hover fill `opacity`; press `scale(.97)` | 120 ms | `--pl-ease` | opacity only |
| 15 | Empty state | no results | the illustration (the atom mark, outlined) `scale(.9) → 1`, `opacity 0 → 1` once | 200 ms | `--pl-spring` | fade |

## Review notes (reference render)

**There is no Stitch render for this screen** (see `screen.json`). Generation timed out and never appeared in `list_screens` (about 20 polls over 25 min); it was not retried. To keep the design reviewable, `reference.html` is a hand-built render of the final prompt using the Plotinium Glass (Dark) tokens, and `reference.png` is its 1440 x 900 Chromium capture (Playwright). Its source is labelled "NOT a Stitch export". Reloading it plays the open sequence: scrim fade, palette spring-in from 0.98, sections staggered 24 ms apart, relevance bars filling, and the preview sliding in. `↑`/`↓` move the selection pill.

What I checked on `reference.png`:
- A macOS-launcher-grade look with our own identity: thick glass, an inner highlight, a soft violet glow, and the desktop dimmed and blurred behind (Files window, Terminal running `ps` with init / sched / vfs / syncd / ai.indexer pid 23 at priority 32, and the dock).
- Every requested element is present: the magnifier and the query `budget report from last week`; Top hit `os-report.md` with its path and highlighted snippet; 3 semantic matches with `path:line` citations and relevance bars (92 / 81 / 67%); Apps (Files, Editor); Commands (`ai "summarise budget report"`, `semsearch budget`); the preview pane with the matched line 14 highlighted; the footer `↩ open · ⌘↩ reveal in Files · ⇥ ai mode`.
- Branding: only Plotinium names (Search, Files, Editor, Terminal) and lucide icons. The `⌘` keycap is a key legend, not a mark; on non-Mac keyboards the palette shows `Ctrl`.
- Contrast: highlighted matches (#B4B3FF on violet at 22%) and citations pass 4.5:1 on the palette tint. The selected row is white on violet at 85% (≥ 4.5:1).

Deliberate choices:
1. The result count reads `8 results` (1 top hit + 3 semantic + 2 apps + 2 commands), not 7.
2. The citations under the home directory use `~/…` as in `ui-design-system.md` §3.8.11. Alice's file keeps its full path so that crossing into another home is visible.
3. The top hit's path carries the line (`os-report.md:14`), so it matches the highlighted line in the preview.

To do when Stitch recovers: generate once with the final prompt, download to `screen.html` / `screenshot.png`, and compare with `reference.png`.

## Accessibility

- **Landmarks and roles.** The palette is `role="dialog"` with `aria-modal="true"` and `aria-label="Search"`; the background is `inert`. The field is a `combobox` (`input role="combobox" aria-expanded="true" aria-controls="results" aria-activedescendant="<row id>" aria-autocomplete="list"`).
- **Results.** One `listbox`, with each section a `group` labelled by its header (`aria-labelledby`), and each row an `option` with `aria-selected`. Each option's accessible name gives the title, path and relevance: `os-report.md, /home/student/notes/os-report.md, top hit`, or for a match `budget-2026-w38.csv, line 14, relevance 92 percent`.
- **Preview.** The preview is a `region` with `aria-label="Preview of os-report.md"`, placed after the listbox in the DOM and reachable with `Tab`.
- **Live regions.** `role="status" aria-live="polite"` announces `8 results` after typing stops (400 ms), plus the fallback notices. Errors use `role="alert"`.
- **Keyboard.** `↑/↓` moves the selection, `Home/End` go to the first and last rows, `↩` opens, `⌘↩`/`Ctrl+↩` reveals in Files, `⇥` toggles AI mode, `Esc` closes and restores focus to the element that opened the palette. Focus is trapped while the palette is open.
- **Colour is never the only signal.** Match highlights are also bold, and relevance is also printed as a percentage.
- **Contrast.** The glass tint behind text is at least 82% opaque, and highlighted matches meet 4.5:1.
