---json
{
  "name": "nice",
  "section": 1,
  "summary": "run with changed niceness",
  "synopsis": "nice [-n N] [COMMAND [ARG...]]",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "PROC-08"
  ],
  "flags": [
    {
      "short": "-n",
      "long": "--adjustment",
      "arg": "N",
      "desc": "add N to the niceness (default 10)"
    }
  ],
  "seeAlso": [
    "renice",
    "ps"
  ]
}
---

# NAME

nice — run with changed niceness

# SYNOPSIS

`nice [-n N] [COMMAND [ARG...]]`

# DESCRIPTION

Without COMMAND prints the current nice value. Otherwise runs COMMAND with nice = current + N, clamped to −20…19. A negative N needs root; without it the command runs unchanged after a warning.

# OPTIONS

- `-n, --adjustment N` — add N to the niceness (default 10)

# EXIT STATUS

COMMAND's status; 127 if COMMAND was not found; 2 on a usage error.

# ERRORS

- `nice: cannot set niceness: Permission denied`

# EXAMPLES

    nice -n 15 burn --ms 60000 &

# SEE ALSO

renice(1), ps(1)
