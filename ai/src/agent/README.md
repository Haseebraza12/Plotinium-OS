# ai/src/agent

The agentic shell: an observation loop of at most 6 turns with read-only tools, mutating tools buffered into ONE plan, then validate, dry run, kernel-decided confirmation (read only from kernel-owned TTY input), ONE transaction as the caller's uid, audit and optional `ai undo`. The planner never sees file contents; names are datamarked with a per-request nonce.

- **Primary owner:** R4 AI Pipeline Specialist
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/10-ai/agentic-shell.md](../../../specs/10-ai/agentic-shell.md), [specs/10-ai/ai-safety-and-evaluation.md](../../../specs/10-ai/ai-safety-and-evaluation.md)
- **Requirement IDs:** AGT-01..10
