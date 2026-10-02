# Google Stitch: logo exploration record

**Outcome: Stitch accepted the brand-board prompts but returned no screen that can be read back, so this folder holds no Stitch screenshot.** Nothing in `docs/design/logo` is a Stitch export. The exploration boards in [`../exploration/`](../exploration/) are hand-built renders (Chrome, one device pixel per CSS pixel), made while the Stitch calls were pending. The same thing happened in the 2026-09-24 design run (see [`../../README.md`](../../README.md), "no Stitch export exists yet").

The exact calls are recorded in [`attempts.json`](attempts.json). In summary, on 2026-09-27:

| #   | Project                                                                            | Model                   | Result                                                                                                                          |
| --- | ---------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `12849137298552292712` (Plotinium OS), design system `assets/10121591451242352758` | default                 | timed out; not retried (tool instructions)                                                                                      |
| 2   | same                                                                               | `GEMINI_3_5_FLASH_LITE` | text reply "brought the Plotinium Logo Exploration — Brand Board onto the canvas", session `14736554431131280864`, no screen id |
| 3   | same                                                                               | `GEMINI_3_8_FLASH`      | timed out                                                                                                                       |
| 4   | same, no design system                                                             | `GEMINI_3_5_FLASH_LITE` | text reply listing the six concepts, session `4051749110761977477`, no screen id                                                |
| 5   | new project `5024907487714755157` ("Plotinium logo exploration")                   | `GEMINI_3_5_FLASH_LITE` | timed out; the project gained a generated design theme but no screen                                                            |

- `list_screens` returned `{}` for both projects in every poll (more than 10 polls from about 04:01 to 04:50 UTC).
- `list_projects` shows no `screenInstances` for either project, while older projects in the same account list theirs, and `list_screens` works on those.
- `get_screen` with a session id returns "Requested entity was not found".
- `get_project` on `12849137298552292712` shows `updateTime` moving (04:09, 04:14) after the calls, but its thumbnail is still an older verbose-boot screen.

So `generate_variants` and `edit_screens`, which need a screen id, could not be used. The design was explored and decided by hand instead ([`../DECISION.md`](../DECISION.md)). The prompts asked Stitch for the same six concepts that the hand-built boards compare. The Stitch design systems' `designMd` was updated to describe the new mark, so future generations draw it.

If a Stitch screen appears later (open the project in the Stitch web app), save it here as `<slug>/screen.html` and `<slug>/screenshot.png`, and add its screen id to `attempts.json`.
