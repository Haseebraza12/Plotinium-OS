---json
{
  "name": "renice",
  "section": 1,
  "summary": "change the niceness of running processes",
  "synopsis": "renice [-n] N [-p] PID... | renice [-n] N -g PGID... | renice [-n] N -u USER...",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "PROC-02",
    "PROC-08"
  ],
  "flags": [
    {
      "short": "-n",
      "long": "--priority",
      "arg": "N",
      "desc": "the new absolute nice value"
    },
    {
      "short": "-p",
      "long": "--pid",
      "arg": null,
      "desc": "operands are process ids (default)"
    },
    {
      "short": "-g",
      "long": "--pgrp",
      "arg": null,
      "desc": "operands are process group ids"
    },
    {
      "short": "-u",
      "long": "--user",
      "arg": null,
      "desc": "operands are user names or ids"
    }
  ],
  "seeAlso": [
    "nice",
    "ps"
  ]
}
---

# NAME

renice — change the niceness of running processes

# SYNOPSIS

`renice [-n] N [-p] PID... | renice [-n] N -g PGID... | renice [-n] N -u USER...`

# DESCRIPTION

Sets the absolute nice value N. Lowering nice or touching another user's process needs root. Prints `312 (process ID) old priority 0, new priority 10`.

# OPTIONS

- `-n, --priority N` — the new absolute nice value
- `-p, --pid` — operands are process ids (default)
- `-g, --pgrp` — operands are process group ids
- `-u, --user` — operands are user names or ids

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- `renice: failed to set priority for 312 (process ID): Permission denied`
- ESRCH

# EXAMPLES

    renice 19 -p 301

# SEE ALSO

nice(1), ps(1)
