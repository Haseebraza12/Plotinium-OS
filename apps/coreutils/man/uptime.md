---json
{
  "name": "uptime",
  "section": 1,
  "summary": "time since boot and load",
  "synopsis": "uptime [-p] [-s]",
  "owner": "R1",
  "requirements": [
    "SYS-02"
  ],
  "flags": [
    {
      "short": "-p",
      "long": "--pretty",
      "arg": null,
      "desc": "print up 12 minutes"
    },
    {
      "short": "-s",
      "long": "--since",
      "arg": null,
      "desc": "print the boot time"
    }
  ],
  "seeAlso": [
    "top",
    "bootlog"
  ]
}
---

# NAME

uptime — time since boot and load

# SYNOPSIS

`uptime [-p] [-s]`

# DESCRIPTION

Prints the time, the time since boot, the number of users and the 1, 5 and 15 minute load averages.

# OPTIONS

- `-p, --pretty` — print up 12 minutes
- `-s, --since` — print the boot time

# EXIT STATUS

0 on success; 2 on a usage error.

# ERRORS

- usage only

# EXAMPLES

    uptime -p

# SEE ALSO

top(1), bootlog(1)
