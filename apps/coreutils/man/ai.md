---json
{
  "name": "ai",
  "section": 1,
  "summary": "agentic shell",
  "synopsis": "ai [-n | --dry-run] [--json] \"INSTRUCTION\" | ai log [-n N] [--json] [--all] [TXN] | ai undo TXN | ai status",
  "owner": "R4",
  "requirements": [
    "SYS-02",
    "AGT-01",
    "AGT-03",
    "AGT-08",
    "AGT-09",
    "AGT-10"
  ],
  "flags": [
    {
      "short": "-n",
      "long": null,
      "arg": "N",
      "desc": "with log: show the last N records; before an instruction: dry run only"
    },
    {
      "short": null,
      "long": "--dry-run",
      "arg": null,
      "desc": "plan and dry run, then stop without executing"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "machine-readable output"
    },
    {
      "short": null,
      "long": "--all",
      "arg": null,
      "desc": "with log: every user's records (root only)"
    }
  ],
  "seeAlso": [
    "semsearch",
    "predict"
  ]
}
---

# NAME

ai — agentic shell

# SYNOPSIS

`ai [-n | --dry-run] [--json] "INSTRUCTION"`  
`ai log [-n N] [--json] [--all] [TXN]`  
`ai undo TXN`  
`ai status`

# DESCRIPTION

The instruction is one argument (quote it). `ai` starts the `ai.agent` process, which plans with read-only tools, validates the plan, prints the dry run and blast radius, asks for confirmation through the kernel-owned terminal prompt when the plan is destructive, and executes it as one transaction. The model never runs text as a command and there is no `--yes`.

`ai log` lists the audit records (`TXN WHEN OUTCOME STEPS INODES PROMPT`) or shows one in full. `ai undo TXN` reverses a committed plan through the same confirmation. `ai status` shows the gateway state, the model and the remaining budget.

# OPTIONS

- `-n N` — with log: show the last N records; before an instruction: dry run only
- `--dry-run` — plan and dry run, then stop without executing
- `--json` — machine-readable output
- `--all` — with log: every user's records (root only)

# EXIT STATUS

0 committed or nothing to do; 1 declined or cancelled; 2 rejected, failed or usage error; 3 needs clarification but the input is not a terminal; 4 AI unavailable or refused; 130 interrupted.

# ERRORS

- `ai: agent unavailable (offline) — nothing was run` (EAIUNAVAIL)
- `ai: the model refused this request — nothing was run` (EAIREFUSED)
- `ai: plan stale — nothing changed` (EAGAIN)
- `ai: interrupted — transaction rolled back, nothing changed`

# EXAMPLES

    ai "create a folder called reports"
    ai log -n 3
    ai undo 0192f0c1
    ai status

# SEE ALSO

semsearch(1), predict(1)
