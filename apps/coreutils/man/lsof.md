---json
{
  "name": "lsof",
  "section": 1,
  "summary": "open files and leases",
  "synopsis": "lsof [-p PID] [-u USER] [PATH]",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-09",
    "PROC-07"
  ],
  "flags": [
    {
      "short": "-p",
      "long": null,
      "arg": "PID",
      "desc": "only descriptors of PID"
    },
    {
      "short": "-u",
      "long": null,
      "arg": "USER",
      "desc": "only descriptors of USER"
    }
  ],
  "seeAlso": [
    "ps"
  ]
}
---

# NAME

lsof — open files and leases

# SYNOPSIS

`lsof [-p PID] [-u USER] [PATH]`

# DESCRIPTION

Lists open descriptors and file leases: `COMMAND PID USER FD TYPE MODE NAME LEASE`.

# OPTIONS

- `-p PID` — only descriptors of PID
- `-u USER` — only descriptors of USER

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- ESRCH for -p
- ENOENT for PATH

# EXAMPLES

    lsof /home/shared/plan.md

# SEE ALSO

ps(1)
