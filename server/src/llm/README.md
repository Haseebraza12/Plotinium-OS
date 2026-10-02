# server/src/llm

The LLM gateway: Claude through the server only (key only in the server env), per-uid limits, reserve / call outside any transaction / settle budget, `llm_requests` logging, cassette record and replay.

- **Primary owner:** R4 AI
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/10-ai/agentic-shell.md](../../../specs/10-ai/agentic-shell.md), [specs/11-server/backend-api.md](../../../specs/11-server/backend-api.md), [specs/12-security/security-model.md](../../../specs/12-security/security-model.md)
- **Requirement IDs:** AGT-01, AGT-08, spec §12.6
