# Research inputs (AI-assisted, 23 Sept 2026)

Raw outputs from the multi-agent stack research run with Claude Code. They are **inputs**, not decisions of record:
the normative documents are in `specs/`. Precedence when sources disagree:
spec PDF > `critic.json` fixes > `coherence.json` resolutions > examiner review inside `decisions/*.json` > original record / `strategy/*.md`.

- `decisions/<key>.json` — one STACK_DECISION-format record per decision + the adversarial examiner review.
- `strategy/*.md` — architecture and delivery strategy drafts.
- `coherence.json` — cross-stack conflicts, resolutions and the consolidated final stack.
- `critic.json` — completeness check against the spec's Appendix A; mandatory fixes.

All numbers are pilot measurements from a development laptop and must be re-measured on the lab machine
(see `docs/evidence/pilot/`). Disclosed in `AI_USAGE.md`.
